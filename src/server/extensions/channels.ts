// The postman between channels: a message handed here goes into the other channel as a message of its own, and that
// channel's Pi reads it there and answers in its own voice. Without it, what one channel concludes stays inside it.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { PocketHost } from "../host.ts";

export default function createChannels(host: PocketHost) {
    const post = defineTool({
        name: "channel_post",
        description:
            "Post a message into another channel of this server: it arrives there as a message, and that channel's Pi reads it and answers in its own channel. Use it to hand work over, to answer a channel that asked here, or to share what this channel concluded. Write the message for that channel's readers; say in it where you are posting from.",
        parameters: obj({
            channel: str({
                description: "The channel's name (without #), or its session number",
            }),
            message: str({ description: "The message to post" }),
        }),
        execute: async (args, api) => ({
            output: [
                {
                    type: "text" as const,
                    text: await host.channels.post(api.conversationId, args.channel, args.message),
                },
            ],
        }),
    });

    return defineExtension({ name: "channels", tools: [post] });
}
