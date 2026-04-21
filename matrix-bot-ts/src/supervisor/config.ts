import { readFile } from "node:fs/promises";
import path from "node:path";

import dotenv from "dotenv";

import type {
    HttpHealthcheckSpec,
    ProcessSpec,
    SupervisorConfig,
    TuwunelProcessSpec,
} from "./types.js";

function assertProcessSpec(value: unknown, label: string): asserts value is ProcessSpec {
    if (!value || typeof value !== "object") {
        throw new Error(`${label} must be an object`);
    }
    const spec = value as Record<string, unknown>;
    if (typeof spec["name"] !== "string" || !spec["name"].trim()) {
        throw new Error(`${label}.name must be a non-empty string`);
    }
    if (!Array.isArray(spec["command"]) || spec["command"].length === 0 || !spec["command"].every((item) => typeof item === "string")) {
        throw new Error(`${label}.command must be a non-empty string array`);
    }
}

function assertHealthcheck(value: unknown, label: string): asserts value is HttpHealthcheckSpec {
    if (!value || typeof value !== "object") {
        throw new Error(`${label} must be an object`);
    }
    const spec = value as Record<string, unknown>;
    if (typeof spec["url"] !== "string" || !spec["url"].trim()) {
        throw new Error(`${label}.url must be a non-empty string`);
    }
}

function resolveMaybeRelative(baseDir: string, rawPath: string | undefined): string | undefined {
    if (!rawPath?.trim()) return undefined;
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

async function loadEnvFile(baseDir: string, envFile: string | undefined): Promise<Record<string, string>> {
    const resolved = resolveMaybeRelative(baseDir, envFile);
    if (!resolved) return {};
    const raw = await readFile(resolved, "utf8");
    return dotenv.parse(raw);
}

async function normalizeProcessSpec(baseDir: string, spec: ProcessSpec): Promise<ProcessSpec> {
    const envFromFile = await loadEnvFile(baseDir, spec.envFile);
    return {
        ...spec,
        cwd: resolveMaybeRelative(baseDir, spec.cwd),
        envFile: resolveMaybeRelative(baseDir, spec.envFile),
        env: {
            ...envFromFile,
            ...(spec.env ?? {}),
        },
    };
}

export async function loadSupervisorConfigFromObject(
    value: unknown,
    baseDir = process.cwd(),
): Promise<SupervisorConfig> {
    if (!value || typeof value !== "object") {
        throw new Error("Supervisor config must be an object");
    }

    const parsed = value as Record<string, unknown>;

    const mode = parsed["mode"];
    if (mode !== "local" && mode !== "remote") {
        throw new Error('Supervisor config mode must be "local" or "remote"');
    }

    const agentsRaw = parsed["agents"];
    if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
        throw new Error("Supervisor config agents must be a non-empty array");
    }

    const agents: ProcessSpec[] = [];
    for (let index = 0; index < agentsRaw.length; index += 1) {
        const label = `agents[${index}]`;
        assertProcessSpec(agentsRaw[index], label);
        agents.push(await normalizeProcessSpec(baseDir, agentsRaw[index]));
    }

    let tuwunel: TuwunelProcessSpec | undefined;
    if (parsed["tuwunel"] !== undefined && parsed["tuwunel"] !== null) {
        assertProcessSpec(parsed["tuwunel"], "tuwunel");
        const tuwunelRaw = parsed["tuwunel"] as unknown as Record<string, unknown>;
        const normalized = await normalizeProcessSpec(baseDir, parsed["tuwunel"] as ProcessSpec);
        const healthcheckRaw = tuwunelRaw["healthcheck"];
        if (healthcheckRaw !== undefined && healthcheckRaw !== null) {
            assertHealthcheck(healthcheckRaw, "tuwunel.healthcheck");
        }
        tuwunel = {
            ...(normalized as TuwunelProcessSpec),
            healthcheck: healthcheckRaw as HttpHealthcheckSpec | undefined,
        };
    }

    if (mode === "local" && !tuwunel) {
        throw new Error('Supervisor local mode requires a "tuwunel" process config');
    }

    return {
        mode,
        tuwunel,
        agents,
    };
}

export async function loadSupervisorConfig(configPath: string): Promise<SupervisorConfig> {
    const resolvedPath = path.resolve(configPath);
    const baseDir = path.dirname(resolvedPath);
    const raw = await readFile(resolvedPath, "utf8");
    return loadSupervisorConfigFromObject(JSON.parse(raw) as Record<string, unknown>, baseDir);
}
