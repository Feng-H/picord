# Spec 0006: Deep TurnPipeline Module & Local Command Registry

- **Status**: Draft -> Ready for Implementation
- **ADR Reference**: [docs/adr/0008-turn-pipeline-deep-module.md](../docs/adr/0008-turn-pipeline-deep-module.md)

## 1. Objectives
1. Extract turn execution and multimodal enrichment from `Commands` (3,236 lines) into an encapsulated deep module `TurnPipeline`.
2. Implement a decoupled `LocalCommandRegistry` that handles prefix commands (`/rule`, `/help`, etc.) locally with zero LLM latency and zero token cost.
3. Guarantee multi-user concurrency across channels with serialized, non-interleaved queueing within channels.
4. Enforce strict steering directive permissions: only administrators or the author of the active turn may interrupt an ongoing response; unauthorized steering requests safely fall back to queueing.
5. Provide resilient multimodal ingestion with graceful degradation: failure in audio transcription or attachment parsing never drops user text.

## 2. Architecture & Seam Design

```
                       [ Incoming SubmitRequest ]
                                  │
                                  ▼
               TurnPipeline.submit(convId, actor, request)
                                  │
         ┌────────────────────────┴────────────────────────┐
         │                                                 │
  (Matches Local Command)                          (Normal Chat Turn)
         │                                                 │
         ▼                                                 ▼
LocalCommandRegistry                          Multimodal Media Ingestion
  - /rule, /help, etc.                         - Audio STT (with timeout)
  - Returns NOTE_ENTRY                         - Image resize & validation
  - Zero LLM Token cost                        - Graceful degradation on error
                                                           │
                                                           ▼
                                               Admission & Steering Policy
                                                - Permission check (owner?)
                                                - Steering authority validation
                                                - whenBusy: steer | followUp
                                                           │
                                                           ▼
                                               Durable Execution Dispatch
                                                - conversation.submit()
                                                - Task interrupt / queue
                                                           │
                                                           ▼
                                               Post-Turn Lifecycle Side-Effects
                                                - Activity touch (Rule Engine)
                                                - Typing state clear
                                                - Event bus notification
```

## 3. Public Types & Interfaces

```typescript
export interface TurnPipeline {
    submit(
        conversationId: ConversationId,
        actor: User,
        request: SubmitRequest,
        options?: TurnSubmitOptions,
    ): Promise<TurnSubmitResult>;
}

export interface LocalCommandHandler {
    (context: LocalCommandContext): Promise<LocalCommandResult> | LocalCommandResult;
}

export interface LocalCommandRegistry {
    register(prefix: string, handler: LocalCommandHandler): void;
    resolve(text: string): { handler: LocalCommandHandler; command: string; args: string } | undefined;
}
```

## 4. Acceptance Criteria
- Unit tests cover local command resolution, media degradation, and steering permission gates.
- All existing 20+ tests pass without regression.
- Local command `/rule` continues to respond instantaneously without LLM execution.
- Graceful degradation warns user but preserves typed text on audio STT failure.
- Steering is rejected (demoted to queue) when attempted by non-admin, non-author actors.
