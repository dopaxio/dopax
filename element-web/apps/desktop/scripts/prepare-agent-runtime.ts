#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import parseArgs from "minimist";

const desktopRoot = process.cwd();
const workspaceRoot = path.resolve(desktopRoot, "../../..");
const agentRoot = path.join(workspaceRoot, "matrix-bot-ts");
const sdkRoot = path.join(workspaceRoot, "matrix-bot-sdk");
const outputRoot = path.join(desktopRoot, "build", "agent-runtime");
const cacheRoot = path.join(desktopRoot, ".cache", "node-runtime");
const argv = parseArgs(process.argv.slice(2), {
    boolean: ["clean"],
    string: ["platform", "arch"],
});

type RuntimePlatform = "darwin" | "linux" | "win32";
type RuntimeArch = "arm64" | "x64" | "ia32";

interface RuntimeTarget {
    platform: RuntimePlatform;
    arch: RuntimeArch;
}

function runtimeTargetDirName(target: RuntimeTarget): string {
    return `${target.platform}-${target.arch}`;
}

function resolveRuntimeTarget(): RuntimeTarget {
    const platform = (argv["platform"] || process.platform) as RuntimePlatform;
    const arch = (argv["arch"] || process.arch) as RuntimeArch;

    if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
        throw new Error(`Unsupported runtime target platform: ${platform}`);
    }

    if (platform === "win32") {
        if (arch !== "arm64" && arch !== "x64" && arch !== "ia32") {
            throw new Error(`Unsupported Windows architecture for Node runtime: ${arch}`);
        }
    } else if (arch !== "arm64" && arch !== "x64") {
        throw new Error(`Unsupported ${platform} architecture for Node runtime: ${arch}`);
    }

    return { platform, arch };
}

function ensurePathExists(target: string, label: string): void {
    if (!fs.existsSync(target)) {
        throw new Error(`Missing ${label}: ${target}`);
    }
}

function run(command: string, args: string[], cwd: string): string {
    return execFileSync(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
    }).trim();
}

function runInherited(command: string, args: string[], cwd: string): void {
    execFileSync(command, args, {
        cwd,
        stdio: "inherit",
    });
}

function runInheritedWithEnv(command: string, args: string[], cwd: string, env: Record<string, string>): void {
    execFileSync(command, args, {
        cwd,
        env: {
            ...process.env,
            ...env,
        },
        stdio: "inherit",
    });
}

function copyDir(source: string, destination: string): void {
    fs.cpSync(source, destination, {
        recursive: true,
        dereference: true,
    });
}

function prepareAgentBuild(): void {
    runInherited("npm", ["run", "build"], agentRoot);

    if (!fs.existsSync(path.join(sdkRoot, "lib", "index.js"))) {
        runInherited("npm", ["run", "build"], sdkRoot);
    }
}

function writeRuntimePackageJson(target: string): void {
    const content = {
        name: "dopax-desktop-agent-runtime",
        private: true,
        type: "module",
    };
    fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

function getNodeDistInfo(): {
    version: string;
    archiveName: string;
    extractDirName: string;
    url: string;
    executableRelativePath: string;
} {
    const version = process.version.replace(/^v/, "");
    const targetSpec = resolveRuntimeTarget();
    const arch = targetSpec.arch;
    const platform = targetSpec.platform;

    let target: string;
    let executableRelativePath: string;
    if (platform === "darwin") {
        target = `darwin-${arch}`;
        executableRelativePath = path.join("bin", "node");
    } else if (platform === "linux") {
        target = `linux-${arch}`;
        executableRelativePath = path.join("bin", "node");
    } else if (platform === "win32") {
        const nodeArch = arch === "ia32" ? "x86" : arch;
        target = `win-${nodeArch}`;
        executableRelativePath = path.join("node.exe");
    } else {
        throw new Error(`Unsupported platform for bundled Node runtime: ${platform}`);
    }

    const baseName = `node-v${version}-${target}`;
    if (platform === "win32") {
        return {
            version,
            archiveName: `${baseName}.zip`,
            extractDirName: baseName,
            url: `https://nodejs.org/dist/v${version}/${baseName}.zip`,
            executableRelativePath,
        };
    }

    return {
        version,
        archiveName: `${baseName}.tar.gz`,
        extractDirName: baseName,
        url: `https://nodejs.org/dist/v${version}/${baseName}.tar.gz`,
        executableRelativePath,
    };
}

function ensureBundledNodeRuntime(): { rootDir: string; executablePath: string } {
    const info = getNodeDistInfo();
    const targetSpec = resolveRuntimeTarget();
    const archiveDir = path.join(cacheRoot, `${targetSpec.platform}-${targetSpec.arch}-${info.version}`);
    const archivePath = path.join(archiveDir, info.archiveName);
    const extractRoot = path.join(archiveDir, info.extractDirName);

    if (!fs.existsSync(extractRoot)) {
        fs.mkdirSync(archiveDir, { recursive: true });

        if (!fs.existsSync(archivePath)) {
            console.log(`Downloading Node runtime from ${info.url}`);
            execFileSync("curl", ["-L", info.url, "-o", archivePath], {
                stdio: "inherit",
            });
        }

        console.log(`Extracting Node runtime ${info.archiveName}`);
        if (targetSpec.platform === "win32") {
            execFileSync("tar", ["-xf", archivePath, "-C", archiveDir], {
                stdio: "inherit",
            });
        } else {
            execFileSync("tar", ["-xzf", archivePath, "-C", archiveDir], {
                stdio: "inherit",
            });
        }
    }

    const executablePath = path.join(extractRoot, info.executableRelativePath);
    ensurePathExists(executablePath, "bundled node executable");
    return { rootDir: extractRoot, executablePath };
}

function copyBundledNodeRuntime(sourceRoot: string, targetRoot: string): string {
    const outputBinDir = path.join(targetRoot, "bin");
    fs.mkdirSync(outputBinDir, { recursive: true });

    if (resolveRuntimeTarget().platform === "win32") {
        const sourceExe = path.join(sourceRoot, "node.exe");
        const sourceNodeModules = path.join(sourceRoot, "node_modules");
        const sourceCorepack = path.join(sourceRoot, "corepack");
        fs.copyFileSync(sourceExe, path.join(outputBinDir, "node.exe"));
        if (fs.existsSync(sourceNodeModules)) {
            copyDir(sourceNodeModules, path.join(targetRoot, "node_modules"));
        }
        if (fs.existsSync(sourceCorepack)) {
            copyDir(sourceCorepack, path.join(targetRoot, "corepack"));
        }
        return path.join(outputBinDir, "node.exe");
    }

    const sourceNodeBinary = path.join(sourceRoot, "bin", "node");
    const outputNodeBinary = path.join(outputBinDir, "node");
    fs.copyFileSync(sourceNodeBinary, outputNodeBinary);
    fs.chmodSync(outputNodeBinary, 0o755);
    return outputNodeBinary;
}

function removeBundledNodeShims(targetRoot: string): void {
    for (const relativePath of [
        path.join("bin", "npm"),
        path.join("bin", "npx"),
        path.join("bin", "corepack"),
        "npm.cmd",
        "npx.cmd",
        "corepack.cmd",
    ]) {
        fs.rmSync(path.join(targetRoot, relativePath), { force: true });
    }
}

function removeNodeModuleBinDirs(root: string): void {
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === ".bin") {
                fs.rmSync(fullPath, { recursive: true, force: true });
                continue;
            }
            pending.push(fullPath);
        }
    }
}

function listSymlinks(root: string): string[] {
    const symlinks: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) {
                symlinks.push(fullPath);
                continue;
            }
            if (entry.isDirectory()) {
                pending.push(fullPath);
            }
        }
    }
    return symlinks;
}

function assertNoSymlinks(root: string): void {
    const symlinks = listSymlinks(root);
    if (symlinks.length === 0) {
        return;
    }

    throw new Error(
        `Bundled runtime still contains symbolic links:\n${symlinks.slice(0, 20).join("\n")}${
            symlinks.length > 20 ? `\n...and ${symlinks.length - 20} more` : ""
        }`,
    );
}

function verifyBundledNodeRuntime(nodeBinaryPath: string, cwd: string): void {
    const version = run(nodeBinaryPath, ["--version"], cwd);
    console.log(`Bundled node runtime ready: ${version}`);
}

function installProductionDependencies(packageRoot: string): void {
    runInheritedWithEnv(
        "npm",
        ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--legacy-peer-deps"],
        packageRoot,
        {
            NODE_ENV: "production",
            npm_config_package_lock: "false",
        },
    );
}

function hydrateMatrixSdkCryptoBinary(packageRoot: string, targetSpec: RuntimeTarget): void {
    const cryptoRoot = path.join(
        packageRoot,
        "node_modules",
        "@matrix-org",
        "matrix-sdk-crypto-nodejs",
    );
    if (!fs.existsSync(cryptoRoot)) {
        return;
    }

    runInheritedWithEnv(
        "node",
        ["download-lib.js"],
        cryptoRoot,
        {
            npm_config_target_platform: targetSpec.platform,
            npm_config_target_arch: targetSpec.arch,
        },
    );
}

function main(): void {
    prepareAgentBuild();
    const targetSpec = resolveRuntimeTarget();
    const targetOutputRoot = path.join(outputRoot, runtimeTargetDirName(targetSpec));

    const agentDist = path.join(agentRoot, "dist");
    const agentDotenv = path.join(agentRoot, "node_modules", "dotenv");
    const sdkLib = path.join(sdkRoot, "lib");
    const bundledNode = ensureBundledNodeRuntime();

    ensurePathExists(agentDist, "agent runtime dist");
    ensurePathExists(agentDotenv, "agent runtime dotenv dependency");
    ensurePathExists(sdkLib, "runtime SDK library");

    if (argv["clean"]) {
        fs.rmSync(outputRoot, { recursive: true, force: true });
    }
    fs.rmSync(targetOutputRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(targetOutputRoot, "node_modules"), { recursive: true });

    copyDir(agentDist, path.join(targetOutputRoot, "dist"));
    copyDir(agentDotenv, path.join(targetOutputRoot, "node_modules", "dotenv"));

    const sdkOutputRoot = path.join(targetOutputRoot, "node_modules", "matrix-bot-sdk");
    fs.mkdirSync(sdkOutputRoot, { recursive: true });
    copyDir(sdkLib, path.join(sdkOutputRoot, "lib"));
    fs.copyFileSync(path.join(sdkRoot, "package.json"), path.join(sdkOutputRoot, "package.json"));
    if (fs.existsSync(path.join(sdkRoot, "LICENSE"))) {
        fs.copyFileSync(path.join(sdkRoot, "LICENSE"), path.join(sdkOutputRoot, "LICENSE"));
    }
    installProductionDependencies(sdkOutputRoot);
    hydrateMatrixSdkCryptoBinary(sdkOutputRoot, targetSpec);

    const bundledNodeBinary = copyBundledNodeRuntime(bundledNode.rootDir, targetOutputRoot);
    removeBundledNodeShims(targetOutputRoot);
    removeNodeModuleBinDirs(targetOutputRoot);
    assertNoSymlinks(targetOutputRoot);
    verifyBundledNodeRuntime(bundledNodeBinary, targetOutputRoot);

    writeRuntimePackageJson(targetOutputRoot);

    console.log(`Prepared agent runtime for ${runtimeTargetDirName(targetSpec)} at ${targetOutputRoot}`);
}

main();
