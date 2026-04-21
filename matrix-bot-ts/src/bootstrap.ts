import type { AgentConfig } from "./config.js";
import type { RuntimeIdentityState } from "./state.js";

interface BootstrapAgentResponse {
    ok: boolean;
    data?: {
        created: boolean;
        provisioningMode: string;
        ownerUserId: string;
        agentUserId?: string;
        botUserId?: string;
        accessToken: string | null;
        deviceId: string | null;
        homeserverUrl: string;
        localpart: string;
        displayName: string | null;
    };
    error?: {
        code?: string;
        message?: string;
    };
}

export interface BootstrappedRuntimeCredentials {
    ownerUserId: string;
    agentUserId: string;
    accessToken: string;
    homeserverUrl: string;
    deviceId: string | null;
    localpart: string;
    exchangedAt: string;
    provisioningMode: string | null;
}

export async function exchangeRuntimeCredentials(
    config: AgentConfig,
    cachedIdentity: RuntimeIdentityState | null,
): Promise<BootstrappedRuntimeCredentials> {
    const response = await fetch(`${config.agentServerUrl}/v1/me/agents/bootstrap`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.ownerAccessToken}`,
        },
        body: JSON.stringify({
            provider: config.provider,
            localpart: config.agentLocalpart ?? undefined,
            displayName: config.agentDisplayName ?? undefined,
            initialDeviceDisplayName: config.agentDeviceDisplayName,
            deviceId: cachedIdentity?.deviceId ?? undefined,
        }),
    });

    const body = await response.json() as BootstrapAgentResponse;
    const runtimeUserId = body.data?.agentUserId ?? body.data?.botUserId;
    if (
        !response.ok
        || !body.ok
        || !body.data?.accessToken
        || !runtimeUserId
        || !body.data.ownerUserId
        || !body.data.homeserverUrl
    ) {
        const message = body.error?.message || "Failed to exchange owner identity for runtime credentials";
        throw new Error(message);
    }

    return {
        ownerUserId: body.data.ownerUserId,
        agentUserId: runtimeUserId,
        accessToken: body.data.accessToken,
        homeserverUrl: body.data.homeserverUrl,
        deviceId: body.data.deviceId ?? cachedIdentity?.deviceId ?? null,
        localpart: body.data.localpart,
        exchangedAt: new Date().toISOString(),
        provisioningMode: body.data.provisioningMode ?? null,
    };
}
