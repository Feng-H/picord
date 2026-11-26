import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../config.ts";
import { ATTACHMENTS_HEADING, NOTE_ENTRY } from "../entry-format.ts";
import { HttpError } from "../errors.ts";
import { clientKey, ownRequest, requestFor } from "../requests.ts";
import { MediaProcessor } from "./media.ts";
import { LocalCommandRegistry } from "./registry.ts";
import { SteeringPolicy } from "./steering.ts";
import type {
    StandardTurnAdapter,
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

export interface TurnPipelineOptions {
    registry?: LocalCommandRegistry;
    conversationLookup: ConversationLookup;
    standard?: StandardTurnAdapter;
    mediaProcessor?: MediaProcessor;
    steeringPolicy?: SteeringPolicy;
}

/**
 * Single authoritative deep-module seam for submitting local commands and standard turns.
 */
export class TurnPipeline {
    readonly registry: LocalCommandRegistry;
    readonly #conversationLookup: ConversationLookup;
    readonly #standard?: StandardTurnAdapter;
    readonly #mediaProcessor: MediaProcessor;
    readonly #steeringPolicy: SteeringPolicy;

    constructor(options: TurnPipelineOptions) {
        this.registry = options.registry ?? new LocalCommandRegistry();
        this.#conversationLookup = options.conversationLookup;
        this.#standard = options.standard;
        this.#mediaProcessor = options.mediaProcessor ?? new MediaProcessor();
        this.#steeringPolicy = options.steeringPolicy ?? new SteeringPolicy();
    }

    /**
     * Submit a user turn or registered local prefix command (`/`).
     */
    async submit(
        conversationId: ConversationId,
        actor: User,
        request: SubmitRequest,
        options?: TurnSubmitOptions,
    ): Promise<TurnSubmitResult> {
        if (this.#standard?.authorize) {
            await this.#standard.authorize(conversationId, actor);
        }

        const rawTyped = request.text.trim();
        const resolved = this.registry.resolve(rawTyped);

        if (resolved !== undefined) {
            return await this.#submitLocalCommand(conversationId, actor, request, rawTyped, resolved);
        }

        if (!this.#standard) {
            throw new Error("No standard turn adapter configured for non-command turns.");
        }

        return await this.#submitStandardTurn(
            conversationId,
            actor,
            request,
            rawTyped,
            this.#standard,
            options,
        );
    }

    async #submitLocalCommand(
        conversationId: ConversationId,
        actor: User,
        request: SubmitRequest,
        rawText: string,
        resolved: NonNullable<ReturnType<LocalCommandRegistry["resolve"]>>,
    ): Promise<TurnSubmitResult> {
        const result = await this.registry.execute(
            {
                conversationId,
                actor,
                command: resolved.command,
                args: resolved.args,
                rawText,
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

    async #submitStandardTurn(
        conversationId: ConversationId,
        actor: User,
        request: SubmitRequest,
        rawTyped: string,
        adapter: StandardTurnAdapter,
        options?: TurnSubmitOptions,
    ): Promise<TurnSubmitResult> {
        const directive = SteeringPolicy.parseDirective(rawTyped, request.mode);
        const typed = directive.cleanedText;
        const mask = (value: string): string =>
            adapter.maskHidden ? adapter.maskHidden(conversationId, value) : value;
        const expanded = adapter.expandText ? await adapter.expandText(conversationId, typed) : typed;
        const text = mask(expanded);
        const attachments = request.attachments ?? [];

        if (text === "" && attachments.length === 0) {
            throw new HttpError(400, "Nothing to send");
        }

        const { supportsImages } = await adapter.prepareTurn(conversationId, actor);
        const mediaPort = adapter.media;
        const sttEnabled = mediaPort?.sttConfigured ? mediaPort.sttConfigured() : false;

        const media = await this.#mediaProcessor.process({
            text,
            attachments,
            audioLanguage: request.audioLanguage,
            sttEnabled,
            modelSupportsImages: supportsImages,
            isInlineImage: mediaPort?.isInlineImage,
            readFile: mediaPort?.readFile,
            transcribe: sttEnabled ? mediaPort?.transcribe : undefined,
            processImage: mediaPort?.processImage,
            onNotice: (level, message) => adapter.notice?.(conversationId, level, message),
        });

        const written =
            media.attachmentLines.length === 0
                ? media.said
                : `${media.said}${ATTACHMENTS_HEADING}${media.attachmentLines.join("\n")}`;
        const body = adapter.formatBody(
            actor,
            options?.via === undefined ? written : `[via ${options.via}] ${written}`,
        );

        const enrichment = adapter.enrichContext
            ? await adapter.enrichContext({
                  conversationId,
                  actor,
                  typed,
                  request,
                  supportsImages,
              })
            : {};

        const parts: Array<TextContent | ImageContent> = [
            { type: "text", text: body },
            ...(enrichment.mentionedParts ?? []).map((part) =>
                part.type === "text" ? { ...part, text: mask(part.text) } : part,
            ),
            ...(enrichment.about === undefined
                ? []
                : [{ type: "text" as const, text: enrichment.about }]),
            ...(enrichment.quotes === undefined
                ? []
                : [{ type: "text" as const, text: enrichment.quotes }]),
            ...(enrichment.channels === undefined
                ? []
                : [{ type: "text" as const, text: enrichment.channels }]),
            ...media.imageParts,
        ];

        const content = parts.length === 1 ? body : parts;

        // Evaluate multi-user steering/interrupt authority right before durable dispatch to minimize TOCTOU
        // across STT/image processing and avoid emitting queue notices on failed preparations.
        const priorityRequested = directive.steerRequested || directive.interruptRequested;
        const activeTurnAuthorId = priorityRequested
            ? await adapter.getActiveTurnAuthorId?.(conversationId)
            : undefined;
        const requestedMode = directive.interruptRequested
            ? "interrupt"
            : directive.steerRequested
              ? "steer"
              : request.mode;
        const steering = this.#steeringPolicy.evaluate({
            text: typed,
            mode: requestedMode,
            actor,
            activeTurnAuthorId,
        });
        const whenBusy = options?.whenBusyOverride ?? steering.whenBusy;

        if (steering.steerRequested && !steering.steerGranted && steering.reason !== undefined) {
            adapter.notice?.(conversationId, "warning", steering.reason);
        }

        const requestId =
            options?.via === undefined
                ? ownRequest(actor.id, clientKey(request.requestId))
                : requestFor(actor.id, clientKey(request.requestId));

        const dispatched = await adapter.dispatchDurable({
            conversationId,
            actor,
            text: media.said,
            content,
            whenBusy,
            allowInterrupt: steering.allowInterrupt && options?.via === undefined,
            requestId,
            via: options?.via,
            admission: options?.admission,
        });

        await adapter.onCommitted?.({
            conversationId,
            actor: dispatched.finalActor,
            submissionId: dispatched.submissionId,
            requestId,
            wait: dispatched.wait,
            knownRetry: dispatched.knownRetry,
            typed,
            said: media.said,
            text,
            via: options?.via,
        });

        return {
            submissionId: dispatched.submissionId,
            requestId,
            wait: dispatched.wait,
            isLocalCommand: false,
        };
    }
}
