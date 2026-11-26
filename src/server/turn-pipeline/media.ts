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
    sttEnabled?: boolean;
    modelSupportsImages?: boolean;
    isInlineImage?: (file: Attachment) => boolean;
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

        // 1. Audio Processing with Graceful Degradation (bounded to 4 clips concurrently)
        const audioFiles = attachments.filter(
            (file) => file.mime?.startsWith("audio/") && file.size <= MAX_STT_SIZE,
        );

        if (audioFiles.length > 0 && input.sttEnabled !== false && transcribe && readFile) {
            const audioResults = await Promise.all(
                audioFiles.slice(0, 4).map(async (file) => {
                    try {
                        const buffer = await readFile(file.path);
                        const words = (
                            await transcribe(buffer, file.mime, input.audioLanguage)
                        ).trim();

                        return words === "" ? undefined : { transcript: `🎙 ${words}` };
                    } catch (error) {
                        const warning = `Could not transcribe ${file.name}: ${describe(error)}`;

                        onNotice?.("warning", warning);

                        // Graceful degradation: preserve warning banner so user & agent see transcription failed
                        return {
                            transcript: `[warning: audio transcription unavailable for ${file.name}]`,
                            warning,
                        };
                    }
                }),
            );

            for (const entry of audioResults) {
                if (!entry) {
                    continue;
                }

                audioTranscripts.push(entry.transcript);

                if (entry.warning !== undefined) {
                    degradationWarnings.push(entry.warning);
                }
            }
        }

        // 2. Image Processing with Graceful Degradation
        const imageParts: ImageContent[] = [];
        const notes = new Map<Attachment, string>();

        if (input.modelSupportsImages && processImage) {
            const imageFilter =
                input.isInlineImage ?? ((file: Attachment) => file.mime?.startsWith("image/") === true);
            const imageFiles = attachments.filter(imageFilter);
            const imageResults = await Promise.all(
                imageFiles.map(async (file) => {
                    try {
                        const result = await processImage(file.path, file.mime);

                        return { file, image: result.image, note: result.note };
                    } catch (error) {
                        const warning = `Could not attach ${file.name}: ${describe(error)}`;

                        onNotice?.("warning", warning);

                        return {
                            file,
                            warning,
                            note: "[image processing failed, kept original file]",
                        };
                    }
                }),
            );

            for (const entry of imageResults) {
                if (entry.image !== undefined) {
                    imageParts.push(entry.image);
                }

                if (entry.note !== undefined) {
                    notes.set(entry.file, entry.note);
                }

                if (entry.warning !== undefined) {
                    degradationWarnings.push(entry.warning);
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
