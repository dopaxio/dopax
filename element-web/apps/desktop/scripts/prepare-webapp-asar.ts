#!/usr/bin/env node

import * as path from "node:path";
import { promises as fs } from "node:fs";

import * as asar from "@electron/asar";

const desktopRoot = process.cwd();
const sourceWebappPath = path.join(desktopRoot, "webapp");
const outputAsarPath = path.join(desktopRoot, "webapp.asar");
const stagingRoot = path.join(desktopRoot, "build", "webapp-packaging");
const stagingWebappPath = path.join(stagingRoot, "webapp");
const bundleReferencePattern = /bundles\/([A-Za-z0-9_-]+)\//g;
const textFileExtensions = new Set([".css", ".html", ".js", ".json", ".txt"]);
const topLevelScanSkips = new Set(["bundles", "fonts", "i18n", "icons", "img", "media", "themes", "vector-icons", "widgets"]);

async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

async function collectReferencedBundleHashes(root: string): Promise<Set<string>> {
    const hashes = new Set<string>();

    async function walk(currentDir: string): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(root, fullPath);

            if (entry.isDirectory()) {
                if (relativePath === "bundles" || relativePath.startsWith(`bundles${path.sep}`)) {
                    continue;
                }
                if (!relativePath.includes(path.sep) && topLevelScanSkips.has(entry.name)) {
                    continue;
                }
                await walk(fullPath);
                continue;
            }

            if (!shouldScan(relativePath, entry.name)) {
                continue;
            }

            let content: string;
            try {
                content = await fs.readFile(fullPath, "utf8");
            } catch {
                continue;
            }

            bundleReferencePattern.lastIndex = 0;
            for (const match of content.matchAll(bundleReferencePattern)) {
                const hash = match[1];
                if (hash) {
                    hashes.add(hash);
                }
            }
        }
    }

    await walk(root);
    return hashes;
}

function shouldScan(relativePath: string, fileName: string): boolean {
    if (relativePath === "version" || relativePath === "apple-app-site-association") {
        return true;
    }

    return textFileExtensions.has(path.extname(fileName));
}

async function pruneUnusedBundles(root: string, activeBundleHashes: Set<string>): Promise<void> {
    if (activeBundleHashes.size === 0) {
        console.warn("[webapp.asar] no active bundle references found; leaving bundles directory untouched");
        return;
    }

    const bundlesRoot = path.join(root, "bundles");
    if (!(await exists(bundlesRoot))) {
        return;
    }

    const entries = await fs.readdir(bundlesRoot, { withFileTypes: true });
    const removed: string[] = [];
    const kept: string[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const bundlePath = path.join(bundlesRoot, entry.name);
        if (activeBundleHashes.has(entry.name)) {
            kept.push(entry.name);
            continue;
        }

        await fs.rm(bundlePath, { recursive: true, force: true });
        removed.push(entry.name);
    }

    console.log(`[webapp.asar] keeping bundles: ${kept.join(", ") || "none"}`);
    if (removed.length > 0) {
        console.log(`[webapp.asar] pruned stale bundles: ${removed.join(", ")}`);
    }
}

async function stripSourceMaps(root: string): Promise<void> {
    let removed = 0;

    async function walk(currentDir: string): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.name.endsWith(".map")) {
                continue;
            }

            await fs.rm(fullPath, { force: true });
            removed += 1;
        }
    }

    await walk(root);
    console.log(`[webapp.asar] removed source maps: ${removed}`);
}

async function createWebappAsarFromDirectory(): Promise<void> {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    try {
        await fs.mkdir(stagingRoot, { recursive: true });
        await fs.cp(sourceWebappPath, stagingWebappPath, { recursive: true, dereference: true });

        const activeBundleHashes = await collectReferencedBundleHashes(stagingWebappPath);
        await pruneUnusedBundles(stagingWebappPath, activeBundleHashes);
        await stripSourceMaps(stagingWebappPath);

        await fs.rm(outputAsarPath, { force: true });
        console.log(`Pack ${sourceWebappPath} -> ${outputAsarPath}`);
        await asar.createPackage(stagingWebappPath, outputAsarPath);
    } finally {
        await fs.rm(stagingRoot, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    if (await exists(sourceWebappPath)) {
        await createWebappAsarFromDirectory();
        return;
    }

    if (await exists(outputAsarPath)) {
        console.log(`Using existing ${outputAsarPath}`);
        return;
    }

    throw new Error("Missing both webapp directory and webapp.asar");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
