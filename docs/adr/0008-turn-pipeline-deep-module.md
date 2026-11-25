# ADR 0008: Deep TurnPipeline Module & Local Command Registry

## Status
Accepted

## Context
1. **Monolithic Turn Ingestion in `Commands`**: In `src/server/commands.ts`, the `submit()` method has grown to over 370 lines supported by 600+ lines of private helper functions. It mixes administrative actions (`createSession`, `removeWorktree`, `compact`, `fork`) with the central turn execution pipeline.
2. **Entangled Concerns**: `submit()` entangles admission checks, spend limits, prompt template expansion, multimodal media ingestion (audio STT, image resizing, quote provenance injection, file inlining), hardcoded prefix command handling (such as `/rule` at lines 882–909), durable task dispatching (steer vs interrupt), and post-turn side-effects (activity touch, typing indicators, event emission).
3. **Multi-User Concurrency & Order**: As multiple users interact in channels, sequential turn order must be guaranteed within each channel without blocking independent channels or leaking user state across sessions.
4. **Steering Invariants**: Arbitrary users interrupting ongoing agent responses can cause chaos ("抢麦"). Only authorized actors (administrators or the author of the active question) should be permitted to steer ongoing outputs.
5. **Media Resiliency**: Transient failures in speech-to-text or image decoding must not cause users to lose their typed text.

## Decision
1. **Encapsulated Deep Module (`src/server/turn-pipeline/`)**:
   - Extract the entire turn preparation and execution lifecycle into a deep `TurnPipeline` module.
   - Present a small, robust interface: `submit(conversationId, actor, request, options)`.
2. **Deterministic Multi-User Isolation**:
   - Conversations maintain isolated, concurrent processing lanes.
   - Within a single conversation, turns default to serialized queueing (`whenBusy: "followUp"`), ensuring responses never interleave or corrupt conversational context.
3. **Steering Directives & Permission Gate**:
   - A turn is flagged for steering either via explicit directive (e.g. `/steer` prefix) or client `request.mode === "steer"`.
   - The pipeline checks authority: only administrators (`role: "owner"`) or the original author of the currently running turn are authorized to interrupt. Unauthorized steering requests gracefully fall back to sequential queueing.
4. **Multimodal Graceful Degradation**:
   - Ingestion of audio STT and image/file attachments runs in a resilient stage.
   - If an audio transcription or attachment parsing encounters an error or timeout, the pipeline preserves user-typed text, continues execution, and appends a degradation warning note (`[warning: audio transcription unavailable]`).
5. **Decoupled Local Command Registry**:
   - Extract prefix commands into a `LocalCommandRegistry`.
   - Commands like `/rule` are registered in an extensible registry table. When matched, the registry executes immediately and writes a local `NOTE_ENTRY` without triggering unnecessary LLM inference or durable task leases.

## Consequences

### Positive
- **High Leverage & Small Interface**: Callers (web client, audio inputs, cross-channel posts, rule engine triggers) invoke one deep `TurnPipeline.submit()` interface.
- **Locality**: Turn enrichment, command routing, and post-turn hooks live in one cohesive module rather than polluting `commands.ts`.
- **Fault-Tolerant UX**: Users never lose text when auxiliary audio/image services hiccup.
- **Clean Testability**: The pipeline can be unit-tested across all stages (media degradation, permission gate, command registry) using in-memory durable harnesses.

### Negative / Trade-offs
- Refactoring `Commands.submit` requires careful migration of existing helper methods to ensure zero regression in legacy chat behavior.
