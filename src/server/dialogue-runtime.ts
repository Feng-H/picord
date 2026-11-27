import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { ChannelManager, normalizeChannelName, type Channel } from "./channels.ts";
import type { User } from "./config.ts";
import { NOTE_ENTRY } from "./entry-format.ts";
import { HttpError } from "./errors.ts";
import { entryWords, HistorySearchEngine } from "./history-search.ts";
import { ownRequest } from "./requests.ts";
import {
    canConversationAccessTarget,
    isGroupSession,
    resolveChannelTargetForScope,
    type SessionAccessMeta,
    type SessionAccessUser,
} from "./session-access.ts";
import {
    appendEngineEventLog,
    appendSummarizedMarker,
    ConversationRuleEngine,
    FileRuleEngineStore,
    formatEngineEventNote,
    formatRuleList,
    formatRulePrompt,
    formatRuleStatus,
    loadDefaultRules,
    watchRuleFiles,
    type ConversationRule,
    type DispatchedTask,
    type EngineEvent,
    type RuleEngineStore,
} from "./rule-engine/index.ts";
import {
    TurnPipeline,
    type ConversationSubmitter,
    type StandardTurnAdapter,
    type SubmitRequest,
} from "./turn-pipeline/index.ts";

export interface DialogueSessionSummary {
    id: number;
    title?: string;
    channel?: boolean;
    archived?: boolean;
    createdBy?: string;
    members?: readonly string[];
    pip?: string;
    cwd?: string;
}

/** Narrow host capabilities supplied by `PocketApp` (or tests) to run Picord dialogue subsystems. */
export interface DialogueRuntimeHost {
    readonly dataDir: string;
    readonly workspaceDir: string;
    readonly build: string;
    readonly pid: number;
    listSessions(): DialogueSessionSummary[];
    sessionMeta(id: ConversationId): Omit<DialogueSessionSummary, "id"> | undefined;
    createChannelSession(
        user: User,
        options: { title: string; channel: true; cwd?: string },
    ): Promise<{ id: ConversationId }>;
    userById(id: string): User | undefined;
    listUsers?(): readonly SessionAccessUser[];
    isRemovedSession?(id: number): boolean;
    fallbackUser(): User | undefined;
    requireSee(user: User, id: ConversationId): void;
    requireSteer(user: User): void;
    conversation(id: ConversationId): Promise<ConversationSubmitter>;
    readTranscriptEntries(
        id: number,
        query?: { minEntryId?: number; maxEntryId?: number },
        limit?: number,
    ): Promise<readonly EntryRecord[]>;
    entriesAfter(
        id: ConversationId,
        cursorEntryId: number,
        full: boolean,
    ): Promise<{ entries: readonly unknown[]; last: number }>;
    visibleEntry(id: ConversationId, entryId: number): Promise<EntryRecord | undefined>;
    submitTurn(
        id: ConversationId,
        user: User,
        request: SubmitRequest,
        via?: string,
    ): Promise<{ submissionId: SubmissionId; requestId: string; wait?: Promise<unknown> }>;
    standardTurnAdapter(): StandardTurnAdapter;
    log(line: string): void;
    tickIntervalMs?: number | null;
    watchFiles?: boolean;
    loadRules?: () => ConversationRule[];
    ruleStore?: RuleEngineStore;
}

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const IN_CHANNEL_EVENTS = new Set<string>([
    "rule_added",
    "rule_removed",
    "rule_modified",
    "rule_fired",
    "cursor_advanced",
]);
const LIFECYCLE_EVENTS = new Set<string>(["rule_added", "rule_removed", "rule_modified"]);

/**
 * Coordinates Picord's four dialogue subsystems (`ChannelManager`, `HistorySearchEngine`,
 * `ConversationRuleEngine`, and `TurnPipeline`) behind one cohesive runtime boundary.
 */
export class DialogueRuntime {
    readonly channels: ChannelManager;
    readonly historySearch: HistorySearchEngine;
    readonly ruleEngine: ConversationRuleEngine;
    readonly turnPipeline: TurnPipeline;

    readonly #host: DialogueRuntimeHost;
    #tickTimer: NodeJS.Timeout | undefined;
    #watcherCleaner: (() => void) | undefined;
    #closed = false;

    constructor(host: DialogueRuntimeHost) {
        this.#host = host;
        this.channels = this.#createChannelManager();
        this.historySearch = this.#createHistorySearch();
        this.ruleEngine = this.#createRuleEngine();
        this.turnPipeline = this.#createTurnPipeline();
        this.#startAutomation();
    }

    /** Reload conversation rules from disk (or configured loader) into the live rule engine. */
    reloadRules(): { count: number; rules: ConversationRule[] } {
        if (this.#closed) {
            return { count: this.ruleEngine.rules.length, rules: [...this.ruleEngine.rules] };
        }

        const rules = this.#loadRules();

        this.ruleEngine.reloadRules(rules);

        return { count: rules.length, rules };
    }

    /** Execute an in-conversation `/rule` command (`list`, `status`, `reload`, or help). */
    executeRuleCommand(typed: string): string {
        const parts = typed.trim().split(/\s+/);
        const sub = (parts[1] ?? "").toLowerCase();

        switch (sub) {
            case "list":
                return formatRuleList(this.ruleEngine.rules);
            case "status":
                return formatRuleStatus(this.ruleEngine);

            case "reload": {
                const res = this.reloadRules();

                return `✅ **规则热重载成功**，已载入 ${String(res.count)} 条规则：\n${res.rules.map((r) => `- \`${r.id}\` (#${r.channel})`).join("\n")}`;
            }

            default:
                return [
                    "🤖 **对话规则引擎指令 (/rule)**",
                    "- `/rule list`: 列出当前已配置生效的所有规则",
                    "- `/rule status`: 查看当前频道的倒计时、增量游标与心跳状态",
                    "- `/rule reload`: 立即从磁盘重新加载规则配置文件",
                ].join("\n");
        }
    }

    /** Dispatch a rule-triggered prompt into target channel (when forwardToChannel is set) or source channel, advance cursor, and mark archives. */
    async handleRuleDispatchedTask(task: DispatchedTask): Promise<void> {
        if (this.#closed) {
            return;
        }

        const sourceChannel = this.channels.get(task.channel);

        if (!sourceChannel) {
            this.#host.log(`rule-engine: source channel not found for ${task.channel}`);

            return;
        }

        const meta = this.#host.sessionMeta(sourceChannel.id);
        const user = this.#host.userById(meta?.createdBy ?? "") ?? this.#host.fallbackUser();

        if (!user) {
            this.#host.log(`rule-engine: no user found for channel ${task.channel}`);

            return;
        }

        const cursor = task.cursorEntryId ?? 0;
        const { entries, last } = await this.#host.entriesAfter(sourceChannel.id, cursor, false);

        if (this.#closed || entries.length === 0) {
            if (!this.#closed) {
                this.#host.log(
                    `rule-engine: no new entries to summarize for #${sourceChannel.name} since cursor ${String(task.cursorEntryId)}`,
                );
            }

            return;
        }

        const headEntryId = Math.max(task.headEntryId ?? 0, last);
        const targetName = task.forwardToChannel?.replace(/^#/, "").trim();
        let prompt = formatRulePrompt(task, cursor, headEntryId);
        let dispatchChannel = sourceChannel;

        if (targetName) {
            const targetChannel = this.channels.get(targetName);

            if (!targetChannel) {
                this.#host.log(
                    `rule-engine: forwardToChannel #${targetName} not found; skipping dispatch to keep #${sourceChannel.name} noise-free`,
                );

                return;
            }

            this.#host.requireSee(user, targetChannel.id);

            if (!this.canConversationAccess(targetChannel.id, sourceChannel.id)) {
                this.#host.log(
                    `rule-engine: target #${targetChannel.name} cannot access source #${sourceChannel.name}; skipping dispatch`,
                );

                return;
            }

            const transcript = await this.#host.readTranscriptEntries(
                Number(sourceChannel.id),
                { minEntryId: cursor + 1, maxEntryId: headEntryId },
                200,
            );
            const excerpts = transcript
                .filter((entry) => entry.kind !== NOTE_ENTRY)
                .map((entry) => {
                    const text = entryWords(entry).text.trim();

                    return text ? `[entry ${String(entry.id)}] ${text}` : "";
                })
                .filter(Boolean);

            if (excerpts.length > 0) {
                prompt = `${prompt}\n\n<source-messages channel="#${sourceChannel.name}" range="(${String(cursor)}, ${String(headEntryId)}]">\n${excerpts.join("\n")}\n</source-messages>`;
            }

            dispatchChannel = targetChannel;
        }

        this.#host.log(
            `rule-engine: injecting prompt into #${dispatchChannel.name} for #${sourceChannel.name} (${String(cursor)}, ${String(headEntryId)}]`,
        );

        const submitted = await this.#host.submitTurn(
            dispatchChannel.id,
            user,
            { text: prompt, requestId: randomUUID() },
            `rule:${task.ruleId}`,
        );

        if (!submitted.wait || this.#closed) {
            return;
        }

        const settled = (await submitted.wait) as
            | {
                  status?: string;
                  type?: string;
                  answer?: number;
              }
            | undefined;

        if (this.#closed || !settled || settled.status === "unanswered") {
            return;
        }

        this.ruleEngine.advanceCursor(task.ruleId, headEntryId);
        this.#host.log(`rule-engine: advanced cursor for ${task.ruleId} to ${String(headEntryId)}`);

        if (task.archiveFile) {
            this.#markArchived(task.archiveFile);
        }
    }

    /** Append rule-engine lifecycle events to disk logs and surface notable transitions according to rule notification policy. */
    async handleEngineEvent(event: EngineEvent): Promise<void> {
        if (this.#closed) {
            return;
        }

        const logPaths = [
            join(this.#host.workspaceDir, ".dialogue-session", "engine-events.log"),
            join(this.#host.dataDir, "engine-events.log"),
        ];

        for (const logPath of logPaths) {
            try {
                appendEngineEventLog(logPath, event);
            } catch {}
        }

        if (!event.channel || !IN_CHANNEL_EVENTS.has(event.type)) {
            return;
        }

        const noteChannelName = this.#resolveEngineNoteChannel(event);

        if (!noteChannelName) {
            return;
        }

        const channel = this.channels.get(noteChannelName);

        if (!channel) {
            return;
        }

        try {
            const conversation = await this.#host.conversation(channel.id);

            if (this.#closed) {
                return;
            }

            const noteText = formatEngineEventNote(event);
            const noteRequestId = ownRequest("engine", `engine-note-${randomUUID()}`);

            await conversation.submit(
                {
                    type: "write",
                    entry: {
                        kind: NOTE_ENTRY,
                        data: { text: noteText, by: "engine", name: "Rule Engine" },
                        model: [
                            {
                                role: "user" as const,
                                content: [{ type: "text" as const, text: noteText }],
                                timestamp: Date.now(),
                            },
                        ],
                    },
                    requestId: noteRequestId,
                },
                BACKGROUND_CONTEXT,
            );
            this.#host.log(`rule-engine: injected [engine] note into #${channel.name}`);
        } catch (err: unknown) {
            this.#host.log(`rule-engine: failed to inject note into #${channel.name}: ${String(err)}`);
        }
    }

    /** Route [engine] notes: muted for "none"; kept out of capture channels when forwarding unless explicitly requested. */
    #resolveEngineNoteChannel(event: EngineEvent): string | undefined {
        const rule = event.ruleId
            ? this.ruleEngine.rules.find((r) => r.id === event.ruleId)
            : undefined;
        const actionFromDetails = event.details.action as { forwardToChannel?: string } | undefined;
        const notifications =
            rule?.notifications ??
            (event.details.notifications as ConversationRule["notifications"] | undefined);
        const forwardTo =
            rule?.action.forwardToChannel ??
            actionFromDetails?.forwardToChannel ??
            (typeof event.details.forwardToChannel === "string"
                ? event.details.forwardToChannel
                : undefined);

        if (notifications === "none") {
            return undefined;
        }

        if (notifications === "target" || (notifications === undefined && Boolean(forwardTo))) {
            return LIFECYCLE_EVENTS.has(event.type) && forwardTo ? forwardTo : undefined;
        }

        return event.channel;
    }

    /** Stop rule ticks and file watchers idempotently during server shutdown. */
    close(): void {
        this.#closed = true;

        if (this.#tickTimer) {
            clearInterval(this.#tickTimer);
            this.#tickTimer = undefined;
        }

        if (this.#watcherCleaner) {
            this.#watcherCleaner();
            this.#watcherCleaner = undefined;
        }
    }

    #loadRules(): ConversationRule[] {
        return this.#host.loadRules
            ? this.#host.loadRules()
            : loadDefaultRules(this.#host.dataDir, this.#host.workspaceDir);
    }

    #toChannel(
        id: ConversationId,
        meta: Pick<
            DialogueSessionSummary,
            "title" | "createdBy" | "members" | "pip" | "cwd" | "archived"
        >,
    ): Channel {
        const name = (meta.title ?? "").replace(/^#/, "").trim().toLowerCase();

        return {
            id,
            name,
            title: `#${name}`,
            createdBy: meta.createdBy ?? "",
            ...(meta.members === undefined ? {} : { members: meta.members }),
            isGroup: isGroupSession(meta),
            cwd: meta.cwd,
            archived: meta.archived === true,
        };
    }

    #sessionMap(): Record<string, SessionAccessMeta> {
        const map: Record<string, SessionAccessMeta> = {};

        for (const s of this.#host.listSessions()) {
            map[String(s.id)] = {
                title: s.title,
                cwd: s.cwd,
                createdBy: s.createdBy,
                ...(s.channel ? { channel: true as const } : {}),
                archived: s.archived,
                pip: s.pip,
                members: s.members,
            };
        }

        return map;
    }

    #knownUsers(): readonly SessionAccessUser[] {
        if (this.#host.listUsers) {
            return this.#host.listUsers();
        }

        const owner = this.#host.fallbackUser();

        return owner ? [owner] : [];
    }

    /** Check whether a conversation's AI tools may access `targetId` (enforcing group/private boundaries). */
    canConversationAccess(callerId: number | string, targetId: number | string): boolean {
        const sessions = this.#sessionMap();

        return canConversationAccessTarget(
            callerId,
            sessions[String(callerId)],
            targetId,
            sessions[String(targetId)],
            this.#knownUsers(),
            this.#host.isRemovedSession?.(Number(targetId)) ?? false,
        );
    }

    #createChannelManager(): ChannelManager {
        return new ChannelManager(
            {
                list: () =>
                    this.#host
                        .listSessions()
                        .filter((session) => session.channel === true)
                        .map((session) =>
                            this.#toChannel(session.id as unknown as ConversationId, session),
                        ),
                get: (id) => {
                    const meta = this.#host.sessionMeta(id);

                    return meta?.channel === true ? this.#toChannel(id, meta) : undefined;
                },
                create: async (info) => {
                    const user = this.#host.userById(info.createdBy);

                    if (user === undefined) {
                        throw new HttpError(403, "Unknown user");
                    }

                    const created = await this.#host.createChannelSession(user, {
                        title: `#${info.name}`,
                        channel: true,
                        cwd: info.cwd,
                    });

                    return this.#toChannel(created.id, {
                        title: `#${info.name}`,
                        createdBy: info.createdBy,
                        cwd: info.cwd,
                        archived: false,
                    });
                },
            },
            async (target, options) => {
                const callerMeta = this.#host.sessionMeta(options.fromId);
                const actorId = callerMeta?.createdBy ?? this.#host.fallbackUser()?.id;
                const user = actorId ? this.#host.userById(actorId) : undefined;

                if (user === undefined) {
                    throw new HttpError(403, "The posting conversation's person is gone.");
                }

                this.#host.requireSee(user, target.id);
                this.#host.requireSteer(user);

                const sourceTag = options.sourceChannel
                    ? `via #${options.sourceChannel.name}`
                    : `via session ${String(options.fromId)}`;
                const text =
                    options.sourceChannel && !options.message.startsWith("[via ")
                        ? `[via #${options.sourceChannel.name}]\n${options.message}`
                        : options.message;

                await this.#host.submitTurn(
                    target.id,
                    user,
                    { text, requestId: randomUUID() },
                    `channel #${target.name} (${sourceTag})`,
                );
            },
            (fromId, targetNameOrId) => {
                const sessions = this.#sessionMap();
                const users = this.#knownUsers();
                const match = resolveChannelTargetForScope(
                    Number(fromId),
                    sessions[String(fromId)],
                    typeof targetNameOrId === "number" ? targetNameOrId : String(targetNameOrId),
                    sessions,
                    users,
                    normalizeChannelName,
                    this.#host.isRemovedSession,
                    this.#host.fallbackUser()?.id,
                );
                const targetMeta = sessions[String(match.id)];

                return this.#toChannel(match.id as unknown as ConversationId, {
                    ...targetMeta,
                    title: targetMeta?.title ?? `#${match.name}`,
                });
            },
        );
    }

    #createHistorySearch(): HistorySearchEngine {
        return new HistorySearchEngine({
            getSessions: () =>
                this.#host.listSessions().map((session) => ({
                    id: session.id,
                    title: session.title,
                    channel: session.channel,
                    archived: session.archived,
                })),
            getSessionMeta: (id) => {
                const meta = this.#host.sessionMeta(id as unknown as ConversationId);

                if (!meta) {
                    return undefined;
                }

                return {
                    id,
                    title: meta.title,
                    channel: meta.channel,
                    archived: meta.archived,
                };
            },
            readEntries: (id, query, limit) => this.#host.readTranscriptEntries(id, query, limit),
        });
    }

    #createRuleEngine(): ConversationRuleEngine {
        const store = this.#host.ruleStore ?? new FileRuleEngineStore(this.#host.dataDir);
        const rules = this.#loadRules();

        return new ConversationRuleEngine({
            rules,
            store,
            onDispatch: (task) => {
                if (this.#closed) {
                    return;
                }

                this.#host.log(`rule-engine dispatched task: ${task.ruleId} for channel ${task.channel}`);
                void this.handleRuleDispatchedTask(task).catch((err: unknown) => {
                    this.#host.log(`rule-engine task execution error: ${String(err)}`);
                });
            },
            onEvent: (event) => {
                if (this.#closed) {
                    return;
                }

                void this.handleEngineEvent(event).catch((err: unknown) => {
                    this.#host.log(`rule-engine event handling error: ${String(err)}`);
                });
            },
        });
    }

    #createTurnPipeline(): TurnPipeline {
        const pipeline = new TurnPipeline({
            conversationLookup: (convId) => this.#host.conversation(convId),
            standard: this.#host.standardTurnAdapter(),
        });

        pipeline.registry.register("/rule", (ctx) => ({
            reply: this.executeRuleCommand(ctx.rawText),
            prefixTag: "rule",
            authorName: "Rule Engine",
        }));

        return pipeline;
    }

    #startAutomation(): void {
        const tickMs =
            this.#host.tickIntervalMs === undefined
                ? DEFAULT_TICK_INTERVAL_MS
                : this.#host.tickIntervalMs;

        if (tickMs !== null && tickMs > 0) {
            this.#tickTimer = setInterval(() => {
                if (this.#closed) {
                    return;
                }

                void this.ruleEngine.tick().catch((err: unknown) => {
                    this.#host.log(`rule-engine tick error: ${String(err)}`);
                });
            }, tickMs);
            this.#tickTimer.unref();
        }

        if (this.#host.watchFiles !== false) {
            const candidateRulePaths = [
                join(this.#host.workspaceDir, ".dialogue-session", "rules.json"),
                join(this.#host.dataDir, "rules.json"),
            ];

            this.#watcherCleaner = watchRuleFiles(candidateRulePaths, (file) => {
                if (this.#closed) {
                    return;
                }

                try {
                    const res = this.reloadRules();

                    this.#host.log(
                        `rule-engine: hot reloaded ${String(res.count)} rules from ${file}`,
                    );
                } catch (err: unknown) {
                    this.#host.log(
                        `rule-engine: failed to hot reload rules from ${file}: ${String(err)}`,
                    );
                }
            });
        }

        this.ruleEngine.emitEvent({
            timestamp: Date.now(),
            type: "engine_version_changed",
            details: { version: this.#host.build, pid: this.#host.pid },
        });
    }

    #markArchived(archiveFile: string): void {
        try {
            const base = resolve(this.#host.workspaceDir);
            const targetPath = resolve(base, archiveFile);
            const rel = relative(base, targetPath);

            if (rel.startsWith("..") || isAbsolute(rel)) {
                this.#host.log(`rule-engine: refused archive path outside workspace: ${archiveFile}`);

                return;
            }

            appendSummarizedMarker(targetPath);
            this.#host.log(`rule-engine: appended >>>SUMMARIZED<<< to ${targetPath}`);
        } catch (err: unknown) {
            this.#host.log(`rule-engine archive marker error: ${String(err)}`);
        }
    }
}
