import type { User } from "../config.ts";

export interface SteeringInput {
    text: string;
    mode?: "steer" | "followUp" | "interrupt";
    actor: User;
    activeTurnAuthorId?: string;
}

export interface SteeringDecision {
    cleanedText: string;
    whenBusy: "steer" | "followUp";
    steerRequested: boolean;
    steerGranted: boolean;
    reason?: string;
}

export class SteeringPolicy {
    evaluate(input: SteeringInput): SteeringDecision {
        let text = input.text.trim();
        let steerRequested = input.mode === "steer";

        // Check explicit prefix directive: /steer or !steer
        if (text.startsWith("/steer ") || text.startsWith("!steer ")) {
            steerRequested = true;
            text = text.slice(7).trim();
        } else if (text === "/steer" || text === "!steer") {
            steerRequested = true;
            text = "";
        }

        if (!steerRequested) {
            return {
                cleanedText: text,
                whenBusy: "followUp",
                steerRequested: false,
                steerGranted: false,
            };
        }

        // Authority validation:
        // 1. Administrators / owners can always steer.
        // 2. The author of the active turn being answered can steer.
        // 3. If there is no active turn running, steering is granted.
        const isOwner = input.actor.role === "owner";
        const isTurnAuthor =
            input.activeTurnAuthorId === undefined ||
            input.activeTurnAuthorId === input.actor.id;

        if (isOwner || isTurnAuthor) {
            return {
                cleanedText: text,
                whenBusy: "steer",
                steerRequested: true,
                steerGranted: true,
            };
        }

        // Unauthorized actor attempting to interrupt another user's response:
        // Demote to sequential queue!
        return {
            cleanedText: text,
            whenBusy: "followUp",
            steerRequested: true,
            steerGranted: false,
            reason: "Only administrators or the original author may steer an ongoing response.",
        };
    }
}
