import type { AgentConfig, ProviderName } from "../config.js";
import { execCommand } from "../executable.js";
import { truncateText, stripPrefixedCommand, buildTurnPrompt } from "./base.js";
import type {
    ContainerSupport,
    PreparedContainerRuntime,
    ProviderAdapter,
    ProviderCapabilities,
    ProviderCommandContext,
    ProviderReplyContext,
} from "./base.js";

async function runCliCommand(
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

interface SimpleCliProviderOptions {
    name: ProviderName;
    displayName: string;
    commandPrefixes: string[];
    buildPromptCommand: (prompt: string, context: ProviderCommandContext | ProviderReplyContext) => string[];
    buildVersionCommand?: (context: ProviderCommandContext) => string[];
    helpLines?: string[];
}

export class SimpleCliProviderAdapter implements ProviderAdapter {
    public readonly name: ProviderName;
    public readonly displayName: string;
    public readonly commandPrefixes: string[];

    public constructor(private readonly options: SimpleCliProviderOptions) {
        this.name = options.name;
        this.displayName = options.displayName;
        this.commandPrefixes = options.commandPrefixes;
    }

    public getCommandHelp(_config: AgentConfig): string[] {
        return this.options.helpLines ?? [
            `${this.commandPrefixes[1]} help`,
            `${this.commandPrefixes[1]} version`,
            `${this.commandPrefixes[1]} <prompt>`,
        ];
    }

    public getCapabilities(_config: AgentConfig): ProviderCapabilities {
        return {
            sessionKind: "session",
            streaming: false,
            tools: false,
            approvals: false,
            vendorCommands: false,
            roomModes: {
                shared: true,
                workspace: true,
                container: false,
            },
        };
    }

    public getContainerSupport(_config: AgentConfig): ContainerSupport {
        return {
            supported: false,
            reason: `${this.displayName} 当前没有容器模式支持。`,
        };
    }

    public async prepareContainerRuntime(): Promise<PreparedContainerRuntime> {
        throw new Error(`${this.displayName} 当前没有容器模式支持。`);
    }

    private async runPrompt(
        prompt: string,
        context: ProviderCommandContext | ProviderReplyContext,
    ): Promise<string> {
        const result = await runCliCommand(
            this.options.buildPromptCommand(prompt, context),
            context.config.providerCwd,
            context.config.cliCommandTimeoutSec,
        );
        const combined = result.stdout || result.stderr || `${this.displayName} 执行失败，退出码 ${result.code}。`;
        return truncateText(combined, context.config.commandResultLimit);
    }

    public async handleChatCommand(body: string, context: ProviderCommandContext): Promise<string | null> {
        const stripped = stripPrefixedCommand(body, this.commandPrefixes);
        if (stripped === null) return null;

        if (stripped === "help" || stripped === "?" || stripped === "commands") {
            return this.getCommandHelp(context.config).join("\n");
        }

        if (stripped === "version" || stripped === "--version" || stripped === "-V") {
            const versionCommand = this.options.buildVersionCommand?.(context) ?? [
                context.config.providerBin,
                "--version",
            ];
            const result = await runCliCommand(
                versionCommand,
                context.config.providerCwd,
                context.config.cliCommandTimeoutSec,
            );
            return truncateText(
                result.stdout || result.stderr || `${this.displayName} 版本查询失败。`,
                context.config.commandResultLimit,
            );
        }

        const prompt = stripped.startsWith("run ") ? stripped.slice(4).trim() : stripped.trim();
        if (!prompt) {
            return this.getCommandHelp(context.config).join("\n");
        }

        return this.runPrompt(prompt, context);
    }

    public async reply(incomingText: string, context: ProviderReplyContext): Promise<string | null> {
        return this.runPrompt(buildTurnPrompt(incomingText, this.displayName), context);
    }
}
