/**
 * EventConnection: deep networking engine for SSE real-time streaming,
 * fallback long polling, watchdog heartbeats, and in-band session switching.
 */

const TRANSPORT_KEY = "pocket.transport";
const POLL_FOR_MS = 60 * 60 * 1000;
const SESSION_EVENTS = new Set(["view", "chat", "notes", "presence", "browser", "missing"]);

export class EventConnection {
    #env;
    #url;
    #onEvent;
    #onStatusChange;
    #onAuthRequired;
    #switchApi;
    #checkAuth;
    #isLocal;

    #currentSource = null;
    #status = "closed";
    #pingPeriod = 15_000;
    #pingMs = 15_000;
    #heardAt = 0;
    #pings = 0;
    #watchdogTimer = null;
    #fallbackTimer = null;
    #retryTimer = null;
    #streamRetries = 0;
    #settled = false;

    // Session switching state
    #activeSession = null;
    #switchSeq = 0;
    #switching = null;

    constructor(options) {
        this.#env = {
            now: options.env?.now ?? (() => Date.now()),
            setTimeout: options.env?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
            clearTimeout: options.env?.clearTimeout ?? ((id) => clearTimeout(id)),
            setInterval: options.env?.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
            clearInterval: options.env?.clearInterval ?? ((id) => clearInterval(id)),
            EventSource:
                options.env?.EventSource ??
                (typeof EventSource !== "undefined" ? EventSource : null),
            fetch: options.env?.fetch ?? (typeof fetch !== "undefined" ? fetch : null),
            storage:
                options.env?.storage ?? (typeof localStorage !== "undefined" ? localStorage : null),
        };

        this.#url = options.url;
        this.#onEvent = options.onEvent;
        this.#onStatusChange = options.onStatusChange ?? (() => {});
        this.#onAuthRequired = options.onAuthRequired ?? (() => {});
        this.#switchApi = options.switchApi;
        this.#checkAuth = options.checkAuth;
        this.#isLocal = options.isLocal ?? (() => false);
        this.#heardAt = this.#env.now();
    }

    get status() {
        return this.#status;
    }

    get activeSession() {
        return this.#activeSession;
    }

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.#onStatusChange(status);
        }
    }

    #storageGet(key) {
        const s = this.#env.storage;

        if (!s) {
            return null;
        }

        if (typeof s.getItem === "function") {
            return s.getItem(key);
        }

        if (typeof s.get === "function") {
            return s.get(key);
        }

        return s[key] ?? null;
    }

    #storageSet(key, value) {
        const s = this.#env.storage;

        if (!s) {
            return;
        }

        if (typeof s.setItem === "function") {
            s.setItem(key, value);
        } else if (typeof s.set === "function") {
            s.set(key, value);
        } else {
            s[key] = value;
        }
    }

    #shouldPoll() {
        const raw = this.#storageGet(TRANSPORT_KEY) ?? "";
        const [mode, at] = raw.split(":");

        return mode === "poll" && this.#env.now() - Number(at) < POLL_FOR_MS;
    }

    #setPollMode() {
        this.#storageSet(TRANSPORT_KEY, `poll:${this.#env.now()}`);
    }

    isSilent(missed) {
        return this.#pingMs > 0 && this.#env.now() - this.#heardAt > this.#pingMs * missed;
    }

    wake() {
        if (this.#status === "open" && this.isSilent(1.5)) {
            this.connect();
        }
    }

    connect() {
        this.#cleanup();
        this.#switching = null;
        this.#switchSeq++;
        this.#setStatus("connecting");

        this.#heardAt = this.#env.now();
        this.#settled = false;
        this.#pings = 0;

        const usePoll = this.#shouldPoll() && !this.#isLocal();

        if (usePoll) {
            this.#startPoll();
        } else {
            this.#startStream();
        }
    }

    #startStream() {
        if (!this.#env.EventSource) {
            this.#startPoll();

            return;
        }

        const url = typeof this.#url === "function" ? this.#url(this, "stream") : this.#url;
        const events = new this.#env.EventSource(url);
        const connection = {
            close: () => {
                this.#env.clearTimeout(this.#fallbackTimer);
                this.#env.clearInterval(this.#watchdogTimer);
                events.close();
            },
        };

        this.#currentSource = connection;

        // Fallback timer: if first batch takes too long on non-local, assume tunnel buffering
        if (!this.#isLocal()) {
            this.#fallbackTimer = this.#env.setTimeout(() => {
                if (this.#settled || this.#currentSource !== connection) {
                    return;
                }

                this.#setPollMode();
                this.connect();
            }, 6000);
        }

        const startWatchdog = () => {
            this.#env.clearInterval(this.#watchdogTimer);
            this.#watchdogTimer = this.#env.setInterval(() => {
                if (this.#currentSource === connection && this.isSilent(2.5)) {
                    if (!this.#isLocal() && this.#settled && this.#pings <= 1) {
                        this.#setPollMode();
                    }

                    this.connect();
                }
            }, this.#pingMs);
        };

        if (this.#pingMs > 0) {
            startWatchdog();
        }

        events.addEventListener("ping", (event) => {
            let data = null;

            try {
                data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            } catch {
                data = null;
            }

            if (typeof data?.every === "number") {
                this.#pingPeriod = data.every;

                if (this.#pingMs !== this.#pingPeriod) {
                    this.#pingMs = this.#pingPeriod;
                    startWatchdog();
                }
            }

            this.#pings++;
            this.#heardAt = this.#env.now();
        });

        // Any custom or standard events registered on the connection
        const knownEvents = [
            "hello",
            "sessions",
            "view",
            "chat",
            "notes",
            "presence",
            "browser",
            "missing",
            "stream",
            "switched",
            "auth",
            "settings",
            "spend",
            "limits",
            "models",
            "ext",
        ];

        for (const name of knownEvents) {
            events.addEventListener(name, (event) => {
                if (this.#currentSource !== connection) {
                    return;
                }

                this.#heardAt = this.#env.now();

                let data = null;

                try {
                    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
                } catch {
                    data = event.data;
                }

                if (name === "view" || name === "sessions" || name === "missing") {
                    this.#settled = true;
                }

                if (this.#switching !== null && SESSION_EVENTS.has(name)) {
                    // Stale residual event from previous session: drop it!
                    return;
                }

                if (name === "switched") {
                    if (data?.seq === this.#switching) {
                        this.#switching = null;
                    }
                }

                this.#onEvent(name, data);
            });
        }

        events.onopen = () => {
            if (this.#currentSource !== connection) {
                return;
            }

            this.#streamRetries = 0;
            this.#setStatus("open");
        };

        events.onerror = async () => {
            if (this.#currentSource !== connection) {
                return;
            }

            this.#setStatus("closed");

            if (this.#checkAuth) {
                const authed = await this.#checkAuth().catch(() => true);

                if (authed === false) {
                    connection.close();
                    this.#onAuthRequired();

                    return;
                }
            }

            // Retry after error with backoff
            this.#env.clearTimeout(this.#fallbackTimer);
            this.#streamRetries++;
            this.#retryTimer = this.#env.setTimeout(
                () => {
                    if (this.#currentSource === connection) {
                        this.connect();
                    }
                },
                Math.min(10_000, 1000 * this.#streamRetries),
            );
        };
    }

    #startPoll() {
        let stopped = false;
        let session = null;
        let ack = 0;
        let requestController = null;

        const connection = {
            close: () => {
                stopped = true;
                requestController?.abort();

                if (session && this.#env.fetch) {
                    this.#env
                        .fetch(`/api/poll?session=${session}&close=1`, {
                            keepalive: true,
                        })
                        .catch(() => {});
                }
            },
        };

        this.#currentSource = connection;

        // Long poll loop
        (async () => {
            let failures = 0;

            while (!stopped && this.#currentSource === connection) {
                try {
                    const fetchFn = this.#env.fetch;

                    if (!fetchFn) {
                        break;
                    }

                    const raw =
                        typeof this.#url === "function" ? this.#url(this, "poll") : this.#url;
                    const query = raw.startsWith("/api/events?")
                        ? raw.slice("/api/events?".length)
                        : raw.startsWith("/api/events")
                          ? ""
                          : raw;
                    const pollUrl = `/api/poll?${query}${session ? `&session=${session}&ack=${ack}` : ""}`;

                    requestController = new AbortController();

                    const response = await fetchFn(pollUrl, {
                        signal: requestController.signal,
                        cache: "no-store",
                    });

                    if (response.status === 401) {
                        stopped = true;
                        this.#setStatus("closed");
                        this.#onAuthRequired();

                        return;
                    }

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data = await response.json();

                    if (stopped || this.#currentSource !== connection) {
                        return;
                    }

                    if (data.session !== session) {
                        session = data.session;
                        ack = 0;
                    }

                    failures = 0;
                    this.#heardAt = this.#env.now();
                    this.#setStatus("open");

                    if (Array.isArray(data.events)) {
                        for (const item of data.events) {
                            if (item.seq <= ack) {
                                continue;
                            }

                            ack = item.seq;

                            if (this.#switching !== null && SESSION_EVENTS.has(item.event)) {
                                continue;
                            }

                            if (item.event === "switched") {
                                if (item.data?.seq === this.#switching) {
                                    this.#switching = null;
                                }
                            }

                            this.#onEvent(item.event, item.data);
                        }
                    }
                } catch {
                    if (stopped || this.#currentSource !== connection) {
                        return;
                    }

                    failures++;
                    this.#setStatus("closed");
                    await new Promise((r) =>
                        this.#env.setTimeout(r, Math.min(10_000, 1000 * failures)),
                    );
                }
            }
        })();
    }

    async switchSession(conversationId, have) {
        this.#activeSession = conversationId;
        const seq = ++this.#switchSeq;

        this.#switching = seq;

        if (this.#status === "open" && this.#switchApi) {
            try {
                await this.#switchApi({
                    c: conversationId,
                    have,
                    seq,
                });
            } catch {
                if (this.#switchSeq === seq) {
                    this.connect();
                }
            }
        } else {
            this.connect();
        }
    }

    #cleanup() {
        if (this.#currentSource) {
            this.#currentSource.close();
            this.#currentSource = null;
        }

        this.#env.clearTimeout(this.#fallbackTimer);
        this.#env.clearTimeout(this.#retryTimer);
        this.#env.clearInterval(this.#watchdogTimer);
    }

    disconnect() {
        this.#cleanup();
        this.#setStatus("closed");
    }

    close() {
        this.disconnect();
    }
}
