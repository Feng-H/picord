# Picord Domain Glossary

A self-hosted, Discord-style personal Agent runtime built on Pi.

## Channels

**Channel**:
A named, persistent discussion space in Picord, presented to users with a `#` prefix and serving as a dedicated venue for agent workflows, schedules, and cross-channel collaboration.
_Avoid_: Room, topic, group chat, session channel.

**Channel Name**:
A unique, lowercased, hyphen-separated string identifier for a channel without the `#` prefix (e.g. `smalltalk`, `zk-review`).
_Avoid_: Title, label, slug.

**Channel Manager**:
The core backend subsystem responsible for channel lookup, uniqueness enforcement, lifecycle, and cross-channel message routing.
_Avoid_: Session manager, post office, router.

**Channel Post**:
An asynchronous message dispatched from one channel's agent directly into another channel, attributed to the session owner with origin context.
_Avoid_: Mailbox, cross-session send, relay.

**Channel Origin**:
The contextual tag (`via #source-channel`) attached to a channel post, identifying the originating channel for attribution and reciprocal receipts.
_Avoid_: Referrer, source header.

## Connection Engine

**Event Connection**:
The deep client-side networking engine responsible for managing long-lived communication (Server-Sent Events and Long Polling fallback) with the Picord backend.
_Avoid_: Socket manager, event source wrapper, poll driver.

**Connection Status**:
The four-state lifecycle condition of the event connection: `"connecting"`, `"open"`, `"stale"`, or `"closed"`.
_Avoid_: Net state, ready state, socket state.

**Silent Socket**:
A half-open or suspended TCP/TLS connection that has ceased receiving server heartbeats without raising a native error event (typically occurring after mobile OS sleep).
_Avoid_: Dead socket, frozen pipe, ghost connection.

**Heartbeat Probe**:
The watchdog mechanism measuring elapsed time since the last server ping against dual thresholds (1.5× for wake recovery, 2.5× for active watchdog timeout).
_Avoid_: Ping timer, keepalive checker, health loop.

**Session Switch**:
An in-band control operation allowing an established connection to switch active session context without terminating or re-establishing the underlying HTTP transport.
_Avoid_: Reconnect, channel jump, session reload.
