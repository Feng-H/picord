import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * Conversation Rule Engine
 *
 * A deterministic server subsystem evaluating declarative triggers (such as Silence Triggers)
 * against channel activity, decoupling automation from probabilistic LLM tool management.
 */

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
    cursor?: EntryIdCursor;
    action: RuleAction;
}

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
 * Watch rule files on disk and trigger reload when modified.
 */
export function watchRuleFiles(
    paths: string[],
    onReload: (file: string) => void,
): () => void {
    const watchers: FSWatcher[] = [];
    let debounceTimer: NodeJS.Timeout | undefined;

    for (const filePath of paths) {
        if (existsSync(filePath)) {
            try {
                const watcher = watch(filePath, () => {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        try {
                            onReload(filePath);
                        } catch {}
                    }, 200);
                    debounceTimer.unref();
                });

                watchers.push(watcher);
            } catch {}
        }
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

    return `⏱️ **对话规则引擎运行时状态 (${rules.length}条生效)**:\n\n${sections.join("\n\n")}`;
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
                const list = Array.isArray(parsed) ? parsed : parsed.rules;

                if (Array.isArray(list) && list.length > 0) {
                    return list as ConversationRule[];
                }
            } catch {}
        }
    }

    // Default built-in rule for smalltalk channel
    return [
        {
            id: "smalltalk-card-summary",
            title: "卡片整理倒计时",
            channel: "smalltalk",
            on: "silence",
            after: "60m",
            cursor: { type: "entry_id" },
            action: {
                type: "prompt",
                instruction: "读取增量对话并整理为卢曼卡片推送至 #zk-review",
                forwardToChannel: "zk-review",
                archiveFile: ".dialogue-session/viewpoints.md",
            },
        },
    ];
}

export interface ConversationRuleEngineOptions {
    rules?: ConversationRule[];
    store?: RuleEngineStore;
    onDispatch?: (task: DispatchedTask) => Promise<void> | void;
}

export class ConversationRuleEngine {
    #rules: ConversationRule[];
    readonly #store: RuleEngineStore;
    readonly #onDispatch?: (task: DispatchedTask) => Promise<void> | void;
    readonly #states = new Map<string, RuleRuntimeState>();

    constructor(options: ConversationRuleEngineOptions = {}) {
        this.#rules = [...(options.rules ?? [])];
        this.#store = options.store ?? new InMemoryRuleEngineStore();
        this.#onDispatch = options.onDispatch;

        for (const rule of this.#rules) {
            this.#validateRule(rule);
            const persisted = this.#store.getState(rule.id);

            if (persisted) {
                this.#states.set(rule.id, { ...persisted });
            }
        }
    }

    /**
     * Reload rules dynamically without losing active state, timers, or cursors.
     */
    reloadRules(newRules: ConversationRule[]): void {
        for (const rule of newRules) {
            this.#validateRule(rule);
        }

        this.#rules = [...newRules];

        for (const rule of this.#rules) {
            if (!this.#states.has(rule.id)) {
                const persisted = this.#store.getState(rule.id);

                if (persisted) {
                    this.#states.set(rule.id, { ...persisted });
                }
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
     * Record activity in a channel. User messages immediately update `lastActivity`.
     * Zero-LLM involvement, completely atomic.
     */
    touch(channel: string, timestamp = Date.now(), entryId?: number): void {
        const cleanChannel = channel.replace(/^#/, "").toLowerCase();

        for (const rule of this.#rules) {
            const ruleChannel = rule.channel.replace(/^#/, "").toLowerCase();

            if (ruleChannel === cleanChannel) {
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
            }
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
