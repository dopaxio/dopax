import { SessionCliProviderAdapter } from "./session-cli.js";
import type { ParsedCliEvent } from "./session-cli.js";
import { containerSubdir, ensureDir, seedPathIfMissing } from "./base.js";

function opencodeParser(line: Record<string, any>): ParsedCliEvent {
    const type = String(line["type"] ?? "");
    const data = (line["data"] ?? {}) as Record<string, any>;
    const sessionId =
        (typeof line["sessionID"] === "string" && line["sessionID"])
        || (typeof line["sessionId"] === "string" && line["sessionId"])
        || undefined;

    if (type === "error") {
        const errorMessage =
            (data["message"] as string | undefined)
            || (((line["error"] as Record<string, any> | undefined)?.["data"] as Record<string, any> | undefined)?.["message"] as string | undefined)
            || ((line["error"] as Record<string, any> | undefined)?.["message"] as string | undefined)
            || JSON.stringify(line);
        return { sessionId, error: errorMessage };
    }

    if (type === "assistant.message_delta") {
        if (typeof data["deltaContent"] === "string") return { sessionId, delta: data["deltaContent"] };
        if (typeof data["delta"] === "string") return { sessionId, delta: data["delta"] };
    }

    if (type === "assistant.message") {
        if (typeof data["content"] === "string") return { sessionId, final: data["content"] };
    }

    if (type === "message" && line["role"] === "assistant" && typeof line["content"] === "string") {
        return line["delta"] ? { sessionId, delta: line["content"] as string } : { sessionId, final: line["content"] as string };
    }

    return sessionId ? { sessionId } : {};
}

export function createOpencodeProvider(): SessionCliProviderAdapter {
    return new SessionCliProviderAdapter({
        name: "opencode",
        displayName: "OpenCode",
        commandPrefixes: ["/opencode", "!opencode"],
        containerSupport: {
            supported: true,
            defaultImage: "matrix-agent-opencode-runtime:local",
            defaultWorkspaceDir: "/workspace",
            containerHomeDir: "/root",
        },
        helpLines: [
            "!opencode help",
            "!opencode version",
            "!opencode <prompt>",
        ],
        prepareContainerRuntime: async ({ hostContainerStateDir }) => {
            const containerHomeDir = "/root";
            const hostConfigDir = containerSubdir(hostContainerStateDir, ".config", "opencode");
            const hostDataDir = containerSubdir(hostContainerStateDir, ".local", "share", "opencode");
            const hostStateDir = containerSubdir(hostContainerStateDir, ".local", "state", "opencode");
            const hostCacheDir = containerSubdir(hostContainerStateDir, ".cache", "opencode");

            await Promise.all([
                ensureDir(hostConfigDir),
                ensureDir(hostDataDir),
                ensureDir(hostStateDir),
                ensureDir(hostCacheDir),
            ]);

            await Promise.all([
                seedPathIfMissing(`${process.env.HOME || ""}/.config/opencode`, hostConfigDir),
                seedPathIfMissing(`${process.env.HOME || ""}/.local/share/opencode`, hostDataDir),
                seedPathIfMissing(`${process.env.HOME || ""}/.local/state/opencode`, hostStateDir),
                seedPathIfMissing(`${process.env.HOME || ""}/.cache/opencode`, hostCacheDir),
            ]);

            return {
                env: {
                    HOME: containerHomeDir,
                    XDG_CONFIG_HOME: `${containerHomeDir}/.config`,
                    XDG_DATA_HOME: `${containerHomeDir}/.local/share`,
                    XDG_STATE_HOME: `${containerHomeDir}/.local/state`,
                    XDG_CACHE_HOME: `${containerHomeDir}/.cache`,
                },
                mounts: [
                    { hostPath: hostConfigDir, containerPath: `${containerHomeDir}/.config/opencode` },
                    { hostPath: hostDataDir, containerPath: `${containerHomeDir}/.local/share/opencode` },
                    { hostPath: hostStateDir, containerPath: `${containerHomeDir}/.local/state/opencode` },
                    { hostPath: hostCacheDir, containerPath: `${containerHomeDir}/.cache/opencode` },
                ],
                containerHomeDir,
            };
        },
        buildPromptCommand: (prompt, context, sessionId) => {
            const cmd = [
                context.config.providerBin,
                "run",
                prompt,
                "--dir",
                context.roomRuntime.cwd,
                "--format",
                "json",
            ];
            if (sessionId) {
                cmd.push("--session", sessionId);
            }
            if (context.config.providerModel) {
                cmd.push("--model", context.config.providerModel);
            }
            return cmd;
        },
        parseJsonLine: opencodeParser,
    });
}
