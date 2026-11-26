import type { User } from "../config.ts";

export interface SteeringInput {
    text: string;
    mode?: "steer" | "followUp" | "interrupt";
    actor: User;
    /**
     * Author of the active run:
     * - `string`: active run owned by that user id
     * - `null`: active run with no identifiable user owner (e.g. system/background run)
     * - `undefined`: conversation is idle / no active run check supplied
     */
    activeTurnAuthorId?: string | null;
}

export interface SteeringDirective {
    cleanedText: string;
    steerRequested: boolean;
    interruptRequested: boolean;
}

export interface SteeringDecision {
    cleanedText: string;
    whenBusy: "steer" | "followUp";
    steerRequested: boolean;
    steerGranted: boolean;
    allowInterrupt: boolean;
    reason?: string;
}

/**
 * Governs multi-user priority (`steer` / `/steer` / `!steer` and `interrupt`) on shared channels.
 * Only workspace owners or the author of the currently active turn may steer or interrupt a live run;
 * unauthorized requests from other members demote cleanly to the `followUp` queue.
 */
export class SteeringPolicy {
    /**
     * Extract priority intent (`steer` vs `interrupt`) and strip `/steer` or `!steer` command prefixes.
     */
    static parseDirective(
        rawText: string,
        mode?: "steer" | "followUp" | "interrupt",
    ): SteeringDirective {
        let text = rawText.trim();
        let steerRequested = mode === "steer";
        const interruptRequested = mode === "interrupt";

        if (text.startsWith("/steer ") || text.startsWith("!steer ")) {
            steerRequested = true;
            text = text.slice(7).trim();
        } else if (text === "/steer" || text === "!steer") {
            steerRequested = true;
            text = "";
        }

        return {
            cleanedText: text,
            steerRequested,
            interruptRequested,
        };
    }

    evaluate(input: SteeringInput): SteeringDecision {
        const { cleanedText, steerRequested, interruptRequested } = SteeringPolicy.parseDirective(
            input.text,
            input.mode,
        );
        const priorityRequested = steerRequested || interruptRequested;

        if (!priorityRequested) {
            return {
                cleanedText,
                whenBusy: "followUp",
                steerRequested: false,
                steerGranted: false,
                allowInterrupt: false,
            };
        }

        // Authority validation:
        // 1. Owners/administrators may always steer or interrupt.
        // 2. When idle (`undefined`), anyone may submit cleanly; when active (`string` or unowned `null`),
        //    only the matching author (never `null`) may steer or interrupt.
        const isOwner = input.actor.role === "owner";
        const isIdle = input.activeTurnAuthorId === undefined;
        const isTurnAuthor =
            typeof input.activeTurnAuthorId === "string" &&
            input.activeTurnAuthorId === input.actor.id;

        if (isOwner || isIdle || isTurnAuthor) {
            return {
                cleanedText,
                whenBusy: "steer",
                steerRequested: true,
                steerGranted: true,
                allowInterrupt: interruptRequested,
            };
        }

        return {
            cleanedText,
            whenBusy: "followUp",
            steerRequested: true,
            steerGranted: false,
            allowInterrupt: false,
            reason: "Only administrators or the original author may steer or interrupt an ongoing response; queued as follow-up.",
        };
    }
}
