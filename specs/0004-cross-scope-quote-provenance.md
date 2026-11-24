# Spec: Cross-Scope Quote Provenance & Context Tracking

- **Status**: Proposed
- **Context**: Picord
- **Domain Terms**: [GLOSSARY.md](../GLOSSARY.md)
- **ADR Reference**: [docs/adr/0005-cross-scope-quote-provenance.md](../docs/adr/0005-cross-scope-quote-provenance.md), [docs/adr/0002-deep-channel-subsystem.md](../docs/adr/0002-deep-channel-subsystem.md)

## Problem Statement

In Picord's Discord-style environment with persistent channels and multi-turn Agent conversations, users frequently cite earlier discussions across different channels and sessions (e.g., citing a deployment rule from `#infra` into `#dev`).

However, the existing quote mechanism in `web/quote-reply.js` and `src/server/commands.ts` has major shortcomings:

1. **Total Provenance Amnesia**: Clicking "Reply" on selected text merely pastes raw Markdown `> text` into the composer textarea. All metadata (source session ID, channel name, entry ID, author, and timestamp) is discarded immediately.
2. **Missing UI Backlinks**: In the message transcript, quotes appear as anonymous gray text blocks without origin capsules, channel attribution, or click-to-jump capabilities.
3. **Restricted Server Context**: The server's `#aboutSession` handler only allows context injection for messages sent to PiP (`app.pip.ownerOf(id)`). Quotes in regular channels receive zero source context, leaving the AI model unaware of where the quote came from and preventing agentic investigation via `session_read`.
4. **Security & IDOR Risk**: If cross-session quotes are accepted blindly, users could probe private or restricted channels by referencing unauthorized session IDs.
5. **Storage-Agnostic Requirement**: Any solution must strictly follow `@earendil-works/pi-durable`'s immutable append log model without introducing invasive relational database schema alterations.

## Solution

Implement an end-to-end **Quote Provenance** subsystem spanning client-side capture, secure server-side validation, AI context block injection, and transcript jump-to-source navigation.

1. **Client Metadata Capture**: When clicking "Reply" on a selected text range, `web/quote-reply.js` extracts `{ sessionId, entryId, channel, speaker, text }` from the containing turn DOM element and binds it to the composer's active draft.
2. **Submit Protocol**: The `POST /api/chat` payload accepts an optional `quotes?: QuoteOrigin[]` array alongside the text message.
3. **Server Validation (IDOR Guard)**: The backend validates every `quotes` item with `app.canSee(user, quote.sessionId)`. Unauthorized or missing sessions are silently stripped of provenance, gracefully degrading to pure Markdown text.
4. **Context Injection**: For verified quotes, the backend generates a `<pocket-context quote ...>` block informing the agent model of the exact source coordinates and prompting on-demand `session_read` if deeper context is required.
5. **Transcript Backlink Navigation**: In `web/transcript.js`, quotes with origin metadata render a clickable badge (`via #channel` or `↩ entry 42`). Clicking the badge navigates to the target channel/session and focuses the cited turn.

## User Stories

1. **US-1 (Origin Capture)**: As a user selecting text in a message and clicking "Reply", I want the composer draft to remember the source session ID, channel name, entry ID, and speaker so that provenance is preserved.
2. **US-2 (Transcript Origin Capsule)**: As a user reading a message that contains a quoted passage, I want to see a clear origin capsule (e.g. `via #infra` or `↩ #general · entry 15`) above the quote so I know where the excerpt originated.
3. **US-3 (Jump-to-Source Navigation)**: As a user reading a quoted passage with an origin capsule, I want to click the capsule to automatically switch to that session or channel and smoothly highlight the original message turn.
4. **US-4 (Agent Model Context Injection)**: As an AI agent receiving a user prompt with quoted text, I want to receive a structured `<pocket-context quote origin="..." session="..." entry="...">` XML block indicating the exact source so I understand the background without prompt bloat.
5. **US-5 (Agentic On-Demand Deepening)**: As an AI agent needing deeper context around a quoted excerpt, I want the context block to provide the session ID and entry ID so I can deliberately call `session_read` to inspect surrounding turns.
6. **US-6 (Security & Visibility Guard)**: As a system owner, I want the server to verify that the submitting user has visibility rights (`app.canSee`) to the cited session, ensuring no private channel contents can be probed or exposed through crafted quote metadata.
7. **US-7 (pi-durable Immutable Compatibility)**: As a backend engineer, I want the stored message body in SQLite to remain standard Markdown without altering database table schemas or breaking third-party clients.
8. **US-8 (Graceful Plain-Text Fallback)**: As a user who manually types a `> quote` by hand in Markdown, I want the quote to render normally without errors, treating absence of metadata as a standard unlinked quote.

## Implementation Details

### Data Types (`src/server/quote-provenance.ts`)

```ts
export interface QuoteOrigin {
    sessionId: number;
    entryId?: number;
    channel?: string;
    speaker?: string;
    text: string;
}

export interface QuoteContextBlockOptions {
    quotes: QuoteOrigin[];
    getSourceMeta: (
        sessionId: number,
    ) => { title?: string; channel?: boolean; archived?: boolean } | undefined;
    canSee: (sessionId: number) => boolean;
}
```

### Context Block XML Format

```xml
<pocket-context quote>
The quoted passage(s) in this message originate from:
- "#infra" (session 12, entry 45, by user): "deployment port is 8790"
If deeper context is needed, use `session_read` with sessionId=12 and minEntryId=40 to inspect surrounding turns.
</pocket-context>
```

### Acceptance Criteria

- [ ] Unit tests in `test/quote-provenance.test.ts` pass 100% in pure Node.js memory.
- [ ] Submitting quotes to unauthorized sessions silently strips provenance without crashing.
- [ ] The generated context block uses `CONTEXT_BLOCK` format consistent with `pi-pocket` conventions.
- [ ] Client composer remembers quote origin across draft saves.
- [ ] Quotes with origin metadata display clickable badges in `web/transcript.js`.
- [ ] TypeScript types compile with 0 errors (`npm run check`).
- [ ] Code style and lint checks pass 100% (`npm run lint`).
- [ ] InstaBox sandbox checks pass with exit code 0 (`npm run check:sandbox`).
