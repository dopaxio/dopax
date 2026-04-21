import path from "node:path";

import { loadSupervisorConfig, loadSupervisorConfigFromObject } from "./config.js";
import { LocalSupervisorService } from "./service.js";

async function main(): Promise<void> {
    const inlineConfig = process.env.SUPERVISOR_CONFIG_JSON_BASE64?.trim();
    const configPath = process.argv[2] || path.resolve(process.cwd(), "supervisor", "local.example.json");
    const config = inlineConfig
        ? await loadSupervisorConfigFromObject(JSON.parse(Buffer.from(inlineConfig, "base64").toString("utf8")))
        : await loadSupervisorConfig(configPath);
    const supervisor = new LocalSupervisorService(config);

    console.log(
        inlineConfig
            ? "[supervisor] loaded config from SUPERVISOR_CONFIG_JSON_BASE64"
            : `[supervisor] loaded config from ${configPath}`,
    );
    await supervisor.start();
    await supervisor.waitUntilInterrupted();
}

main().catch((error) => {
    console.error("[supervisor] fatal error", error);
    process.exit(1);
});
