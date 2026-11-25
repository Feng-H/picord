import type { ImageContent } from "@earendil-works/pi-ai";
import { describe } from "../errors.ts";

export type Attachment = { path: string; name: string; mime: string; size: number };

export type AudioTranscriber = (
    buffer: Buffer,
    mime: string,
    language?: string,
) => Promise<string>;

export type AudioFileReader = (path: string) => Promise<Buffer>;

export type ImageProcessor = (
    path: string,
    mime: string,
) => Promise<{ image: ImageContent; note?: string }>;

export type NoticeCallback = (
    level: "warning" | "error" | "info",
    text: string,
) => void;

export interface MediaProcessInput {
    text: string;
    attachments?: Attachment[];
    audioLanguage?: string;
    modelSupportsImages?: boolean;
    readFile?: AudioFileReader;
    transcribe?: AudioTranscriber;
    processImage?: ImageProcessor;
    onNotice?: NoticeCallback;
}

export interface MediaProcessResult {
    said: string;
    attachmentLines: string[];
    imageParts: ImageContent[];
    degradationWarnings: string[];
}

export const MAX_STT_SIZE = 25 * 1024 * 1024; // 25 MB

export class MediaProcessor {
    readonly #defaultTranscribe?: AudioTranscriber;
    readonly #defaultImageProcessor?: ImageProcessor;
    readonly #defaultFileReader?: AudioFileReader;

    constructor(options?: {
        transcribe?: AudioTranscriber;
        processImage?: ImageProcessor;
        readFile?: AudioFileReader;
    }) {
        this.#defaultTranscribe = options?.transcribe;
        this.#defaultImageProcessor = options?.processImage;
        this.#defaultFileReader = options?.readFile;
    }

    async process(input: MediaProcessInput): Promise<MediaProcessResult> {
        const text = input.text.trim();
        const attachments = input.attachments ?? [];
        const readFile = input.readFile ?? this.#defaultFileReader;
        const transcribe = input.transcribe ?? this.#defaultTranscribe;
        const processImage = input.processImage ?? this.#defaultImageProcessor;
        const onNotice = input.onNotice;

        const degradationWarnings: string[] = [];
        const audioTranscripts: string[] = [];

        // 1. Audio Processing with Graceful Degradation
        const audioFiles = attachments.filter(
            (file) => file.mime?.startsWith("audio/") && file.size <= MAX_STT_SIZE,
        );

        if (audioFiles.length > 0 && transcribe && readFile) {
            for (const file of audioFiles.slice(0, 4)) {
                try {
                    const buffer = await readFile(file.path);
                    const words = (await transcribe(buffer, file.mime, input.audioLanguage)).trim();

                    if (words !== "") {
                        audioTranscripts.push(`🎙 ${words}`);
                    }
                } catch (error) {
                    const warning = `Could not transcribe ${file.name}: ${describe(error)}`;

                    degradationWarnings.push(warning);
                    onNotice?.("warning", warning);
                    // Graceful degradation: append warning banner into transcript so user is aware
                    audioTranscripts.push(`[warning: audio transcription unavailable for ${file.name}]`);
                }
            }
        }

        // 2. Image Processing with Graceful Degradation
        const imageParts: ImageContent[] = [];
        const notes = new Map<Attachment, string>();

        if (input.modelSupportsImages && processImage) {
            const imageFiles = attachments.filter((file) =>
                file.mime?.startsWith("image/"),
            );

            for (const file of imageFiles) {
                try {
                    const result = await processImage(file.path, file.mime);

                    imageParts.push(result.image);

                    if (result.note !== undefined) {
                        notes.set(file, result.note);
                    }
                } catch (error) {
                    const warning = `Could not attach ${file.name}: ${describe(error)}`;

                    degradationWarnings.push(warning);
                    onNotice?.("warning", warning);
                    notes.set(file, "[image processing failed, kept original file]");
                }
            }
        }

        // Combine text + audio transcripts
        const heard = audioTranscripts.join("\n");
        let said = text;

        if (heard !== "") {
            said = text === "" ? heard : `${text}\n${heard}`;
        }

        // Attachment lines
        const attachmentLines = attachments.map((file) => {
            const note = notes.get(file);
            const line = `- ${file.path} (${file.name}, ${file.mime || "unknown type"}, ${file.size} bytes)`;

            return note === undefined ? line : `${line} ${note}`;
        });

        return {
            said,
            attachmentLines,
            imageParts,
            degradationWarnings,
        };
    }
}
