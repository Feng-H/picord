# Spec: Password Authentication, Invite Registration & Picord Brand Identity

- **Status**: Proposed
- **Context**: Picord
- **Domain Terms**: [GLOSSARY.md](../GLOSSARY.md)
- **ADR Reference**: [docs/adr/0006-password-auth-invite-registration.md](../docs/adr/0006-password-auth-invite-registration.md)

## Problem Statement

Picord was originally forked from `pi-pocket` with two major legacy characteristics:

1. **Upstream Mathematical Branding**: The application icon in `web/icon.svg`, `web/app-icon.js`, and PWA manifests features a plain Greek `π` symbol. As Picord has evolved into an independent, channel-first AI runtime, it needs its own visual identity.
2. **Token-Only Authentication**: User login currently requires 32-character bearer tokens (e.g. `https://bot.851127.xyz/login?token=...`), creating friction on mobile and desktop devices.
3. **Restricted Invitation & Lack of Password-Protected Sign-Up**: Inviting members via `/join/:code` sets up session cookies directly without a password, meaning users cannot return and log in with standard credentials later. Furthermore, open registration without invite validation would risk exposing the VPS and LLM API quotas to automated scrapers and abuse.

## Solution

1. **Bespoke Picord Brand Icon**: Redesign the application icon with a faceted, futuristic "P" glyph intertwined with channel matrix lines, maintaining dynamic theme color bindings and updating all PWA icon assets.
2. **Native Password Authentication Engine (`src/server/password.ts`)**: Utilize Node.js's native `crypto.scrypt` with a random 16-byte salt to hash and verify passwords with high memory-hardness and zero external npm dependencies.
3. **User Schema Evolution (`src/server/config.ts`)**: Extend the `User` interface to support an optional `passwordHash?: string;` and provide lookup by username (`userByName`).
4. **Card-Style Web Login & Register Flows (`src/server/http/sign-in.ts`)**:
   - `GET /login`: Render an elegant dark card with username and password inputs, error messaging, and links to register or use an emergency token.
   - `POST /login`: Verify credentials against `scrypt` password hash (or fallback to token authentication), issue standard `pocket_auth` cookie, and redirect to the application.
   - `GET /register`: Render registration form requiring an invite code, desired username, password, and confirmation.
   - `POST /register`: Verify that the invite code is valid and unexpired, ensure the username is not already claimed, create the user account with `role: "member"`, save the password hash, redeem the invite code, and automatically log in.
5. **Admin Credential Provisioning**: Configure administrator `John` with an initial scrypt-hashed password while preserving `ownerToken` as an emergency fallback.

## User Stories

1. **US-1 (Brand Identity)**: As a user opening Picord in a browser or installing it as a PWA, I want to see a distinctive, high-tech "P" brand icon that dynamically adapts to my active color palette.
2. **US-2 (Admin Password Login)**: As administrator `John`, I want to log in at `/login` by typing my username `John` and my secure password, without having to find or copy long token URLs.
3. **US-3 (Invite-Only Registration)**: As a new user invited by John, I want to visit `/register`, enter my invite code, choose a username and password, and create my account.
4. **US-4 (Registration Protection)**: As the system owner, I want `/register` to reject registration attempts with invalid or expired invite codes, preventing unauthorized public access.
5. **US-5 (Unique Usernames)**: As a user registering, I want the system to reject duplicate usernames so that every member has a distinct identity in channels and messages.
6. **US-6 (Member Password Login)**: As a registered member, I want to return to Picord later and log in using my chosen username and password.
7. **US-7 (Token Fallback Compatibility)**: As an administrator performing scripted operations or emergency recovery, I want the token-based login (`/login?token=...` or Bearer header) to continue functioning seamlessly.
8. **US-8 (Zero-Dependency Security)**: As a maintainer, I want password hashing to use Node.js's built-in `scrypt` so that the app builds cleanly in InstaBox sandboxes and minimal containers without C++ compilation errors.

## Data Model & Interfaces

### `src/server/password.ts`

```ts
export async function hashPassword(password: string): Promise<string>;
export async function verifyPassword(password: string, storedHash: string): Promise<boolean>;
```

Format: `scrypt$<saltHex>$<derivedKeyHex>`

### `src/server/config.ts`

```ts
export interface User {
    id: string;
    name: string;
    role: Role;
    tokenHash: string;
    passwordHash?: string;
    createdAt: number;
    // ...
}
```

## Acceptance Criteria

- [ ] `test/password.test.ts` passes 100% with valid, invalid, and malformed password inputs.
- [ ] Administrator `John` can log in with username `John` and generated password.
- [ ] `/register` successfully registers a user when given a valid invite code and sets their password.
- [ ] `/register` rejects invalid invite codes with a clear error message.
- [ ] `/login` rejects incorrect passwords with an HTTP 401 error message.
- [ ] Existing token-based login continues to work for backward compatibility.
- [ ] `web/icon.svg` and `web/app-icon.js` display the new Picord "P" branding and pass `test/app-icon.test.ts`.
- [ ] `npm run check` and `npm run lint` pass with 0 errors.
- [ ] `npm run check:sandbox` succeeds in InstaBox.
- [ ] Production service restarts cleanly and responds HTTP 200.
