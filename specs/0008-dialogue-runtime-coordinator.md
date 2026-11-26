# Spec 0008: DialogueRuntime Coordinator Seam (Candidate 3)

- **Status**: Ready for Implementation
- **ADR Reference**: [docs/adr/0002-deep-channel-subsystem.md](../docs/adr/0002-deep-channel-subsystem.md), [docs/adr/0007-declarative-conversation-rule-engine.md](../docs/adr/0007-declarative-conversation-rule-engine.md), [docs/adr/0008-turn-pipeline-deep-module.md](../docs/adr/0008-turn-pipeline-deep-module.md)
- **Preceded By**: [specs/0007-complete-turn-pipeline-seam.md](./0007-complete-turn-pipeline-seam.md)

## Problem Statement
`src/server/app.ts` (`PocketApp`, ~4900 lines) currently holds ~400 lines of inline Picord domain orchestration: building `ChannelManager` and channel normalization/delivery callbacks, wiring `HistorySearchEngine`, initializing `ConversationRuleEngine` with a 60-second tick interval and file watcher (`watchRuleFiles`), registering `/rule` on `TurnPipeline`, executing `handleRuleDispatchedTask` (cursor advancement, cross-channel summary forwarding, markdown archive `>>>SUMMARIZED<<<` marker), executing `/rule` commands, logging & injecting `[engine]` notes on engine events, and cleaning up timers/watchers on `close()`. Keeping this boilerplate inline inside `PocketApp` blocks unit testing of rule dispatch/delivery without booting a full server and creates heavy merge conflict surface in `app.ts` when syncing `upstream/main` (`0.30.1` + `pi-durable 1.6.0`).

## Solution
Extract all Picord dialogue subsystem coordination into a single deep module **`DialogueRuntime`** (`src/server/dialogue-runtime.ts`) backed by a narrow `DialogueRuntimeHost` port. `PocketApp` constructs `DialogueRuntime` once with ~40 lines of host bindings, exposes its public `channels`, `historySearch`, `ruleEngine`, and `turnPipeline` surfaces without changing downstream callers (`Commands`, `Room`, extensions, tests), and delegates `close()` directly. All inline rule/channel/watcher orchestration methods and fields (`#ruleTickTimer`, `#ruleWatcherCleaner`, `handleRuleDispatchedTask`, `executeRuleCommand`, `reloadRules`, `handleEngineEvent`) leave `app.ts`.

## User Stories
1. As a maintainer merging upstream `0.30.1` and `pi-durable 1.6.x`, I want `PocketApp` (`src/server/app.ts`) to isolate Picord's channel, rule-engine, history-search, and turn-pipeline orchestration behind a single coordinator boundary so upstream changes to `PocketApp` merge cleanly.
2. As an operator relying on silence triggers, hot-reloaded `rules.json`, channel summary forwarding, and `/rule` commands, I want `DialogueRuntime` to preserve 100% behavioral parity and stop timers/watchers cleanly on shutdown without late async callbacks mutating closed state.
3. As a developer, I want cross-channel delivery, `/rule` execution, rule-task dispatch, engine event note injection, and shutdown cleanup tested directly against `DialogueRuntime` with lightweight fakes rather than requiring a full HTTP/SQLite `PocketApp`.

## Implementation Decisions
- `DialogueRuntime` (`src/server/dialogue-runtime.ts`) owns `channels` (`ChannelManager`), `historySearch` (`HistorySearchEngine`), `ruleEngine` (`ConversationRuleEngine`), `turnPipeline` (`TurnPipeline`), the periodic tick timer, and the rule file watcher.
- Host side-effects (`sessions`, `sessionMeta`, `createChannelSession`, `userById`, `requireSee`, `requireSteer`, `conversation`, `submitTurn`, `entriesAfter`, `visibleEntry`, `standardTurnAdapter`, `log`, `dataDir`, `workspaceDir`) cross through a narrow `DialogueRuntimeHost` interface.
- `DialogueRuntime` guards against post-close execution (`#closed`) in tick, file-watcher, task-dispatch, and event callbacks, and exposes `close()` to dispose timer and watcher resources idempotently.
- `PocketApp` keeps `readonly channels`, `readonly historySearch`, `readonly ruleEngine`, and `readonly turnPipeline` pointing to `this.dialogue`'s instances so zero downstream callers (`commands.ts`, `room.ts`, tests) require churn.

## Testing Decisions
- **Agreed Seam**: `DialogueRuntime` (`src/server/dialogue-runtime.ts`) constructed directly with an in-memory `DialogueRuntimeHost` fake and temp directory.
- Verify:
  1. `/rule list`, `/rule status`, `/rule reload`, and `/rule` help executed end-to-end through `dialogue.turnPipeline.submit(...)` write `NOTE_ENTRY` results.
  2. Cross-channel posting enforces `requireSee`/`requireSteer`, prepends `[via #source]`, and delegates through `host.submitTurn`.
  3. `handleRuleDispatchedTask` advances cursor monotonically on non-unanswered settlement, forwards non-empty summary to `forwardToChannel`, appends `>>>SUMMARIZED<<<` to `archiveFile`, and skips empty entry ranges or `status === "unanswered"`.
  4. `handleEngineEvent` appends JSONL logs and writes `[engine]` `NOTE_ENTRY` into matching active channels.
  5. `close()` clears tick timer + watcher and prevents subsequent timer/task/event mutations.
- All existing Picord suites (`channels`, `history-search`, `rule-engine*`, `turn-pipeline-*`, `quote-provenance`, `voice`) + `npm run check`, `npm run lint`, and `npm run check:sandbox` must pass.

## Out of Scope
- `Candidate 4` (`session-cleanup` / `artifacts` / `PendingApprovals` upstream parity alignment) and `Candidate 2` (`web/composer.js` refactoring) — handled sequentially after `Candidate 3`.
