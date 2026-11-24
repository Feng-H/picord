# ADR 0005: Cross-Scope Quote Provenance & Context Tracking

## Status

Accepted

## Context

In multi-channel, multi-session agent environments (such as Discord-style channels and separate task threads), users frequently quote messages across contexts (e.g. citing an instruction from `#general` or a previous session into `#dev`).

Previously in Picord:

1. `web/quote-reply.js` simply transformed selected text into standard Markdown (`> quoted text`) and pasted it into the composer textarea. All provenance (originating session ID, channel name, entry ID, author, timestamp) was immediately discarded upon selection.
2. In the human transcript, quotes appeared as anonymous text passages without backlink navigation or channel origin attribution.
3. On the backend, `Commands.#aboutSession` strictly limited context injection to messages sent to PiP (`app.pip.ownerOf(id)`). Normal cross-session or cross-channel quotes received no origin metadata, leaving the agent model completely unaware of where the excerpt came from, preventing accurate contextual understanding and agentic cross-referencing via `session_read`.
4. Storing foreign keys or reply relations in relational database tables would break alignment with the underlying `pi-durable` engine, which enforces storage-agnostic immutable entry append logs.

## Decision

We implement a dual-track, `pi-durable`-compatible **Quote Provenance** architecture:

1. **Submission Protocol & Metadata Transmission**:
    - The web client captures `{ sessionId, entryId, channel, speaker, text }` when the user selects a message passage and clicks Reply.
    - When submitting a message, the client includes an optional `quotes?: QuoteOrigin[]` array in the `POST /api/chat` payload.
    - The message text itself retains clean, standard Markdown `> quoted text` for human readability, terminal clients, and third-party compatibility.

2. **Server-Side Verification & IDOR Guard**:
    - The backend validates all submitted `quotes` using `app.canSee(user, quote.sessionId)`.
    - If the user lacks access to the source session, or if the session does not exist, the server silently drops the provenance metadata and treats the message as an ordinary plain-text quote. This completely prevents Insecure Direct Object Reference (IDOR) attacks where a user probes private channel contents.

3. **Context Block Injection for Agent Models**:
    - For verified quotes, the server generates a structured `<pocket-context quote ...>` block appended to the model prompt.
    - The block contains the excerpt, source channel name or session title, session ID, entry ID, and speaker.
    - Rather than bloated inline transcript dumping, it guides the model: _"The quoted passage originates from session X (entry Y). Use `session_read` if further historical context is required."_ This keeps token usage minimal and respects agentic tool execution.

4. **Client-Side Provenance Badging & Jump-to-Source**:
    - In `web/transcript.js`, quote blocks carrying origin metadata render an origin badge (`via #channel` or `↩ session X`).
    - Clicking the badge triggers smooth navigation to the referenced session/channel and highlights the specific entry turn.

## Consequences

### Positive

- **100% `pi-durable` Alignment**: Zero invasive schema modifications to SQLite entry tables; immutable append model remains pure.
- **Deterministic Provenance**: Completely eliminates guessing or fuzzy text searching on the server.
- **Security & Multi-User Isolation**: Strictly guarded by session visibility checks; no information leakage across private spaces.
- **Token Efficiency**: Agents receive precise coordinates and use `session_read` only when deeper context is genuinely needed.
- **Graceful Degradation**: Hand-typed Markdown quotes (`> text`) continue to work seamlessly without errors.

### Negative / Trade-offs

- Manual hand-typed quotes will not have automatic origin metadata unless linked explicitly.
- The web client must coordinate quote state across selection, composer draft storage, and transcript rendering.
