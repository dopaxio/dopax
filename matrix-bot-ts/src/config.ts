import "dotenv/config";
import os from "node:os";
import path from "node:path";

export type ProviderName = "codex" | "claude" | "gemini" | "copilot" | "opencode";
export type RoomMode = "shared" | "workspace" | "container";
export type ConnectMode = "remote" | "local";

export interface AgentConfig {
    connectMode: ConnectMode;
    homeserverUrl: string;
    agentServerUrl: string;
    ownerAccessToken: string;
    agentLocalpart: string | null;
    agentDisplayName: string | null;
    agentDeviceDisplayName: string;
    stateDir: string;
    storagePath: string;
    commandPrefix: string;
    roomAllowlist: string[];
    provider: ProviderName;
    providerBin: string;
    containerProviderBin: string;
    providerCwd: string;
    providerModel: string | null;
    defaultRoomMode: RoomMode;
    workspacesRoot: string;
    dockerBin: string;
    containerImage: string | null;
    containerHomesRoot: string;
    containerHomeDir: string;
    containerSeedHome: string | null;
    containerWorkspaceDir: string;
    codexApprovalPolicy: string;
    codexSandboxPolicy: string;
    typingTimeoutMs: number;
    matrixSyncTimeoutMs: number;
    presenceHeartbeatMs: number;
    streamFlushIntervalSec: number;
    streamFlushChars: number;
    commandOutputLimit: number;
    commandResultLimit: number;
    codexRequestTimeoutSec: number;
    codexTurnTimeoutSec: number;
    cliCommandTimeoutSec: number;
}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optional(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value || fallback;
}

function optionalNullable(name: string): string | null {
    const value = process.env[name]?.trim();
    return value || null;
}

function resolvePath(raw: string): string {
    if (raw === "~") {
        return os.homedir();
    }
    if (raw.startsWith("~/")) {
        return path.join(os.homedir(), raw.slice(2));
    }
    return path.resolve(raw);
}

function parseList(value: string | undefined): string[] {
    if (!value?.trim()) return [];
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`Environment variable ${name} must be a number`);
    }
    return value;
}

function parseProviderName(value: string): ProviderName {
    const normalized = value.trim().toLowerCase();
    if (["codex", "claude", "gemini", "copilot", "opencode"].includes(normalized)) {
        return normalized as ProviderName;
    }
    throw new Error(`Unsupported PROVIDER: ${value}`);
}

function parseRoomMode(value: string): RoomMode {
    const normalized = value.trim().toLowerCase();
    if (normalized === "shared" || normalized === "workspace" || normalized === "container") {
        return normalized;
    }
    throw new Error(`Unsupported ROOM_MODE: ${value}`);
}

function parseConnectMode(value: string): ConnectMode {
    const normalized = value.trim().toLowerCase();
    if (normalized === "remote" || normalized === "local") {
        return normalized;
    }
    throw new Error(`Unsupported CONNECT_MODE: ${value}`);
}

function defaultHomeserverForMode(mode: ConnectMode): string {
    if (mode === "local") return "http://tuwunel.dev.localhost";
    return "http://matrix.dev.localhost";
}

function envKeyForProvider(provider: ProviderName, suffix: string): string {
    return `${provider.toUpperCase()}_${suffix}`;
}

function resolveProviderBin(provider: ProviderName): string {
    return optionalNullable("PROVIDER_BIN")
        || optionalNullable(envKeyForProvider(provider, "BIN"))
        || (provider === "codex" ? optionalNullable("CODEX_BIN") : null)
        || provider;
}

function resolveContainerProviderBin(providerBin: string): string {
    return optionalNullable("CONTAINER_PROVIDER_BIN")
        || optionalNullable("PROVIDER_CONTAINER_BIN")
        || path.basename(providerBin);
}

function resolveProviderCwd(provider: ProviderName, stateDir: string): string {
    return path.resolve(
        optionalNullable("PROVIDER_CWD")
        || optionalNullable(envKeyForProvider(provider, "CWD"))
        || (provider === "codex" ? optionalNullable("CODEX_CWD") : null)
        || stateDir,
    );
}

function resolveProviderModel(provider: ProviderName): string | null {
    return optionalNullable("PROVIDER_MODEL")
        || optionalNullable(envKeyForProvider(provider, "MODEL"))
        || null;
}

export function loadConfig(): AgentConfig {
    const stateDir = resolvePath(optional("STATE_DIR", "./storage"));
    const storagePath = resolvePath(optional("STORAGE_PATH", path.join(stateDir, "sdk-storage.json")));
    const provider = parseProviderName(optional("PROVIDER", "codex"));
    const connectMode = parseConnectMode(optional("CONNECT_MODE", "remote"));
    const providerBin = resolveProviderBin(provider);

    return {
        connectMode,
        homeserverUrl: optionalNullable("HOMESERVER_URL") || defaultHomeserverForMode(connectMode),
        agentServerUrl: required("AGENT_SERVER_URL").replace(/\/+$/, ""),
        ownerAccessToken: required("OWNER_ACCESS_TOKEN"),
        agentLocalpart: optionalNullable("AGENT_LOCALPART"),
        agentDisplayName: optionalNullable("AGENT_DISPLAY_NAME"),
        agentDeviceDisplayName: optional("AGENT_DEVICE_DISPLAY_NAME", `${provider} runtime`),
        stateDir,
        storagePath,
        commandPrefix: optional("COMMAND_PREFIX", "!"),
        roomAllowlist: parseList(process.env.ROOM_ALLOWLIST),
        provider,
        providerBin,
        containerProviderBin: resolveContainerProviderBin(providerBin),
        providerCwd: resolveProviderCwd(provider, stateDir),
        providerModel: resolveProviderModel(provider),
        defaultRoomMode: parseRoomMode(optional("DEFAULT_ROOM_MODE", "shared")),
        workspacesRoot: resolvePath(optional("WORKSPACES_ROOT", path.join(stateDir, "workspaces"))),
        dockerBin: optional("DOCKER_BIN", "docker"),
        containerImage: optionalNullable("CONTAINER_IMAGE"),
        containerHomesRoot: resolvePath(optional("CONTAINER_HOMES_ROOT", path.join(stateDir, "container-homes"))),
        containerHomeDir: optional("CONTAINER_HOME_DIR", "/root"),
        containerSeedHome: optionalNullable("CONTAINER_SEED_HOME")
            ? resolvePath(optional("CONTAINER_SEED_HOME", ""))
            : optionalNullable("CONTAINER_CODEX_SEED_HOME")
                ? resolvePath(optional("CONTAINER_CODEX_SEED_HOME", ""))
                : null,
        containerWorkspaceDir: optional("CONTAINER_WORKSPACE_DIR", "/workspace"),
        codexApprovalPolicy: optional("CODEX_APPROVAL_POLICY", "never"),
        codexSandboxPolicy: optional("CODEX_SANDBOX_POLICY", "dangerFullAccess"),
        typingTimeoutMs: parseNumber("TYPING_TIMEOUT_MS", 120000),
        matrixSyncTimeoutMs: parseNumber("MATRIX_SYNC_TIMEOUT_MS", 15000),
        presenceHeartbeatMs: parseNumber("PRESENCE_HEARTBEAT_MS", 60000),
        streamFlushIntervalSec: parseNumber("STREAM_FLUSH_INTERVAL_SEC", 0.5),
        streamFlushChars: parseNumber("STREAM_FLUSH_CHARS", 24),
        commandOutputLimit: parseNumber("COMMAND_OUTPUT_LIMIT", 4000),
        commandResultLimit: parseNumber("COMMAND_RESULT_LIMIT", 3500),
        codexRequestTimeoutSec: parseNumber("CODEX_REQUEST_TIMEOUT_SEC", 30),
        codexTurnTimeoutSec: parseNumber("CODEX_TURN_TIMEOUT_SEC", 120),
        cliCommandTimeoutSec: parseNumber("CLI_COMMAND_TIMEOUT_SEC", 300),
    };
}
