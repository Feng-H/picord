export type ConnectionStatus = "connecting" | "open" | "stale" | "closed";

export interface ConnectionEnv {
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => any;
    clearTimeout?: (id: any) => void;
    setInterval?: (fn: () => void, ms: number) => any;
    clearInterval?: (id: any) => void;
    EventSource?: any;
    fetch?: typeof fetch;
    storage?: {
        getItem?: (key: string) => string | null;
        setItem?: (key: string, value: string) => void;
        get?: (key: string) => string | null;
        set?: (key: string, value: string) => void;
        [key: string]: any;
    } | null;
}

export interface SwitchPayload {
    c: number | string;
    have?: unknown;
    seq: number;
}

export interface EventConnectionOptions {
    env?: ConnectionEnv;
    url: string | ((conn: EventConnection, transport: "stream" | "poll") => string);
    onEvent: (name: string, data: any) => void;
    onStatusChange?: (status: ConnectionStatus) => void;
    onAuthRequired?: () => void;
    switchApi?: (payload: SwitchPayload) => Promise<unknown>;
    checkAuth?: () => Promise<boolean>;
    isLocal?: () => boolean;
}

export declare class EventConnection {
    constructor(options: EventConnectionOptions);
    get status(): ConnectionStatus;
    get activeSession(): number | string | null;
    isSilent(missed: number): boolean;
    wake(): void;
    connect(): void;
    switchSession(conversationId: number | string, have?: unknown): Promise<void>;
    disconnect(): void;
    close(): void;
}
