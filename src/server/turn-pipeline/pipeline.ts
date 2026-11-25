import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../config.ts";
import { NOTE_ENTRY } from "../entry-format.ts";
import { ownRequest } from "../requests.ts";
import { LocalCommandRegistry } from "./registry.ts";
import type {
    SubmitRequest,
    TurnSubmitOptions,
    TurnSubmitResult,
} from "./types.ts";

export interface ConversationSubmitter {
    submit(
        action: {
            type: "write";
            entry: {
                kind: string;
                data: { text: string; by: string; name: string };
                model: Array<{
                    role: "user";
                    content: Array<{ type: "text"; text: string }>;
                    timestamp: number;
                }>;
            };
            requestId: string;
        },
        context: Context,
    ): Promise<unknown>;
}

export type ConversationLookup = (
    id: ConversationId,
) => Promise<ConversationSubmitter>;

export type StandardTurnDispatcher = (
    id: ConversationId,
    actor: User,
    request: SubmitRequest,
    options?: TurnSubmitOptions,
) => Promise<TurnSubmitResult>;

export class TurnPipeline {
    readonly registry: LocalCommandRegistry;
    readonly #conversationLookup: ConversationLookup;
    readonly #standardDispatcher?: StandardTurnDispatcher;

    constructor(options: {
        registry?: LocalCommandRegistry;
        conversationLookup: ConversationLookup;
        standardDispatcher?: StandardTurnDispatcher;
    }) {
        this.registry = options.registry ?? new LocalCommandRegistry();
        this.#conversationLookup = options.conversationLookup;
        this.#standardDispatcher = options.standardDispatcher;
    }

    /**
     * Central seam for submitting turns and local commands.
     */
    async submit(
        conversationId: ConversationId,
        actor: User,
        request: SubmitRequest,
        options?: TurnSubmitOptions,
    ): Promise<TurnSubmitResult> {
        const text = request.text.trim();
        const resolved = this.registry.resolve(text);

        if (resolved !== undefined) {
            const result = await this.registry.execute(
                {
                    conversationId,
                    actor,
                    command: resolved.command,
                    args: resolved.args,
                    rawText: text,
                },
                resolved,
            );

            const prefixTag = result.prefixTag ?? resolved.command;
            const authorName = result.authorName ?? "Rule Engine";
            const reply = result.reply;

            const conversation = await this.#conversationLookup(conversationId);
            const model = [
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: `[${prefixTag}] ${reply}` }],
                    timestamp: Date.now(),
                },
            ];

            const noteRequestId = ownRequest(actor.id, `${resolved.command}-${randomUUID()}`);

            await conversation.submit(
                {
                    type: "write",
                    entry: {
                        kind: NOTE_ENTRY,
                        data: { text: reply, by: actor.id, name: authorName },
                        model,
                    },
                    requestId: noteRequestId,
                },
                BACKGROUND_CONTEXT,
            );

            return {
                submissionId: `${resolved.command}-${Date.now()}` as unknown as SubmissionId,
                requestId: request.requestId ?? randomUUID(),
                isLocalCommand: true,
            };
        }

        if (!this.#standardDispatcher) {
            throw new Error("No standard dispatcher configured for non-command turns.");
        }

        return await this.#standardDispatcher(conversationId, actor, request, options);
    }
}
