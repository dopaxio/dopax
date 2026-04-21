/*
Copyright 2026 Dopax

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { app, powerSaveBlocker } from "electron";

import { buildExecutablePath } from "./agent-cli.js";

type ProviderName = "codex" | "claude" | "gemini" | "copilot" | "opencode";
type RoomMode = "shared" | "workspace" | "container";

interface DesktopAgentProviderConfig {
    provider: ProviderName;
    provider_bin?: string;
    provider_model?: string;
    default_room_mode?: RoomMode;
    command_prefix?: string;
    container_image?: string;
    container_provider_bin?: string;
}

interface DesktopAgentConfig {
    enabled?: boolean;
    agent_server_url?: string;
    providers?: DesktopAgentProviderConfig[];
}

interface DesktopAgentSession {
    accessToken: string;
    homeserverUrl: string;
}

export interface DesktopAgentStatus {
    platform: "desktop";
    available: boolean;
    state: "running" | "stopped" | "waiting" | "unavailable" | "error";
    serviceManager: "launchd" | "process";
    label?: string;
    summary: string;
    configuredProviders: string[];
    runningProviders: string[];
    enabled: boolean;
    sessionReady: boolean;
    updatedAt: string;
}

interface RuntimePaths {
    runtimeRoot: string;
    nodeBinary: string;
    supervisorEntrypoint: string;
}

interface ProcessSpec {
    name: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    envFile?: string;
    restart?: boolean;
    restartDelayMs?: number;
}

interface SupervisorConfig {
    mode: "remote";
    agents: ProcessSpec[];
}

interface ServicePaths {
    launchAgentsDir: string;
    runtimeDir: string;
    stagedRuntimeDir: string;
    envDir: string;
    logsDir: string;
    plistPath: string;
    configPath: string;
    signaturePath: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_RESTART_DELAY_MS = 2000;
const LOG_PREFIX = "[desktop-agent]";
const LAUNCH_AGENT_VERSION = "caffeinate-v2";
const LAUNCH_AGENT_RETRY_DELAY_MS = 500;
const execFileAsync = promisify(execFile);

function runtimeTargetName(platform = process.platform, arch = process.arch): string {
    return `${platform}-${arch}`;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isProviderName(value: unknown): value is ProviderName {
    return value === "codex" || value === "claude" || value === "gemini" || value === "copilot" || value === "opencode";
}

function isRoomMode(value: unknown): value is RoomMode {
    return value === "shared" || value === "workspace" || value === "container";
}

function normalizeAgentConfig(config: IConfigOptions | undefined): DesktopAgentConfig | null {
    const raw = config?.desktop_agent;
    if (!raw || typeof raw !== "object") return null;

    const providers: DesktopAgentProviderConfig[] = [];
    const rawProviders = (raw as Record<string, unknown>)["providers"];
    if (Array.isArray(rawProviders)) {
        for (const item of rawProviders) {
            if (!item || typeof item !== "object") continue;
            const candidate = item as Record<string, unknown>;
            if (!isProviderName(candidate["provider"])) continue;

            providers.push({
                provider: candidate["provider"],
                provider_bin: isNonEmptyString(candidate["provider_bin"]) ? candidate["provider_bin"].trim() : undefined,
                provider_model: isNonEmptyString(candidate["provider_model"])
                    ? candidate["provider_model"].trim()
                    : undefined,
                default_room_mode: isRoomMode(candidate["default_room_mode"]) ? candidate["default_room_mode"] : undefined,
                command_prefix: isNonEmptyString(candidate["command_prefix"])
                    ? candidate["command_prefix"].trim()
                    : undefined,
                container_image: isNonEmptyString(candidate["container_image"])
                    ? candidate["container_image"].trim()
                    : undefined,
                container_provider_bin: isNonEmptyString(candidate["container_provider_bin"])
                    ? candidate["container_provider_bin"].trim()
                    : undefined,
            });
        }
    }

    return {
        enabled: raw["enabled"] !== false,
        agent_server_url: isNonEmptyString(raw["agent_server_url"]) ? raw["agent_server_url"].trim() : undefined,
        providers,
    };
}

function normalizeSession(value: unknown): DesktopAgentSession | null {
    if (!value || typeof value !== "object") return null;

    const payload = value as Record<string, unknown>;
    if (!isNonEmptyString(payload["accessToken"]) || !isNonEmptyString(payload["homeserverUrl"])) {
        return null;
    }

    return {
        accessToken: payload["accessToken"].trim(),
        homeserverUrl: payload["homeserverUrl"].trim(),
    };
}

function prefixedLog(suffix: string, chunk: Buffer | string): void {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.log(`${LOG_PREFIX}:${suffix} ${line}`);
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export class DesktopAgentManager {
    private config: DesktopAgentConfig | null = null;
    private session: DesktopAgentSession | null = null;
    private supervisorProcess: ChildProcess | null = null;
    private runningSignature: string | null = null;
    private desiredSignature: string | null = null;
    private restartTimer: NodeJS.Timeout | null = null;
    private syncChain: Promise<void> = Promise.resolve();
    private powerSaveBlockerId: number | null = null;

    public updateConfig(config: IConfigOptions | undefined): void {
        this.config = normalizeAgentConfig(config);
        console.log(`${LOG_PREFIX} config updated: enabled=${this.config?.enabled !== false} providers=${this.config?.providers?.map((p) => p.provider).join(",") || "none"}`);
        this.enqueueSync();
    }

    public updateSession(value: unknown): void {
        this.session = normalizeSession(value);
        console.log(
            `${LOG_PREFIX} session updated: ${
                this.session ? `homeserver=${this.session.homeserverUrl}` : "null"
            }`,
        );
        this.enqueueSync();
    }

    public stop(): Promise<void> {
        this.session = null;
        this.desiredSignature = null;
        return this.enqueueSync(true);
    }

    public async control(action: "start" | "restart"): Promise<DesktopAgentStatus> {
        if (action === "restart") {
            this.desiredSignature = null;
            await this.stopSupervisor();
        }

        await this.enqueueSync();
        return this.getStatus();
    }

    public async getStatus(): Promise<DesktopAgentStatus> {
        const configuredProviders = (this.config?.providers ?? []).map((provider) => provider.provider);
        const enabled = this.config?.enabled !== false;
        const sessionReady = Boolean(this.session || this.getDevSessionFromEnv());

        if (process.platform === "darwin") {
            return this.getLaunchAgentStatus(configuredProviders, enabled, sessionReady);
        }

        const running = Boolean(this.supervisorProcess && !this.supervisorProcess.killed && this.supervisorProcess.exitCode === null);
        return {
            platform: "desktop",
            available: true,
            state: this.resolveRuntimeState({ enabled, sessionReady, running }),
            serviceManager: "process",
            summary: this.buildStatusSummary({
                enabled,
                sessionReady,
                running,
                configured: configuredProviders.length > 0,
                serviceManager: "process",
            }),
            configuredProviders,
            runningProviders: running ? configuredProviders : [],
            enabled,
            sessionReady,
            updatedAt: new Date().toISOString(),
        };
    }

    public async reconcilePowerSaveBlocker(): Promise<void> {
        const status = await this.getStatus();
        const shouldBlock = status.state === "running";

        if (shouldBlock) {
            if (this.powerSaveBlockerId === null) {
                this.powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
                console.log(`${LOG_PREFIX} powerSaveBlocker enabled (${this.powerSaveBlockerId})`);
            }
            return;
        }

        this.releasePowerSaveBlocker();
    }

    private enqueueSync(forceStop = false): Promise<void> {
        this.syncChain = this.syncChain
            .catch((error) => {
                console.error(`${LOG_PREFIX} previous sync failed`, error);
            })
            .then(async () => {
                await this.sync(forceStop);
            });

        return this.syncChain;
    }

    private async sync(forceStop: boolean): Promise<void> {
        const config = this.config;
        const session = this.session || this.getDevSessionFromEnv();
        if (forceStop || !config?.enabled) {
            console.log(`${LOG_PREFIX} sync stopping service: forceStop=${forceStop} enabled=${config?.enabled !== false}`);
            await this.stopSupervisor();
            await this.reconcilePowerSaveBlocker();
            return;
        }

        if (!session) {
            console.log(`${LOG_PREFIX} no session available yet; leaving background service unchanged`);
            await this.reconcilePowerSaveBlocker();
            return;
        }

        const agentServerUrl = config.agent_server_url || global.vectorConfig?.agent_console?.api_base_url;
        if (!isNonEmptyString(agentServerUrl)) {
            console.warn(`${LOG_PREFIX} desktop_agent enabled but no agent_server_url or agent_console.api_base_url configured`);
            await this.stopSupervisor();
            await this.reconcilePowerSaveBlocker();
            return;
        }

        const providers = config.providers ?? [];
        if (providers.length === 0) {
            console.warn(`${LOG_PREFIX} desktop_agent enabled but no providers configured`);
            await this.stopSupervisor();
            await this.reconcilePowerSaveBlocker();
            return;
        }

        const resolvedRuntimePaths = this.resolveRuntimePaths();
        await this.ensureRuntimePathsReady(resolvedRuntimePaths);
        const runtimePaths = process.platform === "darwin"
            ? await this.stageLaunchAgentRuntime(resolvedRuntimePaths)
            : resolvedRuntimePaths;
        const supervisorConfig = await this.buildSupervisorConfig(runtimePaths, agentServerUrl, providers, session);
        if (!supervisorConfig || supervisorConfig.agents.length === 0) {
            await this.stopSupervisor();
            await this.reconcilePowerSaveBlocker();
            return;
        }

        const signature = JSON.stringify({
            launchAgentVersion: LAUNCH_AGENT_VERSION,
            agentServerUrl,
            session,
            supervisorConfig,
            runtimePaths,
        });
        this.desiredSignature = signature;
        console.log(
            `${LOG_PREFIX} sync ready: providers=${supervisorConfig.agents.map((agent) => agent.name).join(",")} homeserver=${session.homeserverUrl}`,
        );

        if (this.supervisorProcess && this.runningSignature === signature) {
            console.log(`${LOG_PREFIX} supervisor already matches desired config`);
            await this.reconcilePowerSaveBlocker();
            return;
        }

        if (process.platform === "darwin") {
            await this.startLaunchAgent(runtimePaths, supervisorConfig, signature);
            await this.reconcilePowerSaveBlocker();
            return;
        }

        await this.stopSupervisor();
        await this.startSupervisor(runtimePaths, supervisorConfig, signature);
        await this.reconcilePowerSaveBlocker();
    }

    private resolveRuntimeState({
        enabled,
        sessionReady,
        running,
    }: {
        enabled: boolean;
        sessionReady: boolean;
        running: boolean;
    }): DesktopAgentStatus["state"] {
        if (!enabled) {
            return "unavailable";
        }
        if (running) {
            return "running";
        }
        if (!sessionReady) {
            return "waiting";
        }
        return "stopped";
    }

    private buildStatusSummary({
        enabled,
        sessionReady,
        running,
        configured,
        serviceManager,
    }: {
        enabled: boolean;
        sessionReady: boolean;
        running: boolean;
        configured: boolean;
        serviceManager: DesktopAgentStatus["serviceManager"];
    }): string {
        if (!enabled) {
            return "Desktop background runtime is disabled in config.";
        }
        if (!configured) {
            return "Desktop background runtime is enabled, but no providers are configured.";
        }
        if (!sessionReady) {
            return "Waiting for a signed-in Matrix session before starting the background runtime.";
        }
        if (running) {
            return serviceManager === "launchd"
                ? "Desktop background runtime is active and managed by launchd."
                : "Desktop background runtime is active in the current app process.";
        }
        return serviceManager === "launchd"
            ? "Desktop background runtime is configured but not currently running under launchd."
            : "Desktop background runtime is configured but not currently running.";
    }

    private async getLaunchAgentStatus(
        configuredProviders: string[],
        enabled: boolean,
        sessionReady: boolean,
    ): Promise<DesktopAgentStatus> {
        const label = this.serviceLabel();
        const servicePaths = this.getServicePaths();
        let launchctlOutput = "";
        let running = false;
        let loadError = false;
        try {
            const { stdout, stderr } = await execFileAsync("launchctl", [
                "print",
                `gui/${process.getuid?.() ?? process.env.UID}/${label}`,
            ]);
            launchctlOutput = `${stdout}\n${stderr}`;
            running = /\bstate = running\b/.test(launchctlOutput);
        } catch (error) {
            const commandError = error as Error & { stdout?: string; stderr?: string };
            launchctlOutput = `${commandError.stdout ?? ""}\n${commandError.stderr ?? ""}`;
            loadError = !/Could not find service/i.test(launchctlOutput);
        }

        let runningProviders: string[] = [];
        try {
            const persisted = JSON.parse(await readFile(servicePaths.configPath, "utf8")) as {
                agents?: Array<{ name?: string }>;
                bots?: Array<{ name?: string }>;
            };
            const persistedProcesses = Array.isArray(persisted.agents)
                ? persisted.agents
                : Array.isArray(persisted.bots)
                    ? persisted.bots
                    : [];
            runningProviders = persistedProcesses
                .map((agent) => agent.name?.replace(/-desktop$/, ""))
                .filter((provider): provider is string => Boolean(provider));
        } catch {
            runningProviders = [];
        }

        if (running && runningProviders.length === 0 && configuredProviders.length > 0) {
            runningProviders = [...configuredProviders];
        }

        return {
            platform: "desktop",
            available: true,
            state: loadError
                ? "error"
                : this.resolveRuntimeState({
                      enabled,
                      sessionReady,
                      running,
                  }),
            serviceManager: "launchd",
            label,
            summary: loadError
                ? "Unable to inspect the launchd background runtime."
                : this.buildStatusSummary({
                      enabled,
                      sessionReady,
                      running,
                      configured: configuredProviders.length > 0 || runningProviders.length > 0,
                      serviceManager: "launchd",
                  }),
            configuredProviders,
            runningProviders: running ? runningProviders : [],
            enabled,
            sessionReady,
            updatedAt: new Date().toISOString(),
        };
    }

    private async buildSupervisorConfig(
        runtimePaths: RuntimePaths,
        agentServerUrl: string,
        providers: DesktopAgentProviderConfig[],
        session: DesktopAgentSession,
    ): Promise<SupervisorConfig | null> {
        const agents: ProcessSpec[] = [];

        for (const provider of providers) {
            const providerBin = provider.provider_bin || provider.provider;
            const roomMode = provider.default_room_mode || "shared";
            const pathEnv = buildExecutablePath({
                existingPath: process.env.PATH,
                explicitBin: providerBin,
                homeDir: app.getPath("home"),
            });

            const stateDir = join(app.getPath("userData"), "agents", provider.provider);
            const env: Record<string, string> = {
                AGENT_SERVER_URL: agentServerUrl.replace(/\/+$/, ""),
                OWNER_ACCESS_TOKEN: session.accessToken,
                HOMESERVER_URL: session.homeserverUrl,
                STATE_DIR: stateDir,
                STORAGE_PATH: join(stateDir, "sdk-storage.json"),
                PROVIDER: provider.provider,
                PROVIDER_BIN: providerBin,
                AGENT_DEVICE_DISPLAY_NAME: `Dopax ${provider.provider} runtime`,
                DEFAULT_ROOM_MODE: roomMode,
                PROVIDER_CWD: stateDir,
                WORKSPACES_ROOT: join(stateDir, "workspaces"),
                PATH: pathEnv,
            };

            if (isNonEmptyString(provider.provider_model)) {
                env.PROVIDER_MODEL = provider.provider_model;
            }
            if (isNonEmptyString(provider.command_prefix)) {
                env.COMMAND_PREFIX = provider.command_prefix;
            }
            if (isNonEmptyString(provider.container_image)) {
                env.CONTAINER_IMAGE = provider.container_image;
            }
            if (isNonEmptyString(provider.container_provider_bin)) {
                env.CONTAINER_PROVIDER_BIN = provider.container_provider_bin;
            }

            agents.push({
                name: `${provider.provider}-desktop`,
                command: [runtimePaths.nodeBinary, join("dist", "index.js")],
                cwd: runtimePaths.runtimeRoot,
                env,
                restart: true,
                restartDelayMs: SUPERVISOR_RESTART_DELAY_MS,
            });
        }

        if (agents.length === 0) {
            return null;
        }

        return {
            mode: "remote",
            agents,
        };
    }

    private resolveRuntimePaths(): RuntimePaths {
        if (app.isPackaged) {
            const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
            const packagedRuntimeRoot = join(process.resourcesPath, "agent-runtime", runtimeTargetName());
            if (
                existsSync(packagedRuntimeRoot)
                && existsSync(join(packagedRuntimeRoot, "bin", nodeBinaryName))
                && existsSync(join(packagedRuntimeRoot, "dist", "supervisor", "index.js"))
            ) {
                return {
                    runtimeRoot: packagedRuntimeRoot,
                    nodeBinary: join(packagedRuntimeRoot, "bin", nodeBinaryName),
                    supervisorEntrypoint: join(packagedRuntimeRoot, "dist", "supervisor", "index.js"),
                };
            }

            const legacyRuntimeRoot = join(process.resourcesPath, "agent-runtime");
            return {
                runtimeRoot: legacyRuntimeRoot,
                nodeBinary: join(legacyRuntimeRoot, "bin", nodeBinaryName),
                supervisorEntrypoint: join(legacyRuntimeRoot, "dist", "supervisor", "index.js"),
            };
        }

        if (process.platform === "darwin") {
            const bundledRuntimeRoot = resolve(__dirname, "../build/agent-runtime", runtimeTargetName());
            const bundledNodeBinary = join(bundledRuntimeRoot, "bin", "node");
            const bundledSupervisorEntrypoint = join(bundledRuntimeRoot, "dist", "supervisor", "index.js");
            if (
                existsSync(bundledRuntimeRoot)
                && existsSync(bundledNodeBinary)
                && existsSync(bundledSupervisorEntrypoint)
            ) {
                return {
                    runtimeRoot: bundledRuntimeRoot,
                    nodeBinary: bundledNodeBinary,
                    supervisorEntrypoint: bundledSupervisorEntrypoint,
                };
            }

            const legacyBundledRuntimeRoot = resolve(__dirname, "../build/agent-runtime");
            const legacyBundledNodeBinary = join(legacyBundledRuntimeRoot, "bin", "node");
            const legacyBundledSupervisorEntrypoint = join(legacyBundledRuntimeRoot, "dist", "supervisor", "index.js");
            if (
                existsSync(legacyBundledRuntimeRoot)
                && existsSync(legacyBundledNodeBinary)
                && existsSync(legacyBundledSupervisorEntrypoint)
            ) {
                return {
                    runtimeRoot: legacyBundledRuntimeRoot,
                    nodeBinary: legacyBundledNodeBinary,
                    supervisorEntrypoint: legacyBundledSupervisorEntrypoint,
                };
            }

            const runtimeRoot = resolve(__dirname, "../../../../matrix-bot-ts");
            return {
                runtimeRoot,
                nodeBinary: process.env.DOPAX_DESKTOP_NODE_BINARY || "node",
                supervisorEntrypoint: join(runtimeRoot, "dist", "supervisor", "index.js"),
            };
        }

        const runtimeRoot = resolve(__dirname, "../../../../matrix-bot-ts");
        return {
            runtimeRoot,
            nodeBinary: process.env.DOPAX_DESKTOP_NODE_BINARY || "node",
            supervisorEntrypoint: join(runtimeRoot, "dist", "supervisor", "index.js"),
        };
    }

    private serviceLabel(): string {
        const suffix = createHash("sha1").update(app.getPath("userData")).digest("hex").slice(0, 12);
        return `io.dopax.agentd.${suffix}`;
    }

    private getServicePaths(): ServicePaths {
        const runtimeDir = join(app.getPath("userData"), "agent-service");
        const launchAgentsDir = join(app.getPath("home"), "Library", "LaunchAgents");
        const label = this.serviceLabel();
        return {
            launchAgentsDir,
            runtimeDir,
            stagedRuntimeDir: join(runtimeDir, "runtime"),
            envDir: join(runtimeDir, "env"),
            logsDir: join(runtimeDir, "logs"),
            plistPath: join(launchAgentsDir, `${label}.plist`),
            configPath: join(runtimeDir, "supervisor.json"),
            signaturePath: join(runtimeDir, "signature.txt"),
        };
    }

    private async ensureRuntimePathsReady(runtimePaths: RuntimePaths): Promise<void> {
        try {
            await access(runtimePaths.runtimeRoot, fsConstants.R_OK);
            await access(runtimePaths.supervisorEntrypoint, fsConstants.R_OK);
            if (runtimePaths.nodeBinary.includes("/") || runtimePaths.nodeBinary.includes("\\")) {
                await access(runtimePaths.nodeBinary, fsConstants.X_OK);
            }
            return;
        } catch {
            // Fall through to dev-time regeneration.
        }

        if (app.isPackaged || process.platform !== "darwin") {
            throw new Error(`Desktop agent runtime is missing: ${runtimePaths.runtimeRoot}`);
        }

        const desktopRoot = resolve(__dirname, "..");
        const prepareScript = resolve(desktopRoot, "scripts", "prepare-agent-runtime.ts");
        const nodeBinary = await this.resolveNodeBinary(process.env.DOPAX_DESKTOP_NODE_BINARY || "node");

        console.log(`${LOG_PREFIX} runtime bundle missing; rebuilding desktop agent runtime`);
        await execFileAsync(nodeBinary, [prepareScript], {
            cwd: desktopRoot,
        });

        await access(runtimePaths.runtimeRoot, fsConstants.R_OK);
        await access(runtimePaths.supervisorEntrypoint, fsConstants.R_OK);
        if (runtimePaths.nodeBinary.includes("/") || runtimePaths.nodeBinary.includes("\\")) {
            await access(runtimePaths.nodeBinary, fsConstants.X_OK);
        }
    }

    private async stageLaunchAgentRuntime(runtimePaths: RuntimePaths): Promise<RuntimePaths> {
        const servicePaths = this.getServicePaths();
        await mkdir(servicePaths.runtimeDir, { recursive: true });
        await rm(servicePaths.stagedRuntimeDir, { recursive: true, force: true });
        await cp(runtimePaths.runtimeRoot, servicePaths.stagedRuntimeDir, { recursive: true, dereference: true });
        const nodeBinaryName = process.platform === "win32" ? "node.exe" : "node";
        const sourceBundledNodeBinary = join(runtimePaths.runtimeRoot, "bin", nodeBinaryName);
        const stagedBundledNodeBinary = join(servicePaths.stagedRuntimeDir, "bin", nodeBinaryName);
        return {
            runtimeRoot: servicePaths.stagedRuntimeDir,
            nodeBinary: runtimePaths.nodeBinary === sourceBundledNodeBinary
                ? stagedBundledNodeBinary
                : runtimePaths.nodeBinary,
            supervisorEntrypoint: join(servicePaths.stagedRuntimeDir, "dist", "supervisor", "index.js"),
        };
    }

    private async resolveNodeBinary(raw: string): Promise<string> {
        if (raw.includes("/") || (process.platform === "win32" && raw.includes("\\"))) {
            return raw;
        }

        const { stdout } = await execFileAsync("/usr/bin/which", [raw]);
        const resolved = stdout.trim();
        if (!resolved) {
            throw new Error(`Unable to resolve runtime node binary: ${raw}`);
        }
        return resolved;
    }

    private async isLaunchAgentLoaded(label: string): Promise<boolean> {
        try {
            await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? process.env.UID}/${label}`]);
            return true;
        } catch {
            return false;
        }
    }

    private async readServiceSignature(file: string): Promise<string | null> {
        try {
            return (await readFile(file, "utf8")).trim() || null;
        } catch {
            return null;
        }
    }

    private async writeServiceFiles(
        runtimePaths: RuntimePaths,
        supervisorConfig: SupervisorConfig,
        signature: string,
    ): Promise<{ servicePaths: ServicePaths; nodeBinary: string }> {
        const sharedPathEnv = buildExecutablePath({
            existingPath: process.env.PATH,
            homeDir: app.getPath("home"),
        });
        const servicePaths = this.getServicePaths();
        await mkdir(servicePaths.launchAgentsDir, { recursive: true });
        await mkdir(servicePaths.runtimeDir, { recursive: true });
        await mkdir(servicePaths.envDir, { recursive: true });
        await mkdir(servicePaths.logsDir, { recursive: true });

        const agents: ProcessSpec[] = [];
        for (const agent of supervisorConfig.agents) {
            const envFilePath = join(servicePaths.envDir, `${agent.name}.env`);
            const envLines = Object.entries(agent.env ?? {}).map(([key, value]) => `${key}=${value}`);
            await writeFile(envFilePath, `${envLines.join("\n")}\n`, "utf8");
            agents.push({
                ...agent,
                env: undefined,
                envFile: envFilePath,
            });
        }

        await writeFile(
            servicePaths.configPath,
            `${JSON.stringify({ ...supervisorConfig, agents }, null, 2)}\n`,
            "utf8",
        );
        await writeFile(servicePaths.signaturePath, `${signature}\n`, "utf8");

        const nodeBinary = await this.resolveNodeBinary(runtimePaths.nodeBinary);
        const programArguments = [
            "/usr/bin/caffeinate",
            "-i",
            nodeBinary,
            runtimePaths.supervisorEntrypoint,
            servicePaths.configPath,
        ];
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${this.serviceLabel()}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments.map((argument) => `        <string>${argument}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${runtimePaths.runtimeRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${sharedPathEnv}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(servicePaths.logsDir, "agentd.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(servicePaths.logsDir, "agentd.error.log")}</string>
</dict>
</plist>
`;
        await writeFile(servicePaths.plistPath, plist, "utf8");

        return { servicePaths, nodeBinary };
    }

    private async startLaunchAgent(
        runtimePaths: RuntimePaths,
        supervisorConfig: SupervisorConfig,
        signature: string,
    ): Promise<void> {
        const label = this.serviceLabel();
        const loaded = await this.isLaunchAgentLoaded(label);
        const existingSignature = await this.readServiceSignature(this.getServicePaths().signaturePath);
        const { servicePaths } = await this.writeServiceFiles(runtimePaths, supervisorConfig, signature);

        if (loaded && existingSignature === signature) {
            console.log(`${LOG_PREFIX} launch agent already running with matching config`);
            this.runningSignature = signature;
            return;
        }

        console.log(`${LOG_PREFIX} installing launch agent ${label}`);
        if (loaded) {
            await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? process.env.UID}/${label}`]).catch(() => undefined);
            await wait(LAUNCH_AGENT_RETRY_DELAY_MS);
        }

        try {
            await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? process.env.UID}`, servicePaths.plistPath]);
        } catch (error) {
            console.warn(`${LOG_PREFIX} bootstrap failed, retrying once`, error);
            await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? process.env.UID}/${label}`]).catch(() => undefined);
            await wait(LAUNCH_AGENT_RETRY_DELAY_MS);
            await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? process.env.UID}`, servicePaths.plistPath]);
        }

        if (!loaded || existingSignature !== signature) {
            await wait(LAUNCH_AGENT_RETRY_DELAY_MS);
            await execFileAsync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? process.env.UID}/${label}`]).catch(() => undefined);
        }
        this.runningSignature = signature;
    }

    private getDevSessionFromEnv(): DesktopAgentSession | null {
        if (app.isPackaged) {
            return null;
        }

        const accessToken = process.env.DOPAX_DESKTOP_AGENT_OWNER_ACCESS_TOKEN?.trim();
        const homeserverUrl = process.env.DOPAX_DESKTOP_AGENT_HOMESERVER_URL?.trim()
            || process.env.DOPAX_DESKTOP_HOMESERVER_URL?.trim();

        if (!accessToken || !homeserverUrl) {
            return null;
        }

        return {
            accessToken,
            homeserverUrl,
        };
    }

    private async startSupervisor(
        runtimePaths: RuntimePaths,
        supervisorConfig: SupervisorConfig,
        signature: string,
    ): Promise<void> {
        console.log(
            `${LOG_PREFIX} starting supervisor with ${supervisorConfig.agents.map((agent) => agent.name).join(",")}`,
        );
        const child = spawn(runtimePaths.nodeBinary, [runtimePaths.supervisorEntrypoint], {
            cwd: runtimePaths.runtimeRoot,
            env: {
                ...process.env,
                PATH: buildExecutablePath({
                    existingPath: process.env.PATH,
                    homeDir: app.getPath("home"),
                }),
                SUPERVISOR_CONFIG_JSON_BASE64: Buffer.from(JSON.stringify(supervisorConfig), "utf8").toString("base64"),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout?.on("data", (chunk) => prefixedLog("stdout", chunk));
        child.stderr?.on("data", (chunk) => prefixedLog("stderr", chunk));
        child.on("exit", (code, signal) => {
            this.supervisorProcess = null;
            this.runningSignature = null;
            console.warn(`${LOG_PREFIX} supervisor exited (code=${code ?? "null"} signal=${signal ?? "null"})`);

            if (this.restartTimer) {
                clearTimeout(this.restartTimer);
                this.restartTimer = null;
            }
            if (this.desiredSignature !== signature) {
                return;
            }

            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                this.enqueueSync();
            }, SUPERVISOR_RESTART_DELAY_MS);
        });

        child.on("error", (error) => {
            console.error(`${LOG_PREFIX} failed to start supervisor`, error);
        });

        this.supervisorProcess = child;
        this.runningSignature = signature;
    }

    private async stopSupervisor(): Promise<void> {
        if (process.platform === "darwin") {
            const label = this.serviceLabel();
            this.runningSignature = null;
            await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? process.env.UID}/${label}`]).catch(() => undefined);
            this.releasePowerSaveBlocker();
            return;
        }

        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }

        const child = this.supervisorProcess;
        this.supervisorProcess = null;
        this.runningSignature = null;

        if (!child || child.killed || child.exitCode !== null) {
            this.releasePowerSaveBlocker();
            return;
        }

        console.log(`${LOG_PREFIX} stopping supervisor`);

        await new Promise<void>((resolveStop) => {
            const timeout = setTimeout(() => {
                child.kill("SIGKILL");
            }, 5000);

            child.once("exit", () => {
                clearTimeout(timeout);
                this.releasePowerSaveBlocker();
                resolveStop();
            });
            child.kill("SIGTERM");
        });
    }

    private releasePowerSaveBlocker(): void {
        if (this.powerSaveBlockerId === null) {
            return;
        }

        if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
            powerSaveBlocker.stop(this.powerSaveBlockerId);
        }
        console.log(`${LOG_PREFIX} powerSaveBlocker disabled (${this.powerSaveBlockerId})`);
        this.powerSaveBlockerId = null;
    }

}
