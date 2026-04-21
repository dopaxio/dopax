import sdk from "matrix-bot-sdk";
import type { MatrixClient as MatrixClientType } from "matrix-bot-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleLocalCommand } from "./commands.js";
import { exchangeRuntimeCredentials } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import {
    assertExecutableAvailable,
    ensureExecutablePathEnvironment,
    type ExecutableProbeCommand,
} from "./executable.js";
import { handlePollEvent } from "./polls.js";
import { createProviderAdapter } from "./providers/index.js";
import { formatProviderErrorText } from "./providers/base.js";
import { MatrixRoomAgentConfigStore } from "./room-config.js";
import { resolveRoomRuntime } from "./runtime.js";
import {
    clearToken,
    ensureStateDir,
    loadConversationSessions,
    loadHandledPolls,
    loadRoomRuntimes,
    loadRuntimeIdentity,
    loadSavedToken,
    saveRuntimeIdentity,
    saveToken,
} from "./state.js";
import { getConversationKey, getThreadRootEventId, MatrixTransport } from "./transports/matrix.js";

const {
    AutojoinRoomsMixin,
    LogService,
    MatrixClient,
    MessageEvent,
    RichConsoleLogger,
    SimpleFsStorageProvider,
} = sdk as typeof import("matrix-bot-sdk");

const execFileAsync = promisify(execFile);

function providerProbeCommands(provider: ReturnType<typeof loadConfig>["provider"]): ExecutableProbeCommand[] {
    switch (provider) {
        case "codex":
            return [
                { args: ["--version"] },
                { args: ["app-server", "--help"] },
            ];
        case "claude":
            return [
                { args: ["--version"] },
                {
                    args: ["--help"],
                    requiredText: ["--print", "--output-format", "--include-partial-messages", "--add-dir"],
                },
            ];
        case "gemini":
            return [
                { args: ["--version"] },
                {
                    args: ["--help"],
                    requiredText: ["--prompt", "--output-format", "--include-directories", "--resume"],
                },
            ];
        case "copilot":
            return [
                { args: ["--version"] },
                {
                    args: ["--help"],
                    requiredText: ["--prompt", "--output-format", "--add-dir", "--silent"],
                },
            ];
        case "opencode":
            return [
                { args: ["--version"] },
                {
                    args: ["run", "--help"],
                    requiredText: ["--dir", "--format", "--session", "--model"],
                },
            ];
        default:
            return [];
    }
}

function shouldIgnoreRoom(roomId: string, allowlist: string[]): boolean {
    return allowlist.length > 0 && !allowlist.includes(roomId);
}

function startPresenceHeartbeat(
    client: MatrixClientType,
    intervalMs: number,
): () => void {
    if (intervalMs <= 0) {
        return () => undefined;
    }

    let disposed = false;
    let inFlight = false;

    const tick = async (): Promise<void> => {
        if (disposed || inFlight) return;
        inFlight = true;

        try {
            await client.setPresenceStatus("online");
        } catch (error) {
            LogService.warn(
                "matrix-agent-ts",
                `Presence heartbeat failed: ${String((error as Error)?.message ?? error)}`,
            );
        } finally {
            inFlight = false;
        }
    };

    void tick();
    const timer = setInterval(() => {
        void tick();
    }, intervalMs);

    return () => {
        disposed = true;
        clearInterval(timer);
    };
}

async function createClient(config = loadConfig()): Promise<{
    client: MatrixClientType;
    userId: string;
    statePaths: Awaited<ReturnType<typeof ensureStateDir>>;
}> {
    const statePaths = await ensureStateDir(config.stateDir);
    const cachedIdentity = await loadRuntimeIdentity(statePaths.runtimeIdentityFile);
    const storage = new SimpleFsStorageProvider(config.storagePath);
    const savedToken = await loadSavedToken(statePaths.tokenFile);
    const reusableHomeserverUrl = cachedIdentity?.homeserverUrl || config.homeserverUrl;

    if (savedToken && cachedIdentity && cachedIdentity.provider === config.provider) {
        const client = new MatrixClient(reusableHomeserverUrl, savedToken, storage);

        try {
            const userId = await client.getUserId();
            if (cachedIdentity.agentUserId && userId !== cachedIdentity.agentUserId) {
                throw new Error(
                    `Cached token resolved to ${userId}, expected ${cachedIdentity.agentUserId}`,
                );
            }

            LogService.info(
                "matrix-agent-ts",
                `Reusing cached agent token for ${cachedIdentity.agentUserId}`,
            );
            return { client, userId, statePaths };
        } catch (error) {
            LogService.warn(
                "matrix-agent-ts",
                `Cached agent token is no longer usable, falling back to owner bootstrap: ${String((error as Error)?.message ?? error)}`,
            );
            await clearToken(statePaths.tokenFile);
        }
    }

    LogService.info(
        "matrix-agent-ts",
        `Bootstrapping runtime credentials for provider ${config.provider}`,
    );
    const runtimeCredentials = await exchangeRuntimeCredentials(config, cachedIdentity);

    await saveToken(statePaths.tokenFile, runtimeCredentials.accessToken);
    await saveRuntimeIdentity(statePaths.runtimeIdentityFile, {
        ownerUserId: runtimeCredentials.ownerUserId,
        agentUserId: runtimeCredentials.agentUserId,
        provider: config.provider,
        homeserverUrl: runtimeCredentials.homeserverUrl,
        deviceId: runtimeCredentials.deviceId,
        localpart: runtimeCredentials.localpart,
        exchangedAt: runtimeCredentials.exchangedAt,
        provisioningMode: runtimeCredentials.provisioningMode,
    });

    const client = new MatrixClient(
        runtimeCredentials.homeserverUrl || config.homeserverUrl,
        runtimeCredentials.accessToken,
        storage,
    );
    const userId = await client.getUserId();

    return { client, userId, statePaths };
}

async function main(): Promise<void> {
    const config = loadConfig();
    const providerPathEnv = ensureExecutablePathEnvironment(config.providerBin);
    const provider = createProviderAdapter(config.provider);
    if (config.defaultRoomMode === "container") {
        const support = provider.getContainerSupport(config);
        if (!support.supported) {
            throw new Error(support.reason || `${provider.displayName} does not support container mode.`);
        }
    } else {
        config.providerBin = await assertExecutableAvailable(config.providerBin, {
            pathEnv: providerPathEnv,
            probeCommands: providerProbeCommands(config.provider),
        });
    }
    const statePaths = await ensureStateDir(config.stateDir);
    const sessions = await loadConversationSessions(statePaths.conversationSessionsFile);
    const roomRuntimes = await loadRoomRuntimes(statePaths.roomRuntimesFile);
    const handledPolls = await loadHandledPolls(statePaths.handledPollsFile);
    LogService.setLogger(new RichConsoleLogger());

    const { client, userId } = await createClient(config);
    const transport = new MatrixTransport(client);
    const roomConfigStore = new MatrixRoomAgentConfigStore(client);

    client.syncingPresence = "online";
    client.syncingTimeout = config.matrixSyncTimeoutMs;
    AutojoinRoomsMixin.setupOnClient(client);
    const stopPresenceHeartbeat = startPresenceHeartbeat(client, config.presenceHeartbeatMs);

    client.on("room.event", async (roomId: string, event: Record<string, any>) => {
        const sender = typeof event["sender"] === "string" ? event["sender"] : "";
        if (sender === userId) return;
        if (shouldIgnoreRoom(roomId, config.roomAllowlist)) return;

        try {
            await handlePollEvent(client, { ...event, room_id: roomId }, handledPolls, statePaths.handledPollsFile);
        } catch (error) {
            console.error("[matrix-agent-ts] failed to handle poll", error);
        }
    });

    client.on("room.message", async (roomId: string, event: Record<string, unknown>) => {
        const sender = typeof event["sender"] === "string" ? event["sender"] : "";
        if (sender === userId) return;
        if (shouldIgnoreRoom(roomId, config.roomAllowlist)) return;

        const message = new MessageEvent(event);
        if (message.messageType !== "m.text") return;
        if (message.textBody.startsWith("[alice-agent-ignore]")) return;

        const threadRootEventId = getThreadRootEventId(event as Record<string, any>);
        const replyToEventId = message.eventId;
        const conversationKey = getConversationKey(roomId, threadRootEventId);
        let runtimeInfo;
        try {
            runtimeInfo = await resolveRoomRuntime(
                roomConfigStore,
                roomId,
                userId,
                config,
                provider,
                roomRuntimes,
                statePaths.roomRuntimesFile,
            );
        } catch (error) {
            await transport.sendMessage(
                roomId,
                `Runtime initialization failed: ${String((error as Error)?.message ?? error)}`,
                {
                    threadRootEventId,
                    replyToEventId,
                    msgtype: "m.notice",
                },
            );
            return;
        }
        const { runtime: roomRuntime, roomConfig } = runtimeInfo;

        const handled = await handleLocalCommand(message.textBody, {
            transport,
            roomConfigStore,
            agentUserId: userId,
            roomId,
            event: event as Record<string, any>,
            sender,
            config,
            provider,
            conversationKey,
            sessions,
            sessionsFile: statePaths.conversationSessionsFile,
            roomRuntime,
            roomConfig,
            roomRuntimes,
            roomRuntimesFile: statePaths.roomRuntimesFile,
            threadRootEventId,
            replyToEventId,
        });

        if (handled) return;

        const shouldEmitTyping = !threadRootEventId;
        try {
            if (shouldEmitTyping) {
                await transport.setTyping?.(roomId, true, config.typingTimeoutMs);
            }

            let reply: string | null = null;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                if (shouldEmitTyping) {
                    await transport.setTyping?.(roomId, true, config.typingTimeoutMs);
                }

                reply = await provider.reply(message.textBody, {
                    transport,
                    agentUserId: userId,
                    roomId,
                    threadRootEventId,
                    replyToEventId,
                    config,
                    conversationKey,
                    sessions,
                    sessionsFile: statePaths.conversationSessionsFile,
                    roomRuntime,
                    roomConfig,
                    roomRuntimes,
                    roomRuntimesFile: statePaths.roomRuntimesFile,
                });

                if (reply) break;
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }

            if (!reply) {
                await transport.sendMessage(
                    roomId,
                    `Use ${config.commandPrefix}help to see supported commands.`,
                    {
                        threadRootEventId,
                        replyToEventId,
                    },
                );
            }
        } catch (error) {
            const renderedError = formatProviderErrorText(
                provider.displayName,
                error instanceof Error ? error.message : error,
                config.commandResultLimit,
            );
            LogService.error(
                "matrix-agent-ts",
                `${provider.name} reply failed in ${roomId}: ${String((error as Error)?.stack ?? (error as Error)?.message ?? error)}`,
            );
            await transport.sendMessage(
                roomId,
                renderedError,
                {
                    threadRootEventId,
                    replyToEventId,
                    msgtype: "m.notice",
                },
            ).catch((sendError) => {
                LogService.error(
                    "matrix-agent-ts",
                    `failed to send provider error to ${roomId}: ${String((sendError as Error)?.stack ?? (sendError as Error)?.message ?? sendError)}`,
                );
            });
        } finally {
            if (shouldEmitTyping) {
                await transport.setTyping?.(roomId, false, config.typingTimeoutMs).catch(() => undefined);
            }
        }
    });

    LogService.info("matrix-agent-ts", `Starting ${config.provider} agent as ${userId}`);
    try {
        await client.start();
    } finally {
        stopPresenceHeartbeat();
    }
}

main().catch((error) => {
    console.error("[matrix-agent-ts] fatal error", error);
    process.exit(1);
});
