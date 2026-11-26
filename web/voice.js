// Dictation into a message box, with the browser's own speech recognition (the Web Speech API). Words show in the box
// as they are heard and stay once the browser settles on them; nothing is ever sent by itself. Chrome sends the audio
// to Google's servers to be recognised; Safari on iOS has it too; Firefox has none, and there the mic does not show.
import { useEffect, useRef, useState } from "preact/hooks";
import { notify, store } from "./store.js";
import { t } from "./i18n.js";
import { html, Icon, Spinner } from "./ui.js";

/** The browser's recognizer, looked up when used (so a page can stand one in), or undefined where there is none. */
const Recognizer = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

/** Whether the mic can work here: a recognizer, and a page browsers give the microphone to (https, or this machine). */
/** Whether the mic can work here: the server's Whisper (me.stt), or a recognizer on a page given the microphone. */
export const voiceAvailable = () =>
    globalThis.isSecureContext !== false &&
    (typeof Recognizer() === "function" || (store.state.me?.stt ?? false));

/** What each of the recognizer's errors means for the person; those not here are named as they are. */
const ERRORS = {
    "not-allowed": "The microphone is blocked. Allow it for this site in the browser's settings.",
    "service-not-allowed": "This browser does not allow dictation here.",
    "no-speech": "No speech heard. Tap the mic and try again.",
    "audio-capture": "No microphone found.",
    network: "Dictation needs the network: the browser recognises speech on its own servers.",
    "language-not-supported": "This browser cannot recognise your language.",
};

/** The dictation that listens now: one at a time, in the whole app. */
let current = null;
/**
 * The boxes that can dictate, newest last. The shortcut (Alt+V) dictates into PiP's while it shows (its box is `top`),
 * else into the newest in the page: one gone for now (view only, someone else's turn) is passed over.
 */
const boxes = [];

/** Alt+V: start or stop dictation in PiP's box or the newest; false when no box can. */
export function toggleDictation() {
    const shown = (each) => each.box.current?.isConnected === true;
    const box = boxes.findLast((each) => each.top && shown(each)) ?? boxes.findLast(shown);

    if (!box || !voiceAvailable()) {
        return false;
    }

    box.toggle();

    return true;
}

/**
 * How long the starts of `a` and `b` agree, and their ends, each on its own: an edit that repeats what is beside it
 * ("H" typed before "Hello") fits both ways, and either way it is outside what agrees.
 */
function common(a, b) {
    let head = 0;

    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }

    let tail = 0;

    while (
        tail < a.length &&
        tail < b.length &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }

    return { head, tail };
}

/** Words heard, put between what the box has before and after them, with a space where words would touch. */
function join(before, words, after) {
    if (words === "") {
        return { value: before + after, at: before.length };
    }

    const start = /\S$/.test(before) ? " " : "";
    const end = /^[^\s.,;:!?)]/.test(after) ? " " : "";
    // A sentence's first word starts with a capital, as the browser leaves some in lower case.
    const capital = before.trim() === "" || /[.!?]\s*$/.test(before);
    const said = capital ? words[0].toUpperCase() + words.slice(1) : words;
    const head = before + start + said;

    return { value: head + end + after, at: head.length };
}

/**
 * Dictation into a textarea (`box`, a ref). `onText(value, caret)` hears each change, as typing does, so the box's own
 * draft saving keeps it. Words go in at the caret while the box has the focus, and after its text when it does not.
 * Returns whether it listens, and `toggle` and `stop` (`stop(true)` drops words not yet settled: for sending, leaving).
 * `top` marks PiP's box, which takes Alt+V while it shows. `place(value, start, end)` may move where words go from the
 * selection `start`..`end`: it gives back `{ text, start, end }` (the text may change, a line added for them), or null
 * to leave them there (the session's box keeps them out of a quote).
 */
export function useDictation(box, onText, { top = false, place = null, onError = null } = {}) {
    const [listening, setListening] = useState(false);
    const hear = useRef(onText);
    const where = useRef(place);
    const self = useRef(null);

    hear.current = onText;
    where.current = place;

    if (self.current === null) {
        self.current = {
            box,
            top,
            onError,
            recognition: null,
            recorder: null,
            /** Stop listening: `drop` throws away what is not settled yet, and anything heard after. */
            stop(drop = false) {
                void releaseWakeLock();

                if (this.recorder) {
                    const recorder = this.recorder;

                    if (drop) {
                        this.recorder = null;
                    }

                    recorder.stop();

                    return;
                }

                const recognition = this.recognition;

                if (!recognition) {
                    return;
                }

                this.recognition = null;
                setListening(false);

                if (current === this) {
                    current = null;
                }

                if (drop) {
                    recognition.onresult = null;
                    recognition.abort();
                } else {
                    recognition.stop();
                }
            },
            start() {
                const element = box.current;
                const Recognition = Recognizer();
                // The server's Whisper path: any browser that can record audio, whenever it is configured.
                const server = store.state.me?.stt === true;

                // A read-only box's words are not to change (a send on its way holds them).
                if (
                    !element ||
                    element.readOnly ||
                    (server === false && typeof Recognition !== "function")
                ) {
                    return;
                }

                if (server) {
                    return this.startRecording();
                }

                current?.stop();
                current = this;

                const recognition = new Recognition();

                recognition.lang = navigator.language || "en-US";
                recognition.continuous = true;
                recognition.interimResults = true;
                this.recognition = recognition;

                // What the box had around the words, the results already in it, and the box as dictation left it: its
                // text and its selection. `pending` is the first result not settled yet, and `span` where its words are.
                let base = null;
                let from = 0;
                let seen = 0;
                let written = "";
                let selection = [0, 0];
                let pending = 0;
                let span = [0, 0];
                // The person moved on while words were still coming: those finish where they are, then words go where
                // the person is.
                let moving = false;

                const focused = () => document.activeElement === element;
                const selected = () => [element.selectionStart, element.selectionEnd];

                const rebase = () => {
                    const at = focused() ? element.selectionStart : element.value.length;
                    const end = focused() ? element.selectionEnd : at;
                    const placed = where.current?.(element.value, at, end) ?? {
                        text: element.value,
                        start: at,
                        end,
                    };

                    base = {
                        before: placed.text.slice(0, placed.start),
                        after: placed.text.slice(placed.end),
                    };
                    from = seen;
                    moving = false;
                };

                rebase();
                written = element.value;
                selection = selected();

                /**
                 * Typed into, or the caret moved, since the words last went in. Outside the words still coming, those
                 * finish where they are, around what the person did; on them, the person's edit wins, and what is heard
                 * next goes where the caret is.
                 */
                const changed = () => {
                    const value = element.value;
                    const [s, e] = span;
                    const { head, tail } = common(written, value);
                    // Where the edit was in what dictation wrote: after the words coming (they are in the start that
                    // agrees), or before them (in the end that agrees).
                    const after = value === written || head >= e;
                    const before = !after && written.length - tail <= s;

                    if (pending >= seen || !(after || before)) {
                        rebase();

                        return;
                    }

                    const shift = before ? value.length - written.length : 0;

                    base = { before: value.slice(0, s + shift), after: value.slice(e + shift) };
                    from = pending;
                    moving = true;
                };

                recognition.onresult = (event) => {
                    const results = event.results;

                    if (
                        element.value !== written ||
                        (focused() && selected().some((at, index) => at !== selection[index]))
                    ) {
                        changed();
                    }

                    // What is settled, then what may still change, from the first result not settled on.
                    let first = from;

                    while (first < results.length && results[first].isFinal) {
                        first++;
                    }

                    const said = (start, end) => {
                        const words = [];

                        for (let index = start; index < end; index++) {
                            words.push(results[index][0].transcript.trim());
                        }

                        return words.filter(Boolean).join(" ");
                    };

                    const settled = said(from, first);
                    const coming = said(first, results.length);
                    const all = [settled, coming].filter(Boolean).join(" ");
                    const { value, at } = join(base.before, all, base.after);
                    // Where the words still coming start: after the settled ones and a space, or where all start.
                    const start =
                        settled === ""
                            ? base.before.length + (all !== "" && /\S$/.test(base.before) ? 1 : 0)
                            : join(base.before, settled, base.after).at + (coming === "" ? 0 : 1);
                    // Where the text after the words ends up: the person's selection there moves with it.
                    const was = element.value.length - base.after.length;
                    const now = value.length - base.after.length;
                    const person = selected();

                    seen = results.length;
                    pending = first;
                    span = [start, at];
                    written = value;
                    element.value = value;

                    if (focused()) {
                        const place = (point) =>
                            point >= was ? point + now - was : Math.min(point, now);

                        if (moving) {
                            element.setSelectionRange(place(person[0]), place(person[1]));
                        } else {
                            element.setSelectionRange(at, at);
                        }
                    }

                    selection = selected();
                    hear.current(value, moving ? selection[1] : at);

                    // The words left behind are all settled: what comes next goes where the person is.
                    if (moving && first === results.length) {
                        rebase();
                    }
                };

                recognition.onerror = (event) => {
                    // Aborted is this app's own doing; no speech for a while ends a quiet dictation, said once.
                    if (event.error !== "aborted") {
                        const level = event.error === "no-speech" ? "info" : "error";
                        const said = ERRORS[event.error];

                        notify(
                            level,
                            said === undefined ? t("Dictation stopped: $", event.error) : t(said),
                        );
                    }
                };

                recognition.onend = () => {
                    if (this.recognition === recognition) {
                        this.stop();
                    }
                };

                try {
                    void requestWakeLock();
                    recognition.start();
                    setListening(true);
                } catch (error) {
                    this.recognition = null;
                    current = null;
                    notify("error", t("Dictation did not start: $", error.message ?? error));
                }
            },
            toggle() {
                if (this.recorder || this.recognition) {
                    this.stop();
                } else {
                    this.start();
                }
            },

            /** Record into a chunked MediaRecorder; the transcription lands when the person stops. */
            startRecording() {
                if (typeof MediaRecorder === "undefined" || navigator.mediaDevices === undefined) {
                    notify("error", t("This browser cannot record audio for dictation."));

                    return;
                }

                const mime =
                    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((each) =>
                        MediaRecorder.isTypeSupported(each),
                    ) ?? "";

                if (mime === "") {
                    notify("error", t("This browser cannot record audio for dictation."));

                    return;
                }

                navigator.mediaDevices
                    .getUserMedia({ audio: true })
                    .then((stream) => {
                        const recorder = new MediaRecorder(stream, { mimeType: mime });
                        const chunks = [];

                        recorder.ondataavailable = (event) => {
                            if (event.data.size > 0) {
                                chunks.push(event.data);
                            }
                        };

                        recorder.onstop = () => {
                            stream.getTracks().forEach((track) => track.stop());

                            if (this.recorder !== recorder) {
                                return;
                            }

                            this.recorder = null;

                            this.transcribe(new Blob(chunks, { type: mime }));
                        };

                        this.recorder = recorder;
                        void requestWakeLock();
                        recorder.start();
                        setListening(true);
                    })
                    .catch(() => {
                        notify(
                            "error",
                            "No microphone found, or its use is blocked for this site.",
                        );
                    });
            },

            /** The recording goes to the server's Whisper, and the words land where dictation would put them. */
            async transcribe(blob) {
                const element = this.box.current;

                try {
                    const lang = voiceLanguage();
                    const out = await fetch(lang === "" ? "/api/stt" : `/api/stt?lang=${lang}`, {
                        method: "POST",
                        headers: { "content-type": blob.type || "audio/webm", "x-pocket": "1" },
                        body: blob,
                    });

                    if (!out.ok) {
                        const data = await out.json().catch(() => undefined);
                        const message = data?.error ?? t("Transcription failed ($).", out.status);

                        notify(out.status === 501 ? "info" : "error", message);

                        return;
                    }

                    const data = await out.json();
                    const words = String(data.text ?? "").trim();

                    if (element === null || element.readOnly) {
                        return;
                    }

                    if (words === "") {
                        notify("info", "No speech heard. Tap the mic and try again.");

                        return;
                    }

                    const focused = () => document.activeElement === element;
                    const at = focused() ? element.selectionStart : element.value.length;
                    const end = focused() ? element.selectionEnd : at;
                    const placed = this.where.current?.(element.value, at, end) ?? {
                        text: element.value,
                        start: at,
                        end,
                    };
                    const { value, at: caret } = join(
                        placed.text.slice(0, placed.start),
                        words,
                        placed.text.slice(placed.end),
                    );

                    element.value = value;
                    element.setSelectionRange(caret, caret);
                    this.hear.current(value, caret);
                } catch (error) {
                    notify("error", t("Dictation failed: $", error.message ?? error));
                } finally {
                    setListening(false);
                }
            },
        };
    }

    const dictation = self.current;

    // The newest box takes the shortcut while it shows; leaving it ends dictation, as does the tab going out of sight.
    useEffect(() => {
        const hidden = () => document.hidden && dictation.stop();

        boxes.push(dictation);
        document.addEventListener("visibilitychange", hidden);

        return () => {
            boxes.splice(boxes.indexOf(dictation), 1);
            document.removeEventListener("visibilitychange", hidden);
            dictation.stop(true);
        };
    }, []);

    return {
        listening,
        toggle: () => dictation.toggle(),
        stop: (drop) => dictation.stop(drop),
    };
}

/** The mic: starts dictation, and while it listens, stops it. None where the browser cannot recognise speech. */
export function MicButton({ dictation, class: className = "", size = 17, part, disabled = false }) {
    if (!voiceAvailable()) {
        return null;
    }

    const { listening, toggle } = dictation;

    return html`<button
        type="button"
        class=${`icon-button mic-button ${listening ? "listening" : ""} ${className}`}
        data-part=${part}
        aria-label="Dictate"
        aria-pressed=${listening ? "true" : "false"}
        title=${listening ? t("Listening: tap to stop (Alt+V)") : t("Dictate (Alt+V)")}
        disabled=${disabled}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${toggle}
    >
        <${Icon} name="mic" size=${size} />
    </button>`;
}

/**
 * A voice message records: `toggle` starts, and the next tap ends the recording and hands it to `onRecording` to send;
 * `cancel` drops it. The tab going out of sight drops a recording under way. Whether this browser can record at all
 * (`MediaRecorder` and the microphone on a page given to it) says `voiceRecording`.
 */
export const voiceRecording = () =>
    globalThis.isSecureContext !== false &&
    typeof MediaRecorder === "function" &&
    navigator.mediaDevices !== undefined;

let activeWakeLock = null;

/**
 * Acquire a screen wake lock to prevent the device from sleeping during recording.
 */
export async function requestWakeLock() {
    try {
        if ("wakeLock" in navigator && typeof navigator.wakeLock?.request === "function") {
            activeWakeLock = await navigator.wakeLock.request("screen");
            activeWakeLock.addEventListener?.("release", () => {
                activeWakeLock = null;
            });
        }
    } catch {
        activeWakeLock = null;
    }
}

/**
 * Release the active screen wake lock.
 */
export async function releaseWakeLock() {
    try {
        if (activeWakeLock) {
            await activeWakeLock.release();
            activeWakeLock = null;
        }
    } catch {}
}

export function useVoiceMessage(onRecording) {
    const [state, setState] = useState("idle"); // A recording under way, or not.
    const [began, setBegan] = useState(0); // When the recording began, for the time beside its mic.
    const hear = useRef(onRecording);
    const self = useRef(null);

    hear.current = onRecording;

    if (self.current === null) {
        self.current = {
            recorder: null,
            mime: "",
            chunks: [],
            began: 0,
            starting: false,
            pendingStop: null,
            startGen: 0,
            /** End the recording: `send` hands it on, anything else drops it. */
            stop(send) {
                void releaseWakeLock();

                if (this.starting) {
                    this.pendingStop = send ? "send" : "cancel";

                    return;
                }

                const recorder = this.recorder;

                if (!recorder || recorder.state === "inactive") {
                    return;
                }

                this.recorder = null;
                this.began = 0;

                const chunks = this.chunks;
                const mime = this.mime;
                // What the recording ends as: heard once only — some browsers, iOS among them, never fire the stop.
                let over = false;

                const once = () => {
                    if (over) {
                        return;
                    }

                    over = true;

                    for (const track of recorder.stream?.getTracks?.() ?? []) {
                        track.stop();
                    }

                    if (send && chunks.some((chunk) => chunk.size > 0)) {
                        // The recording goes out: the mic shows it going until it has.
                        setState("sending");

                        Promise.resolve(
                            hear.current(
                                new Blob(chunks, {
                                    type: (mime || "audio/webm").split(";")[0],
                                }),
                            ),
                        )
                            .catch(() => {})
                            .finally(() => setState("idle"));
                    } else {
                        setState("idle");

                        if (send) {
                            notify(
                                "info",
                                "The recording came out empty. Tap the mic and try again.",
                            );
                        }
                    }
                };

                recorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        chunks.push(event.data);
                    }
                };

                recorder.onstop = once;

                try {
                    recorder.requestData?.();
                } catch {}

                try {
                    recorder.stop();
                } catch {
                    once();
                }

                // If the stop never lands, the recording still goes.
                setTimeout(once, 2000);
            },
            start() {
                if (this.starting || this.recorder) {
                    return;
                }

                const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((each) =>
                    MediaRecorder.isTypeSupported(each),
                );

                this.starting = true;
                this.pendingStop = null;
                const gen = ++this.startGen;

                navigator.mediaDevices
                    .getUserMedia({ audio: true })
                    .then((stream) => {
                        this.starting = false;

                        if (gen !== this.startGen || this.pendingStop !== null) {
                            const action = this.pendingStop;

                            this.pendingStop = null;

                            for (const track of stream.getTracks?.() ?? []) {
                                track.stop();
                            }

                            if (action === "send") {
                                notify(
                                    "info",
                                    "The recording came out empty. Tap the mic and try again.",
                                );
                            }

                            return;
                        }

                        const recorder = mime
                            ? new MediaRecorder(stream, { mimeType: mime })
                            : new MediaRecorder(stream);

                        // A slice every 250ms: even brief voice clips capture chunks reliably (iOS Safari included).
                        this.mime = recorder.mimeType || mime || "audio/webm";
                        this.chunks = [];

                        recorder.ondataavailable = (event) => {
                            if (event.data.size > 0) {
                                this.chunks.push(event.data);
                            }
                        };

                        this.recorder = recorder;
                        this.began = Date.now();
                        recorder.start(250);
                        void requestWakeLock();
                        setBegan(this.began);
                        setState("recording");
                    })
                    .catch(() => {
                        this.starting = false;
                        this.pendingStop = null;
                        notify(
                            "error",
                            "No microphone found, or its use is blocked for this site.",
                        );
                    });
            },
        };
    }

    useEffect(() => {
        const hidden = () => {
            if (document.hidden && (self.current?.recorder || self.current?.starting)) {
                // If recording has been active for more than 500ms, preserve and send it rather than discarding
                const elapsed = self.current.began > 0 ? Date.now() - self.current.began : 0;

                self.current.stop(elapsed >= 500);
            }
        };

        document.addEventListener("visibilitychange", hidden);

        return () => {
            document.removeEventListener("visibilitychange", hidden);
            self.current.stop(false);
        };
    }, []);

    return {
        state,
        began,
        start: () => self.current.start(),
        stop: (send = true) => self.current.stop(send),
        toggle: () => (self.current.recorder ? self.current.stop(true) : self.current.start()),
        cancel: () => self.current.stop(false),
    };
}

/** What the mic's language chip reads now, with what hearing goes as. */
const voiceLangNow = () => {
    const said = voiceLanguage() || "auto";

    return VOICE_LANGS.find(([code]) => code === said) ?? VOICE_LANGS[0];
};

/** The next language for voice messages, and it stays for the recordings to come. The theme is imported late:
 * this file loads in Node for its tests, and the theme touches the document there. */
const cycleVoiceLanguage = async () => {
    const at = VOICE_LANGS.findIndex(([code]) => code === (voiceLanguage() || "auto"));
    const next = VOICE_LANGS[(at + 1) % VOICE_LANGS.length] ?? VOICE_LANGS[0];

    const { setPrefs } = await import("./theme.js");

    setPrefs({ voiceLang: next[0] });

    return next;
};

/** A recording's clock reads seconds as m:ss. */
const voiceClock = (seconds) =>
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The languages a voice message can be heard as: the code the server takes, its name, and what the chip reads. */
const VOICE_LANGS = [
    ["auto", "the transcription's own guess", "AUTO"],
    ["zh", "Chinese", "中"],
    ["en", "English", "EN"],
    ["de", "German", "DE"],
];

/** The person's language for voice messages, as the server takes it: none for its own guess. */
export const voiceLanguage = () => {
    const said = String(store.state.appearance?.voiceLang ?? "auto")
        .trim()
        .toLowerCase();

    return /^[a-z]{2,3}$/.test(said) ? said : "";
};

/** The language switch chip for voice messages. */
export function VoiceLangButton({ disabled = false }) {
    const lang = voiceLangNow();

    return html`<button
        type="button"
        class="voice-lang"
        aria-label=${t("Voice message language: $", t(lang[1]))}
        title=${t("Voice message language: $", t(lang[1]))}
        disabled=${disabled}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${() => void cycleVoiceLanguage()}
    >
        ${lang[2]}
    </button>`;
}

/**
 * The voice message's mic: starts a recording, and while it records, ends it and sends it. While it records, the
 * time it has been going stands before it, and a cross behind it drops the recording.
 */
export function VoiceButton({ voice, class: className = "", size = 17, part, disabled = false }) {
    const { state, began } = voice;
    const recording = state === "recording";
    const sending = state === "sending";
    const [, tick] = useState(0);

    useEffect(() => {
        if (!recording) {
            return;
        }

        const timer = setInterval(() => tick((each) => each + 1), 1000);

        return () => clearInterval(timer);
    }, [recording]);

    return html`<span class="voice-live">
        <${VoiceLangButton} disabled=${sending} />
        ${
            recording &&
            html`<span class="voice-clock" aria-hidden="true">
                ${voiceClock(Math.max(0, Math.floor((Date.now() - began) / 1000)))}
            </span>`
        }
        <button
            type="button"
            class=${`icon-button mic-button ${recording ? "listening" : ""} ${className}`}
            data-part=${part}
            aria-label=${sending ? t("Sending the voice message") : t("Voice message")}
            aria-pressed=${recording ? "true" : "false"}
            title=${
                recording
                    ? t("Recording: tap to send")
                    : sending
                      ? t("Sending the recording…")
                      : t("Record a voice message")
            }
            disabled=${disabled || sending}
            onMouseDown=${(event) => event.preventDefault()}
            onClick=${voice.toggle}
        >
            ${sending ? html`<${Spinner} hidden=${true} />` : html`<${Icon} name="mic" size=${size} />`}
        </button>
        ${
            recording &&
            html`<button
                type="button"
                class="icon-button voice-cancel"
                aria-label=${t("Drop the recording")}
                title=${t("Drop the recording")}
                disabled=${disabled}
                onMouseDown=${(event) => event.preventDefault()}
                onClick=${voice.cancel}
            >
                <${Icon} name="close" size=${14} />
            </button>`
        }
    </span>`;
}

/**
 * Mobile Push-to-Talk Recording Overlay (WeChat / Telegram style).
 * Shows pulsing microphone waves, timer, and cancel warning when user slides up.
 */
export function VoiceOverlay({ active, canceling, seconds = 0 }) {
    if (!active) {
        return null;
    }

    const clock = voiceClock(seconds);

    return html`<div class="voice-overlay-backdrop" onContextMenu=${(e) => e.preventDefault()}>
        <div class=${`voice-overlay-card ${canceling ? "canceling" : ""}`}>
            <div class="voice-overlay-icon-wrap">
                <${Icon} name=${canceling ? "close" : "mic"} size=${36} />
            </div>
            <div class="voice-overlay-waves">
                <span class="wave wave-1"></span>
                <span class="wave wave-2"></span>
                <span class="wave wave-3"></span>
            </div>
            <div class="voice-overlay-timer">${clock}</div>
            <div class="voice-overlay-tip">
                ${canceling ? t("Release to cancel") : t("Release to send, slide up to cancel")}
            </div>
        </div>
    </div>`;
}
