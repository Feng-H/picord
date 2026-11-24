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
