import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { ProcessSpec, SupervisorConfig, TuwunelProcessSpec } from "./types.js";

interface RunningProcess {
    spec: ProcessSpec;
    child: ChildProcess;
}

function prefixedLog(prefix: string, chunk: Buffer | string): void {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.log(`[supervisor:${prefix}] ${line}`);
    }
}

async function waitForHealthcheck(spec: TuwunelProcessSpec): Promise<void> {
    const check = spec.healthcheck;
    if (!check) return;

    const intervalMs = check.intervalMs ?? 1000;
    const timeoutMs = check.timeoutMs ?? 30000;
    const expectedStatus = check.expectedStatus ?? 200;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(check.url);
            if (response.status === expectedStatus) {
                return;
            }
        } catch {
            // ignore and retry
        }
        await delay(intervalMs);
    }

    throw new Error(`Tuwunel healthcheck timed out: ${check.url}`);
}

export class LocalSupervisorService {
    private readonly running = new Map<string, RunningProcess>();
    private stopping = false;

    public constructor(private readonly config: SupervisorConfig) {}

    private spawnProcess(spec: ProcessSpec): RunningProcess {
        if (spec.command.length === 0) {
            throw new Error(`Process ${spec.name} has an empty command`);
        }

        const child = spawn(spec.command[0], spec.command.slice(1), {
            cwd: spec.cwd,
            env: {
                ...process.env,
                ...(spec.env ?? {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout?.on("data", (chunk) => prefixedLog(spec.name, chunk));
        child.stderr?.on("data", (chunk) => prefixedLog(spec.name, chunk));
        child.on("exit", (code, signal) => {
            this.running.delete(spec.name);
            if (this.stopping) return;
            if (spec.restart === false) return;

            const restartDelayMs = spec.restartDelayMs ?? 2000;
            console.log(`[supervisor:${spec.name}] exited (code=${code ?? "null"} signal=${signal ?? "null"}), restarting in ${restartDelayMs}ms`);
            void delay(restartDelayMs).then(() => {
                if (this.stopping) return;
                const next = this.spawnProcess(spec);
                this.running.set(spec.name, next);
            });
        });

        return { spec, child };
    }

    private async startManaged(spec: ProcessSpec): Promise<void> {
        if (this.running.has(spec.name)) return;
        console.log(`[supervisor] starting ${spec.name}`);
        const running = this.spawnProcess(spec);
        this.running.set(spec.name, running);
    }

    public async start(): Promise<void> {
        if (this.config.mode === "local" && this.config.tuwunel) {
            await this.startManaged(this.config.tuwunel);
            await waitForHealthcheck(this.config.tuwunel);
            console.log("[supervisor] tuwunel healthcheck passed");
        }

        for (const agent of this.config.agents) {
            await this.startManaged(agent);
        }
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        const processes = Array.from(this.running.values());
        this.running.clear();

        for (const running of processes.reverse()) {
            if (!running.child.killed && running.child.exitCode === null) {
                console.log(`[supervisor] stopping ${running.spec.name}`);
                running.child.kill("SIGTERM");
            }
        }
    }

    public async waitUntilInterrupted(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const shutdown = () => {
                void this.stop().then(resolve, reject);
            };

            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        });
    }
}
