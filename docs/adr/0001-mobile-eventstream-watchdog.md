# 0001: Mobile Event Stream Watchdog & Reconnection

The mobile PWA client uses a Server-Sent Events (SSE) connection (`/api/events`) to stream real-time updates. On mobile platforms (particularly iOS Safari), when the device is locked or placed in the background, the operating system freezes JavaScript execution and quietly terminates the TCP connection without emitting an `onerror` event. When the user unlocks and returns, the webpage sits on a dead "half-open" socket and appears completely frozen until a manual full-page reload.

To resolve this without wasting battery or causing false reconnections:

1. **Dual-channel Heartbeat (Server)**: The server emits an active named SSE event (`event: ping\ndata: {"every": 15000}\n\n`) alongside the standard comment (`: ping\n\n`), allowing frontend JavaScript to measure heartbeat arrivals while preserving proxy/tunnel keep-alive.
2. **Foreground Wakeup Probe (Client)**: On `visibilitychange` (when the screen is unlocked or the browser tab is focused), if `Date.now() - heardAt > 1.5 * pingPeriod` (i.e. > 22.5s), the client knows the connection was severed during sleep and immediately reconnects on the spot (0.01s), seamlessly fetching fresh state without user intervention.
3. **Active Watchdog Timer (Client)**: While the screen remains awake (e.g. user in an elevator or encountering quiet packet loss), an active watchdog fires every ping interval and reconnects if `Date.now() - heardAt > 2.5 * pingPeriod` (37.5s), tolerating minor 4G/WiFi jitter.

## Considered Options

- **Option A (Blind Reconnect on Wakeup)**: Reconnect unconditionally on every `visibilitychange`. Rejected because brief 2-second switches (e.g. copying an SMS 2FA code) would trigger unnecessary connection restarts and UI flicker.
- **Option B (Rely on native EventSource error events)**: Rejected because iOS WebKit does not fire `onerror` on socket freeze/suspension.

## Consequences

- Web and PWA mobile clients automatically recover from sleep and network transitions seamlessly.
- Bandwidth overhead is negligible (~10 KB/hour per active connection).
- Zero battery consumption while phone is asleep, as background code execution is not required.
