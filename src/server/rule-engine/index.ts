import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
}

export interface DispatchedTask {
    ruleId: string;
    channel: string;
    instruction: string;
    cursorEntryId?: number;
    forwardToChannel?: string;
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
    readonly #rules: ConversationRule[];
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
                    // Update entry anchor if needed
                }

                this.#states.set(rule.id, current);
                this.#store.saveState(rule.id, current);
            }
        }
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
                    forwardToChannel: rule.action.forwardToChannel,
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
