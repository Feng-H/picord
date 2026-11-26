import type { Context } from "@earendil-works/chord/context";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../config.ts";
import type { SubmitRequest } from "../commands.ts";
import type { Attachment } from "./media.ts";

export type { Attachment, SubmitRequest };

export interface LocalCommandContext {
    conversationId: ConversationId;
    actor: User;
    command: string;
    args: string;
    rawText: string;
}

export interface LocalCommandResult {
    reply: string;
    authorName?: string;
    prefixTag?: string;
}

export interface LocalCommandHandler {
    (context: LocalCommandContext): Promise<LocalCommandResult> | LocalCommandResult;
}

export interface TurnSubmitOptions {
    via?: string;
    admission?: {
        beforeSubmit(): Promise<{ user: User; context: Context }>;
        afterSubmit(): void;
    };
    whenBusyOverride?: "steer" | "followUp";
}

export interface TurnSubmitResult {
    submissionId: SubmissionId;
    requestId: string;
    wait?: Promise<unknown>;
    isLocalCommand?: boolean;
}

export interface TurnMediaPort {
    sttConfigured(): boolean;
    readFile(path: string): Promise<Buffer>;
    transcribe(buffer: Buffer, mime: string, language?: string): Promise<string>;
    isInlineImage(file: Attachment): boolean;
    processImage(path: string, mime: string): Promise<{ image: ImageContent; note?: string }>;
}

export interface TurnContextEnrichment {
    about?: string;
    quotes?: string;
    channels?: string;
    mentionedParts?: Array<TextContent | ImageContent>;
}

export interface StandardTurnDispatchResult {
    submissionId: SubmissionId;
    wait?: Promise<unknown>;
    knownRetry: boolean;
    finalActor: User;
}

/** Narrow host capabilities required for `TurnPipeline` to execute non-local turns. */
export interface StandardTurnAdapter {
    /** Verify conversation access and driver/extension availability before executing commands or turns. */
    authorize?(conversationId: ConversationId, actor: User): Promise<void>;
    /** Look up who authored the currently active run (`null` when active without a user author, `undefined` when idle). */
    getActiveTurnAuthorId?(conversationId: ConversationId): Promise<string | null | undefined>;
    /** Expand `/skill:...` or `/prompt` templates prior to masking hidden values. */
    expandText?(conversationId: ConversationId, text: string): Promise<string> | string;
    /** Replace hidden extension secrets before persistence or model submission. */
    maskHidden?(conversationId: ConversationId, text: string): string;
    /** Verify model selection and user spend allowance, reporting whether inline images are supported. */
    prepareTurn(
        conversationId: ConversationId,
        actor: User,
    ): Promise<{ supportsImages: boolean }>;
    /** Multimodal media capabilities orchestrated by `MediaProcessor`. */
    media?: Partial<TurnMediaPort>;
    /** Wrap the written message text with speaker attribution and optional `via` marker. */
    formatBody(actor: User, written: string): string;
    /** Build auxiliary `<pocket-context>` blocks (`about`, `quotes`, `#channels`, `@files`). */
    enrichContext?(input: {
        conversationId: ConversationId;
        actor: User;
        typed: string;
        request: SubmitRequest;
        supportsImages: boolean;
    }): Promise<TurnContextEnrichment>;
    /** Persist the prepared user turn (or interrupt handoff) into Pi Durable. */
    dispatchDurable(input: {
        conversationId: ConversationId;
        actor: User;
        content: string | Array<TextContent | ImageContent>;
        whenBusy: "steer" | "followUp";
        allowInterrupt: boolean;
        requestId: string;
        via?: string;
        admission?: TurnSubmitOptions["admission"];
    }): Promise<StandardTurnDispatchResult>;
    /** Run post-commit bookkeeping (typing indicator, title touch, rule engine activity, events). */
    onCommitted?(input: {
        conversationId: ConversationId;
        actor: User;
        submissionId: SubmissionId;
        requestId: string;
        wait?: Promise<unknown>;
        knownRetry: boolean;
        typed: string;
        said: string;
        text: string;
        via?: string;
    }): Promise<void>;
    /** Deliver a session notice (`info`, `warning`, `error`). */
    notice?(
        conversationId: ConversationId,
        level: "info" | "warning" | "error",
        message: string,
    ): void;
}
