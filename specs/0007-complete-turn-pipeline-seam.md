# Spec 0007: Complete the TurnPipeline Seam (Candidate 1)

- **Status**: Ready for Implementation
- **ADR Reference**: [docs/adr/0008-turn-pipeline-deep-module.md](../docs/adr/0008-turn-pipeline-deep-module.md), [docs/adr/0005-cross-scope-quote-provenance.md](../docs/adr/0005-cross-scope-quote-provenance.md), [docs/adr/0007-declarative-conversation-rule-engine.md](../docs/adr/0007-declarative-conversation-rule-engine.md)
- **Supersedes partial draft**: [specs/0006-turn-pipeline-deep-module.md](./0006-turn-pipeline-deep-module.md)

## Problem Statement
Although `TurnPipeline` and ADR-0008 exist, standard chat turns, voice messages, channel posts, and rule-engine dispatches still bypass `TurnPipeline` inside `Commands.submit()`. As a result, `MediaProcessor` is dead production code, duplicate audio STT and image preparation loops live inline in `commands.ts`, and `SteeringPolicy` never receives the live `activeTurnAuthorId` or guards `interrupt` turns. This also leaves ~250 lines of Picord-specific enrichment entangled inside `src/server/commands.ts`, creating direct merge friction with `upstream/main` (`0.30.1`).

## Solution
Route every standard turn submission through `TurnPipeline.submit()` as the single deep module seam. Move prompt/skill expansion, hidden-value masking, `MediaProcessor` multimodal ingestion (with ADR-0008 `[warning: ...]` graceful degradation and warning notices), quote provenance and `#channel` context enrichment, multi-user `SteeringPolicy` enforcement (for both `steer` and `interrupt`, with live active-run author lookup and demotion notice), durable admission/interrupt dispatch, and post-commit lifecycle hooks behind `TurnPipeline.submit()`. `Commands.submit()` remains a thin facade for backward compatibility.

## User Stories
1. As a channel member sending a voice message alongside typed text, I want transient STT failures to preserve my typed text, emit a warning notice, and attach `[warning: audio transcription unavailable for ...]` so the agent can acknowledge the hiccup without losing my context.
2. As a channel member replying in a shared channel while the agent is answering another user's prompt, I want my accidental `Steer` or `Interrupt` attempt to gracefully demote to the sequential `followUp` queue with a brief notice, so I don't hijack or kill someone else's active turn.
3. As an owner (`role === "owner"`) or the active turn's original author, I want my `Steer`, `/steer`, or `Interrupt` request to steer or interrupt immediately as expected.
4. As a maintainer preparing for upstream `0.30.1` + `pi-durable 1.6.0` synchronization, I want Picord's turn enrichment isolated behind `TurnPipeline.submit()` with narrow injected adapters, so `commands.ts` shrinks cleanly and tests exercise real production behavior through one seam.

## Implementation Decisions
- `TurnPipeline.submit(conversationId, actor, request, options)` is the single authoritative entry point for both local commands (`/rule`) and standard/voice/channel/rule turns.
- `Commands.submit()` validates access (`requireSee`, `requireDriver`, PiP enabled check) or delegates straight through `TurnPipeline` via a single host adapter constructed in `PocketApp` / `Commands`.
- `SteeringPolicy` evaluates `mode: "steer" | "followUp" | "interrupt"` as well as `/steer` / `!steer` prefixes against `activeTurnAuthorId` (resolved from `LiveDoc.run.inputs[0]` submission `requestId` via `requestPerson`), returning `{ allowInterrupt, whenBusy, steerRequested, steerGranted, reason }`. Unauthorized `steer` or `interrupt` emits a session notice and demotes to `followUp`.
- `MediaProcessor` executes inside `TurnPipeline` for audio STT and model image resizing, following ADR-0008 (`[warning: audio transcription unavailable for ...]` + `[image processing failed, kept original file]` + `onNotice("warning", ...)`).
- Duplicate `#heardAudio` and inline image/STT loops in `Commands` are deleted once `TurnPipeline` owns them.

## Testing Decisions
- **Agreed Seam**: `TurnPipeline.submit(conversationId, actor, request, options)` is the single seam under test.
- **Strategy (replace, don't layer)**: Write TDD vertical-slice tests crossing `TurnPipeline.submit()` with lightweight in-memory/mock adapters (storage, STT, image processor, notice sink, active-author lookup, durable admission), verifying observable outcomes: local command bypass, STT success/degradation, image degradation, quote/channel `<pocket-context>`, multi-user `steer` & `interrupt` demotion + notice, and post-commit activity hooks.
- All existing Picord suites (`test/turn-pipeline-*.test.ts`, `test/channels*.test.ts`, `test/rule-engine*.test.ts`, `test/quote*.test.ts`, `test/stt*.test.ts`, `test/voice.test.ts`) plus `npm run check`, `npm run lint`, and `npm run check:sandbox` must pass.

## Out of Scope
- Splitting `PocketApp` rule/channel orchestration (`Candidate 3`), aligning `session-cleanup`/`artifacts` (`Candidate 4`), or refactoring `web/composer.js` (`Candidate 2`) — those follow sequentially after `Candidate 1`.
