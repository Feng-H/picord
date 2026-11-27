# ADR 0009: Private-by-Default Session Isolation & Shared Group Semantics

## Status
Accepted (implemented and verified)

## Context
1. **Upstream Single-Workbench Model**: Upstream `pi-pocket` assumes a single-owner workbench where non-scoped `guest` and `viewer` accounts (`user.sessions === undefined`) see every conversation and channel on the server, while `owner` can inspect all non-PiP sessions.
2. **Picord Multi-User Privacy Requirement**: Picord hosts independent personal accounts (e.g., `John`, `tester`) who expect personal conversations and personal `#channels` to remain private to their creator by default—including from the server `owner`—and only become shared when the creator explicitly adds other users.
3. **Private Channels vs. Shared Groups**:
   - Both regular sessions and `#channels` start private to `createdBy`.
   - Adding members converts a private session/channel into a **Shared Group**.
   - Multiple groups with the same name (including duplicate `#general · B` shared from other users) must be allowed without blocking membership or leaking private channel names during sharing.
4. **Leaks in Upstream Multi-Session Call Sites**: `sessions(user)`, `#scheduleSessions`, `subagents(user)`, `ChannelManager`, and the AI `search_history` tool (`app.searchHistory`) previously bypassed per-user visibility or checked only `user.sessions !== undefined`.

## Decision
1. **Extract a Deep `SessionAccess` Module (`src/server/session-access.ts`)**:
   - Centralize ownership (`createdBy`, with legacy `undefined` attributed to `owner`), group state (`members?.length > 0`), visibility (`canSee`), creator-only membership authority (`canManageMembers`), self-leave (`canLeave`), private-channel uniqueness checks, display attribution (`ownerName` for non-owned shared items), and cross-conversation scope filtering for `search_history` and `channel_post`.
2. **Explicit Group Membership on `SessionMeta` (`src/server/docs.ts`)**:
   - Add `members?: string[]` to `SessionMeta`.
   - Keep `user.sessions?: string[]` strictly as an additional pin for legacy single-session invitees (and enroll newly redeemed single-session invitees into `meta.members`).
3. **Private-Only Channel Name Collision + Duplicate Group Allowance**:
   - Enforce `#channel` name uniqueness only against the creator's own unshared private channels (`channel === true && !isGroup && isOwner`).
   - Once converted to a group (`members.length > 0`), duplicate names are permitted with zero collision blocking.
   - Recipients see `ownerName` attribution (e.g. `#general · B`) whenever `ownerId !== viewer.id`.
   - Ambiguous `#name` references in `channel_post` fail fast listing candidate numeric session IDs and creator names.
4. **Creator-Only Member Management & Safe Cross-Session AI Tools**:
   - Only the creator (`canManageMembers`) may add or remove members (`POST /api/c/:id/members`) or mint single-session invites; shared members may leave (`POST /api/c/:id/leave`).
   - Removing a member immediately evicts their live rooms, peeks, and subagent views.
   - `search_history` inside a group searches only the current session and sessions visible to every participant in that group, preventing cross-user transcript leakage.

## Consequences

### Positive
- **True Multi-User Privacy**: Every account sees only their own sessions/channels plus groups they joined.
- **No Privacy Leak on Name Reuse**: Two users can independently use `#general`, and sharing never exposes whether the recipient owns a private `#general`.
- **Single Seam**: All HTTP routes, SSE broadcasts, subagent boards, search, and channel routing consume one deep `SessionAccess` module.

### Negative / Trade-offs
- **Test Fixture Updates**: ~20 existing upstream tests assume newly created `guest`/`viewer` users immediately see owner-created sessions without sharing; those tests must explicitly share the session under test.
- **Cross-Channel Ambiguity**: When a user belongs to multiple `#general` groups, AI `channel_post` / `search_history` calls targeting `#general` require numeric session IDs for disambiguation.
