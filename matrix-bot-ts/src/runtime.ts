import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, RoomMode } from "./config.js";
import { execCommand } from "./executable.js";
import type { ProviderAdapter } from "./providers/base.js";
import type { RoomAgentConfig, RoomAgentConfigStore } from "./room-config.js";
import type { RoomRuntimeState } from "./state.js";
import { saveRoomRuntimes } from "./state.js";

export interface RoomRuntime {
    mode: RoomMode;
    cwd: string;
    hostWorkspaceDir: string;
    effectiveModel: string | null;
    containerId?: string;
    containerName?: string;
    containerImage?: string;
    containerHomeDir?: string;
    hostContainerStateDir?: string;
    containerWorkspaceDir?: string;
}

function slugForRoom(roomId: string, workspaceKey?: string | null): string {
    const base = (workspaceKey?.trim() || roomId).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const digest = createHash("sha1").update(roomId).digest("hex").slice(0, 8);
    return `${base || "room"}-${digest}`;
}

async function runCommand(command: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execCommand(command, {
            cwd,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
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

async function dockerInspectContainer(config: AgentConfig, containerId: string): Promise<boolean> {
    const result = await runCommand(
        [config.dockerBin, "inspect", "-f", "{{.State.Running}}", containerId],
        config.stateDir,
    );
    return result.code === 0 && result.stdout.trim() === "true";
}

async function dockerRemoveContainer(config: AgentConfig, containerId: string): Promise<void> {
    await runCommand([config.dockerBin, "rm", "-f", containerId], config.stateDir);
}

function clearContainerState(state: RoomRuntimeState): RoomRuntimeState {
    const next = { ...state };
    delete next.container_id;
    delete next.container_name;
    delete next.container_image;
    delete next.container_home_dir;
    delete next.host_container_state_dir;
    delete next.host_container_home_dir;
    delete next.container_workspace_dir;
    return next;
}

async function ensureRoomContainer(
    config: AgentConfig,
    provider: ProviderAdapter,
    roomId: string,
    workspaceSlug: string,
    hostWorkspaceDir: string,
    state: RoomRuntimeState,
    roomConfig: RoomAgentConfig,
): Promise<{
    containerId: string;
    containerName: string;
    containerImage: string;
    containerHomeDir: string;
    hostContainerStateDir: string;
    containerWorkspaceDir: string;
}> {
    const support = provider.getContainerSupport(config);
    if (!support.supported) {
        throw new Error(support.reason || `${provider.displayName} 不支持 container 模式。`);
    }

    const containerWorkspaceDir =
        roomConfig.container_workspace_dir
        || state.container_workspace_dir
        || support.defaultWorkspaceDir
        || config.containerWorkspaceDir;
    const containerImage =
        roomConfig.container_image
        || state.container_image
        || config.containerImage
        || support.defaultImage
        || null;
    const hostContainerStateDir =
        state.host_container_state_dir
        || state.host_container_home_dir
        || path.join(config.containerHomesRoot, workspaceSlug);
    const preparedRuntime = await provider.prepareContainerRuntime(config, hostContainerStateDir);
    const containerHomeDir = preparedRuntime.containerHomeDir || support.containerHomeDir || config.containerHomeDir;

    if (!containerImage) {
        throw new Error("container 模式需要配置 CONTAINER_IMAGE 或房间级 container_image。");
    }

    await mkdir(hostContainerStateDir, { recursive: true });

    const existing = state.container_id?.trim();
    const reusable = existing
        && state.container_image === containerImage
        && state.container_workspace_dir === containerWorkspaceDir
        && state.container_home_dir === containerHomeDir
        && (state.host_container_state_dir || state.host_container_home_dir) === hostContainerStateDir;

    if (reusable && await dockerInspectContainer(config, existing)) {
        return {
            containerId: existing,
            containerName: state.container_name || "",
            containerImage,
            containerHomeDir,
            hostContainerStateDir,
            containerWorkspaceDir,
        };
    }

    if (existing) {
        await dockerRemoveContainer(config, existing);
    }

    const mountArgs = preparedRuntime.mounts.flatMap((mount) => ["-v", `${mount.hostPath}:${mount.containerPath}`]);
    const envArgs = Object.entries(preparedRuntime.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const name = `matrix-agent-${config.provider}-${workspaceSlug}-${Date.now().toString(36)}`;
    const result = await runCommand(
        [
            config.dockerBin,
            "run",
            "-d",
            "--name",
            name,
            "--label",
            "com.uu.matrix-agent-ts.managed=true",
            "--label",
            `com.uu.matrix-agent-ts.provider=${config.provider}`,
            "--label",
            `com.uu.matrix-agent-ts.room=${roomId}`,
            ...envArgs,
            "-w",
            containerWorkspaceDir,
            "-v",
            `${hostWorkspaceDir}:${containerWorkspaceDir}`,
            ...mountArgs,
            containerImage,
            "sleep",
            "infinity",
        ],
        config.stateDir,
    );

    if (result.code !== 0 || !result.stdout.trim()) {
        throw new Error(`创建 room 容器失败: ${result.stderr || result.stdout || result.code}`);
    }

    return {
        containerId: result.stdout.trim(),
        containerName: name,
        containerImage,
        containerHomeDir,
        hostContainerStateDir,
        containerWorkspaceDir,
    };
}

export async function resolveRoomRuntime(
    roomConfigStore: RoomAgentConfigStore,
    roomId: string,
    agentUserId: string,
    config: AgentConfig,
    provider: ProviderAdapter,
    roomRuntimes: Record<string, RoomRuntimeState>,
    roomRuntimesFile: string,
): Promise<{ runtime: RoomRuntime; roomConfig: RoomAgentConfig }> {
    const roomConfig = await roomConfigStore.get(roomId, agentUserId);
    const state = roomRuntimes[roomId] ?? {};
    const mode = roomConfig.mode || state.mode || config.defaultRoomMode;
    const effectiveModel = roomConfig.model ?? config.providerModel;

    if (mode === "shared") {
        if (state.container_id) {
            await dockerRemoveContainer(config, state.container_id);
        }
        roomRuntimes[roomId] = {
            ...clearContainerState(state),
            mode,
        };
        await saveRoomRuntimes(roomRuntimesFile, roomRuntimes);
        return {
            runtime: {
                mode,
                cwd: config.providerCwd,
                hostWorkspaceDir: config.providerCwd,
                effectiveModel,
            },
            roomConfig,
        };
    }

    const workspaceSlug = slugForRoom(roomId, roomConfig.workspace_key);
    const hostWorkspaceDir = path.join(config.workspacesRoot, workspaceSlug);
    await mkdir(hostWorkspaceDir, { recursive: true });

    if (mode === "workspace") {
        if (state.container_id) {
            await dockerRemoveContainer(config, state.container_id);
        }
        roomRuntimes[roomId] = {
            ...clearContainerState(state),
            mode,
            workspace_dir: hostWorkspaceDir,
        };
        await saveRoomRuntimes(roomRuntimesFile, roomRuntimes);
        return {
            runtime: {
                mode,
                cwd: hostWorkspaceDir,
                hostWorkspaceDir,
                effectiveModel,
            },
            roomConfig,
        };
    }

    const ensured = await ensureRoomContainer(config, provider, roomId, workspaceSlug, hostWorkspaceDir, state, roomConfig);
    roomRuntimes[roomId] = {
        ...state,
        mode,
        workspace_dir: hostWorkspaceDir,
        container_id: ensured.containerId,
        container_name: ensured.containerName,
        container_image: ensured.containerImage,
        container_home_dir: ensured.containerHomeDir,
        host_container_state_dir: ensured.hostContainerStateDir,
        container_workspace_dir: ensured.containerWorkspaceDir,
    };
    await saveRoomRuntimes(roomRuntimesFile, roomRuntimes);
    return {
        runtime: {
            mode,
            cwd: ensured.containerWorkspaceDir,
            hostWorkspaceDir,
            effectiveModel,
            containerId: ensured.containerId,
            containerName: ensured.containerName,
            containerImage: ensured.containerImage,
            containerHomeDir: ensured.containerHomeDir,
            hostContainerStateDir: ensured.hostContainerStateDir,
            containerWorkspaceDir: ensured.containerWorkspaceDir,
        },
        roomConfig,
    };
}

export function buildProviderCommand(
    config: AgentConfig,
    runtime: RoomRuntime,
    executable: string,
    args: string[],
): { command: string[]; hostCwd: string } {
    if (runtime.mode === "container") {
        if (!runtime.containerId) {
            throw new Error("container 模式缺少 containerId");
        }
        return {
            command: [
                config.dockerBin,
                "exec",
                "-i",
                "-w",
                runtime.cwd,
                runtime.containerId,
                config.containerProviderBin,
                ...args,
            ],
            hostCwd: runtime.hostWorkspaceDir,
        };
    }

    return {
        command: [executable, ...args],
        hostCwd: runtime.cwd,
    };
}
