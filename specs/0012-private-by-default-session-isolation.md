# Spec 0012: Private-by-Default Session Isolation & Shared Group Management

- **Status**: Implemented (verified by unit, integration, and InstaBox sandbox checks)
- **Preceded By**: [specs/0011-sync-0.30.1-and-pi-durable-1.6.0.md](./0011-sync-0.30.1-and-pi-durable-1.6.0.md)
- **ADR**: [docs/adr/0009-private-by-default-session-isolation.md](../docs/adr/0009-private-by-default-session-isolation.md)

## Problem Statement
Upstream `pi-pocket` treats the server as one shared single-owner workbench: any non-scoped account (`tester`, `guest`, `viewer`) sees every session and `#channel` created by `John`. Picord needs true per-user isolation where all sessions and `#channels` are private to their creator by default (including isolation from the server `owner`), and sharing converts a conversation into a group with explicit member controls and duplicate-group-name support.

## Proposed Changes

### 1. Data Model (`src/server/docs.ts`, `src/server/config.ts`)
- Add `members?: string[]` to `SessionMeta`.
- Legacy sessions with `createdBy === undefined` remain owned by `role === "owner"` accounts.
- `PiP` sessions (`meta.pip !== undefined`) remain strictly single-user and reject `members`.

### 2. Deep Module `SessionAccess` (`src/server/session-access.ts`)
- Pure, unit-testable policy module behind a compact interface:
  - `canSee(user, rootId, meta, removed)`
  - `canManageMembers(user, meta)` (creator-only; legacy sessions = `owner`)
  - `canLeave(user, meta)`
  - `isGroup(meta)` (`members.length > 0`)
  - `checkPrivateChannelCollision(user, name, sessions, excludeId?)` (checks only the caller's own unshared private channels; groups skip collision check)
  - `attributionForViewer(meta, viewerId, userNameOf)` -> `{ isGroup, ownerName?, memberIds?, canManageMembers, canLeave }`
  - `participantIdsFor(meta, sessionsOwnerFallback)` -> intersection set for `search_history` and `channel_post` inside shared groups.

### 3. Server Enforcement (`src/server/app.ts`, `commands.ts`, `channels.ts`, `history-search.ts`, `http/*.ts`, `auth.ts`)
- **`app.ts`**:
  - Route `canSee`, `sessions(user)`, `#scheduleSessions`, `subagents(user)`, `people(viewer)`, and `searchHistory` through `SessionAccess` (remove unscoped global `all` broadcast cache in `#scheduleSessions`).
  - Implement `setSessionMembers(actor, id, memberIds)` (evicting removed users immediately from active rooms/peeks and emitting updated `sessions` + `view`) and `leaveSession(actor, id)`.
  - Note: in `people(viewer)`, full users see registered non-scoped members so they can pick collaborators in the Share sheet, while never leaking private `sessions` IDs others belong to.
- **`commands.ts` & `channels.ts`**:
  - `createSession` & `updateSession`: allow duplicate channel names across different users and across groups; check private collision only against the user's own unshared private channels.
  - `fork`: continues creating a fresh private session (`createdBy: user.id`, empty `members`, no `channel`).
  - `ChannelManager` & `app.postToChannel`: scope channel lookup to caller/group-visible channels; when multiple visible channels share a `#name`, fail clearly listing each channel's numeric session ID and owner name.
- **`history-search.ts`**:
  - Enforce `canSee` / group-intersection filter inside `HistorySearchEngine` so neither `GET /api/search` nor Pi's `search_history` tool reads or returns transcripts outside permitted scope.
- **`http/conversation-routes.ts` & `http/api.ts` & `auth.ts`**:
  - Add `POST /api/c/:id/members` and `POST /api/c/:id/leave`.
  - Gate single-session `POST /api/invite` on `canManageMembers`; on invite redemption (`auth.redeem`, `auth.redeemWithPassword`), add the new user to `meta.members` of that invited session (keeping `user.sessions = [id]`).

### 4. Web UI (`web/`)
- `web/sessions.js`, `web/store.js`, `web/composer.js`:
  - Render `· <ownerName>` attribution on shared channels/sessions when `createdBy !== me.id` (e.g. `#general · John` or `#general · B`).
  - In `/channel` (`web/commands.js`) and `+` New Channel (`web/sessions.js`), block duplicate names only against the user's own unshared private channels (`!each.isGroup && each.ownerId === me?.id`).
- `web/sheets/session.js` & `web/sheets/people.js`:
  - Replace single-purpose `Share` button with **Share / 成员** sheet (`ShareSheet`) for `canManageMembers` owners: pick existing registered users to add/remove as group members + optionally generate single-session invite links for new users.
  - Add **Leave group** action in `SessionSheet` when `session.canLeave` is true.
- `web/sw.js`: bump `SHELL_CACHE` to `picord-shell-v10`.

### 5. Verification Plan
- **New Seam Unit Tests (`test/session-access.test.ts`)**: creator-only private visibility (including owner isolation), group promotion & member management/eviction, self-leave, duplicate group `#general` allowance + `#general · B` attribution, ambiguous `channel_post` ID disambiguation, and `search_history` private-session isolation inside shared groups.
- **Updated Existing Tests**: update `test/channels.test.ts` + multi-user fixtures in ~20 existing tests (`memory`, `artifact-state`, `browser`, `plan`, `triggers`, `app`, etc.) to explicitly share test sessions before asserting guest/viewer collaboration.
- **Full Verification Gate**: `npm run check`, `npm run lint`, targeted server suites, `npm run check:sandbox` (InstaBox), GitHub Actions `CI`, live `pi-pocket.service` restart + `preview_*` verification logging in as both `John` and `tester` with screenshots!
