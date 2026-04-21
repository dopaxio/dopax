import type { MatrixClient } from "matrix-bot-sdk";

import type { RoomMode } from "./config.js";

export const AGENT_ROOM_CONFIG_EVENT = "com.uu.matrix_agent.room_config";

export interface RoomAgentConfig {
    mode?: RoomMode;
    model?: string | null;
    workspace_key?: string | null;
    container_image?: string | null;
    container_workspace_dir?: string | null;
    updated_by?: string;
    updated_at?: number;
}

export interface RoomAgentConfigStore {
    get(roomId: string, agentUserId: string): Promise<RoomAgentConfig>;
    set(
        roomId: string,
        agentUserId: string,
        current: RoomAgentConfig,
        patch: Partial<RoomAgentConfig>,
        updatedBy: string,
    ): Promise<void>;
}

function isRoomMode(value: unknown): value is RoomMode {
    return value === "shared" || value === "workspace" || value === "container";
}

export function normalizeRoomAgentConfig(content: unknown): RoomAgentConfig {
    if (!content || typeof content !== "object") return {};
    const obj = content as Record<string, unknown>;
    const config: RoomAgentConfig = {};

    if (isRoomMode(obj["mode"])) {
        config.mode = obj["mode"];
    }
    if (typeof obj["model"] === "string") {
        config.model = obj["model"].trim() || null;
    }
    if (typeof obj["workspace_key"] === "string") {
        config.workspace_key = obj["workspace_key"].trim() || null;
    }
    if (typeof obj["container_image"] === "string") {
        config.container_image = obj["container_image"].trim() || null;
    }
    if (typeof obj["container_workspace_dir"] === "string") {
        config.container_workspace_dir = obj["container_workspace_dir"].trim() || null;
    }
    if (typeof obj["updated_by"] === "string" && obj["updated_by"].trim()) {
        config.updated_by = obj["updated_by"].trim();
    }
    if (typeof obj["updated_at"] === "number" && Number.isFinite(obj["updated_at"])) {
        config.updated_at = obj["updated_at"];
    }

    return config;
}

export class MatrixRoomAgentConfigStore implements RoomAgentConfigStore {
    public constructor(private readonly client: MatrixClient) {}

    public async get(roomId: string, agentUserId: string): Promise<RoomAgentConfig> {
        try {
            const accountData = await this.client.getSafeRoomAccountData(AGENT_ROOM_CONFIG_EVENT, roomId, {});
            const normalizedAccountData = normalizeRoomAgentConfig(accountData);
            if (Object.keys(normalizedAccountData).length > 0) {
                return normalizedAccountData;
            }
        } catch {}

        try {
            const legacyState = await this.client.getRoomStateEvent(roomId, AGENT_ROOM_CONFIG_EVENT, agentUserId);
            return normalizeRoomAgentConfig(legacyState);
        } catch {}

        return {};
    }

    public async set(
        roomId: string,
        _agentUserId: string,
        current: RoomAgentConfig,
        patch: Partial<RoomAgentConfig>,
        updatedBy: string,
    ): Promise<void> {
        const merged: RoomAgentConfig = {
            ...current,
            ...patch,
            updated_by: updatedBy,
            updated_at: Date.now(),
        };
        await this.client.setRoomAccountData(AGENT_ROOM_CONFIG_EVENT, roomId, merged);
    }
}
