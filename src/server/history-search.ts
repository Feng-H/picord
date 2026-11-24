/**
 * Decoupled History Search Engine: provides transcript search, channel-first scoping,
 * and incremental in-memory entry caching adhering to pi-durable's immutability model.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { normalizeChannelName } from "./channels.ts";
import { HttpError } from "./errors.ts";

const CONTEXT_BLOCK = "<!-- context: ";

export interface SessionSummary {
    id: number;
    title?: string;
    channel?: boolean;
    archived?: boolean;
}

export interface SearchMatch {
    sessionId: number;
    sessionLabel: string;
    entryId: number;
    role: string;
    when: string;
    excerpt: string;
    raw: string;
}

export interface SearchResult {
    query: string;
    scope: string;
    matches: SearchMatch[];
    sessionsSearched: number;
    entriesWalked: number;
    formatted: string;
}

export interface HistoryDataSource {
    getSessions(): SessionSummary[];
    getSessionMeta(id: number): SessionSummary | undefined;
    readEntries(
        id: number,
        query?: { minEntryId?: number; maxEntryId?: number },
        limit?: number,
    ): Promise<readonly EntryRecord[]>;
}

export interface ParsedEntry {
    id: number;
    role: string;
    when: string;
    text: string;
}

export function entryWords(entry: EntryRecord): ParsedEntry {
    const id = Number(entry.id);
    const said = entry as {
        kind?: string;
        model?: Array<{ role?: string; timestamp?: number; content?: unknown }>;
    };
    const parts: string[] = [];
    let role = said.kind ?? "";
    let when = "";

    for (const message of said.model ?? []) {
        if (message.role !== undefined && !role.startsWith("pi.")) {
            role = message.role;
        }

        if (typeof message.timestamp === "number" && when === "") {
            when = new Date(message.timestamp).toLocaleString("sv");
        }

        const content = message.content;

        if (typeof content === "string") {
            parts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content as Array<{ type?: string; text?: string; name?: string }>) {
                if (
                    part.type === "text" &&
                    typeof part.text === "string" &&
                    !part.text.startsWith(CONTEXT_BLOCK)
                ) {
                    parts.push(part.text);
                } else if (part.type === "toolCall" && typeof part.name === "string") {
                    parts.push(`(${part.name})`);
                }
            }
        }
    }

    return { id, role, when, text: parts.join(" ") };
}

export class HistorySearchEngine {
    readonly #dataSource: HistoryDataSource;
    readonly #cache = new Map<number, { lastIndexedEntryId: number; entries: ParsedEntry[] }>();

    constructor(dataSource: HistoryDataSource) {
        this.#dataSource = dataSource;
    }

    invalidateSession(sessionId: number): void {
        this.#cache.delete(sessionId);
    }

    resolveScope(
        activeSessionId: number,
        scope?: string,
    ): { id: number; label: string; channel?: boolean }[] {
        const asked = (scope ?? "current").trim();
        const lower = asked.toLowerCase();
        const targets: { id: number; label: string; channel?: boolean }[] = [];

        if (lower === "all") {
            for (const session of this.#dataSource.getSessions()) {
                const marks = [session.channel ? "channel" : "", session.archived ? "archived" : ""]
                    .filter(Boolean)
                    .join(", ");

                targets.push({
                    id: session.id,
                    label: `#${session.title ?? "untitled"}${marks === "" ? "" : ` (${marks})`}`,
                    channel: session.channel,
                });
            }

            return targets;
        }

        if (lower === "channels") {
            for (const session of this.#dataSource.getSessions()) {
                if (session.channel) {
                    targets.push({
                        id: session.id,
                        label: `#${session.title} (channel)`,
                        channel: true,
                    });
                }
            }

            return targets;
        }

        if (lower === "chats") {
            for (const session of this.#dataSource.getSessions()) {
                if (!session.channel) {
                    targets.push({
                        id: session.id,
                        label: `#${session.title ?? "chat"}`,
                        channel: false,
                    });
                }
            }

            return targets;
        }

        if (asked.startsWith("#")) {
            const channelName = normalizeChannelName(asked);
            const found = this.#dataSource
                .getSessions()
                .find(
                    (s) =>
                        s.channel &&
                        ((s.title ?? "").toLowerCase() === channelName ||
                            (s.title ?? "").toLowerCase() === `#${channelName}`),
                );

            if (!found) {
                throw new HttpError(404, `Channel "${asked}" not found.`);
            }

            return [
                {
                    id: found.id,
                    label: `#${found.title ?? channelName} (channel)`,
                    channel: true,
                },
            ];
        }

        if (/^\d+$/.test(lower)) {
            const id = Number(lower);
            const meta = this.#dataSource.getSessionMeta(id);

            return [
                {
                    id,
                    label: `#${meta?.title ?? lower}${meta?.channel ? " (channel)" : ""}`,
                    channel: meta?.channel,
                },
            ];
        }

        // Default: "current" or unrecognized string defaults to active session
        const meta = this.#dataSource.getSessionMeta(activeSessionId);

        return [
            {
                id: activeSessionId,
                label: `#${meta?.title ?? "this conversation"}${meta?.channel ? " (channel)" : ""}`,
                channel: meta?.channel,
            },
        ];
    }

    async search(
        activeSessionId: number,
        query: string,
        scope?: string,
        limit?: number,
    ): Promise<SearchResult> {
        const needle = query.trim().toLowerCase();

        if (needle === "") {
            throw new HttpError(400, "Say what to search for.");
        }

        const cap = Math.max(1, Math.min(Math.round(limit ?? 10), 25));
        const effectiveScope = scope ?? "current";
        const targets = this.resolveScope(activeSessionId, effectiveScope);

        let walked = 0;
        const matches: SearchMatch[] = [];

        for (const target of targets) {
            if (matches.length >= cap) {
                break;
            }

            let sessionCache = this.#cache.get(target.id);

            if (!sessionCache) {
                sessionCache = { lastIndexedEntryId: 0, entries: [] };
                this.#cache.set(target.id, sessionCache);
            }

            try {
                // Fetch incremental entries newer than lastIndexedEntryId
                const newEntries = await this.#dataSource.readEntries(target.id, {
                    minEntryId: sessionCache.lastIndexedEntryId + 1,
                });

                if (Array.isArray(newEntries) && newEntries.length > 0) {
                    for (const entry of newEntries) {
                        const parsed = entryWords(entry);

                        sessionCache.entries.push(parsed);

                        if (parsed.id > sessionCache.lastIndexedEntryId) {
                            sessionCache.lastIndexedEntryId = parsed.id;
                        }
                    }
                }
            } catch {
                // If a session cannot be read, skip gracefully
            }

            walked += sessionCache.entries.length;

            for (const entry of sessionCache.entries) {
                const at = entry.text.toLowerCase().indexOf(needle);

                if (at === -1) {
                    continue;
                }

                const from = Math.max(0, at - 90);
                const excerpt = entry.text
                    .slice(from, at + needle.length + 140)
                    .replace(/\s+/g, " ")
                    .trim();

                const raw = `[${target.label} · entry ${entry.id}${entry.when === "" ? "" : ` · ${entry.when}`}] (${entry.role}) ${from > 0 ? "…" : ""}${excerpt}`;

                matches.push({
                    sessionId: target.id,
                    sessionLabel: target.label,
                    entryId: entry.id,
                    role: entry.role,
                    when: entry.when,
                    excerpt,
                    raw,
                });

                if (matches.length >= cap) {
                    break;
                }
            }
        }

        const where =
            targets.length === 1
                ? `this conversation (${targets[0]!.label})`
                : `${targets.length} sessions`;

        let formatted: string;

        if (matches.length === 0) {
            formatted = `No match for ${JSON.stringify(query)} after reading ${walked} entries of ${where}. Try other words, a shorter form, or scope "all".`;
        } else {
            formatted = [
                `${matches.length} match${matches.length === 1 ? "" : "es"} for ${JSON.stringify(query)} (read ${walked} entries of ${where}; entry ids are stable, timestamps are server time):`,
                ...matches.map((m) => m.raw),
            ].join("\n");
        }

        return {
            query,
            scope: effectiveScope,
            matches,
            sessionsSearched: targets.length,
            entriesWalked: walked,
            formatted,
        };
    }
}
