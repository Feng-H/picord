# ADR 0007: Declarative Conversation Rule Engine & Silence Trigger System

## Status
Accepted

## Context
1. **Recurring Timer Stacking in Channel Workflows**: In automated channel workflows such as `#smalltalk`, users established a conversational contract: each user utterance should start or postpone a 1-hour countdown; once 1 hour of silence elapses without further utterances, the agent must summarize incremental viewpoints into Luhmann Zettelkasten cards and dispatch them to `#zk-review`.
2. **Failure Mode of LLM-Managed Schedules**: Previously, this was implemented by instructing the agent to call `schedule({ action: 'cancel', id })` and `schedule({ action: 'add', ... })`. Because LLM execution is probabilistic, models repeatedly skipped the `cancel` step, causing up to 9 duplicate schedules to accumulate in SQLite and fire simultaneously.
3. **Limits of Prompt-Level Constraints**: Attempting to fix this via stronger prompt instructions ("铁律", penalty counters in `state.json`, cross-session memory) failed repeatedly. As articulated in engineering skill principles (Matt Pocock / Viewpoints 17–22), trust boundaries must be placed on deterministic machine verification and system mechanics, not on LLM obedience.
4. **Visibility Requirement**: Users actively monitor countdowns in the bottom status bar (`<SchedulesPill>`), making live UI countdown visibility an essential requirement.

## Decision
1. **Native Server Subsystem (`src/server/rule-engine/`)**:
   - Build the rule engine directly into the Picord backend server, managed within the `pi-pocket.service` lifecycle with zero external process dependencies.
2. **Silence Trigger with Heartbeat Evaluation**:
   - Model countdown resets as a declarative **Silence Trigger** (`on: "silence"`, `after: "60m"`).
   - **Zero-LLM Activity Capture**: When any message with `role: "user"` is committed via `submissions.ts`, the backend message pipeline atomically records `last_activity = Date.now()` for the channel. The agent is entirely removed from timestamp bookkeeping.
   - **Heartbeat Clock**: A lightweight 1-minute server heartbeat evaluates active rules (`now - last_activity >= after && last_fired_at < last_activity`). This eliminates in-memory timer loss on restart, prevents race conditions, and makes timer stacking structurally impossible.
3. **Status Bar Pipeline Integration**:
   - Active silence triggers dynamically project their projected fire timestamp (`next = last_activity + after`) into the conversation's `schedules` payload.
   - The web client's existing `<SchedulesPill>`, live countdown hover tooltip, and schedule sheet immediately reflect the countdown with zero fragile frontend DOM changes.
4. **Stable SQLite Entry ID Cursor**:
   - The rule engine persists a monotonically increasing SQLite `cursor_entry_id` alongside each rule.
   - When firing, the engine injects a deterministic instruction specifying the exact entry range (`id > cursor_entry_id`) and advances the cursor upon task completion, while preserving human-readable `>>>SUMMARIZED<<<` markers in Markdown archives.
5. **Declarative File Schema & Hot Reloading**:
   - Channel rules are defined in declarative JSON (`.dialogue-session/rules.json` or `~/.pi-pocket/rules.json`).
   - The server watches the file for hot updates and exposes a `/rule` command for operational status queries.

## Consequences

### Positive
- **Structural Impossibility of Stacking**: Timers cannot duplicate or stack regardless of LLM behavior, because there is no dynamic creation of multiple timers.
- **Resilient Recovery**: Heartbeat comparison against persistent timestamps naturally survives server restarts and crashes.
- **Seamless UI Visibility**: The status bar clock and hover tooltip display live countdowns using the established scheduling UI.
- **Extensible Architecture**: New rules (e.g. `message_match`, `schedule`, `channel_event`) can be added declaratively without modifying backend scheduling code.

### Negative / Trade-offs
- Evaluation occurs on a 1-minute heartbeat interval rather than sub-second precision (wholly negligible for multi-minute/hourly quiet periods).
- Requires server-side storage of rule definitions and execution state.
