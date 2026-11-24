# 0003: Deep Event Connection Engine & Resilient Transport

Mobile PWA real-time updates rely on a persistent connection (`/api/events` via SSE with fallback to `/api/poll`). As detailed in [ADR-0001](./0001-mobile-eventstream-watchdog.md), mobile operating systems frequently suspend JavaScript execution, resulting in silent TCP half-open failures that bypass native error handlers.

Previously, SSE connection management, fallback polling, heartbeat measurement, exponential retry backoff, and dual-threshold watchdog timers (1.5× wake probe, 2.5× active timeout) were deeply entwined within the 3,300-line UI state container (`web/store.js`). This tight coupling prevented fast, isolated unit testing, leaked transport-level race conditions to user-interface components, and made connection behavior difficult to reason about and evolve.

To establish a resilient, deep architectural seam:

1. **Encapsulated Connection Engine**: Introduce `EventConnection` in `web/connection.js`. The engine encapsulates all transport-level concerns: SSE stream management, long polling fallback, heartbeat measurement, exponential backoff, and silent socket detection.
2. **In-Band Session Switching & Race Immunity**: The engine natively manages session switching (`switchSession(id, have)`). An internal monotonic `switchSeq` sequence counter transparently discards out-of-order residual events from previously viewed sessions, completely insulating the UI store from network race conditions.
3. **Hermetic Test Seam via Dependency Injection**: All environment dependencies (`now`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `EventSource`, `fetch`, `storage`) are passed through an optional environment adapter interface. In browser runtimes, defaults bind to standard browser globals; in Node.js unit tests, lightweight fake timers and mock streams enable exhaustive testing of 30-second sleep timeouts in under 5 milliseconds.
4. **Autonomous Proxy Buffering Fallback**: If an SSE stream is blocked by intermediary reverse proxies or tunnels (such as Cloudflare 64 KiB block buffering) before completing the initial batch, the engine autonomously transitions to long polling for one hour, managing state persistence through its abstract storage adapter.
5. **Minimal Tripartite Event Surface**: The engine presents a clean, narrow interface to callers:
    - `onEvent(name: string, data: unknown)`: Dispatches normalized, parsed business events.
    - `onStatusChange(status: "connecting" | "open" | "stale" | "closed")`: Reports health indicators for UI connection status chips.
    - `onAuthRequired()`: Signals HTTP 401 unauthorized status, triggering the authentication sheet.

## Considered Options

- **Option A (Generic Transport Without Session Switching)**: Evaluated keeping the transport engine strictly agnostic to session IDs. Rejected because out-of-order responses during rapid session navigation would leak into UI state, forcing the UI store to duplicate sequencing and filtering logic across multiple event handlers.
- **Option B (Global `globalThis` Mocking)**: Evaluated patching `globalThis.EventSource` and global timers during tests. Rejected because Picord's test runner executes with `--test-concurrency=4`, causing shared global timer mutation to introduce flaky test failures across concurrent test suites.

## Consequences

- Strips over 350 lines of complex networking and timer logic from `web/store.js`, keeping the store focused entirely on UI state.
- Enables complete offline unit testing of mobile sleep/wake reconnection and watchdog timeout behaviors without starting HTTP servers or browser automation.
- Solidifies ADR-0001 watchdog rules within an isolated, deterministic state machine.
