#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import * as asar from "@electron/asar";

const desktopRoot = process.cwd();
const distRoot = path.join(desktopRoot, "dist");
const webappAsarPath = path.join(desktopRoot, "webapp.asar");
const bundleEntryPattern = /^\/bundles\/([^/]+)\//;

async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function walkDirs(root: string): Promise<string[]> {
    const results: string[] = [];

    async function walk(currentDir: string): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                results.push(fullPath);
                await walk(fullPath);
            }
        }
    }

    if (await exists(root)) {
        await walk(root);
    }
    return results;
}

async function walkFiles(root: string): Promise<string[]> {
    const results: string[] = [];

    async function walk(currentDir: string): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            results.push(fullPath);
        }
    }

    if (await exists(root)) {
        await walk(root);
    }
    return results;
}

async function validateWebappAsar(): Promise<void> {
    if (!(await exists(webappAsarPath))) {
        throw new Error(`Missing webapp.asar: ${webappAsarPath}`);
    }

    const files = await asar.listPackage(webappAsarPath, { isPack: false });
    const bundleHashes = new Set<string>();
    const sourceMaps = files.filter((entry) => entry.endsWith(".map"));

    for (const entry of files) {
        const match = entry.match(bundleEntryPattern);
        if (match?.[1]) {
            bundleHashes.add(match[1]);
        }
    }

    if (bundleHashes.size !== 1) {
        throw new Error(`Expected exactly one packaged bundle hash, found: ${Array.from(bundleHashes).join(", ") || "none"}`);
    }
    if (sourceMaps.length > 0) {
        throw new Error(`webapp.asar still contains source maps; first entry: ${sourceMaps[0]}`);
    }
}

async function validateNoSymlinks(root: string): Promise<void> {
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`Unexpected symlink in packaged runtime: ${fullPath}`);
            }
            if (entry.isDirectory()) {
                pending.push(fullPath);
            }
        }
    }
}

async function validatePackagedApps(): Promise<void> {
    if (!(await exists(distRoot))) {
        throw new Error(`Missing dist directory: ${distRoot}`);
    }

    const allDirs = await walkDirs(distRoot);
    const apps = allDirs.filter(
        (dir) => dir.endsWith(".app") && !dir.includes(`${path.sep}Contents${path.sep}Frameworks${path.sep}`),
    );
    const allFiles = await walkFiles(distRoot);
    const packagedWebapps = allFiles.filter((file) => file.endsWith(`${path.sep}webapp.asar`));
    const packagedRuntimeRoots = allDirs.filter((dir) => path.basename(dir) === "agent-runtime");

    if (packagedWebapps.length === 0) {
        throw new Error(`No packaged webapp.asar found under ${distRoot}`);
    }
    if (packagedRuntimeRoots.length === 0) {
        throw new Error(`No packaged agent-runtime directory found under ${distRoot}`);
    }

    if (process.platform === "darwin" && apps.length === 0) {
        throw new Error(`No packaged .app found under ${distRoot}`);
    }

    for (const appPath of apps) {
        execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
            stdio: "inherit",
        });

        const resourcesRoot = path.join(appPath, "Contents", "Resources");
        const packagedWebappAsar = path.join(resourcesRoot, "webapp.asar");
        if (!(await exists(packagedWebappAsar))) {
            throw new Error(`Missing packaged webapp.asar in ${appPath}`);
        }

    }

    for (const agentRuntimeRoot of packagedRuntimeRoots) {
        await validateNoSymlinks(agentRuntimeRoot);

        const runtimeTargets = (await fs.readdir(agentRuntimeRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        if (runtimeTargets.length === 0) {
            throw new Error(`No target runtime directories found in ${agentRuntimeRoot}`);
        }

        for (const runtimeTarget of runtimeTargets) {
            const runtimeRoot = path.join(agentRuntimeRoot, runtimeTarget);
            const nodeBinary = path.join(
                runtimeRoot,
                "bin",
                runtimeTarget.startsWith("win32-") ? "node.exe" : "node",
            );
            const supervisorEntrypoint = path.join(runtimeRoot, "dist", "supervisor", "index.js");
            if (!(await exists(nodeBinary))) {
                throw new Error(`Missing bundled node binary: ${nodeBinary}`);
            }
            if (!(await exists(supervisorEntrypoint))) {
                throw new Error(`Missing supervisor entrypoint: ${supervisorEntrypoint}`);
            }

            const matrixCryptoRoot = path.join(
                runtimeRoot,
                "node_modules",
                "matrix-bot-sdk",
                "node_modules",
                "@matrix-org",
                "matrix-sdk-crypto-nodejs",
            );
            const nativeBindings = (await exists(matrixCryptoRoot))
                ? (await fs.readdir(matrixCryptoRoot)).filter((entry) => entry.endsWith(".node"))
                : [];
            if (nativeBindings.length === 0) {
                throw new Error(`Missing matrix-sdk-crypto native binding in ${matrixCryptoRoot}`);
            }
        }
    }
}

async function main(): Promise<void> {
    await validateWebappAsar();
    await validatePackagedApps();
    console.log("[release-validate] desktop release artifacts look consistent");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
