import { SessionCliProviderAdapter } from "./session-cli.js";
import type { ParsedCliEvent } from "./session-cli.js";
import { ensureDir, extractProviderErrorMessage, seedPathIfMissing } from "./base.js";

function geminiParser(line: Record<string, any>): ParsedCliEvent {
    if (line["type"] === "init") {
        return { sessionId: typeof line["session_id"] === "string" ? line["session_id"] : undefined };
    }
    if (line["type"] === "message" && line["role"] === "assistant") {
        const content = typeof line["content"] === "string" ? line["content"] : "";
        if (content) {
            if (line["delta"]) return { delta: content };
            return { final: content };
        }
    }
    if (line["type"] === "result" && line["status"] && line["status"] !== "success") {
        return { error: extractProviderErrorMessage(line) ?? JSON.stringify(line) };
    }
    return {};
}

export function createGeminiProvider(): SessionCliProviderAdapter {
    return new SessionCliProviderAdapter({
        name: "gemini",
        displayName: "Gemini",
        commandPrefixes: ["/gemini", "!gemini"],
        containerSupport: {
            supported: true,
            defaultImage: "matrix-agent-gemini-runtime:local",
            defaultWorkspaceDir: "/workspace",
            containerHomeDir: "/root",
        },
        helpLines: [
            "!gemini help",
            "!gemini version",
            "!gemini <prompt>",
        ],
        prepareContainerRuntime: async ({ config, hostContainerStateDir }) => {
            const containerHomeDir = "/root";
            await ensureDir(hostContainerStateDir);
            await seedPathIfMissing(config.containerSeedHome, hostContainerStateDir);
            return {
                env: {
                    HOME: containerHomeDir,
                },
                mounts: [
                    {
                        hostPath: hostContainerStateDir,
                        containerPath: `${containerHomeDir}/.gemini`,
                    },
                ],
                containerHomeDir,
            };
        },
        buildPromptCommand: (prompt, context, sessionId) => {
            const cmd = [
                context.config.providerBin,
                "-p",
                prompt,
                "--output-format",
                "stream-json",
                "--approval-mode",
                "yolo",
                "--include-directories",
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
        parseJsonLine: geminiParser,
    });
}
