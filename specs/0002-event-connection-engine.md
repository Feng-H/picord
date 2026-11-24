# Spec: Deep Event Connection Engine & Resilient Transport

- **Status**: Proposed
- **Context**: Picord
- **Domain Terms**: [GLOSSARY.md](../GLOSSARY.md)
- **ADR Reference**: [docs/adr/0003-event-connection-engine.md](../docs/adr/0003-event-connection-engine.md), [docs/adr/0001-mobile-eventstream-watchdog.md](../docs/adr/0001-mobile-eventstream-watchdog.md)

## Problem Statement

Real-time streaming in Picord is vital for interactive agent chat, channel message delivery, and subagent observation. However, transport mechanics—including Server-Sent Events (SSE), Long Polling fallback, heartbeat tracking, silent socket detection, and mobile foreground wakeup handling—are deeply coupled within the 3,300-line UI store (`web/store.js`).

This tight coupling creates severe friction:

1. **Network Race Conditions**: Switching between sessions in rapid succession risks applying delayed events from previous sessions to the newly active view.
2. **Untestable Watchdogs**: Critical mobile resilience logic (such as ADR-0001's 1.5× wake probe and 2.5× active watchdog) cannot be unit-tested without real elapsed time and browser instances.
3. **UI Code Bloat**: Transport protocol mechanics clutter UI state logic, increasing maintenance overhead and the risk of accidental regressions during UI iterations.

## Solution

Extract all network transport, heartbeat measurement, and watchdog state machine logic into a standalone, deep module: `web/connection.js` (`EventConnection`).

The engine encapsulates dual-channel heartbeats, silent socket detection, autonomous proxy fallback, and in-band session switching with monotonic sequence guarantees. Caller dependencies and timing facilities are fully injectable, providing a hermetic test seam for millisecond Node.js unit tests.

## User Stories

1. As a mobile Picord user locking my phone for 30 minutes, I want the web app to immediately detect that the connection went half-open when I unlock the screen (`1.5 * pingPeriod`), so that my active session and channel updates refresh in 0.01 seconds without a manual full page reload.
2. As a Picord user in an elevator or experiencing silent packet loss, I want the active watchdog (`2.5 * pingPeriod`) to detect that server pings have stopped, so that the client automatically recovers without remaining in a broken silent state.
3. As a Picord user clicking rapidly through several channels and sessions in the sidebar, I want the connection engine to sequence session switches (`switchSession`), so that delayed events from previous sessions never pollute my current view.
4. As a Picord user connecting behind a buffering proxy or tunnel (e.g. Cloudflare Quick Tunnel), I want the client to detect SSE buffering on the initial batch and autonomously fall back to Long Polling, so that I can use Picord smoothly even through aggressive proxies.
5. As a Picord user whose authentication session expires (HTTP 401), I want the connection engine to notify the application with `onAuthRequired()`, so that the login sheet is prompted without flooding the server with infinite reconnect attempts.
6. As a frontend engineer developing Picord UI components, I want `store.js` to merely subscribe to clean `onEvent`, `onStatusChange`, and `onAuthRequired` callbacks, so that UI code does not touch raw EventSource, timeouts, or polling loops.
7. As an engineer maintaining Picord, I want to test mobile sleep wakeups, watchdog timeouts, and backoff retries in milliseconds using in-memory fake timers without launching headless Chromium or waiting for real wall-clock delays.

## Implementation Decisions

- **Dedicated Deep Module (`web/connection.js`)**: All communication logic is contained within `EventConnection`.
- **In-Band Session Switching**: `switchSession(conversationId, have)` tracks `switchSeq`. Any event arriving from a prior sequence is silently dropped before reaching `onEvent`.
- **Tripartite Callback Surface**: Callers provide three callbacks:
    - `onEvent(name, data)`: Normalized and parsed event payloads.
    - `onStatusChange(status)`: Emits `"connecting"`, `"open"`, `"stale"`, or `"closed"`.
    - `onAuthRequired()`: Dispatched upon HTTP 401 or session authorization rejection.
- **Dependency Injection Seam**: The constructor accepts an optional `env` object:
    ```js
    {
        now: () => Date.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
        EventSource: typeof EventSource !== "undefined" ? EventSource : null,
        fetch: typeof fetch !== "undefined" ? fetch : null,
        storage: typeof localStorage !== "undefined" ? localStorage : null,
    }
    ```
- **Foreground Wake Detection**: Accepts an explicit `.wake()` method. When the host browser fires `visibilitychange` to visible, it invokes `.wake()`. If `isSilent(1.5)` returns true, an immediate reconnect is triggered.
- **Autonomous Transport Fallback**: If SSE stalls for 6 seconds prior to initial batch settlement, the engine flags `poll:<timestamp>` in its storage adapter and switches to Long Polling for 1 hour.

## Testing Decisions

- **Fast Pure-Node Testing (`test/connection.test.ts`)**: Using a mock EventSource and fake deterministic timer provider, all states—including connection open, ping arrival, 1.5× wake probe, 2.5× active timeout, and proxy fallback—are verified in <10ms.
- **Zero Global Pollution**: Tests instantiate `new EventConnection({ env: fakeEnv })` without modifying `globalThis`.

## Out of Scope

- WebSocket bidirectional protocol replacement (SSE + HTTP POST is Picord's standard architecture).
- Multi-server load balancing or mesh routing.
