import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type { User } from "../config.ts";
import type { SubmitRequest } from "../commands.ts";

export type { SubmitRequest };

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
        beforeSubmit(): Promise<{ user: User; context: unknown }>;
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
