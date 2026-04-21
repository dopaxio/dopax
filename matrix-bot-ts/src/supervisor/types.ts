export interface ProcessSpec {
    name: string;
    command: string[];
    cwd?: string;
    env?: Record<string, string>;
    envFile?: string;
    restart?: boolean;
    restartDelayMs?: number;
}
export interface HttpHealthcheckSpec {
    url: string;
    intervalMs?: number;
    timeoutMs?: number;
    expectedStatus?: number;
}
export interface TuwunelProcessSpec extends ProcessSpec {
    healthcheck?: HttpHealthcheckSpec;
}

export interface SupervisorConfig {
    mode: "local" | "remote";
    tuwunel?: TuwunelProcessSpec;
    agents: ProcessSpec[];
}
