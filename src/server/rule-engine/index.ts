import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Conversation Rule Engine
 *
 * A deterministic server subsystem evaluating declarative triggers (such as Silence Triggers)
 * against channel activity, decoupling automation from probabilistic LLM tool management.
 */

export type EngineEventType =
    | "rule_added"
    | "rule_removed"
    | "rule_modified"
    | "schedule_projected"
    | "rule_fired"
    | "engine_version_changed"
    | "cursor_advanced";

export interface EngineEvent {
    timestamp: number;
    type: EngineEventType;
    ruleId?: string;
    channel?: string;
    details: Record<string, unknown>;
}

export interface PromptRuleAction {
    type: "prompt";
    instruction: string;
    forwardToChannel?: string;
    archiveFile?: string;
    summarizedMarker?: boolean;
}

export type RuleAction = PromptRuleAction;

export interface EntryIdCursor {
    type: "entry_id";
    lastProcessedId?: number;
}

export interface ConversationRule {
    id: string;
    title?: string;
    channel: string;
    on: "silence";
    after: string | number;
    /** Which activity resets the silence timer: "user" (human messages only, default) or "any". */
    actor?: "user" | "any";
    /** Where to inject in-channel [engine] status notes: "source", "target" (default when forwardToChannel is set), or "none". */
    notifications?: "source" | "target" | "none";
    cursor?: EntryIdCursor;
    action: RuleAction;
}

export type ActivityActor = "user" | "system";

export interface RuleRuntimeState {
    lastActivity?: number;
    lastFiredAt?: number;
    cursorEntryId?: number;
    headEntryId?: number;
    lastTaskSubmissionId?: string;
}

export interface DispatchedTask {
    ruleId: string;
    channel: string;
    instruction: string;
    cursorEntryId?: number;
    headEntryId?: number;
    forwardToChannel?: string;
    archiveFile?: string;
    triggeredAt: number;
}

export interface ProjectedSchedule {
    id: string;
    text: string;
    next: number;
    remainingMs: number;
}

/**
 * Parse human duration string (e.g. "30s", "60m", "1h", "2d") into milliseconds.
 */
export function parseDuration(duration: string | number): number {
    if (typeof duration === "number") {
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error("Duration must be positive");
        }

        return Math.floor(duration);
    }

    if (typeof duration !== "string") {
        throw new Error("Invalid duration format");
    }

    const trimmed = duration.trim();

    if (trimmed.startsWith("-")) {
        throw new Error("Duration must be positive");
    }

    const match = /^(\d+)(s|m|h|d)$/.exec(trimmed);

    if (!match) {
        throw new Error(`Invalid duration format: "${duration}". Expected format like "30s", "60m", "1h", "2d".`);
    }

    const amount = Number.parseInt(match[1]!, 10);
    const unit = match[2]!;

    if (amount <= 0) {
        throw new Error("Duration must be positive");
    }

    switch (unit) {
        case "s":
            return amount * 1000;
        case "m":
            return amount * 60 * 1000;
        case "h":
            return amount * 60 * 60 * 1000;
        case "d":
            return amount * 24 * 60 * 60 * 1000;
        default:
            throw new Error(`Unknown duration unit: ${unit}`);
    }
}

/**
 * Format a human-readable >>>SUMMARIZED<<< marker with timestamp.
 */
export function formatSummarizedMarker(date: Date | number = new Date()): string {
    const d = typeof date === "number" ? new Date(date) : date;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");

    return `>>>SUMMARIZED<<< ${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Append human-readable >>>SUMMARIZED<<< marker to a Markdown archive file.
 */
export function appendSummarizedMarker(filePath: string, date: Date | number = new Date()): void {
    const marker = formatSummarizedMarker(date);
    const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";

    writeFileSync(filePath, `${content}${separator}${marker}\n`, "utf8");
}

/**
 * Format system prompt for an injected rule task specifying entry range boundary.
 */
export function formatRulePrompt(
    task: DispatchedTask,
    cursorEntryId = task.cursorEntryId ?? 0,
    headEntryId = task.headEntryId ?? 0,
): string {
    const lines: string[] = [
        `[系统规则触发：${task.ruleId}]`,
        `本轮总结处理范围：SQLite entry_id (${cursorEntryId}, ${headEntryId}]。`,
        "请严格只处理此增量区间内的对话内容。",
        task.instruction,
    ];

    if (task.forwardToChannel) {
        lines.push(`总结成果将自动投递至 #${task.forwardToChannel.replace(/^#/, "")} 频道。`);
    }

    return lines.join("\n");
}

/**
 * Watch rule files on disk (via parent directories so atomic renames and new files still trigger reload).
 */
export function watchRuleFiles(
    paths: string[],
    onReload: (file: string) => void,
): () => void {
    const watchers: FSWatcher[] = [];
    const byDir = new Map<string, string[]>();
    let debounceTimer: NodeJS.Timeout | undefined;

    for (const filePath of paths) {
        const dir = dirname(filePath);
        const list = byDir.get(dir) ?? [];

        list.push(filePath);
        byDir.set(dir, list);
    }

    for (const [dir, filePaths] of byDir) {
        if (!existsSync(dir)) {
            continue;
        }

        const expectedNames = new Set(filePaths.map((p) => basename(p)));

        try {
            const watcher = watch(dir, (_eventType, filename) => {
                const name = filename === null ? undefined : String(filename);

                if (name !== undefined && !expectedNames.has(name)) {
                    return;
                }

                const matchedFile =
                    name !== undefined
                        ? (filePaths.find((p) => basename(p) === name) ?? filePaths[0]!)
                        : filePaths[0]!;

                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    try {
                        onReload(matchedFile);
                    } catch {}
                }, 200);
                debounceTimer.unref();
            });

            watchers.push(watcher);
        } catch {}
    }

    return () => {
        clearTimeout(debounceTimer);

        for (const w of watchers) {
            try {
                w.close();
            } catch {}
        }
    };
}

/**
 * Append an engine event entry to the JSONL engine-events.log file.
 */
export function appendEngineEventLog(filePath: string, event: EngineEvent): void {
    try {
        const dir = dirname(filePath);

        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const record = {
            timestamp: event.timestamp,
            time: new Date(event.timestamp).toISOString(),
            type: event.type,
            ruleId: event.ruleId,
            channel: event.channel,
            details: event.details,
        };

        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {}
}

/**
 * Format an engine event into a concise human-readable system note.
 */
export function formatEngineEventNote(event: EngineEvent): string {
    const channelTag = event.channel ? `[#${event.channel.replace(/^#/, "")}] ` : "";
    const ruleTag = event.ruleId ?? "";

    switch (event.type) {
        case "rule_added": {
            const title = (event.details.title as string) || ruleTag;
            const after = (event.details.after as string) || "";

            return `[engine] 规则 "${title}" 已添加至频道 #${event.channel} (静默 ${after} 触发)`;
        }

        case "rule_removed": {
            const title = (event.details.title as string) || ruleTag;

            return `[engine] 规则 "${title}" 已从频道 #${event.channel} 移除`;
        }

        case "rule_modified": {
            const title = (event.details.title as string) || ruleTag;
            const after = (event.details.after as string) || "";

            return `[engine] 规则 "${title}" 已更新 (静默 ${after} 触发)`;
        }

        case "schedule_projected": {
            const title = (event.details.title as string) || ruleTag;
            const next = typeof event.details.next === "number" ? new Date(event.details.next).toLocaleTimeString("sv") : "";
            const remaining = typeof event.details.remainingMs === "number" ? Math.round(event.details.remainingMs / 60000) : undefined;
            const remStr = remaining !== undefined ? ` (约 ${String(remaining)} 分钟后到期)` : "";

            return `[engine] 倒计时已刷新：${title} 到期时间为 ${next}${remStr}`;
        }

        case "rule_fired": {
            const cursor = event.details.cursorEntryId ?? 0;
            const head = event.details.headEntryId ?? 0;
            const fwd = event.details.forwardToChannel ? ` -> 转发至 #${String(event.details.forwardToChannel).replace(/^#/, "")}` : "";

            return `[engine] 规则 ${ruleTag} 已触发，增量游标 (${String(cursor)}, ${String(head)}]${fwd}`;
        }

        case "cursor_advanced": {
            const newCursor = event.details.newCursorId ?? 0;

            return `[engine] 游标推进：${ruleTag} 游标已推进至 #${String(newCursor)}`;
        }

        case "engine_version_changed": {
            const ver = (event.details.version as string) || "unknown";

            return `[engine] 规则引擎已加载/更新，版本 ${ver}`;
        }

        default:
            return `[engine] ${channelTag}${event.type}: ${ruleTag}`;
    }
}

/**
 * Format active rule status for human consumption (/rule status).
 */
export function formatRuleStatus(engine: ConversationRuleEngine, now = Date.now()): string {
    const rules = engine.rules;

    if (rules.length === 0) {
        return "当前未加载任何对话规则。";
    }

    const sections = rules.map((rule) => {
        const state = engine.getState(rule.id);
        const afterMs = parseDuration(rule.after);
        let countdownStr = "等待初次发言";

        if (state?.lastActivity) {
            const remainingMs = Math.max(0, state.lastActivity + afterMs - now);
            const remainingMin = Math.round(remainingMs / 60000);
            const remainingSec = Math.round(remainingMs / 1000);

            countdownStr =
                remainingMs > 0
                    ? `剩余约 ${remainingMin} 分钟 (${remainingSec} 秒)`
                    : "已到期（待心跳触发）";
        }

        const lastActiveStr = state?.lastActivity
            ? new Date(state.lastActivity).toLocaleTimeString("sv")
            : "无";
        const lastFiredStr = state?.lastFiredAt
            ? new Date(state.lastFiredAt).toLocaleTimeString("sv")
            : "未触发";

        return [
            `- **${rule.title || rule.id}** (\`#${rule.channel}\`):`,
            `  - 倒计时: ${countdownStr}`,
            `  - 增量游标: cursor_entry_id = ${String(state?.cursorEntryId ?? 0)}, head_entry_id = ${String(state?.headEntryId ?? 0)}`,
            `  - 最近发言: ${lastActiveStr} | 最近触发: ${lastFiredStr}`,
            rule.action.forwardToChannel
                ? `  - 跨频道转发: #${rule.action.forwardToChannel.replace(/^#/, "")}`
                : undefined,
        ]
            .filter(Boolean)
            .join("\n");
    });

    const projectedLines: string[] = [];

    for (const rule of rules) {
        const state = engine.getState(rule.id);

        if (state?.lastActivity) {
            const afterMs = parseDuration(rule.after);
            const next = state.lastActivity + afterMs;
            const remainingMs = Math.max(0, next - now);
            const remainingMin = Math.round(remainingMs / 60000);
            const timeStr = new Date(next).toLocaleTimeString("sv");
            const scheduleId = `rule-silence-${rule.id}`;

            projectedLines.push(
                `- **${rule.title || rule.id}** (\`${scheduleId}\`):\n` +
                `  - 规则ID: \`${rule.id}\` | 所属频道: \`#${rule.channel}\`\n` +
                `  - 到点时间: ${timeStr} (剩余约 ${String(remainingMin)} 分钟)\n` +
                `  - 当前状态: ${remainingMs > 0 ? "运行中" : "已到期待触发"}`,
            );
        }
    }

    const projectedBlock = projectedLines.length > 0
        ? `\n\n### ⏱️ 引擎投影定时任务 (Projected Schedules):\n\n${projectedLines.join("\n\n")}`
        : "";

    return `⏱️ **对话规则引擎运行时状态 (${rules.length}条生效)**:\n\n${sections.join("\n\n")}${projectedBlock}`;
}

/**
 * Format loaded rules list (/rule list).
 */
export function formatRuleList(rules: readonly ConversationRule[]): string {
    if (rules.length === 0) {
        return "当前未配置任何规则。";
    }

    const items = rules.map((r) => {
        const target = r.action.forwardToChannel
            ? ` -> 转发至 \`#${r.action.forwardToChannel.replace(/^#/, "")}\``
            : "";

        return `- **${r.title || r.id}** (\`${r.id}\`): 频道 \`#${r.channel}\`, 静默满 \`${r.after}\` 触发${target}`;
    });

    return `📋 **当前生效的对话规则列表 (${rules.length}条)**:\n\n${items.join("\n")}`;
}

export interface RuleEngineStore {
    loadRules?(): Promise<ConversationRule[]> | ConversationRule[];
    getState(ruleId: string): RuleRuntimeState | undefined;
    saveState(ruleId: string, state: RuleRuntimeState): Promise<void> | void;
    deleteState?(ruleId: string): Promise<void> | void;
    pruneStatesExcept?(activeRuleIds: ReadonlySet<string>): Promise<void> | void;
}

export class InMemoryRuleEngineStore implements RuleEngineStore {
    readonly #states = new Map<string, RuleRuntimeState>();

    getState(ruleId: string): RuleRuntimeState | undefined {
        const state = this.#states.get(ruleId);

        return state ? { ...state } : undefined;
    }

    saveState(ruleId: string, state: RuleRuntimeState): void {
        this.#states.set(ruleId, { ...state });
    }

    deleteState(ruleId: string): void {
        this.#states.delete(ruleId);
    }

    pruneStatesExcept(activeRuleIds: ReadonlySet<string>): void {
        for (const key of this.#states.keys()) {
            if (!activeRuleIds.has(key)) {
                this.#states.delete(key);
            }
        }
    }
}

export class FileRuleEngineStore implements RuleEngineStore {
    readonly #file: string;
    #states: Record<string, RuleRuntimeState> = {};

    constructor(dataDirectory: string) {
        this.#file = join(dataDirectory, "rule-states.json");

        try {
            if (existsSync(this.#file)) {
                this.#states = JSON.parse(readFileSync(this.#file, "utf8")) as Record<string, RuleRuntimeState>;
            }
        } catch {
            this.#states = {};
        }
    }

    getState(ruleId: string): RuleRuntimeState | undefined {
        const state = this.#states[ruleId];

        return state ? { ...state } : undefined;
    }

    saveState(ruleId: string, state: RuleRuntimeState): void {
        this.#states[ruleId] = { ...state };
        this.#flush();
    }

    deleteState(ruleId: string): void {
        if (!(ruleId in this.#states)) {
            return;
        }

        delete this.#states[ruleId];
        this.#flush();
    }

    pruneStatesExcept(activeRuleIds: ReadonlySet<string>): void {
        let changed = false;

        for (const key of Object.keys(this.#states)) {
            if (!activeRuleIds.has(key)) {
                delete this.#states[key];
                changed = true;
            }
        }

        if (changed) {
            this.#flush();
        }
    }

    #flush(): void {
        try {
            writeFileSync(this.#file, JSON.stringify(this.#states, null, 2), "utf8");
        } catch {}
    }
}

export function loadDefaultRules(dataDir?: string, projectDir?: string): ConversationRule[] {
    const candidatePaths: string[] = [];

    if (projectDir) {
        candidatePaths.push(join(projectDir, ".dialogue-session", "rules.json"));
    }

    if (dataDir) {
        candidatePaths.push(join(dataDir, "rules.json"));
    }

    for (const file of candidatePaths) {
        if (existsSync(file)) {
            try {
                const parsed = JSON.parse(readFileSync(file, "utf8"));
                const list = Array.isArray(parsed) ? parsed : parsed?.rules;

                if (Array.isArray(list)) {
                    return list as ConversationRule[];
                }
            } catch {}

            return [];
        }
    }

    return [];
}

export interface ConversationRuleEngineOptions {
    rules?: ConversationRule[];
    store?: RuleEngineStore;
    onDispatch?: (task: DispatchedTask) => Promise<void> | void;
    onEvent?: (event: EngineEvent) => Promise<void> | void;
}

export class ConversationRuleEngine {
    #rules: ConversationRule[];
    readonly #store: RuleEngineStore;
    readonly #onDispatch?: (task: DispatchedTask) => Promise<void> | void;
    readonly #onEvent?: (event: EngineEvent) => Promise<void> | void;
    readonly #states = new Map<string, RuleRuntimeState>();

    constructor(options: ConversationRuleEngineOptions = {}) {
        this.#rules = [...(options.rules ?? [])];
        this.#store = options.store ?? new InMemoryRuleEngineStore();
        this.#onDispatch = options.onDispatch;
        this.#onEvent = options.onEvent;

        for (const rule of this.#rules) {
            this.#validateRule(rule);
            const persisted = this.#store.getState(rule.id);

            if (persisted) {
                this.#states.set(rule.id, { ...persisted });
            }
        }

        void this.#store.pruneStatesExcept?.(new Set(this.#rules.map((r) => r.id)));
    }

    /**
     * Emit an engine event to external listeners.
     */
    emitEvent(event: EngineEvent): void {
        if (this.#onEvent) {
            try {
                void this.#onEvent(event);
            } catch {}
        }
    }

    /**
     * Reload rules dynamically without losing active state, timers, or cursors.
     */
    reloadRules(newRules: ConversationRule[]): void {
        for (const rule of newRules) {
            this.#validateRule(rule);
        }

        const oldRules = this.#rules;
        const oldMap = new Map(oldRules.map((r) => [r.id, r]));
        const newMap = new Map(newRules.map((r) => [r.id, r]));

        this.#rules = [...newRules];

        for (const rule of this.#rules) {
            if (!this.#states.has(rule.id)) {
                const persisted = this.#store.getState(rule.id);

                if (persisted) {
                    this.#states.set(rule.id, { ...persisted });
                }
            }
        }

        // 1. rule_added diff
        for (const [id, r] of newMap) {
            if (!oldMap.has(id)) {
                this.emitEvent({
                    timestamp: Date.now(),
                    type: "rule_added",
                    ruleId: id,
                    channel: r.channel,
                    details: {
                        title: r.title,
                        after: r.after,
                        action: r.action,
                        notifications: r.notifications,
                    },
                });
            }
        }

        // 2. rule_removed diff — also cancel projected schedules and clear persisted state
        for (const [id, r] of oldMap) {
            if (!newMap.has(id)) {
                this.#states.delete(id);
                void this.#store.deleteState?.(id);
                this.emitEvent({
                    timestamp: Date.now(),
                    type: "rule_removed",
                    ruleId: id,
                    channel: r.channel,
                    details: {
                        title: r.title,
                        after: r.after,
                        action: r.action,
                        notifications: r.notifications,
                        cancelledScheduleId: `rule-silence-${id}`,
                    },
                });
            }
        }

        // 3. rule_modified diff
        for (const [id, newR] of newMap) {
            const oldR = oldMap.get(id);

            if (oldR && JSON.stringify(oldR) !== JSON.stringify(newR)) {
                this.emitEvent({
                    timestamp: Date.now(),
                    type: "rule_modified",
                    ruleId: id,
                    channel: newR.channel,
                    details: {
                        title: newR.title,
                        after: newR.after,
                        action: newR.action,
                        notifications: newR.notifications,
                        before: oldR,
                        afterRule: newR,
                    },
                });
            }
        }
    }

    #validateRule(rule: ConversationRule): void {
        if (!rule.id || typeof rule.id !== "string") {
            throw new Error("Rule id is required");
        }

        if (!rule.channel || typeof rule.channel !== "string") {
            throw new Error("Rule channel is required");
        }

        if (rule.on !== "silence") {
            throw new Error(`Unsupported trigger type: "${rule.on}". Currently supported: "silence"`);
        }

        parseDuration(rule.after);

        if (!rule.action || rule.action.type !== "prompt" || !rule.action.instruction) {
            throw new Error("Rule action must be a valid prompt action with instruction");
        }
    }

    get rules(): readonly ConversationRule[] {
        return this.#rules;
    }

    getState(ruleId: string): RuleRuntimeState | undefined {
        const memory = this.#states.get(ruleId);

        if (memory) {
            return { ...memory };
        }

        const stored = this.#store.getState(ruleId);

        if (stored) {
            this.#states.set(ruleId, { ...stored });

            return { ...stored };
        }

        return undefined;
    }

    /**
     * Record activity in a channel. By default (`actor: "user"`), only human user messages
     * update `lastActivity` and reset the silence countdown; automated/AI submissions (`"system"`)
     * are ignored unless the rule sets `actor: "any"`.
     */
    touch(
        channel: string,
        timestamp = Date.now(),
        entryId?: number,
        activityActor: ActivityActor = "user",
    ): void {
        const cleanChannel = channel.replace(/^#/, "").toLowerCase();

        for (const rule of this.#rules) {
            const ruleChannel = rule.channel.replace(/^#/, "").toLowerCase();

            if (ruleChannel !== cleanChannel) {
                continue;
            }

            if (activityActor !== "user" && (rule.actor ?? "user") !== "any") {
                continue;
            }

            const current = this.getState(rule.id) ?? {};

            current.lastActivity = timestamp;

            if (entryId !== undefined) {
                const num = Number(entryId);

                if (Number.isFinite(num)) {
                    current.headEntryId = Math.max(current.headEntryId ?? 0, num);
                }
            }

            this.#states.set(rule.id, current);
            this.#store.saveState(rule.id, current);

            const afterMs = parseDuration(rule.after);
            const next = timestamp + afterMs;

            this.emitEvent({
                timestamp,
                type: "schedule_projected",
                ruleId: rule.id,
                channel: rule.channel,
                details: {
                    title: rule.title || rule.id,
                    next,
                    remainingMs: afterMs,
                    scheduleId: `rule-silence-${rule.id}`,
                },
            });
        }
    }

    /**
     * Advance the processed cursor entry ID monotonically.
     * Rejects backwards or equal movements to guarantee strictly increasing progression.
     */
    advanceCursor(ruleId: string, newCursorId: number): boolean {
        const current = this.getState(ruleId) ?? {};
        const prev = current.cursorEntryId ?? 0;

        if (newCursorId > prev) {
            current.cursorEntryId = newCursorId;
            this.#states.set(ruleId, current);
            this.#store.saveState(ruleId, current);

            const rule = this.#rules.find((r) => r.id === ruleId);

            this.emitEvent({
                timestamp: Date.now(),
                type: "cursor_advanced",
                ruleId,
                channel: rule?.channel,
                details: { prevCursorId: prev, newCursorId },
            });

            return true;
        }

        return false;
    }

    /**
     * Evaluate active rules against the heartbeat clock.
     * Evaluates: (now - lastActivity >= afterMs) && (lastFiredAt < lastActivity)
     */
    async tick(now = Date.now()): Promise<DispatchedTask[]> {
        const dispatched: DispatchedTask[] = [];

        for (const rule of this.#rules) {
            const state = this.getState(rule.id);

            if (!state || state.lastActivity === undefined) {
                continue;
            }

            const afterMs = parseDuration(rule.after);
            const silenceElapsed = now - state.lastActivity;
            const notYetFiredForThisActivity =
                state.lastFiredAt === undefined || state.lastFiredAt < state.lastActivity;

            if (silenceElapsed >= afterMs && notYetFiredForThisActivity) {
                state.lastFiredAt = now;
                this.#states.set(rule.id, state);
                await this.#store.saveState(rule.id, state);

                const task: DispatchedTask = {
                    ruleId: rule.id,
                    channel: rule.channel,
                    instruction: rule.action.instruction,
                    cursorEntryId: state.cursorEntryId,
                    headEntryId: state.headEntryId,
                    forwardToChannel: rule.action.forwardToChannel,
                    archiveFile: rule.action.archiveFile,
                    triggeredAt: now,
                };

                dispatched.push(task);

                this.emitEvent({
                    timestamp: now,
                    type: "rule_fired",
                    ruleId: rule.id,
                    channel: rule.channel,
                    details: {
                        cursorEntryId: state.cursorEntryId,
                        headEntryId: state.headEntryId,
                        forwardToChannel: rule.action.forwardToChannel,
                        archiveFile: rule.action.archiveFile,
                        instruction: rule.action.instruction,
                    },
                });

                if (this.#onDispatch) {
                    await this.#onDispatch(task);
                }
            }
        }

        return dispatched;
    }

    /**
     * Project active silence triggers for a specific session ID or channel name.
     * Matches either rule.channel === channelName (case-insensitive) OR rule.channel === String(sessionId).
     */
    activeSchedulesForSession(
        sessionId: number | string,
        channelName?: string,
        now = Date.now(),
    ): Array<{
        id: string;
        version: string;
        text: string;
        next: number;
        createdAt: number;
        isRule: boolean;
    }> {
        const cleanChannel = channelName?.replace(/^#/, "").toLowerCase();
        const strId = String(sessionId);
        const results: Array<{
            id: string;
            version: string;
            text: string;
            next: number;
            createdAt: number;
            isRule: boolean;
        }> = [];

        for (const rule of this.#rules) {
            const ruleTarget = rule.channel.replace(/^#/, "").toLowerCase();
            const matchesChannel = cleanChannel !== undefined && ruleTarget === cleanChannel;
            const matchesId = rule.channel === strId;

            if (!matchesChannel && !matchesId) {
                continue;
            }

            const state = this.getState(rule.id);

            if (!state || state.lastActivity === undefined) {
                continue;
            }

            const notYetFired =
                state.lastFiredAt === undefined || state.lastFiredAt < state.lastActivity;

            if (!notYetFired) {
                continue;
            }

            const afterMs = parseDuration(rule.after);
            const next = state.lastActivity + afterMs;

            results.push({
                id: `rule:${rule.id}`,
                version: "1",
                text: rule.title || rule.id,
                next,
                createdAt: state.lastActivity,
                isRule: true,
            });
        }

        return results;
    }

    /**
     * Project active silence triggers into the format consumed by the client SchedulesPill.
     */
    activeSchedules(channel: string, now = Date.now()): ProjectedSchedule[] {
        const cleanChannel = channel.replace(/^#/, "").toLowerCase();
        const results: ProjectedSchedule[] = [];

        for (const rule of this.#rules) {
            const ruleChannel = rule.channel.replace(/^#/, "").toLowerCase();

            if (ruleChannel !== cleanChannel) {
                continue;
            }

            const state = this.getState(rule.id);

            if (!state || state.lastActivity === undefined) {
                continue;
            }

            // Only show active countdown if it has not yet fired for the current silence window
            const notYetFired =
                state.lastFiredAt === undefined || state.lastFiredAt < state.lastActivity;

            if (!notYetFired) {
                continue;
            }

            const afterMs = parseDuration(rule.after);
            const next = state.lastActivity + afterMs;

            results.push({
                id: `rule:${rule.id}`,
                text: rule.title || rule.id,
                next,
                remainingMs: Math.max(0, next - now),
            });
        }

        return results;
    }
}
