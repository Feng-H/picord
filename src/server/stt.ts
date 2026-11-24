import { HttpError } from "./errors.ts";

/** Groq's own cap for this endpoint; past it the request is refused before it leaves the server. */
export const MAX_STT = 25 * 1024 * 1024;

/** The Whisper model to transcribe with: the fast one, at a friendly price. */
const MODEL = "whisper-large-v3-turbo";

/** Whether audio can be transcribed here: a Groq key is set. */
export const sttConfigured = (): boolean =>
    process.env.GROQ_API_KEY !== undefined && process.env.GROQ_API_KEY !== "";

/**
 * The language to hear audio as, from what a person picked ("zh", "de", "en"…): a short code, and none for the
 * model's own guess ("auto", or anything else), which mistakes short or accented speech for a neighboring tongue.
 */
export const sttLanguage = (value: string | null | undefined): string => {
    const said = (value ?? "").trim().toLowerCase();

    return /^[a-z]{2,3}$/.test(said) ? said : "";
};

/** The upload's name: Groq reads an audio file's format from its extension, so it follows the type. */
function speechName(type: string): string {
    if (type.includes("mp4")) {
        return "speech.m4a";
    }

    if (type.includes("ogg")) {
        return "speech.ogg";
    }

    if (type.includes("wav")) {
        return "speech.wav";
    }

    if (type.includes("mpeg")) {
        return "speech.mp3";
    }

    return "speech.webm";
}

/**
 * The words the server's speech-to-text hears in the audio (raw bytes, as the browser recorded them). Throws an
 * HttpError when the service cannot be reached or refuses the audio; an empty string when it hears nothing.
 */
export async function transcribeAudio(audio: Buffer, mime: string, language = ""): Promise<string> {
    const key = process.env.GROQ_API_KEY;

    if (key === undefined || key === "") {
        throw new HttpError(501, "Server speech-to-text is not configured on this server");
    }

    const type = mime === "" || mime === "application/octet-stream" ? "audio/webm" : mime;
    const form = new FormData();

    form.append("file", new Blob([new Uint8Array(audio)], { type }), speechName(type));
    form.append("model", MODEL);
    form.append("response_format", "json");

    const said = sttLanguage(language);

    if (said !== "") {
        form.append("language", said);
    }

    let out: Response;

    try {
        out = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${key}` },
            body: form,
        });
    } catch (error) {
        throw new HttpError(
            502,
            `Could not reach the speech-to-text service: ${(error as Error).message}`,
        );
    }

    if (!out.ok) {
        const detail = (await out.text().catch(() => "")).slice(0, 200);
        const code = out.status === 429 ? 429 : 502;

        throw new HttpError(
            code,
            `Transcription failed (${out.status})${detail === "" ? "" : `: ${detail}`}`,
        );
    }

    const data = (await out.json().catch(() => ({}))) as { text?: string };

    return String(data.text ?? "");
}
