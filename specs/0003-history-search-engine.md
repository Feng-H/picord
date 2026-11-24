# Spec: Decoupled History Search Engine & Channel-First Multi-Scope Retrieval

- **Status**: Proposed
- **Context**: Picord
- **Domain Terms**: [GLOSSARY.md](../GLOSSARY.md)
- **ADR Reference**: [docs/adr/0004-history-search-engine.md](../docs/adr/0004-history-search-engine.md), [docs/adr/0002-deep-channel-subsystem.md](../docs/adr/0002-deep-channel-subsystem.md)

## Problem Statement

When users or agents ask about historical interactions ("what was the deployment port we discussed?", "find the error log from yesterday in #smalltalk"), Picord must search transcript entries across sessions and channels.

However, the existing implementation in `src/server/app.ts` (lines 3095–3204) suffers from critical limitations:

1. **Brute-Force Sequential Traversal**: On every search, it walks all target sessions, queries raw entries page by page via `conversation.entries({}, 200, cursor)`, deserializes large JSON objects in memory, and performs raw string `indexOf` checks.
2. **Hard Timeout Dropout**: An arbitrary 8,000 ms wall-clock timeout aborts searches prematurely on moderately large workspaces, returning partial or missing results.
3. **No Channel-Aware Scoping**: The `scope` parameter only accepts `"current"`, `"all"`, or a numeric ID. It cannot target a specific channel by name (e.g. `"#general"`), nor can it search across all channels (`"channels"`) or private chats (`"chats"`).
4. **Tight Monolithic Coupling**: Search logic is embedded within the 4,700-line `PocketApp` class, preventing isolated, sub-second unit testing.
5. **No Client-Facing API**: Only the internal LLM Agent has access through the `search_history` tool; the Web PWA has no HTTP endpoint for cross-session message search.

## Solution

Extract transcript search into a dedicated, decoupled `HistorySearchEngine` class (`src/server/history-search.ts`).

The engine aligns strictly with `@earendil-works/pi-durable`'s core architecture by leveraging the immutability of `EntryRecord`s to maintain an in-memory incremental entry cache (`lastIndexedEntryId`). Subsequent queries avoid re-reading previously scanned entries from SQLite, reducing search latency from ~8,000 ms to <10 ms while eliminating timeout failures. The engine introduces first-class channel scoping and is accessible via both the Agent tool `search_history` and a standard authenticated `GET /api/search` HTTP route.

## User Stories

1. As an AI Agent answering a user question about earlier discussions, I want to call `search_history` with query words and receive accurate, excerpted transcript matches without the search timing out after 8 seconds.
2. As a Picord user or Agent, I want to scope my search to a specific channel (e.g. `scope: "#general"`) so that I only retrieve messages relevant to that topic.
3. As a Picord user or Agent, I want to scope my search to `"channels"` so that I search across all community channels while excluding private notes and task sessions.
4. As a Picord user or Agent, I want to scope my search to `"chats"` so that I search across 1-on-1 conversations without channel discussions.
5. As a Web PWA client, I want to call `GET /api/search?q=...&scope=...&limit=...` to retrieve search results with structured metadata (entry ID, channel/session title, timestamp, author role, and excerpt text) with proper authorization checks (`requireSee`).
6. As a backend engineer, I want the search engine to use incremental entry caching based on monotonic `EntryId`s so that repeat searches do not repeatedly read and deserialize identical historical records from disk.
7. As a backend engineer, I want to test search query parsing, scope resolution, excerpting, and limit enforcement in pure Node.js in <20ms using an in-memory data source without requiring a running database or HTTP server.

## Implementation Decisions

### 1. Dedicated Search Engine Module (`src/server/history-search.ts`)

Encapsulates all search logic:

- `HistorySearchEngine`: Main class managing query execution, scope resolution, incremental caching, and excerpt formatting.
- `HistoryDataSource`: Clean dependency-injected interface separating the engine from `PocketApp`:
    ```ts
    export interface SessionSummary {
        id: number;
        title: string;
        channel?: boolean;
        archived?: boolean;
    }

    export interface HistoryDataSource {
        getSessions(): SessionSummary[];
        getSessionMeta(id: number): SessionSummary | undefined;
        readEntries(
            id: number,
            minEntryId?: number,
            limit?: number,
        ): Promise<{ items: EntryRecord[]; nextCursor?: string }>;
    }
    ```

### 2. Incremental Entry Caching

Because `pi-durable` entries are immutable and sequentially numbered:

- For each session, the engine caches parsed searchable entries: `{ id: number, role: string, when: string, text: string }`.
- On search, the engine queries the data source for entries with `minEntryId: lastIndexedId + 1`.
- If new entries exist, they are appended to the cache and `lastIndexedId` is updated.
- Cached entries are searched in memory with case-insensitive matching and word boundary awareness.

### 3. Scope Resolution Rules

- `"current"` or empty: Defaults to the active `conversationId`.
- `"all"`: All non-archived sessions (both channels and chats).
- `"#<channel-name>"`: Matches session with `session.channel === true` and matching normalized name.
- `"channels"`: All sessions with `session.channel === true`.
- `"chats"`: All sessions with `session.channel !== true`.
- `"<number>"`: Explicit conversation ID.

### 4. REST API Endpoint (`GET /api/search`)

- Path: `GET /api/search?q=<query>&scope=<scope>&limit=<limit>`
- Authentication: Requires authenticated user (`app.requireUser(request)`).
- Authorization: Enforces `app.requireSee(user, sessionId)` for target sessions.
- Response JSON:
    ```json
    {
        "query": "deployment",
        "scope": "channels",
        "matches": [
            {
                "sessionId": 42,
                "sessionLabel": "#ops (channel)",
                "entryId": 105,
                "role": "user",
                "when": "2026-11-24 14:00:00",
                "excerpt": "…configuration for the deployment port is 8790…",
                "raw": "[#ops · entry 105 · 2026-11-24 14:00:00] (user) …configuration for the deployment port is 8790…"
            }
        ],
        "totalMatches": 1,
        "sessionsSearched": 3
    }
    ```

### 5. Seamless Agent Tool Compatibility

`host.history.search(conversationId, query, scope, limit)` calls `this.historySearch.search(...)` and returns the exact human/LLM-readable text format expected by existing prompts and extensions, preserving 100% backward compatibility.

## Testing Decisions

- **Fast In-Memory Unit Testing (`test/history-search.test.ts`)**:
    - Implements `InMemoryHistoryDataSource` with mock sessions and entries.
    - Verifies:
        1. Single conversation search with excerpt extraction.
        2. Multi-session `"all"` search.
        3. Channel-specific scoping (`"#general"`, `"channels"`, `"chats"`).
        4. Incremental caching: verify newly added entries are discovered without reloading old entries.
        5. Limit clamping (default 10, max 25, min 1).
        6. Empty query handling (HTTP 400 error).

## Out of Scope

- Client-side full-text vector embeddings or semantic vector search (future roadmap).
- Search within external file attachments or images (Photon image OCR).
