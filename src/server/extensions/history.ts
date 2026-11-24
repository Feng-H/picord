// The archive cabinet: the original words behind a compaction summary, found by words. A summary keeps the shape of a
// long conversation and loses its details; this tool reads the entries themselves, here or across every session, so a
// question about yesterday — or anything the visible context does not hold — is answered from what was said.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { PocketHost } from "../host.ts";

export default function createHistory(host: PocketHost) {
    const search = Object.assign(
        defineTool({
            name: "search_history",
            description:
                "Search the original transcript for words from earlier: this conversation's every entry, or every session's. Summaries of a long conversation drop details; this reads what was actually said. Call it before you answer a question about past details, 'yesterday', or anything the visible context does not hold.",
            parameters: obj({
                query: str({ description: "The words to find (case-insensitive, any language)" }),
                scope: opt(
                    str({
                        description:
                            '"current" (default): this conversation. "all": every session. Or a session number.',
                    }),
                ),
                limit: opt(
                    num({ description: "How many matches to show (default 10, at most 25)" }),
                ),
            }),
            replay: "safe",
            execute: async (args, api) => ({
                output: [
                    {
                        type: "text" as const,
                        text: await host.history.search(
                            api.conversationId,
                            args.query,
                            args.scope,
                            args.limit,
                        ),
                    },
                ],
            }),
        }),
        { annotations: { readOnlyHint: true } },
    );

    return defineExtension({ name: "history", tools: [search] });
}
