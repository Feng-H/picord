/**
 * SessionAccess: centralized policy module for private-by-default conversation ownership,
 * shared group membership, duplicate-safe channel resolution, and cross-session scope isolation.
 */
import { HttpError } from "./errors.ts";

export interface SessionAccessMeta {
    title?: string;
    cwd?: string;
    createdBy?: string;
    channel?: true;
    archived?: boolean;
    pip?: string;
    members?: readonly string[];
}

export interface SessionAccessUser {
    id: string;
    name?: string;
    role: "owner" | "guest" | "viewer";
    sessions?: readonly string[];
}

export interface ViewerSessionAttribution {
    isGroup: boolean;
    ownerId?: string;
    ownerName?: string;
    memberIds?: string[];
    canManageMembers: boolean;
    canLeave: boolean;
}

export interface ChannelLookupMatch {
    id: number;
    name: string;
    ownerName?: string;
}

/** True once at least one other member has been explicitly added to a session/channel. */
export function isGroupSession(meta: Pick<SessionAccessMeta, "members" | "pip">): boolean {
    return meta.pip === undefined && Array.isArray(meta.members) && meta.members.length > 0;
}

/** Effective owner user ID of a session (legacy unattributed sessions default to the server owner). */
export function ownerIdOfSession(
    meta: Pick<SessionAccessMeta, "createdBy" | "pip">,
    fallbackOwnerId?: string,
): string | undefined {
    if (meta.pip !== undefined) {
        return meta.pip;
    }

    return meta.createdBy ?? fallbackOwnerId;
}

/** True when `user` is the owner/creator of `meta` (legacy unattributed sessions belong to `role: "owner"`). */
export function isSessionOwner(
    user: Pick<SessionAccessUser, "id" | "role">,
    meta: Pick<SessionAccessMeta, "createdBy" | "pip">,
): boolean {
    if (meta.pip !== undefined) {
        return meta.pip === user.id;
    }

    return meta.createdBy === undefined ? user.role === "owner" : meta.createdBy === user.id;
}

/** Canonical visibility check shared across HTTP routes, SSE broadcasts, subagent boards, search, and channels. */
export function canSeeSession(
    user: SessionAccessUser,
    rootId: number | string,
    meta: SessionAccessMeta | undefined,
    isRemoved = false,
): boolean {
    if (meta === undefined || isRemoved) {
        return false;
    }

    if (meta.pip !== undefined) {
        return meta.pip === user.id;
    }

    const allowed = isSessionOwner(user, meta) || (meta.members?.includes(user.id) ?? false);

    if (!allowed) {
        return false;
    }

    return user.sessions === undefined || user.sessions.includes(String(rootId));
}

/** Strictly creator-only permission to add/remove group members or mint session-scoped invites. */
export function canManageSessionMembers(
    user: SessionAccessUser,
    meta: SessionAccessMeta | undefined,
): boolean {
    return meta !== undefined && meta.pip === undefined && isSessionOwner(user, meta);
}

/** True when a non-owner member of a shared group is eligible to leave it. */
export function canLeaveSession(
    user: SessionAccessUser,
    meta: SessionAccessMeta | undefined,
): boolean {
    return (
        meta !== undefined &&
        meta.pip === undefined &&
        !isSessionOwner(user, meta) &&
        (meta.members?.includes(user.id) ?? false)
    );
}

/** Deduplicate member IDs, dropping the session owner so they remain implicitly owner rather than duplicated. */
export function normalizeMemberIds(
    ownerId: string | undefined,
    candidateIds: readonly string[],
): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const raw of candidateIds) {
        const id = raw.trim();

        if (id === "" || id === ownerId || seen.has(id)) {
            continue;
        }

        seen.add(id);
        unique.push(id);
    }

    return unique;
}

/** Normalize a channel title (`#foo` -> `foo`) without throwing on empty titles for non-channel lookup. */
export function normalizedChannelTitle(title: string | undefined): string {
    return (title ?? "").replace(/^#/, "").trim().toLowerCase();
}

/**
 * Enforce channel uniqueness ONLY against this user's own unshared private channels.
 * Once a channel becomes a group (`members.length > 0`), or when another user owns it, duplicates are allowed.
 */
export function assertPrivateChannelNameAvailable(
    user: SessionAccessUser,
    normalizedName: string,
    sessions: Readonly<Record<string, SessionAccessMeta>>,
    excludeId?: string | number,
): void {
    const excludeKey = excludeId === undefined ? undefined : String(excludeId);
    const current = excludeKey === undefined ? undefined : sessions[excludeKey];

    // Groups allow duplicate names with zero collision check.
    if (current !== undefined && isGroupSession(current)) {
        return;
    }

    for (const [id, meta] of Object.entries(sessions)) {
        if (id === excludeKey || meta.channel !== true || isGroupSession(meta)) {
            continue;
        }

        if (!isSessionOwner(user, meta)) {
            continue;
        }

        if (normalizedChannelTitle(meta.title) === normalizedName) {
            throw new HttpError(409, `A channel called #${normalizedName} is already here.`);
        }
    }
}

/** Compute viewer-facing attribution (`ownerName` only when shared by another user) and group flags. */
export function attributionForViewer(
    meta: SessionAccessMeta,
    viewer: Pick<SessionAccessUser, "id" | "role"> | undefined,
    userNameOf: (userId: string) => string | undefined,
    fallbackOwnerId?: string,
): ViewerSessionAttribution {
    const group = isGroupSession(meta);
    const ownerId = ownerIdOfSession(meta, fallbackOwnerId);
    const ownedByViewer = viewer !== undefined && isSessionOwner(viewer, meta);
    const ownerName =
        !ownedByViewer && ownerId !== undefined ? userNameOf(ownerId) : undefined;
    const memberIds =
        Array.isArray(meta.members) && meta.members.length > 0 ? [...meta.members] : undefined;

    return {
        isGroup: group,
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(ownerName === undefined ? {} : { ownerName }),
        ...(memberIds === undefined ? {} : { memberIds }),
        canManageMembers: viewer !== undefined && canManageSessionMembers(viewer, meta),
        canLeave: viewer !== undefined && canLeaveSession(viewer, meta),
    };
}

/** All active participants of a conversation (its owner plus explicit group members). */
export function sessionParticipants(
    meta: SessionAccessMeta,
    users: readonly SessionAccessUser[],
): SessionAccessUser[] {
    const participants: SessionAccessUser[] = [];
    const seen = new Set<string>();

    const add = (user: SessionAccessUser | undefined) => {
        if (user !== undefined && !seen.has(user.id)) {
            seen.add(user.id);
            participants.push(user);
        }
    };

    if (meta.pip !== undefined) {
        add(users.find((u) => u.id === meta.pip));

        return participants;
    }

    if (meta.createdBy === undefined) {
        for (const user of users) {
            if (user.role === "owner") {
                add(user);
            }
        }
    } else {
        add(users.find((u) => u.id === meta.createdBy));
    }

    for (const memberId of meta.members ?? []) {
        add(users.find((u) => u.id === memberId));
    }

    return participants;
}

/**
 * Determine whether a target session/channel is safe for an AI tool running inside `callerMeta`
 * (`search_history`, `channel_post`): every participant in `callerMeta` must be able to see the target,
 * preventing private transcript leakage inside shared groups.
 */
export function canConversationAccessTarget(
    callerId: number | string,
    callerMeta: SessionAccessMeta | undefined,
    targetId: number | string,
    targetMeta: SessionAccessMeta | undefined,
    users: readonly SessionAccessUser[],
    isTargetRemoved = false,
): boolean {
    if (callerMeta === undefined || targetMeta === undefined || isTargetRemoved) {
        return false;
    }

    if (String(callerId) === String(targetId)) {
        return true;
    }

    const participants = sessionParticipants(callerMeta, users);

    if (participants.length === 0) {
        return false;
    }

    return participants.every((participant) =>
        canSeeSession(participant, targetId, targetMeta, isTargetRemoved),
    );
}

/** Resolve a channel target by ID or `#name` within `callerId`'s permitted scope, disambiguating duplicates. */
export function resolveChannelTargetForScope(
    callerId: number | string,
    callerMeta: SessionAccessMeta | undefined,
    rawTarget: string | number,
    sessions: Readonly<Record<string, SessionAccessMeta>>,
    users: readonly SessionAccessUser[],
    normalizeName: (raw: string) => string,
    isRemoved: (id: number) => boolean = () => false,
    fallbackOwnerId?: string,
): ChannelLookupMatch {
    const callerKey = String(callerId);
    const trimmed = typeof rawTarget === "number" ? String(rawTarget) : rawTarget.trim();
    const userNameOf = (id: string) => users.find((u) => u.id === id)?.name;

    if (/^\d+$/.test(trimmed)) {
        const targetId = Number(trimmed);
        const meta = sessions[String(targetId)];

        if (
            meta?.channel !== true ||
            !canConversationAccessTarget(callerKey, callerMeta, targetId, meta, users, isRemoved(targetId))
        ) {
            throw new HttpError(404, `No live channel called #${trimmed} is here.`);
        }

        if (meta.archived === true) {
            throw new HttpError(404, `Channel #${normalizedChannelTitle(meta.title)} is archived.`);
        }

        if (Number(callerId) === targetId) {
            throw new HttpError(400, "That is this very conversation: just say it here.");
        }

        const ownerId = ownerIdOfSession(meta, fallbackOwnerId);

        return {
            id: targetId,
            name: normalizedChannelTitle(meta.title),
            ...(ownerId === undefined ? {} : { ownerName: userNameOf(ownerId) }),
        };
    }

    const asked = trimmed.replace(/^#/, "");
    const targetName = normalizeName(trimmed);
    const matches: Array<{ id: number; meta: SessionAccessMeta; ownerName?: string }> = [];

    for (const [idStr, meta] of Object.entries(sessions)) {
        const id = Number(idStr);

        if (
            meta.channel !== true ||
            !canConversationAccessTarget(callerKey, callerMeta, id, meta, users, isRemoved(id))
        ) {
            continue;
        }

        if (normalizedChannelTitle(meta.title) !== targetName) {
            continue;
        }

        const ownerId = ownerIdOfSession(meta, fallbackOwnerId);

        matches.push({
            id,
            meta,
            ...(ownerId === undefined ? {} : { ownerName: userNameOf(ownerId) }),
        });
    }

    const liveMatches = matches.filter((m) => m.meta.archived !== true);

    if (liveMatches.length === 0) {
        if (matches.length > 0) {
            throw new HttpError(404, `Channel #${targetName} is archived.`);
        }

        throw new HttpError(404, `No live channel called #${asked || targetName} is here.`);
    }

    if (liveMatches.length === 1) {
        const only = liveMatches[0]!;

        if (Number(callerId) === only.id) {
            throw new HttpError(400, "That is this very conversation: just say it here.");
        }

        return {
            id: only.id,
            name: targetName,
            ...(only.ownerName === undefined ? {} : { ownerName: only.ownerName }),
        };
    }

    const labels = liveMatches
        .map(
            (m) =>
                `#${targetName}${m.ownerName ? ` · ${m.ownerName}` : ""} (session ${String(m.id)})`,
        )
        .join(", ");

    throw new HttpError(
        409,
        `Multiple channels called #${targetName} are visible here: ${labels}. Pass the session number instead.`,
    );
}
