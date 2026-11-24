import { CONTEXT_BLOCK } from "./entry-format.ts";

/** A quoted excerpt submitted by a client, linking back to its original location. */
export interface QuoteOrigin {
    sessionId: number;
    entryId?: number;
    channel?: string;
    speaker?: string;
    text: string;
}

/** A verified quote with resolved session metadata. */
export interface ValidatedQuote extends QuoteOrigin {
    title: string;
    isChannel: boolean;
}

/** Verification interface for quote provenance. */
export interface QuoteValidationContext {
    canSee: (sessionId: number) => boolean;
    getSessionMeta: (sessionId: number) =>
        | {
              title?: string;
              channel?: boolean;
              archived?: boolean;
          }
        | undefined;
}

const MAX_QUOTE_TEXT = 1500;

/** Sanitize text for inclusion in context XML attributes or blocks. */
function sanitizeText(text: string, max: number): string {
    return text
        .replace(/\p{Cf}/gu, "")
        .replace(/\p{Cc}/gu, " ")
        .replace(/\s+/g, " ")
        .slice(0, max)
        .trim();
}

/**
 * Validates raw quotes against user visibility and active sessions.
 * Drops invalid or unauthorized quotes to prevent IDOR scanning.
 */
export function validateQuotes(quotes: unknown, context: QuoteValidationContext): ValidatedQuote[] {
    if (!Array.isArray(quotes)) {
        return [];
    }

    const validated: ValidatedQuote[] = [];

    for (const raw of quotes) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }

        const candidate = raw as Partial<QuoteOrigin>;
        const sessionId = candidate.sessionId;

        if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
            continue;
        }

        // IDOR Guard: User must be authorized to see the source session
        if (!context.canSee(sessionId)) {
            continue;
        }

        const meta = context.getSessionMeta(sessionId);

        if (!meta) {
            continue;
        }

        const rawText = candidate.text;

        if (typeof rawText !== "string" || rawText.trim() === "") {
            continue;
        }

        const text = sanitizeText(rawText, MAX_QUOTE_TEXT);

        if (text === "") {
            continue;
        }

        const entryId =
            typeof candidate.entryId === "number" &&
            Number.isSafeInteger(candidate.entryId) &&
            candidate.entryId >= 0
                ? candidate.entryId
                : undefined;

        const speaker =
            typeof candidate.speaker === "string" && candidate.speaker.trim() !== ""
                ? sanitizeText(candidate.speaker, 60)
                : undefined;

        const title = sanitizeText(meta.title ?? "untitled", 120);
        const isChannel = meta.channel === true;

        validated.push({
            sessionId,
            entryId,
            speaker,
            text,
            title,
            isChannel,
        });
    }

    return validated;
}

/**
 * Formats validated quotes into a structured `<pocket-context quotes>` block for the AI model.
 * Informs the agent of the exact origin and guides on-demand `session_read` usage.
 */
export function formatQuoteContextBlock(quotes: ValidatedQuote[]): string | undefined {
    if (quotes.length === 0) {
        return undefined;
    }

    const lines: string[] = [
        `${CONTEXT_BLOCK} quotes>`,
        "The quoted passage(s) in this message originate from earlier turn(s):",
    ];

    for (const quote of quotes) {
        const originLabel = quote.isChannel ? `#${quote.title}` : `session ${quote.sessionId}`;
        const entryPart = quote.entryId !== undefined ? `, entry ${quote.entryId}` : "";
        const speakerPart = quote.speaker ? `, by ${quote.speaker}` : "";

        lines.push(
            `- origin="${originLabel}" (session ${quote.sessionId}${entryPart}${speakerPart}): "${quote.text}"`,
        );

        if (quote.entryId !== undefined) {
            const minEntry = Math.max(0, quote.entryId - 5);

            lines.push(
                `  -> To inspect surrounding context around this quote, use \`session_read\` with sessionId=${quote.sessionId} and minEntryId=${minEntry}.`,
            );
        } else {
            lines.push(
                `  -> To read this session, use \`session_read\` with sessionId=${quote.sessionId}.`,
            );
        }
    }

    lines.push("</pocket-context>");

    return lines.join("\n");
}
