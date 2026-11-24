import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    type QuoteOrigin,
    type QuoteValidationContext,
    validateQuotes,
    formatQuoteContextBlock,
} from "../src/server/quote-provenance.ts";

describe("Quote Provenance Subsystem", () => {
    const mockContext: QuoteValidationContext = {
        canSee: (id) => id !== 999, // 999 is private/forbidden
        getSessionMeta: (id) => {
            if (id === 1) {
                return { title: "general", channel: true };
            }

            if (id === 2) {
                return { title: "Task discussion", channel: false };
            }

            if (id === 999) {
                return { title: "Secret Admin", channel: true };
            }

            return undefined; // 404
        },
    };

    it("validates valid quotes and extracts metadata", () => {
        const rawQuotes: QuoteOrigin[] = [
            {
                sessionId: 1,
                entryId: 42,
                text: "We should use port 8790",
                speaker: "alice",
            },
            {
                sessionId: 2,
                text: "Refactor completed yesterday",
            },
        ];

        const validated = validateQuotes(rawQuotes, mockContext);

        assert.equal(validated.length, 2);
        assert.equal(validated[0]!.sessionId, 1);
        assert.equal(validated[0]!.entryId, 42);
        assert.equal(validated[0]!.title, "general");
        assert.equal(validated[0]!.isChannel, true);
        assert.equal(validated[0]!.speaker, "alice");

        assert.equal(validated[1]!.sessionId, 2);
        assert.equal(validated[1]!.entryId, undefined);
        assert.equal(validated[1]!.title, "Task discussion");
        assert.equal(validated[1]!.isChannel, false);
    });

    it("drops unauthorized sessions to prevent IDOR probing", () => {
        const rawQuotes: QuoteOrigin[] = [
            {
                sessionId: 999, // forbidden
                text: "Top secret credentials",
            },
            {
                sessionId: 1,
                text: "Public announcement",
            },
        ];

        const validated = validateQuotes(rawQuotes, mockContext);

        assert.equal(validated.length, 1);
        assert.equal(validated[0]!.sessionId, 1);
    });

    it("drops non-existent sessions and invalid payloads", () => {
        const rawQuotes = [
            { sessionId: 404, text: "Ghost session" },
            { sessionId: -1, text: "Negative ID" },
            { sessionId: "not a number", text: "Invalid type" },
            { sessionId: 1, text: "   " }, // Empty text
            null,
            undefined,
            "random string",
        ] as unknown as QuoteOrigin[];

        const validated = validateQuotes(rawQuotes, mockContext);

        assert.equal(validated.length, 0);
    });

    it("generates structured <pocket-context quotes> block for AI model", () => {
        const rawQuotes: QuoteOrigin[] = [
            {
                sessionId: 1,
                entryId: 50,
                text: "Deploy to production tonight",
                speaker: "bob",
            },
        ];

        const validated = validateQuotes(rawQuotes, mockContext);
        const block = formatQuoteContextBlock(validated);

        assert.ok(block !== undefined);
        assert.ok(block.startsWith("<pocket-context quotes>"));
        assert.ok(block.includes('origin="#general"'));
        assert.ok(block.includes("session 1"));
        assert.ok(block.includes("entry 50"));
        assert.ok(block.includes("Deploy to production tonight"));
        assert.ok(block.includes("session_read"));
        assert.ok(block.endsWith("</pocket-context>"));
    });

    it("returns undefined when no valid quotes are present", () => {
        assert.equal(formatQuoteContextBlock([]), undefined);
    });
});
