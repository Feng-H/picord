import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/** What voice.js imports, stood in for: hooks for one call outside a component, and no page to draw on. */
const STUBS: Record<string, string> = {
    "preact/hooks": `
        export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
        export const useRef = (current) => ({ current });
        export const useEffect = (effect, deps) => {
            globalThis.voiceEffectDeps.push(deps);
            globalThis.voiceCleanups.push(effect());
        };
    `,
    "./store.js": `export const notify = () => {}; export const store = { state: { appearance: {} } };`,
    "./ui.js": `export const html = () => null; export const Icon = () => null; export const Spinner = () => null;`,
    "./i18n.js": `export const t = (word) => word; export const uiLanguage = () => "en";`,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/voice.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

type Result = { 0: { transcript: string }; isFinal: boolean };
type Recognition = {
    onresult: ((event: { results: Result[] }) => void) | null;
    started: boolean;
};
type Dictation = { listening: boolean; toggle: () => void; stop: (drop?: boolean) => void };
type Voice = {
    useDictation: (
        box: { current: Box | null },
        onText: (value: string, at: number) => void,
        options?: { top?: boolean },
    ) => Dictation;
    toggleDictation: () => boolean;
};

const recognitions: Recognition[] = [];

(globalThis as Record<string, unknown>).voiceCleanups = [];
(globalThis as Record<string, unknown>).voiceEffectDeps = [];
(globalThis as Record<string, unknown>).document = {
    activeElement: null,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
};
(globalThis as Record<string, unknown>).SpeechRecognition = class {
    onresult = null;
    onerror = null;
    onend = null;
    started = false;

    constructor() {
        recognitions.push(this as unknown as Recognition);
    }

    start() {
        this.started = true;
    }

    stop() {
        this.started = false;
    }

    abort() {
        this.started = false;
    }
};

const voice = (await import(new URL("../web/voice.js", import.meta.url).href)) as Voice;
const page = (globalThis as unknown as { document: { activeElement: unknown } }).document;

/** A textarea as dictation sees it: setting its text puts the caret at the end, as a browser does. */
class Box {
    #value: string;
    selectionStart: number;
    selectionEnd: number;
    isConnected = true;

    constructor(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    get value() {
        return this.#value;
    }

    set value(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    /** The person types `text` at the caret. */
    type(text: string) {
        const at = this.selectionStart;

        this.value = this.#value.slice(0, at) + text + this.#value.slice(this.selectionEnd);
        this.caret(at + text.length);
    }

    caret(at: number) {
        this.setSelectionRange(at, at);
    }
}

/** Results as the browser sends them: each phrase heard, and whether it is settled. */
const said = (...phrases: [string, boolean][]): { results: Result[] } => ({
    results: phrases.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })),
});

/** Dictation started in a focused box holding `value`, with the caret at its end. */
function dictate(value = "", options?: { top?: boolean }) {
    const box = new Box(value);

    page.activeElement = box;
    const dictation = voice.useDictation({ current: box }, () => {}, options);

    dictation.toggle();
    const recognition = recognitions.at(-1)!;

    return { box, dictation, hear: (event: { results: Result[] }) => recognition.onresult!(event) };
}

/** The boxes made so far leave the page, as when their component unmounts. */
function unmountAll() {
    const cleanups = (globalThis as unknown as { voiceCleanups: (() => void)[] }).voiceCleanups;

    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
}

test("words heard show as they come, and a revision replaces them", () => {
    const { box, hear } = dictate();

    hear(said(["helo wor", false]));
    assert.equal(box.value, "Helo wor");
    hear(said(["hello world", true]));
    assert.equal(box.value, "Hello world");
    hear(said(["hello world", true], ["again", false]));
    assert.equal(box.value, "Hello world again");
    unmountAll();
});

test("a phrase still being heard finishes in place around what was typed after it", () => {
    const { box, hear } = dictate();

    hear(said(["please fix the lo", false]));
    assert.equal(box.value, "Please fix the lo");
    box.type("!");
    hear(said(["please fix the login bug", true]));
    assert.equal(box.value, "Please fix the login bug!");
    assert.equal(box.selectionStart, 25, "the caret stays after what was typed");

    // The next phrase goes where the caret is.
    hear(said(["please fix the login bug", true], ["and add a test", false]));
    assert.equal(box.value, "Please fix the login bug! And add a test");
    unmountAll();
});

test("VoiceOverlay returns null when inactive and renders when active", () => {
    const VoiceOverlay = (voice as unknown as { VoiceOverlay: (props: { active: boolean; canceling?: boolean; seconds?: number }) => unknown }).VoiceOverlay;

    assert.equal(VoiceOverlay({ active: false }), null);
    // When active, stub returns non-null or calls html()
    assert.doesNotThrow(() => VoiceOverlay({ active: true, canceling: false, seconds: 12 }));
    assert.doesNotThrow(() => VoiceOverlay({ active: true, canceling: true, seconds: 5 }));
});

test("VoiceLangButton renders without error", () => {
    const VoiceLangButton = (voice as unknown as { VoiceLangButton: (props: { disabled?: boolean }) => unknown }).VoiceLangButton;

    assert.doesNotThrow(() => VoiceLangButton({ disabled: false }));
});

test("useVoiceMessage keeps recording alive across start and sends blob on stop(true)", async () => {
    type MockRecorder = {
        mimeType: string;
        state: string;
        stream: { getTracks: () => { stop: () => void }[] };
        ondataavailable: ((event: { data: Blob }) => void) | null;
        onstop: (() => void) | null;
        start: (ms?: number) => void;
        requestData: () => void;
        stop: () => void;
    };

    const tracksStopped: number[] = [];
    const createdRecorders: MockRecorder[] = [];
    const fakeStream = {
        getTracks: () => [{ stop: () => tracksStopped.push(1) }],
    };

    (globalThis as Record<string, unknown>).MediaRecorder = class {
        static isTypeSupported = (mime: string) => mime === "audio/webm";
        mimeType: string;
        state = "inactive";
        stream: typeof fakeStream;
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;

        constructor(stream: typeof fakeStream, opts?: { mimeType?: string }) {
            this.stream = stream;
            this.mimeType = opts?.mimeType ?? "audio/webm";
            createdRecorders.push(this);
        }

        start() {
            this.state = "recording";
        }

        requestData() {
            this.ondataavailable?.({ data: new Blob(["hello-audio"], { type: "audio/webm" }) });
        }

        stop() {
            this.state = "inactive";
            this.onstop?.();
        }
    };

    Object.defineProperty(globalThis, "navigator", {
        value: {
            mediaDevices: {
                getUserMedia: () => Promise.resolve(fakeStream),
            },
        },
        configurable: true,
    });

    const effectDeps = (globalThis as unknown as { voiceEffectDeps: (unknown[] | undefined)[] })
        .voiceEffectDeps;

    effectDeps.length = 0;

    const sentBlobs: Blob[] = [];
    const useVoiceMessage = (
        voice as unknown as {
            useVoiceMessage: (onRecording: (blob: Blob) => Promise<void> | void) => {
                start: () => void;
                stop: (send?: boolean) => void;
                cancel: () => void;
            };
        }
    ).useVoiceMessage;

    const controller = useVoiceMessage((blob) => {
        sentBlobs.push(blob);
    });

    // Regression check: visibilitychange effect must mount once (`[]`) so setBegan() does not abort recording.
    assert.deepEqual(effectDeps, [[]]);

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(createdRecorders.length, 1);
    assert.equal(createdRecorders[0]!.state, "recording");

    controller.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(sentBlobs.length, 1, "recorded audio blob is handed to onRecording");
    assert.ok(sentBlobs[0]!.size > 0, "recorded audio blob is non-empty");
    assert.equal(tracksStopped.length, 1, "microphone track is released after stop");

    // Cancel must discard without calling onRecording.
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sentBlobs.length, 1, "cancel discards recording");

    // Canceling while getUserMedia is still pending stops tracks cleanly on resolution.
    let resolveMedia!: (stream: typeof fakeStream) => void;

    (globalThis.navigator as unknown as { mediaDevices: { getUserMedia: () => Promise<typeof fakeStream> } }).mediaDevices.getUserMedia =
        () =>
            new Promise((resolve) => {
                resolveMedia = resolve;
            });

    const tracksBefore = tracksStopped.length;

    controller.start();
    controller.cancel();
    resolveMedia(fakeStream);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(tracksStopped.length, tracksBefore + 1, "pending stream tracks are stopped cleanly");

    unmountAll();
});
