import test from "node:test";
import assert from "node:assert/strict";
import { MediaProcessor, type Attachment } from "../src/server/turn-pipeline/media.ts";

test("MediaProcessor transcribes audio successfully", async () => {
    const processor = new MediaProcessor({
        transcribe: async () => "Hello from voice input",
        readFile: async () => Buffer.from("audio bytes"),
    });

    const audioFile: Attachment = {
        path: "/tmp/voice.ogg",
        name: "voice.ogg",
        mime: "audio/ogg",
        size: 1024,
    };

    const result = await processor.process({
        text: "User original text",
        attachments: [audioFile],
    });

    assert.equal(
        result.said,
        "User original text\n🎙 Hello from voice input",
    );
    assert.equal(result.degradationWarnings.length, 0);
    assert.equal(result.attachmentLines.length, 1);
});

test("MediaProcessor gracefully degrades when audio transcription fails", async () => {
    const warnings: string[] = [];
    const processor = new MediaProcessor({
        transcribe: async () => {
            throw new Error("STT network timeout");
        },
        readFile: async () => Buffer.from("audio bytes"),
    });

    const audioFile: Attachment = {
        path: "/tmp/voice.ogg",
        name: "voice.ogg",
        mime: "audio/ogg",
        size: 1024,
    };

    const result = await processor.process({
        text: "Important message from user",
        attachments: [audioFile],
        onNotice: (_level, text) => warnings.push(text),
    });

    // Verifies graceful degradation: user text is NOT lost!
    assert.ok(result.said.includes("Important message from user"));
    assert.ok(result.said.includes("[warning: audio transcription unavailable for voice.ogg]"));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes("Could not transcribe voice.ogg"));
});

test("MediaProcessor gracefully degrades when image processing fails", async () => {
    const warnings: string[] = [];
    const processor = new MediaProcessor({
        processImage: async () => {
            throw new Error("Corrupted PNG payload");
        },
    });

    const imgFile: Attachment = {
        path: "/tmp/broken.png",
        name: "broken.png",
        mime: "image/png",
        size: 2048,
    };

    const result = await processor.process({
        text: "Look at this picture",
        attachments: [imgFile],
        modelSupportsImages: true,
        onNotice: (_level, text) => warnings.push(text),
    });

    assert.equal(result.imageParts.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes("Could not attach broken.png"));
    assert.ok(result.attachmentLines[0]?.includes("[image processing failed, kept original file]"));
});
