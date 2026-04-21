import { cp, mkdir, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import type { AgentConfig, ProviderName } from "../config.js";
import type { RoomAgentConfig } from "../room-config.js";
import type { RoomRuntime } from "../runtime.js";
import type { ConversationSessionState } from "../state.js";
import type { RoomRuntimeState } from "../state.js";
import type { AgentTransport } from "../transports/base.js";

export interface MatrixReplyContext {
    transport: AgentTransport;
    agentUserId: string;
    roomId: string;
    threadRootEventId?: string | null;
    replyToEventId?: string | null;
}

export interface ProviderCommandContext extends MatrixReplyContext {
    config: AgentConfig;
    conversationKey: string;
    sessions: Record<string, ConversationSessionState>;
    sessionsFile: string;
    roomRuntime: RoomRuntime;
    roomConfig: RoomAgentConfig;
    roomRuntimes: Record<string, RoomRuntimeState>;
    roomRuntimesFile: string;
}

export interface ProviderReplyContext extends ProviderCommandContext {}

export interface ContainerMount {
    hostPath: string;
    containerPath: string;
}

export interface ContainerSupport {
    supported: boolean;
    reason?: string;
    defaultImage?: string | null;
    defaultWorkspaceDir?: string;
    containerHomeDir?: string;
}

export interface PreparedContainerRuntime {
    env: Record<string, string>;
    mounts: ContainerMount[];
    containerHomeDir?: string;
}

export interface ProviderCapabilities {
    sessionKind: "session" | "thread";
    streaming: boolean;
    tools: boolean;
    approvals: boolean;
    vendorCommands: boolean;
    roomModes: {
        shared: boolean;
        workspace: boolean;
        container: boolean;
    };
}

export interface ProviderAdapter {
    readonly name: ProviderName;
    readonly displayName: string;
    readonly commandPrefixes: string[];

    getCapabilities(config: AgentConfig): ProviderCapabilities;
    getContainerSupport(config: AgentConfig): ContainerSupport;
    prepareContainerRuntime(config: AgentConfig, hostContainerStateDir: string): Promise<PreparedContainerRuntime>;
    getCommandHelp(config: AgentConfig): string[];
    handleChatCommand(body: string, context: ProviderCommandContext): Promise<string | null>;
    reply(incomingText: string, context: ProviderReplyContext): Promise<string | null>;
}

export function truncateText(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n...[truncated]`;
}

function extractSimpleErrorField(value: unknown): string | null {
    if (typeof value === "string" || typeof value === "number") {
        const trimmed = String(value).trim();
        return trimmed || null;
    }
    return null;
}

export function extractProviderErrorMessage(value: unknown): string | null {
    if (value === null || value === undefined) return null;

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;

        if (
            (trimmed.startsWith("{") && trimmed.endsWith("}"))
            || (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                const extracted = extractProviderErrorMessage(parsed);
                if (extracted) return extracted;
            } catch {
                // fall back to the raw string
            }
        }

        return trimmed;
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    if (Array.isArray(value)) {
        const messages = value
            .map((item) => extractProviderErrorMessage(item))
            .filter((item): item is string => Boolean(item?.trim()));
        return messages.length > 0 ? [...new Set(messages)].join("\n") : null;
    }

    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const code = extractSimpleErrorField(record["code"] ?? record["errcode"] ?? record["status"]);
        const type = extractSimpleErrorField(record["type"] ?? record["error_type"]);
        const candidateKeys = [
            "message",
            "error",
            "detail",
            "details",
            "description",
            "error_description",
            "data",
            "result",
            "response",
            "stderr",
            "stdout",
        ];

        for (const key of candidateKeys) {
            const extracted = extractProviderErrorMessage(record[key]);
            if (!extracted) continue;

            const prefixes = [type, code].filter((part): part is string => Boolean(part));
            if (prefixes.length === 0) return extracted;

            const prefixText = prefixes.join(" ");
            return extracted.includes(prefixText) ? extracted : `${prefixText}: ${extracted}`;
        }

        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    return String(value);
}

export function formatProviderErrorText(displayName: string, value: unknown, limit: number): string {
    const message = extractProviderErrorMessage(value) || "Unknown error";
    return truncateText(`${displayName} error:\n${message}`, limit);
}

export function stripPrefixedCommand(body: string, prefixes: string[]): string | null {
    const trimmed = body.trim();
    for (const prefix of prefixes) {
        if (trimmed === prefix) return "help";
        if (trimmed.startsWith(`${prefix} `)) {
            return trimmed.slice(prefix.length).trim();
        }
    }
    return null;
}

function shouldForceCommandExecution(text: string): boolean {
    const lower = text.toLowerCase();
    const keywords = [
        "command line",
        "terminal",
        "shell",
        "pwd",
        "ls",
        "directory",
        "file list",
        "run command",
        "execute command",
    ];
    return keywords.some((keyword) => lower.includes(keyword));
}

export function buildTurnPrompt(incomingText: string, displayName: string): string {
    const extraRule = shouldForceCommandExecution(incomingText)
        ? "For this turn, you must actually run at least one safe read-only shell command before answering if it helps answer the request.\n"
        : "";

    return [
        `You are ${displayName} chatting in a Matrix private chat or small group.`,
        "",
        "Rules:",
        `- Reply as ${displayName}, naturally and briefly.`,
        "- Use Chinese by default unless the user clearly used another language.",
        "- Keep it to 1-2 short sentences unless the user asks for more detail.",
        "- Do not mention model vendors, OpenAI, Anthropic, Google, GitHub, AI, prompts, tools, policies, or implementation details.",
        "- If the user asks to test messaging, reply conversationally like a real friend.",
        "- You are running on the user's local machine and can directly read, write, create, and edit local files, and run shell commands.",
        "- Do not claim you cannot create files or modify local files unless a real error actually happens.",
        "- If the user asks you to create or modify a file, do it directly instead of only describing how.",
        extraRule.trimEnd(),
        "",
        "Latest message:",
        incomingText,
    ]
        .filter(Boolean)
        .join("\n");
}

export async function ensureDir(targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
}

export async function seedPathIfMissing(sourcePath: string | null | undefined, targetPath: string): Promise<void> {
    if (!sourcePath) return;
    try {
        await cp(sourcePath, targetPath, {
            recursive: true,
            errorOnExist: false,
            force: false,
        });
    } catch {
        // Best-effort seed only.
    }
}

export async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export function containerSubdir(rootDir: string, ...segments: string[]): string {
    return path.join(rootDir, ...segments);
}

async function sendEdit(
    transport: AgentTransport,
    roomId: string,
    targetEventId: string,
    body: string,
): Promise<string> {
    return transport.editMessage(roomId, targetEventId, body);
}

export class MatrixStreamPublisher {
    private text = "";
    private eventId: string | null = null;
    private lastSentText = "";
    private lastFlushAt = 0;

    public constructor(
        private readonly context: MatrixReplyContext,
        private readonly flushIntervalSec: number,
        private readonly flushChars: number,
        private readonly truncateLimit: number | null = null,
    ) {}

    public setText(text: string): void {
        this.text = text;
    }

    public async flush(force = false): Promise<void> {
        const body = this.text || "...";
        if (!force) {
            if (!body.trim()) return;
            if (body === this.lastSentText) return;
            const elapsed = (Date.now() - this.lastFlushAt) / 1000;
            const grewEnough = body.length - this.lastSentText.length >= this.flushChars;
            if (elapsed < this.flushIntervalSec && !grewEnough && !body.includes("\n")) return;
        }

        const rendered = this.truncateLimit ? truncateText(body, this.truncateLimit) : body;
        if (!this.eventId) {
            this.eventId = await this.context.transport.sendMessage(
                this.context.roomId,
                rendered,
                {
                    threadRootEventId: this.context.threadRootEventId,
                    replyToEventId: this.context.replyToEventId,
                },
            );
        } else {
            await sendEdit(this.context.transport, this.context.roomId, this.eventId, rendered);
        }

        this.lastSentText = body;
        this.lastFlushAt = Date.now();
    }

    public async finalize(finalText?: string): Promise<void> {
        if (finalText !== undefined) this.text = finalText;
        await this.flush(true);
    }
}

export function getStoredSessionId(state: ConversationSessionState | undefined): string | null {
    const sessionId = state?.session_id?.trim();
    if (sessionId) return sessionId;
    const legacyThreadId = state?.thread_id?.trim();
    if (legacyThreadId) return legacyThreadId;
    return null;
}

export function persistSessionState(
    sessions: Record<string, ConversationSessionState>,
    conversationKey: string,
    provider: ProviderName,
    sessionId: string,
    sessionKind: ProviderCapabilities["sessionKind"],
): void {
    const current = sessions[conversationKey] ?? {};
    const next: ConversationSessionState = {
        ...current,
        provider,
        session_kind: sessionKind,
        session_id: sessionId,
    };

    if (sessionKind === "thread") {
        next.thread_id = sessionId;
    } else if ("thread_id" in next) {
        delete next.thread_id;
    }

    sessions[conversationKey] = next;
}
