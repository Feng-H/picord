/**
 * Channel subsystem: encapsulates channel domain logic, naming rules,
 * deduplication, and cross-channel message routing.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "./errors.ts";

export interface Channel {
    id: ConversationId;
    name: string; // normalized name, e.g. "general"
    title: string; // formatted title, e.g. "#general"
    createdBy: string;
    members?: readonly string[];
    isGroup?: boolean;
    cwd?: string;
    archived?: boolean;
}

export interface ChannelStore {
    list(): Channel[];
    get(id: ConversationId): Channel | undefined;
    create(info: { name: string; createdBy: string; cwd?: string }): Promise<Channel>;
}

export class InMemoryChannelStore implements ChannelStore {
    #channels = new Map<ConversationId, Channel>();
    #nextId = 1;

    list(): Channel[] {
        return Array.from(this.#channels.values());
    }

    get(id: ConversationId): Channel | undefined {
        return this.#channels.get(id);
    }

    async create(info: { name: string; createdBy: string; cwd?: string }): Promise<Channel> {
        const id = this.#nextId++ as unknown as ConversationId;
        const channel: Channel = {
            id,
            name: info.name,
            title: `#${info.name}`,
            createdBy: info.createdBy,
            cwd: info.cwd,
            archived: false,
        };

        this.#channels.set(id, channel);

        return channel;
    }
}

/**
 * Normalizes a channel name according to domain rules:
 * - Strips leading '#'
 * - Trims whitespace
 * - Converts to lowercase
 * - Validates: non-empty and matches ^[a-z0-9_-]+$
 */
export function normalizeChannelName(raw: string): string {
    const trimmed = raw.trim();
    const stripped = trimmed.startsWith("#") ? trimmed.slice(1).trim() : trimmed;

    if (stripped === "") {
        throw new HttpError(400, "Channel name cannot be empty.");
    }

    const lower = stripped.toLowerCase();

    if (!/^[a-z0-9_-]+$/.test(lower)) {
        throw new HttpError(
            400,
            "Invalid channel name: only lowercase alphanumeric characters, underscores, and hyphens are allowed.",
        );
    }

    return lower;
}

export type ChannelDelivery = (
    target: Channel,
    options: {
        fromId: ConversationId;
        sourceChannel?: Channel;
        message: string;
    },
) => Promise<void>;

export type ChannelTargetResolver = (
    fromId: ConversationId,
    targetNameOrId: string | ConversationId,
) => Channel;

export class ChannelManager {
    readonly #store: ChannelStore;
    readonly #delivery?: ChannelDelivery;
    readonly #resolveTarget?: ChannelTargetResolver;

    constructor(
        store: ChannelStore,
        delivery?: ChannelDelivery,
        resolveTarget?: ChannelTargetResolver,
    ) {
        this.#store = store;
        this.#delivery = delivery;
        this.#resolveTarget = resolveTarget;
    }

    /**
     * Lists active channels (or all including archived if specified).
     */
    list(includeArchived = false): Channel[] {
        return this.#store.list().filter((c) => includeArchived || !c.archived);
    }

    /**
     * Retrieves a channel by ID or normalized name (with or without #).
     */
    get(nameOrId: string | ConversationId): Channel | undefined {
        const all = this.#store.list();

        // 1. Direct match by ConversationId / number
        if (typeof nameOrId === "number") {
            return all.find((c) => Number(c.id) === nameOrId);
        }

        // 2. If it's a numeric string matching conversation ID
        if (/^\d+$/.test(nameOrId)) {
            const numericId = Number(nameOrId);
            const found = all.find((c) => Number(c.id) === numericId);

            if (found !== undefined) {
                return found;
            }
        }

        // 3. Match by channel name
        try {
            const normalized = normalizeChannelName(nameOrId);

            return all.find((c) => c.name === normalized);
        } catch {
            return undefined;
        }
    }

    /**
     * Creates a new channel. Rejects duplicates only within the creator's own unshared private channels;
     * shared groups and other users may reuse channel names freely.
     */
    async create(rawName: string, createdBy: string, options?: { cwd?: string }): Promise<Channel> {
        const name = normalizeChannelName(rawName);
        const existing = this.#store
            .list()
            .find(
                (c) =>
                    c.name === name &&
                    c.createdBy === createdBy &&
                    !c.isGroup &&
                    (!c.members || c.members.length === 0),
            );

        if (existing !== undefined) {
            throw new HttpError(409, `A channel called #${name} is already here.`);
        }

        return await this.#store.create({
            name,
            createdBy,
            cwd: options?.cwd,
        });
    }

    /**
     * Posts a message into a target channel.
     * Enforces fail-fast 404 on missing/archived channels, prevents self-posting,
     * tags message with origin, and delivers via delivery delegate.
     */
    async post(
        fromId: ConversationId,
        targetNameOrId: string | ConversationId,
        message: string,
    ): Promise<string> {
        const said = message.trim();

        if (said === "") {
            throw new HttpError(400, "Say what to post.");
        }

        const target = this.#resolveTarget
            ? this.#resolveTarget(fromId, targetNameOrId)
            : this.get(targetNameOrId);

        if (target === undefined) {
            const clean =
                typeof targetNameOrId === "string"
                    ? targetNameOrId.trim().replace(/^#/, "")
                    : String(targetNameOrId);

            throw new HttpError(404, `No live channel called #${clean} is here.`);
        }

        if (target.archived === true) {
            throw new HttpError(404, `Channel #${target.name} is archived.`);
        }

        if (Number(target.id) === Number(fromId)) {
            throw new HttpError(400, "That is this very conversation: just say it here.");
        }

        const source = this.get(fromId);

        if (this.#delivery !== undefined) {
            await this.#delivery(target, {
                fromId,
                sourceChannel: source,
                message: said,
            });
        }

        return `Posted into #${target.name} (session ${String(target.id)}). Its Pi reads it there and answers in that channel.`;
    }
}
