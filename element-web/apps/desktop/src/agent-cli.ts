import { readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

interface BuildExecutablePathOptions {
    explicitBin?: string | null;
    existingPath?: string | undefined;
    homeDir: string;
    platform?: NodeJS.Platform;
}

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

function buildCommonExecutableSearchDirs(homeDir: string, platform = process.platform): string[] {
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

function isExplicitExecutablePath(bin: string): boolean {
    return bin.includes("/") || (process.platform === "win32" && bin.includes("\\"));
}

export function buildExecutablePath({
    explicitBin,
    existingPath = process.env.PATH,
    homeDir,
    platform = process.platform,
}: BuildExecutablePathOptions): string {
    const parts = splitPathEnv(existingPath, platform);
    parts.push(...buildCommonExecutableSearchDirs(homeDir, platform));

    if (explicitBin && isExplicitExecutablePath(explicitBin)) {
        parts.push(dirname(stripWrappingQuotes(explicitBin)));
    }

    return dedupePaths(parts, platform).join(delimiter);
}
