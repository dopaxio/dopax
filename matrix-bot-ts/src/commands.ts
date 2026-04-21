import type { AgentConfig } from "./config.js";
import type { RoomAgentConfigStore } from "./room-config.js";
import type { RoomRuntime } from "./runtime.js";
import type { RoomAgentConfig } from "./room-config.js";
import type { RoomRuntimeState } from "./state.js";
import type { ProviderAdapter, ProviderCommandContext } from "./providers/base.js";
import type { ConversationSessionState } from "./state.js";
import type { AgentTransport } from "./transports/base.js";

export interface CommandContext {
    transport: AgentTransport;
    roomConfigStore: RoomAgentConfigStore;
    agentUserId: string;
    roomId: string;
    event: Record<string, any>;
    sender: string;
    config: AgentConfig;
    provider: ProviderAdapter;
    conversationKey: string;
    sessions: Record<string, ConversationSessionState>;
    sessionsFile: string;
    roomRuntime: RoomRuntime;
    roomConfig: RoomAgentConfig;
    roomRuntimes: Record<string, RoomRuntimeState>;
    roomRuntimesFile: string;
    threadRootEventId?: string | null;
    replyToEventId?: string | null;
}

function parseLocalCommand(body: string, prefix: string): { command: string; args: string } | null {
    if (!body.startsWith(prefix)) return null;
    const commandLine = body.slice(prefix.length).trim();
    if (!commandLine) return { command: "help", args: "" };
    const [command, ...rest] = commandLine.split(/\s+/);
    return {
        command: command.toLowerCase(),
        args: rest.join(" ").trim(),
    };
}

async function handleRoomCommand(parsedArgs: string, context: CommandContext): Promise<string | null> {
    const [subcommand = "", ...rest] = parsedArgs.split(/\s+/).filter(Boolean);
    const current = await context.roomConfigStore.get(context.roomId, context.agentUserId);
    const capabilities = context.provider.getCapabilities(context.config);

    if (!subcommand || subcommand === "show" || subcommand === "runtime") {
        return [
            `provider=${context.provider.name}`,
            `session_kind=${capabilities.sessionKind}`,
            `streaming=${capabilities.streaming}`,
            `tools=${capabilities.tools}`,
            `approvals=${capabilities.approvals}`,
            `mode=${context.roomRuntime.mode}`,
            `model=${context.roomRuntime.effectiveModel ?? "(default)"}`,
            `cwd=${context.roomRuntime.cwd}`,
            `host_workspace=${context.roomRuntime.hostWorkspaceDir}`,
            context.roomRuntime.containerName ? `container_name=${context.roomRuntime.containerName}` : "container_name=(none)",
            context.roomRuntime.containerId ? `container_id=${context.roomRuntime.containerId}` : "container_id=(none)",
            context.roomRuntime.hostContainerStateDir ? `host_container_state=${context.roomRuntime.hostContainerStateDir}` : "host_container_state=(none)",
            `room_config=${JSON.stringify(current, null, 2)}`,
        ].join("\n");
    }

    if (subcommand === "mode") {
        const value = rest[0];
        if (!value || !["shared", "workspace", "container"].includes(value)) {
            return "用法：!room mode <shared|workspace|container>";
        }
        if (value === "container") {
            const support = context.provider.getContainerSupport(context.config);
            if (!support.supported) {
                return support.reason || `${context.provider.displayName} 不支持 container 模式。`;
            }
        }
        await context.roomConfigStore.set(
            context.roomId,
            context.agentUserId,
            current,
            { mode: value as "shared" | "workspace" | "container" },
            context.sender,
        );
        return `已设置 room 模式为 ${value}`;
    }

    if (subcommand === "model") {
        const value = rest.join(" ").trim();
        await context.roomConfigStore.set(
            context.roomId,
            context.agentUserId,
            current,
            { model: value || null },
            context.sender,
        );
        return value ? `已设置 room 模型为 ${value}` : "已清除 room 模型，恢复实例默认值";
    }

    if (subcommand === "workspace-key") {
        const value = rest.join(" ").trim();
        await context.roomConfigStore.set(
            context.roomId,
            context.agentUserId,
            current,
            { workspace_key: value || null },
            context.sender,
        );
        return value ? `已设置 workspace_key=${value}` : "已清除 workspace_key";
    }

    if (subcommand === "container-image") {
        const value = rest.join(" ").trim();
        await context.roomConfigStore.set(
            context.roomId,
            context.agentUserId,
            current,
            { container_image: value || null },
            context.sender,
        );
        return value ? `已设置 container_image=${value}` : "已清除 container_image";
    }

    return "可用命令：!room show | !room mode <shared|workspace|container> | !room model <name> | !room workspace-key <key> | !room container-image <image>";
}

export async function handleLocalCommand(
    body: string,
    context: CommandContext,
): Promise<boolean> {
    const providerReply = await context.provider.handleChatCommand(body, context);
    if (providerReply !== null) {
        await context.transport.sendMessage(
            context.roomId,
            providerReply,
            {
                threadRootEventId: context.threadRootEventId,
                replyToEventId: context.replyToEventId,
            },
        );
        return true;
    }

    const parsed = parseLocalCommand(body, context.config.commandPrefix);
    if (!parsed) return false;

    switch (parsed.command) {
        case "help":
            await context.transport.sendMessage(
                context.roomId,
                [
                    "可用命令：",
                    `${context.config.commandPrefix}help`,
                    `${context.config.commandPrefix}ping`,
                    `${context.config.commandPrefix}echo <text>`,
                    `${context.config.commandPrefix}whoami`,
                    `${context.config.commandPrefix}rooms`,
                    `${context.config.commandPrefix}room show`,
                    `${context.config.commandPrefix}room mode <shared|workspace|container>`,
                    `${context.config.commandPrefix}room model <name>`,
                    ...context.provider.getCommandHelp(context.config),
                ].join("\n"),
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;

        case "ping":
            await context.transport.sendMessage(
                context.roomId,
                "pong",
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;

        case "echo":
            await context.transport.sendMessage(
                context.roomId,
                parsed.args || "Nothing to echo.",
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;

        case "whoami": {
            await context.transport.sendMessage(
                context.roomId,
                `agent_user_id=${context.agentUserId}\nsender=${context.sender}\nroom_id=${context.roomId}`,
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;
        }

        case "rooms": {
            const rooms = await context.transport.getJoinedConversations();
            await context.transport.sendMessage(
                context.roomId,
                rooms.length ? rooms.join("\n") : "No joined rooms.",
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;
        }

        case "room": {
            const result = await handleRoomCommand(parsed.args, context);
            if (result) {
                await context.transport.sendMessage(
                    context.roomId,
                    result,
                    {
                        threadRootEventId: context.threadRootEventId,
                        replyToEventId: context.replyToEventId,
                    },
                );
            }
            return true;
        }

        default:
            await context.transport.sendMessage(
                context.roomId,
                `Unknown command: ${parsed.command}`,
                {
                    threadRootEventId: context.threadRootEventId,
                    replyToEventId: context.replyToEventId,
                },
            );
            return true;
    }
}
