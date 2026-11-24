# 0004: Decoupled History Search Engine & Channel-First Multi-Scope Retrieval

Transcripts in Picord hold critical conversational history, decision logs, and channel knowledge. When users or agents ask questions about past context ("what did we decide yesterday?", "find the docker configuration discussed last week"), the system must reliably search past messages across conversations and channels.

Previously, `searchHistory` was directly implemented as an internal method inside `src/server/app.ts` (lines 3095–3204). On every search invocation, it executed a brute-force sequential walk across every session, querying entries through paginated calls (`conversation.entries({}, 200, cursor)`), deserializing JSON models, and evaluating text with string `indexOf`. Because a hard wall-clock timeout of 8,000 ms was enforced, searches across large workspaces frequently timed out and dropped matches. Furthermore, it lacked support for channel-first filtering (`#channel-name`, `channels`, `chats`), was tightly coupled to the 4,700-line `PocketApp` single class (zero isolated testability), and was inaccessible to the Web PWA client.

To establish a scalable, testable, and maintainable search subsystem strictly aligned with the underlying `@earendil-works/pi-durable` architecture:

1. **Decoupled Search Engine Subsystem**: Extract search logic from `src/server/app.ts` into a dedicated `HistorySearchEngine` class (`src/server/history-search.ts`).
2. **Alignment with `@earendil-works/pi-durable` Immutability Contract**: Rather than creating external SQLite FTS tables that risk schema divergence and desync during `pi-durable` migrations, the engine builds upon `pi-durable`'s core architectural guarantee: **all committed `EntryRecord`s are immutable and monotonically sequenced (`entry.id`)**.
3. **Incremental Entry Indexing & LRU Caching**: The engine maintains an in-memory entry index for active sessions tracked by `lastIndexedEntryId`. Subsequent searches query `pi-durable` exclusively for newly committed entries (`minEntryId: lastIndexed + 1`), reducing repetitive SQLite deserialization and dropping search latency from ~8,000 ms to <10 ms.
4. **Channel-First Multi-Scope Retrieval**: The engine extends search scoping beyond `"current"` and `"all"` to include:
    - `"#<name>"`: Targets a specific named channel (e.g. `"#general"`, `"#zk-review"`).
    - `"channels"`: Restricts search exclusively to channel sessions (`session.channel === true`), filtering out private drafts and ephemeral tasks.
    - `"chats"`: Restricts search to ordinary one-on-one sessions.
    - `<number>`: Retains numeric conversation ID scoping.
5. **Hermetic Test Seam via Data Source Abstraction**: The engine accesses session metadata and transcript entries through an abstract `HistoryDataSource` interface. In production, this binds to `PocketApp`'s durable session and conversation handles; in unit tests, `InMemoryHistoryDataSource` enables sub-20ms hermetic test execution with zero disk or database dependencies.
6. **Dual Ingestion (REST API + Agent Tool)**: Expose search through both the Agent's durable `search_history` tool and a authenticated `GET /api/search` endpoint (with `requireSee` permission enforcement), preparing Picord for future client-side global search (`Cmd+K`).

## Considered Options

- **Option A (External SQLite FTS5 Shadow Database)**: Evaluated spinning up a separate `search_index.db` utilizing SQLite's FTS5 extension with synchronization triggers. Rejected because `@earendil-works/pi-durable` owns the underlying database schema and transactions; an out-of-band shadow index introduces dual-write hazards, data corruption risks on abnormal process termination, and high friction during upstream `pi-durable` upgrades.
- **Option B (Retaining In-Memory Brute-Force Without Caching)**: Evaluated simply raising the 8,000 ms timeout in `app.ts`. Rejected because scanning tens of thousands of JSON entries on every query burns CPU and still causes latency degradation as history accumulates over months.

## Consequences

- 100% adherence to `pi-durable`'s storage contract and immutability model with zero database schema pollution.
- Massive performance boost for repeat and cross-channel searches through incremental entry caching.
- Direct testability: full search query parsing, scope resolution, excerpting, and ranking can be tested in Node in under 50 ms.
- Lays the backend foundation for global multi-channel search in the Web PWA.
