# Spec 0008 Tickets — DialogueRuntime Coordinator Seam (Candidate 3)

Spec: [0008-dialogue-runtime-coordinator.md](./0008-dialogue-runtime-coordinator.md)

## Ticket 1
**Implement `DialogueRuntime` deep coordinator module (`channels`, `historySearch`, `ruleEngine`, `turnPipeline`) with TDD tests**
- Blocked by: None
- Scope:
  - Create vertical-slice tests in `test/dialogue-runtime.test.ts` crossing `DialogueRuntime` (Red -> Green).
  - Build `src/server/dialogue-runtime.ts` encapsulating channel normalization & delivery, history search data source, rule engine initialization/ticker/watcher, `/rule` registration & execution, `handleRuleDispatchedTask`, `handleEngineEvent`, and idempotent `close()`.

## Ticket 2
**Wire `PocketApp` (`src/server/app.ts`) to `DialogueRuntime` and remove inline Picord orchestration**
- Blocked by: Ticket 1
- Scope:
  - Replace inline `ChannelManager`, `HistorySearchEngine`, `ConversationRuleEngine`, `TurnPipeline`, `#ruleTickTimer`, `#ruleWatcherCleaner`, and rule orchestration methods in `src/server/app.ts` with `readonly dialogue: DialogueRuntime`.
  - Keep `channels`, `historySearch`, `ruleEngine`, `turnPipeline`, `postToChannel`, and `searchHistory` intact on `PocketApp` for zero caller breakage.
  - Run `npm run check`, `npm run lint`, and all server unit tests.

## Ticket 3
**Two-axis code-review, sandbox parity check, deploy, and archive**
- Blocked by: Ticket 2
- Scope:
  - Parallel Standards & Spec code-review subagents; fix any findings and re-verify.
  - Run `npm run check:sandbox`, push `main`, verify CI green, restart `pi-pocket.service`, close issues, and update `PI-POCKET.md`.
