# Spec 0007 Tickets — Complete TurnPipeline Seam (Candidate 1)

Parent issue: [#11](https://github.com/Feng-H/picord/issues/11)  
Spec: [0007-complete-turn-pipeline-seam.md](./0007-complete-turn-pipeline-seam.md)

## Ticket 1 — [#12](https://github.com/Feng-H/picord/issues/12)
**Route all standard turns through TurnPipeline.submit() with MediaProcessor and context enrichment (wire real seam & delete duplicate Commands loops)**
- Blocked by: None
- Design & TDD:
  - Replace the half-wired `#standardDispatcher` pass-through in `TurnPipeline` (`src/server/turn-pipeline/pipeline.ts`) with narrow injected adapters for access/spend checks, prompt/skill expansion & hidden-value masking, `MediaProcessor` multimodal ingestion (with ADR-0008 `[warning: audio transcription unavailable for ...]` + `[image processing failed, kept original file]` graceful degradation and `warning` notices), quote provenance / `#channel` / inline-file `<pocket-context>` enrichment, durable admission/interrupt dispatch, and post-commit activity/rule/event hooks.
  - Wire `PocketApp.turnPipeline` (`src/server/app.ts`) and make `Commands.submit()` (`src/server/commands.ts`) delegate unconditionally to `app.turnPipeline.submit()`, deleting `#heardAudio` and duplicate inline image/STT loops from `commands.ts`.
  - Add vertical-slice TDD tests in `test/turn-pipeline-core.test.ts` crossing `TurnPipeline.submit()` directly (replace, don't layer).

## Ticket 2 — [#13](https://github.com/Feng-H/picord/issues/13)
**Enforce multi-user SteeringPolicy for steer and interrupt with live activeTurnAuthorId lookup and notice**
- Blocked by: [#12](https://github.com/Feng-H/picord/issues/12)
- Design & TDD:
  - Extend `SteeringPolicy` (`src/server/turn-pipeline/steering.ts`) so `mode: "interrupt"` follows the same multi-user permission rule as `steer` and `/steer`: only `role === "owner"` or `actor.id === activeTurnAuthorId` may steer or interrupt.
  - Unauthorized `steer` or `interrupt` against another user's active turn demotes to `followUp` (`allowInterrupt: false`), skips `#interrupt`, and emits a user notice.
  - Wire live `activeTurnAuthorId` lookup from `LiveDoc` (`run.inputs[0]` -> submission -> `requestPerson`) into the `TurnPipeline` host adapter.
  - Cover all cases in `test/turn-pipeline-steering.test.ts` and `test/turn-pipeline-core.test.ts`.

## Ticket 3 — [#14](https://github.com/Feng-H/picord/issues/14)
**Two-axis code-review and production parity verification for TurnPipeline seam**
- Blocked by: [#12](https://github.com/Feng-H/picord/issues/12), [#13](https://github.com/Feng-H/picord/issues/13)
- Verification & Deploy:
  - Run `npx eslint --fix`, `npm run check`, `npm run lint`, all relevant `node --test` suites (`turn-pipeline-*`, `channels*`, `rule-engine*`, `quote*`, `stt*`, `voice*`), and `npm run check:sandbox` (InstaBox).
  - Run parallel two-axis `code-review` subagents (Standards & Design vs `GLOSSARY.md`/`AGENTS.md` + Spec Conformance vs Spec 0007); resolve any issues.
  - Push `main`, watch GitHub Actions CI green, restart `pi-pocket.service`, close issues `#11`–`#14`, and update `PI-POCKET.md`.
