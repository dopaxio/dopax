import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type RoomMode = "shared" | "workspace" | "container";

export interface ConversationSessionState {
    provider?: string;
    session_kind?: string;
    thread_id?: string;
    session_id?: string;
}

export interface RoomRuntimeState {
    mode?: RoomMode;
    workspace_dir?: string;
    container_id?: string;
    container_name?: string;
    container_image?: string;
    container_home_dir?: string;
    host_container_state_dir?: string;
    host_container_home_dir?: string;
    container_workspace_dir?: string;
}

export interface AgentStatePaths {
    tokenFile: string;
    runtimeIdentityFile: string;
    conversationSessionsFile: string;
    roomRuntimesFile: string;
    handledPollsFile: string;
}

export interface RuntimeIdentityState {
    ownerUserId: string;
    agentUserId: string;
    provider: string;
    homeserverUrl?: string | null;
    deviceId?: string | null;
    localpart?: string | null;
    exchangedAt: string;
    provisioningMode?: string | null;
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
    try {
        const raw = await readFile(file, "utf8");
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export async function ensureStateDir(stateDir: string): Promise<AgentStatePaths> {
    await mkdir(stateDir, { recursive: true });
    return {
        tokenFile: path.join(stateDir, "access-token.txt"),
        runtimeIdentityFile: path.join(stateDir, "runtime-identity.json"),
        conversationSessionsFile: path.join(stateDir, "conversation-sessions.json"),
        roomRuntimesFile: path.join(stateDir, "room-runtimes.json"),
        handledPollsFile: path.join(stateDir, "handled-polls.json"),
    };
}

export async function loadSavedToken(file: string): Promise<string | null> {
    try {
        const raw = (await readFile(file, "utf8")).trim();
        return raw || null;
    } catch {
        return null;
    }
}

export async function saveToken(file: string, token: string): Promise<void> {
    await writeFile(file, `${token.trim()}\n`, "utf8");
}

export async function clearToken(file: string): Promise<void> {
    try {
        await unlink(file);
    } catch {
        // ignore
    }
}

export async function loadRuntimeIdentity(file: string): Promise<RuntimeIdentityState | null> {
    const raw = await readJsonFile<unknown>(file, null);
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const value = raw as Record<string, unknown>;
    if (
        typeof value.ownerUserId !== "string"
        || typeof value.agentUserId !== "string"
        || typeof value.provider !== "string"
        || typeof value.exchangedAt !== "string"
    ) {
        return null;
    }

    return {
        ownerUserId: value.ownerUserId,
        agentUserId: value.agentUserId,
        provider: value.provider,
        homeserverUrl: typeof value.homeserverUrl === "string" ? value.homeserverUrl : null,
        deviceId: typeof value.deviceId === "string" ? value.deviceId : null,
        localpart: typeof value.localpart === "string" ? value.localpart : null,
        exchangedAt: value.exchangedAt,
        provisioningMode: typeof value.provisioningMode === "string" ? value.provisioningMode : null,
    };
}

export async function saveRuntimeIdentity(file: string, identity: RuntimeIdentityState): Promise<void> {
    await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export async function loadConversationSessions(file: string): Promise<Record<string, ConversationSessionState>> {
    const raw = await readJsonFile<Record<string, unknown>>(file, {});
    const sessions: Record<string, ConversationSessionState> = {};

    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string" && value.trim()) {
            sessions[key] = { thread_id: value.trim() };
            continue;
        }

        if (value && typeof value === "object") {
            const obj = value as Record<string, unknown>;
            const state: ConversationSessionState = {};
            const maybeProvider = obj["provider"];
            const maybeSessionKind = obj["session_kind"];
            const maybeThreadId = obj["thread_id"];
            const maybeSessionId = obj["session_id"];

            if (typeof maybeProvider === "string" && maybeProvider.trim()) {
                state.provider = maybeProvider.trim();
            }
            if (typeof maybeSessionKind === "string" && maybeSessionKind.trim()) {
                state.session_kind = maybeSessionKind.trim();
            }
            if (typeof maybeThreadId === "string" && maybeThreadId.trim()) {
                state.thread_id = maybeThreadId.trim();
            }
            if (typeof maybeSessionId === "string" && maybeSessionId.trim()) {
                state.session_id = maybeSessionId.trim();
            }

            if (state.provider || state.session_kind || state.thread_id || state.session_id) {
                sessions[key] = state;
            }
        }
    }

    return sessions;
}

export async function saveConversationSessions(
    file: string,
    sessions: Record<string, ConversationSessionState>,
): Promise<void> {
    await writeFile(file, JSON.stringify(sessions, null, 2), "utf8");
}

export async function loadRoomRuntimes(file: string): Promise<Record<string, RoomRuntimeState>> {
    const raw = await readJsonFile<Record<string, unknown>>(file, {});
    const runtimes: Record<string, RoomRuntimeState> = {};

    for (const [roomId, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        const obj = value as Record<string, unknown>;
        const state: RoomRuntimeState = {};
        const mode = obj["mode"];
        const workspaceDir = obj["workspace_dir"];
        const containerId = obj["container_id"];
        const containerName = obj["container_name"];
        const containerImage = obj["container_image"];
        const containerHomeDir = obj["container_home_dir"];
        const hostContainerStateDir = obj["host_container_state_dir"];
        const hostContainerHomeDir = obj["host_container_home_dir"];
        const containerWorkspaceDir = obj["container_workspace_dir"];

        if (mode === "shared" || mode === "workspace" || mode === "container") {
            state.mode = mode;
        }
        if (typeof workspaceDir === "string" && workspaceDir.trim()) {
            state.workspace_dir = workspaceDir.trim();
        }
        if (typeof containerId === "string" && containerId.trim()) {
            state.container_id = containerId.trim();
        }
        if (typeof containerName === "string" && containerName.trim()) {
            state.container_name = containerName.trim();
        }
        if (typeof containerImage === "string" && containerImage.trim()) {
            state.container_image = containerImage.trim();
        }
        if (typeof containerHomeDir === "string" && containerHomeDir.trim()) {
            state.container_home_dir = containerHomeDir.trim();
        }
        if (typeof hostContainerStateDir === "string" && hostContainerStateDir.trim()) {
            state.host_container_state_dir = hostContainerStateDir.trim();
        }
        if (typeof hostContainerHomeDir === "string" && hostContainerHomeDir.trim()) {
            state.host_container_home_dir = hostContainerHomeDir.trim();
        }
        if (typeof containerWorkspaceDir === "string" && containerWorkspaceDir.trim()) {
            state.container_workspace_dir = containerWorkspaceDir.trim();
        }

        if (
            state.mode
            || state.workspace_dir
            || state.container_id
            || state.container_name
            || state.container_image
            || state.container_home_dir
            || state.host_container_state_dir
            || state.host_container_home_dir
            || state.container_workspace_dir
        ) {
            runtimes[roomId] = state;
        }
    }

    return runtimes;
}

export async function saveRoomRuntimes(
    file: string,
    runtimes: Record<string, RoomRuntimeState>,
): Promise<void> {
    await writeFile(file, JSON.stringify(runtimes, null, 2), "utf8");
}

export async function loadHandledPolls(file: string): Promise<Set<string>> {
    const raw = await readJsonFile<unknown>(file, []);
    if (!Array.isArray(raw)) return new Set();
    return new Set(
        raw
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
    );
}

export async function saveHandledPolls(file: string, handledPolls: Set<string>): Promise<void> {
    await writeFile(
        file,
        JSON.stringify(Array.from(handledPolls).sort(), null, 2),
        "utf8",
    );
}
