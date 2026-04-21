import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../config.js";
import { execCommand, spawnCommand } from "../executable.js";
import { buildProviderCommand } from "../runtime.js";
import { saveConversationSessions } from "../state.js";
import {
    buildTurnPrompt,
    ensureDir,
    extractProviderErrorMessage,
    getStoredSessionId,
    MatrixStreamPublisher,
    persistSessionState,
    seedPathIfMissing,
    stripPrefixedCommand,
    truncateText,
} from "./base.js";
import type {
    ContainerSupport,
    PreparedContainerRuntime,
    ProviderAdapter,
    ProviderCapabilities,
    ProviderCommandContext,
    ProviderReplyContext,
} from "./base.js";

class AppServerSession {
    private readonly process;
    private readonly stdin;
    private readonly stdoutLines: Array<string | null> = [];
    private readonly stderrLines: Array<string | null> = [];
    private waiters: Array<(line: string | null) => void> = [];
    private nextId = 1;

    public constructor(private readonly config: AgentConfig, context: ProviderReplyContext) {
        const wrapped = buildProviderCommand(this.config, context.roomRuntime, this.config.providerBin, ["app-server"]);
        this.process = spawnCommand(wrapped.command, {
            cwd: wrapped.hostCwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdin = this.process.stdin;
        const stdoutStream = this.process.stdout;
        const stderrStream = this.process.stderr;
        if (!stdin || !stdoutStream || !stderrStream) {
            throw new Error("codex app-server missing stdio pipes");
        }
        this.stdin = stdin;

        const stdout = createInterface({ input: stdoutStream });
        const stderr = createInterface({ input: stderrStream });

        stdout.on("line", (line) => this.enqueue(this.stdoutLines, line));
        stderr.on("line", (line) => this.enqueue(this.stderrLines, line));
        stdoutStream.on("close", () => this.enqueue(this.stdoutLines, null));
        stderrStream.on("close", () => this.enqueue(this.stderrLines, null));
    }

    private enqueue(queue: Array<string | null>, line: string | null): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(line);
        } else {
            queue.push(line);
        }
    }

    private async readStdoutLine(timeoutMs: number): Promise<string> {
        if (this.stdoutLines.length > 0) {
            const line = this.stdoutLines.shift();
            if (line === null || line === undefined) {
                throw new Error(`codex app-server exited (${this.process.exitCode})`);
            }
            return line;
        }

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out waiting for codex output")), timeoutMs);
            this.waiters.push((line) => {
                clearTimeout(timer);
                if (line === null) {
                    reject(new Error(`codex app-server exited (${this.process.exitCode})`));
                } else {
                    resolve(line);
                }
            });
        });
    }

    private drainStderr(): void {
        while (this.stderrLines.length > 0) {
            const line = this.stderrLines.shift();
            if (line) {
                console.log(`[matrix-agent-ts] codex stderr: ${line}`);
            }
        }
    }

    private async readStdoutJson(timeoutSec: number): Promise<Record<string, any>> {
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() < deadline) {
            this.drainStderr();
            const line = await this.readStdoutLine(Math.max(100, deadline - Date.now()));
            if (!line.trim()) continue;
            try {
                return JSON.parse(line) as Record<string, any>;
            } catch {
                console.log(`[matrix-agent-ts] invalid codex stdout line: ${line}`);
            }
        }

        throw new Error("Timed out waiting for codex JSON");
    }

    private send(payload: Record<string, any>): void {
        this.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    public notify(method: string, params?: Record<string, any>): void {
        this.send(params ? { method, params } : { method });
    }

    public async request(
        method: string,
        params: Record<string, any>,
        onNotification: (message: Record<string, any>) => Promise<void> | void,
        timeoutSec: number,
    ): Promise<Record<string, any>> {
        const requestId = this.nextId++;
        this.send({ id: requestId, method, params });

        while (true) {
            const message = await this.readStdoutJson(timeoutSec);
            if (message["id"] === requestId) {
                if (message["error"]) {
                    throw new Error(
                        extractProviderErrorMessage(message["error"]) || JSON.stringify(message["error"]),
                    );
                }
                return (message["result"] ?? {}) as Record<string, any>;
            }
            await onNotification(message);
        }
    }

    public async listenUntilTurnCompleted(
        onNotification: (message: Record<string, any>) => Promise<void> | void,
    ): Promise<void> {
        const deadline = Date.now() + this.config.codexTurnTimeoutSec * 1000;
        while (Date.now() < deadline) {
            const message = await this.readStdoutJson(
                Math.max(1, (deadline - Date.now()) / 1000),
            );
            if (message["method"] === "turn/completed") return;
            await onNotification(message);
        }

        throw new Error("Codex turn did not complete in time");
    }

    public async close(): Promise<void> {
        this.stdin.end();
        if (this.process.exitCode === null) {
            this.process.kill("SIGTERM");
        }
    }
}

function parseCommonCliOptions(args: string[]): {
    cwd: string;
    model: string | null;
    ephemeral: boolean;
    rest: string[];
} | { error: string } {
    let cwd = "";
    let model: string | null = null;
    let ephemeral = false;
    let index = 0;

    while (index < args.length) {
        const token = args[index];
        if (token === "--cd" || token === "-C") {
            if (index + 1 >= args.length) return { error: "Missing directory argument for --cd" };
            cwd = args[index + 1];
            index += 2;
            continue;
        }
        if (token === "--model" || token === "-m") {
            if (index + 1 >= args.length) return { error: "Missing model name for --model" };
            model = args[index + 1];
            index += 2;
            continue;
        }
        if (token === "--ephemeral") {
            ephemeral = true;
            index += 1;
            continue;
        }
        break;
    }

    return { cwd, model, ephemeral, rest: args.slice(index) };
}

async function runCodexCliCommand(
    command: string[],
    cwd: string,
    timeoutSec: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execCommand(command, {
            cwd,
            timeout: timeoutSec * 1000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return { code: 0, stdout, stderr };
    } catch (error: any) {
        return {
            code: typeof error?.code === "number" ? error.code : 1,
            stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "",
            stderr: typeof error?.stderr === "string" ? error.stderr.trim() : String(error?.message ?? error),
        };
    }
}

function splitCommandLine(input: string): string[] {
    return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
}

export class CodexProviderAdapter implements ProviderAdapter {
    public readonly name = "codex" as const;
    public readonly displayName = "Codex";
    public readonly commandPrefixes = ["/codex", "!codex"];

    public getCapabilities(config: ProviderCommandContext["config"]): ProviderCapabilities {
        return {
            sessionKind: "thread",
            streaming: true,
            tools: true,
            approvals: config.codexApprovalPolicy !== "never",
            vendorCommands: true,
            roomModes: {
                shared: true,
                workspace: true,
                container: this.getContainerSupport(config).supported,
            },
        };
    }

    public getContainerSupport(_config: ProviderCommandContext["config"]): ContainerSupport {
        return {
            supported: true,
            defaultImage: "matrix-agent-codex-runtime:local",
            defaultWorkspaceDir: "/workspace",
            containerHomeDir: "/root",
        };
    }

    public async prepareContainerRuntime(
        config: ProviderCommandContext["config"],
        hostContainerStateDir: string,
    ): Promise<PreparedContainerRuntime> {
        const containerHomeDir = "/root";
        await ensureDir(hostContainerStateDir);
        await seedPathIfMissing(config.containerSeedHome, hostContainerStateDir);
        return {
            env: {
                HOME: containerHomeDir,
                CODEX_HOME: `${containerHomeDir}/.codex`,
            },
            mounts: [
                {
                    hostPath: hostContainerStateDir,
                    containerPath: `${containerHomeDir}/.codex`,
                },
            ],
            containerHomeDir,
        };
    }

    public getCommandHelp(): string[] {
        return [
            "!codex help",
            "!codex version",
            "!codex exec [--cd DIR] [--model MODEL] [--ephemeral] <prompt>",
            "!codex review [--cd DIR] [--base BRANCH | --commit SHA | --uncommitted] [--title TITLE] [prompt]",
        ];
    }

    public async handleChatCommand(body: string, context: ProviderCommandContext): Promise<string | null> {
        const stripped = stripPrefixedCommand(body, this.commandPrefixes);
        if (stripped === null) return null;

        let parts = splitCommandLine(stripped);
        if (parts.length === 0) {
            parts = ["help"];
        }

        const [command, ...args] = parts;

        if (command === "help" || command === "?" || command === "commands") {
            return [
                "Available commands:",
                ...this.getCommandHelp(),
                "The /codex prefix also works, but some clients intercept unknown slash commands first.",
            ].join("\n");
        }

        if (command === "version" || command === "--version" || command === "-V") {
            const result = await runCodexCliCommand(
                buildProviderCommand(
                    context.config,
                    context.roomRuntime,
                    context.config.providerBin,
                    ["--version"],
                ).command,
                buildProviderCommand(
                    context.config,
                    context.roomRuntime,
                    context.config.providerBin,
                    ["--version"],
                ).hostCwd,
                context.config.cliCommandTimeoutSec,
            );
            return truncateText(result.stdout || result.stderr || "Failed to fetch Codex version.", context.config.commandResultLimit);
        }

        if (command === "exec") {
            const parsed = parseCommonCliOptions(args);
            if ("error" in parsed) return parsed.error;

            const cwd = parsed.cwd || context.roomRuntime.cwd;
            const prompt = parsed.rest.join(" ").trim();
            if (!prompt) return "Usage: !codex exec [--cd DIR] [--model MODEL] [--ephemeral] <prompt>";

            const outputFile = path.join(context.config.stateDir, "codex-chat-last-message.txt");
            const cmd = [
                context.config.providerBin,
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "-C",
                cwd,
                "-o",
                outputFile,
            ];
            if (parsed.model) {
                cmd.push("-m", parsed.model);
            } else if (context.config.providerModel) {
                cmd.push("-m", context.config.providerModel);
            }
            if (parsed.ephemeral) {
                cmd.push("--ephemeral");
            }
            cmd.push(prompt);

            const wrapped = buildProviderCommand(
                context.config,
                context.roomRuntime,
                cmd[0],
                cmd.slice(1),
            );
            const result = await runCodexCliCommand(
                wrapped.command,
                wrapped.hostCwd,
                context.config.cliCommandTimeoutSec,
            );
            let finalText = "";
            try {
                finalText = (await readFile(outputFile, "utf8")).trim();
            } catch {
                // ignore
            }
            const combined = finalText || result.stdout || result.stderr || `Execution failed with exit code ${result.code}.`;
            return truncateText(combined, context.config.commandResultLimit);
        }

        if (command === "review") {
            const parsed = parseCommonCliOptions(args);
            if ("error" in parsed) return parsed.error;
            const cwd = parsed.cwd || context.roomRuntime.cwd;

            const reviewArgs: string[] = [];
            const promptTokens: string[] = [];
            for (let i = 0; i < parsed.rest.length; i += 1) {
                const token = parsed.rest[i];
                if (token === "--uncommitted") {
                    reviewArgs.push(token);
                    continue;
                }
                if (token === "--base" || token === "--commit" || token === "--title") {
                    if (i + 1 >= parsed.rest.length) return `Missing argument for ${token}`;
                    reviewArgs.push(token, parsed.rest[i + 1]);
                    i += 1;
                    continue;
                }
                promptTokens.push(...parsed.rest.slice(i));
                break;
            }

            const cmd = [context.config.providerBin, "review"];
            if (parsed.model) {
                cmd.push("-c", `model=\"${parsed.model}\"`);
            } else if (context.config.providerModel) {
                cmd.push("-c", `model=\"${context.config.providerModel}\"`);
            }
            cmd.push(...reviewArgs);
            if (promptTokens.length > 0) {
                cmd.push(promptTokens.join(" "));
            }

            const wrapped = buildProviderCommand(
                context.config,
                context.roomRuntime,
                cmd[0],
                cmd.slice(1),
            );
            const result = await runCodexCliCommand(
                wrapped.command,
                wrapped.hostCwd,
                context.config.cliCommandTimeoutSec,
            );
            const combined = result.stdout || result.stderr || `Review failed with exit code ${result.code}.`;
            return truncateText(combined, context.config.commandResultLimit);
        }

        return `This Codex command is not supported yet: ${command}\nUse !codex help to see the currently supported subset.`;
    }

    public async reply(incomingText: string, context: ProviderReplyContext): Promise<string | null> {
        const session = new AppServerSession(context.config, context);
        const mainStream = new MatrixStreamPublisher(
            context,
            context.config.streamFlushIntervalSec,
            context.config.streamFlushChars,
        );
        const commandStates = new Map<string, { command: string; output: string }>();
        let statusText = "";
        let finalAnswer: string | null = null;

        const renderProgress = (): string => {
            const parts: string[] = [];
            if (statusText.trim()) parts.push(statusText.trim());
            for (const { command, output } of commandStates.values()) {
                let section = `[Running command] ${command}`;
                if (output.trim()) {
                    section += `\n${truncateText(output, context.config.commandOutputLimit).trimEnd()}`;
                }
                parts.push(section);
            }
            return parts.join("\n\n").trim();
        };

        const refreshProgress = async (force = false): Promise<void> => {
            if (finalAnswer) return;
            const rendered = renderProgress();
            if (!rendered.trim()) return;
            mainStream.setText(rendered);
            await mainStream.flush(force);
        };

        const onNotification = async (message: Record<string, any>): Promise<void> => {
            const method = message["method"];
            const params = (message["params"] ?? {}) as Record<string, any>;

            if (method === "item/started") {
                const item = (params["item"] ?? {}) as Record<string, any>;
                if (item["type"] === "commandExecution") {
                    const itemId = String(item["id"] ?? "").trim();
                    if (itemId) {
                        commandStates.set(itemId, {
                            command: String(item["command"] ?? "").trim(),
                            output: "",
                        });
                        statusText = "Running tools...";
                        await refreshProgress(true);
                    }
                }
                return;
            }

            if (method === "item/agentMessage/delta") {
                return;
            }

            if (method === "item/completed") {
                const item = (params["item"] ?? {}) as Record<string, any>;
                const itemType = item["type"];
                const itemId = String(item["id"] ?? "").trim();

                if (itemType === "agentMessage") {
                    const text = String(item["text"] ?? "");
                    const phase = String(item["phase"] ?? "");
                    if (phase === "final_answer" && text.trim()) {
                        finalAnswer = text;
                        await mainStream.finalize(text);
                    }
                    return;
                }

                if (itemType === "commandExecution" && itemId) {
                    const state = commandStates.get(itemId);
                    if (state) {
                        state.output = String(item["aggregatedOutput"] ?? "");
                        statusText = "Tools finished, preparing the response...";
                        await refreshProgress(true);
                    }
                }
                return;
            }

            if (method && String(method).endsWith("requestApproval")) {
                throw new Error(`Unexpected approval request: ${method}`);
            }

            if (method === "error") {
                throw new Error(extractProviderErrorMessage(params) || JSON.stringify(params));
            }
        };

        try {
            await session.request(
                "initialize",
                {
                    clientInfo: {
                        name: "matrix_agent_ts",
                        title: "Matrix Agent TS",
                        version: "0.1.0",
                    },
                    capabilities: {
                        experimentalApi: true,
                    },
                },
                onNotification,
                10,
            );
            session.notify("initialized");

            let threadId = getStoredSessionId(context.sessions[context.conversationKey]) || "";
            if (threadId) {
                try {
                    await session.request(
                        "thread/resume",
                        { threadId },
                        onNotification,
                        context.config.codexRequestTimeoutSec,
                    );
                } catch (error) {
                    console.log(`[matrix-agent-ts] failed to resume thread ${threadId}:`, error);
                    threadId = "";
                }
            }

            if (!threadId) {
                const result = await session.request(
                    "thread/start",
                    {
                        cwd: context.roomRuntime.cwd,
                        approvalPolicy: context.config.codexApprovalPolicy,
                    },
                    onNotification,
                    context.config.codexRequestTimeoutSec,
                );
                threadId = String(result["thread"]?.["id"] ?? "").trim();
                if (!threadId) throw new Error("thread/start did not return a thread id");
                persistSessionState(context.sessions, context.conversationKey, "codex", threadId, "thread");
                await saveConversationSessions(context.sessionsFile, context.sessions);
            }

            await session.request(
                "turn/start",
                {
                    threadId,
                    input: [{ type: "text", text: buildTurnPrompt(incomingText, "Alice") }],
                    cwd: context.roomRuntime.cwd,
                    approvalPolicy: context.config.codexApprovalPolicy,
                    sandboxPolicy: { type: context.config.codexSandboxPolicy },
                },
                onNotification,
                context.config.codexRequestTimeoutSec,
            );

            await session.listenUntilTurnCompleted(onNotification);

            if (!finalAnswer) {
                await mainStream.finalize(renderProgress());
            }

            return finalAnswer;
        } finally {
            await session.close();
        }
    }
}
