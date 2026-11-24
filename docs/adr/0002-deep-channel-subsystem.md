# 0002: Deep Channel Subsystem & Message Routing

Channels were initially prototyped by tagging standard sessions with `channel: true`. As features expanded (name normalization, `#` mention autocompletion, cross-channel agent delivery via `channel_post`), channel logic scattered across six disparate files and leaked directly into the 4,600-line `PocketApp` monolith, preventing isolated unit testing and clear boundary enforcement.

To establish clean architectural leverage for Discord-style multi-channel interactions:

1. **Encapsulated Deep Module**: We introduce a dedicated `ChannelManager` subsystem in `src/server/channels.ts`. All channel operations (resolution, uniqueness checks, lifecycle, and delivery) pass through this single seam.
2. **Encapsulated Storage Reuse**: Under the hood, `ChannelManager` continues to persist channels using Pi Durable SQLite sessions, preserving atomic commits and restart durability while hiding session implementation details from callers.
3. **Strict Normalized Identifiers**: Channel names are normalized without `#`, lowercased, and restricted to `[a-z0-9_-]`. Names are globally unique; duplicate creation is rejected.
4. **Fail-Fast Cross-Channel Delivery**: The `channel_post` routing engine strictly verifies target channel existence. If a channel does not exist or is archived, the call immediately throws an explicit error rather than attempting fuzzy matching or silent failure.
5. **Attribution & Origin Preservation**: Dispatched messages inherit the originating conversation owner's user identity and append a verifiable origin tag (`via #source-channel`), enabling destination agents to understand context and dispatch reciprocal receipts.

## Considered Options

- **Option A (Separate Database Tables for Channels)**: Rejected because it breaks compatibility with Pi Durable transactional logs and requires complex data migration without providing extra behavioral leverage.
- **Option B (Fuzzy Match Target on Post)**: Rejected because fuzzy substring matching introduces non-deterministic delivery and potential message leaks between similar channel names.

## Consequences

- All channel business rules concentrate in a single module, eliminating leakage into UI stores and server monoliths.
- Channels can be unit-tested in pure Node.js in milliseconds using lightweight in-memory storage stubs.
- Future channel capabilities (such as categories, read-only permissions, and bot assignments) can be added cleanly at this seam.
