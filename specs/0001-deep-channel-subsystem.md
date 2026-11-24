# Spec: Deep Channel Subsystem & Cross-Channel Routing

- **Status**: Proposed
- **Context**: Picord
- **Domain Terms**: [GLOSSARY.md](../GLOSSARY.md)
- **ADR Reference**: [docs/adr/0002-deep-channel-subsystem.md](../docs/adr/0002-deep-channel-subsystem.md)

## Problem Statement

Channels in Picord are currently implemented as a shallow boolean tag (`channel: true`) on generic sessions. Naming normalization, deduplication, autocompletion, and cross-channel agent delivery (`channel_post`) are fragmented across six disparate files and buried within the 4,600-line `PocketApp` server monolith.

Because channel logic is not encapsulated in a deep module, the storage mechanism leaks directly to the frontend views, channels cannot be unit-tested without booting the full server and database harness, and future capabilities (such as channel categories, permissions, and archiving) risk introducing subtle regression bugs.

## Solution

Introduce a dedicated, deep `ChannelManager` subsystem at a clean seam. The manager encapsulates all channel domain behavior: identifier normalization, uniqueness enforcement, channel resolution, and fail-fast cross-channel post delivery. Under the hood, it reuses Pi Durable SQLite session persistence via an in-memory substitutable storage adapter. The frontend UI consumes a clean `store.channels` derived store instead of inspecting raw session properties.

## User Stories

1. As a Picord user, I want to create a channel by specifying a name (e.g. `smalltalk`), so that I have a dedicated space for thinking and collaborating with my agent.
2. As a Picord user, I want channel names to be unique and case-insensitive, so that I don't accidentally create duplicate `#general` and `#General` channels.
3. As a Picord user, I want channel names to follow a strict character format (`[a-z0-9_-]`), so that URLs, command lines, and mention parsers can reference them deterministically.
4. As a Picord user, I want to type `#` in the message composer, so that I see a clean autocompletion popup of all active channels.
5. As a Picord user, I want selecting a `#channel` mention to attach that channel's identity context, so that my agent can inspect the mentioned channel's transcripts with `session_read` when needed.
6. As an agent in `#smalltalk`, I want to call `channel_post` to deliver conclusions directly into `#zk-review`, so that downstream tasks are handed off autonomously.
7. As an agent receiving a `channel_post`, I want the message to clearly state its source (`[via #smalltalk]`), so that I know where the work came from and can reply with reciprocal receipts.
8. As an agent calling `channel_post` with a non-existent or archived target, I want the system to fail fast with an explicit error, so that I can correct my reasoning instead of messages being silently lost or misdelivered.
9. As an existing Picord user upgrading to this version, I want all my existing channels, transcripts, and Luhmann cards to continue working seamlessly without manual data migration.
10. As an engineer maintaining Picord, I want to test channel creation, duplicate rejection, and cross-channel message routing in milliseconds using pure in-memory stubs without starting the full HTTP and database harness.

## Implementation Decisions

- **Dedicated Deep Module**: Create `ChannelManager` in `src/server/channels.ts`. It manages the lifecycle and operations of all channels.
- **Encapsulated Storage Adapter**: `ChannelManager` delegates persistence to a minimal `ChannelStore` interface. In production, this adapter interfaces with Pi Durable SQLite session records. In unit tests, an in-memory Map adapter is used.
- **Strict Identifier Normalization**: Channel identifiers are stripped of `#`, converted to lowercase, and trimmed. Valid characters are limited to `[a-z0-9_-]`. Display titles prepend `#`.
- **Fail-Fast Delivery**: `channel_post` strictly validates destination channels. If the channel does not exist or is archived, it throws an `HttpError(404)` with an explicit explanation.
- **Preserved Attribution & Origin**: Cross-channel posts are submitted on behalf of the originating conversation's user and are tagged with `via #<source-channel>` in the submission label and message metadata.
- **Client Channel Seam**: `web/store.js` computes a dedicated `store.channels` derived store. The composer (`web/composer.js`) and sidebar (`web/sessions.js`) consume this collection directly instead of filtering generic sessions.

## Testing Decisions

- **Behavior-Driven Testing**: Tests exercise the external interface of `ChannelManager` (`list`, `get`, `create`, `post`), never internal session flags or SQLite row representations.
- **Fast In-Memory Seam**: A dedicated unit test suite (`test/channels.test.ts`) tests all validation, uniqueness, and cross-posting behaviors using an in-memory storage adapter, executing in under 20ms.
- **End-to-End Regression Test**: An integration test verifies that `channel_post` tool invocations correctly route messages between channels in the full server environment.

## Out of Scope

- Multi-tenant channel access control lists (ACLs) or private invite-only channels.
- Discord voice channel streaming (Picord handles text/audio dictation via Web Speech API).
- Channel category nesting and collapsible header folders.

## Further Notes

- Fully adheres to [GLOSSARY.md](../GLOSSARY.md) vocabulary.
- Implements architectural choices defined in [docs/adr/0002-deep-channel-subsystem.md](../docs/adr/0002-deep-channel-subsystem.md).
