import type { LocalCommandHandler, LocalCommandContext, LocalCommandResult } from "./types.ts";

export class LocalCommandRegistry {
    readonly #handlers = new Map<string, LocalCommandHandler>();

    /**
     * Register a prefix command handler.
     * E.g. register("/rule", handler) or register("rule", handler).
     */
    register(commandPrefix: string, handler: LocalCommandHandler): void {
        const normalized = this.#normalize(commandPrefix);

        if (normalized === "") {
            throw new Error("Command prefix cannot be empty.");
        }

        this.#handlers.set(normalized, handler);
    }

    /**
     * Check if a text begins with a registered prefix command.
     * If matched, returns handler, canonical command name, and arguments.
     */
    resolve(
        text: string,
    ): { handler: LocalCommandHandler; command: string; args: string } | undefined {
        const trimmed = text.trim();

        if (!trimmed.startsWith("/")) {
            return undefined;
        }

        const spaceIdx = trimmed.indexOf(" ");
        const rawCmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const normalizedCmd = this.#normalize(rawCmd);
        const handler = this.#handlers.get(normalizedCmd);

        if (!handler) {
            return undefined;
        }

        const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

        return {
            handler,
            command: normalizedCmd,
            args,
        };
    }

    /**
     * Executes a resolved command within a context.
     */
    async execute(
        context: LocalCommandContext,
        resolved: { handler: LocalCommandHandler; command: string; args: string },
    ): Promise<LocalCommandResult> {
        return await resolved.handler(context);
    }

    #normalize(prefix: string): string {
        const trimmed = prefix.trim().toLowerCase();

        return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    }
}
