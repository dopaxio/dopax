import { SessionCliProviderAdapter } from "./session-cli.js";
import type { ParsedCliEvent } from "./session-cli.js";
import { containerSubdir, ensureDir, pathExists, seedPathIfMissing } from "./base.js";

function joinTextBlocks(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (!item || typeof item !== "object") return "";
                const record = item as Record<string, unknown>;
                return typeof record["text"] === "string" ? record["text"] : "";
            })
            .filter(Boolean)
            .join("");
    }
    return "";
}

function claudeParser(line: Record<string, any>): ParsedCliEvent {
    if (line["type"] === "system" && line["subtype"] === "init") {
        return { sessionId: typeof line["session_id"] === "string" ? line["session_id"] : undefined };
    }
    if (line["type"] === "assistant") {
        const message = line["message"] as Record<string, any> | undefined;
        const text = joinTextBlocks(message?.["content"]);
        const error = typeof line["error"] === "string" ? line["error"] : undefined;
        return {
            sessionId: typeof line["session_id"] === "string" ? line["session_id"] : undefined,
            ...(text ? { final: text } : {}),
            ...(error ? { error } : {}),
        };
    }
    if (line["type"] === "result") {
        return {
            sessionId: typeof line["session_id"] === "string" ? line["session_id"] : undefined,
            ...(typeof line["result"] === "string" ? { final: line["result"] } : {}),
            ...(line["is_error"] && typeof line["result"] === "string" ? { error: line["result"] } : {}),
        };
    }
    return {};
}

export function createClaudeProvider(): SessionCliProviderAdapter {
    return new SessionCliProviderAdapter({
        name: "claude",
        displayName: "Claude",
        commandPrefixes: ["/claude", "!claude"],
        containerSupport: {
            supported: true,
            defaultImage: "matrix-agent-claude-runtime:local",
            defaultWorkspaceDir: "/workspace",
            containerHomeDir: "/root",
        },
        helpLines: [
            "!claude help",
            "!claude version",
            "!claude <prompt>",
        ],
        prepareContainerRuntime: async ({ config, hostContainerStateDir }) => {
            const containerHomeDir = "/root";
            const claudeDir = containerSubdir(hostContainerStateDir, ".claude");
            const claudeJsonPath = containerSubdir(hostContainerStateDir, ".claude.json");
            await ensureDir(claudeDir);
            await seedPathIfMissing(config.containerSeedHome ?? containerSubdir(process.env.HOME || "", ".claude"), claudeDir);
            await seedPathIfMissing(
                config.containerSeedHome ? null : containerSubdir(process.env.HOME || "", ".claude.json"),
                claudeJsonPath,
            );

            const mounts = [
                { hostPath: claudeDir, containerPath: `${containerHomeDir}/.claude` },
            ];
            if (await pathExists(claudeJsonPath)) {
                mounts.push({ hostPath: claudeJsonPath, containerPath: `${containerHomeDir}/.claude.json` });
            }

            return {
                env: {
                    HOME: containerHomeDir,
                },
                mounts,
                containerHomeDir,
            };
        },
        buildPromptCommand: (prompt, context, sessionId) => {
            const cmd = [
                context.config.providerBin,
                "-p",
                prompt,
                "--verbose",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--dangerously-skip-permissions",
                "--add-dir",
                context.roomRuntime.cwd,
            ];
            if (sessionId) {
                cmd.push("--resume", sessionId);
            }
            if (context.config.providerModel) {
                cmd.push("--model", context.config.providerModel);
            }
            return cmd;
        },
        parseJsonLine: claudeParser,
    });
}
