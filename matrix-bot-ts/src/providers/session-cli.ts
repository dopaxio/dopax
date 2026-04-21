import { createInterface } from "node:readline";
import { once } from "node:events";

import { spawnCommand } from "../executable.js";
import { buildProviderCommand } from "../runtime.js";
import { saveConversationSessions } from "../state.js";
import {
    buildTurnPrompt,
    ensureDir,
    formatProviderErrorText,
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

export interface ParsedCliEvent {
    sessionId?: string;
    delta?: string;
    final?: string;
    error?: string;
}

interface SessionCliProviderOptions {
    name: ProviderAdapter["name"];
    displayName: string;
    commandPrefixes: string[];
    helpLines: string[];
    buildPromptCommand: (
        prompt: string,
        context: ProviderCommandContext | ProviderReplyContext,
        sessionId?: string | null,
    ) => string[];
    buildVersionCommand?: (context: ProviderCommandContext) => string[];
    parseJsonLine: (line: Record<string, any>) => ParsedCliEvent;
    containerSupport: ContainerSupport;
    capabilities?: Partial<Omit<ProviderCapabilities, "sessionKind" | "roomModes">>;
    prepareContainerRuntime?: (context: {
        config: ProviderCommandContext["config"];
        hostContainerStateDir: string;
    }) => Promise<PreparedContainerRuntime>;
}

export class SessionCliProviderAdapter implements ProviderAdapter {
    public readonly name;
    public readonly displayName;
    public readonly commandPrefixes;

    public constructor(private readonly options: SessionCliProviderOptions) {
        this.name = options.name;
        this.displayName = options.displayName;
        this.commandPrefixes = options.commandPrefixes;
    }

    public getCommandHelp(): string[] {
        return this.options.helpLines;
    }

    public getCapabilities(config: ProviderCommandContext["config"]): ProviderCapabilities {
        const containerSupport = this.getContainerSupport(config);
        return {
            sessionKind: "session",
            streaming: true,
            tools: this.options.capabilities?.tools ?? false,
            approvals: this.options.capabilities?.approvals ?? false,
            vendorCommands: this.options.capabilities?.vendorCommands ?? false,
            roomModes: {
                shared: true,
                workspace: true,
                container: containerSupport.supported,
            },
        };
    }

    public getContainerSupport(_config: ProviderCommandContext["config"]): ContainerSupport {
        return this.options.containerSupport;
    }

    public async prepareContainerRuntime(
        config: ProviderCommandContext["config"],
        hostContainerStateDir: string,
    ): Promise<PreparedContainerRuntime> {
        if (this.options.prepareContainerRuntime) {
            return this.options.prepareContainerRuntime({ config, hostContainerStateDir });
        }

        const support = this.getContainerSupport(config);
        const containerHomeDir = support.containerHomeDir || config.containerHomeDir;
        const mountTarget = `${containerHomeDir}/${this.name === "opencode" ? ".local/share/opencode" : `.${this.name}`}`;

        await ensureDir(hostContainerStateDir);
        await seedPathIfMissing(config.containerSeedHome, hostContainerStateDir);

        return {
            env: {
                HOME: containerHomeDir,
            },
            mounts: [
                {
                    hostPath: hostContainerStateDir,
                    containerPath: mountTarget,
                },
            ],
            containerHomeDir,
        };
    }

    private async runSimpleCommand(command: string[], cwd: string, limit: number): Promise<string> {
        const child = spawnCommand(command, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        if (!stdoutStream || !stderrStream) {
            throw new Error(`${this.displayName} command is missing stdio pipes.`);
        }
        const stdout = createInterface({ input: stdoutStream });
        const stderr = createInterface({ input: stderrStream });
        const out: string[] = [];
        const err: string[] = [];
        stdout.on("line", (line) => out.push(line));
        stderr.on("line", (line) => err.push(line));
        const [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
        return truncateText(
            out.join("\n").trim() || err.join("\n").trim() || `${this.displayName} command failed with exit code ${code ?? 1}.`,
            limit,
        );
    }

    private async runPrompt(
        prompt: string,
        context: ProviderCommandContext | ProviderReplyContext,
        options: { streamToMatrix?: boolean } = {},
    ): Promise<string> {
        const priorState = context.sessions[context.conversationKey];
        let sessionId = getStoredSessionId(priorState);
        const rawCommand = this.options.buildPromptCommand(prompt, context, sessionId);
        const { command, hostCwd } = buildProviderCommand(
            context.config,
            context.roomRuntime,
            rawCommand[0],
            rawCommand.slice(1),
        );

        const child = spawnCommand(command, {
            cwd: hostCwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        if (!stdoutStream || !stderrStream) {
            throw new Error(`${this.displayName} command is missing stdio pipes.`);
        }

        const stdout = createInterface({ input: stdoutStream });
        const stderr = createInterface({ input: stderrStream });
        const stderrLines: string[] = [];
        let childErrorMessage = "";
        const publisher = options.streamToMatrix
            ? new MatrixStreamPublisher(
                context,
                context.config.streamFlushIntervalSec,
                context.config.streamFlushChars,
                context.config.commandResultLimit,
            )
            : null;
        let accumulated = "";
        let finalAnswer: string | null = null;
        let timedOut = false;
        let parseFailure = "";
        let processing = Promise.resolve();

        child.once("error", (error) => {
            childErrorMessage = String(error?.message ?? error).trim();
        });

        const persistSession = async (nextSessionId: string) => {
            if (!nextSessionId || nextSessionId === sessionId) return;
            sessionId = nextSessionId;
            persistSessionState(context.sessions, context.conversationKey, this.name, sessionId, "session");
            await saveConversationSessions(context.sessionsFile, context.sessions);
        };

        stdout.on("line", (line) => {
            processing = processing.then(async () => {
                if (!line.trim()) return;
                let payload: Record<string, any>;
                try {
                    payload = JSON.parse(line) as Record<string, any>;
                } catch {
                    parseFailure = line.trim();
                    return;
                }

                const parsed = this.options.parseJsonLine(payload);
                if (parsed.sessionId) {
                    await persistSession(parsed.sessionId);
                }
                if (parsed.delta) {
                    accumulated += parsed.delta;
                    if (publisher) {
                        publisher.setText(accumulated);
                        await publisher.flush();
                    }
                }
                if (parsed.final) {
                    const bestFinal =
                        accumulated.trim() && accumulated.trim().length > parsed.final.trim().length
                            ? accumulated.trim()
                            : parsed.final;
                    finalAnswer = bestFinal;
                    if (publisher) {
                        await publisher.finalize(bestFinal);
                    }
                }
                if (parsed.error && !finalAnswer) {
                    finalAnswer = formatProviderErrorText(
                        this.displayName,
                        parsed.error,
                        context.config.commandResultLimit,
                    );
                    if (publisher) {
                        await publisher.finalize(finalAnswer);
                    }
                }
            });
        });

        stderr.on("line", (line) => {
            if (line.trim()) stderrLines.push(line.trim());
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, context.config.cliCommandTimeoutSec * 1000);

        const [code] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
        clearTimeout(timeout);
        await processing;

        if (!finalAnswer) {
            const fallbackError = stderrLines.join("\n").trim() || parseFailure || childErrorMessage;
            finalAnswer = accumulated.trim()
                || (fallbackError
                    ? formatProviderErrorText(this.displayName, fallbackError, context.config.commandResultLimit)
                    : timedOut
                        ? formatProviderErrorText(this.displayName, `${this.displayName} request timed out.`, context.config.commandResultLimit)
                        : formatProviderErrorText(
                            this.displayName,
                            `${this.displayName} failed with exit code ${code ?? 1}.`,
                            context.config.commandResultLimit,
                        ));
            if (publisher) {
                await publisher.finalize(finalAnswer);
            }
        }

        return truncateText(finalAnswer, context.config.commandResultLimit);
    }

    public async handleChatCommand(body: string, context: ProviderCommandContext): Promise<string | null> {
        const stripped = stripPrefixedCommand(body, this.commandPrefixes);
        if (stripped === null) return null;

        if (stripped === "help" || stripped === "?" || stripped === "commands") {
            return this.getCommandHelp().join("\n");
        }

        if (stripped === "version" || stripped === "--version" || stripped === "-V") {
            const versionCommand = this.options.buildVersionCommand?.(context) ?? [
                context.config.providerBin,
                "--version",
            ];
            const wrapped = buildProviderCommand(
                context.config,
                context.roomRuntime,
                versionCommand[0],
                versionCommand.slice(1),
            );
            return this.runSimpleCommand(wrapped.command, wrapped.hostCwd, context.config.commandResultLimit);
        }

        return this.runPrompt(stripped.trim(), context);
    }

    public async reply(incomingText: string, context: ProviderReplyContext): Promise<string | null> {
        return this.runPrompt(
            buildTurnPrompt(incomingText, this.displayName),
            context,
            { streamToMatrix: true },
        );
    }
}
