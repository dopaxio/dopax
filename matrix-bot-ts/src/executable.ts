import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as fsConstants, readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

export interface ExecutableAssertionOptions {
    pathEnv?: string;
    probeCommands?: ExecutableProbeCommand[];
    timeoutMs?: number;
}

export interface ExecutableProbeCommand {
    args: string[];
    requiredText?: string[];
}

interface ExecCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    timeout?: number;
}

// Keep this search-path policy aligned with the desktop app resolver in
// element-web/apps/desktop/src/agent-cli.ts.
function stripWrappingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length > 1) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function pathKey(value: string, platform = process.platform): string {
    return platform === "win32" ? value.toLowerCase() : value;
}

function dedupePaths(values: string[], platform = process.platform): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const value of values) {
        const normalized = value.trim();
        if (!normalized) continue;
        const key = pathKey(normalized, platform);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(normalized);
    }
    return deduped;
}

function splitPathEnv(value: string | undefined, platform = process.platform): string[] {
    if (!value?.trim()) {
        return [];
    }
    return dedupePaths(value.split(delimiter), platform);
}

function directoryEntries(root: string): string[] {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(root, entry.name, "bin"));
    } catch {
        return [];
    }
}

function buildCommonExecutableSearchDirs(homeDir = os.homedir(), platform = process.platform): string[] {
    const extras: string[] = [];

    if (platform !== "win32") {
        extras.push(
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            join(homeDir, ".local", "bin"),
            join(homeDir, ".local", "share", "mise", "shims"),
            join(homeDir, ".cargo", "bin"),
            join(homeDir, ".bun", "bin"),
            join(homeDir, ".npm-global", "bin"),
            join(homeDir, ".opencode", "bin"),
            join(homeDir, ".volta", "bin"),
            join(homeDir, "Library", "pnpm"),
            ...directoryEntries(join(homeDir, ".nvm", "versions", "node")),
        );

        if (platform === "darwin") {
            extras.push("/Applications/Codex.app/Contents/Resources");
        }
    } else {
        const appData = process.env.APPDATA?.trim();
        const localAppData = process.env.LOCALAPPDATA?.trim();
        const programData = process.env.PROGRAMDATA?.trim();

        if (appData) {
            extras.push(join(appData, "npm"));
        }
        if (localAppData) {
            extras.push(join(localAppData, "Microsoft", "WindowsApps"));
        }

        extras.push(
            join(homeDir, ".cargo", "bin"),
            join(homeDir, "scoop", "shims"),
        );

        if (programData) {
            extras.push(join(programData, "chocolatey", "bin"));
        }
    }

    return dedupePaths(extras, platform);
}

export function isExplicitExecutablePath(bin: string): boolean {
    return bin.includes("/") || (process.platform === "win32" && bin.includes("\\"));
}

export function buildExecutablePathEnv(existingPath = process.env.PATH, explicitBin?: string | null): string {
    const parts = splitPathEnv(existingPath);
    parts.push(...buildCommonExecutableSearchDirs());

    if (explicitBin && isExplicitExecutablePath(explicitBin)) {
        parts.push(dirname(stripWrappingQuotes(explicitBin)));
    }

    return dedupePaths(parts).join(delimiter);
}

export function ensureExecutablePathEnvironment(explicitBin?: string | null): string {
    const pathEnv = buildExecutablePathEnv(process.env.PATH, explicitBin);
    process.env.PATH = pathEnv;
    return pathEnv;
}

function accessModeForPlatform(platform = process.platform): number {
    return platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
}

function commandEnvironment(pathEnv?: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
    if (!pathEnv) {
        return env;
    }
    return {
        ...process.env,
        ...env,
        PATH: pathEnv,
    };
}

function isWindowsBatchFile(bin: string): boolean {
    return process.platform === "win32" && WINDOWS_BATCH_EXTENSIONS.has(extname(bin).toLowerCase());
}

function quoteCmdToken(value: string): string {
    if (value.includes("\0")) {
        throw new Error("Windows cmd wrapper does not support NUL bytes.");
    }
    if (value.includes("\n") || value.includes("\r")) {
        throw new Error("Windows cmd wrapper does not support newline characters.");
    }

    let escaped = "";
    for (const ch of value) {
        switch (ch) {
            case "^":
                escaped += "^^";
                break;
            case "\"":
                escaped += "^\"";
                break;
            case "%":
                escaped += "^%";
                break;
            case "!":
                escaped += "^!";
                break;
            default:
                escaped += ch;
                break;
        }
    }

    return `"${escaped}"`;
}

function buildCmdCommand(program: string, args: string[]): string {
    const inner = [program, ...args].map(quoteCmdToken).join(" ");
    return `"${inner}"`;
}

function wrapCommandForExecution(command: string[]): string[] {
    if (command.length === 0) {
        throw new Error("Cannot execute an empty command.");
    }
    if (!isWindowsBatchFile(command[0])) {
        return command;
    }
    return ["cmd.exe", "/D", "/S", "/C", buildCmdCommand(command[0], command.slice(1))];
}

export async function resolveExecutableFromPath(bin: string, pathEnv = process.env.PATH): Promise<string | null> {
    const trimmed = stripWrappingQuotes(bin);
    if (!trimmed) {
        return null;
    }

    if (isExplicitExecutablePath(trimmed)) {
        try {
            await access(trimmed, accessModeForPlatform());
            return trimmed;
        } catch {
            return null;
        }
    }

    const probe = process.platform === "win32" ? "where" : "/usr/bin/which";
    try {
        const { stdout } = await execFileAsync(probe, [trimmed], {
            env: commandEnvironment(pathEnv),
        });
        return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0) || null;
    } catch {
        return null;
    }
}

export async function execCommand(
    command: string[],
    options: ExecCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
    const wrapped = wrapCommandForExecution(command);
    const { stdout, stderr } = await execFileAsync(wrapped[0], wrapped.slice(1), {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
    });
    return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
    };
}

export function spawnCommand(command: string[], options: SpawnOptions = {}): ChildProcess {
    const wrapped = wrapCommandForExecution(command);
    return spawn(wrapped[0], wrapped.slice(1), options);
}

function probeFailureMessage(command: string[], error: unknown): string {
    const details = error as { stderr?: string; stdout?: string; message?: string };
    const detail = details.stderr?.trim() || details.stdout?.trim() || details.message || String(error);
    return `Provider CLI failed probe (${command.join(" ")}): ${detail}`;
}

function normalizeProbeText(value: string): string {
    return value.toLowerCase();
}

function findMissingProbeText(output: string, requiredText: string[]): string[] {
    const haystack = normalizeProbeText(output);
    return requiredText.filter((needle) => !haystack.includes(normalizeProbeText(needle)));
}

export async function assertExecutableAvailable(
    bin: string,
    options: ExecutableAssertionOptions = {},
): Promise<string> {
    const pathEnv = options.pathEnv ?? buildExecutablePathEnv(process.env.PATH, bin);
    const resolved = await resolveExecutableFromPath(bin, pathEnv);
    if (!resolved) {
        throw new Error(`Provider CLI is not installed or not on PATH: ${bin}`);
    }

    const probeCommands = options.probeCommands ?? [];
    for (const probe of probeCommands) {
        try {
            const result = await execCommand([resolved, ...probe.args], {
                env: commandEnvironment(pathEnv),
                maxBuffer: 4 * 1024 * 1024,
                timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
            });
            const requiredText = probe.requiredText ?? [];
            if (requiredText.length > 0) {
                const combinedOutput = `${result.stdout}\n${result.stderr}`;
                const missingText = findMissingProbeText(combinedOutput, requiredText);
                if (missingText.length > 0) {
                    throw new Error(
                        `missing expected help text: ${missingText.join(", ")}`,
                    );
                }
            }
        } catch (error) {
            throw new Error(probeFailureMessage([resolved, ...probe.args], error));
        }
    }

    return resolved;
}
