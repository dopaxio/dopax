# Desktop Release Packaging

This document defines the release packaging contract for the desktop application.
It focuses on the failure modes that matter for shipped builds: oversized web assets,
non-self-contained runtimes, platform-specific breakage, and packaging-time validation.

## Scope

This contract applies to:

- the desktop app build in [`apps/desktop`](../apps/desktop/README.md)
- the desktop-facing web payload packaged into `webapp.asar`
- the bundled agent runtime copied into `Contents/Resources/agent-runtime` on macOS and equivalent resource locations on other platforms

It does not replace the general release process documented in [packaging.md](./packaging.md).
It defines the artifact-level rules that must hold before a desktop release is considered valid.

## Normative Language

- `MUST` means release-blocking.
- `SHOULD` means strongly recommended and expected by default.
- `MAY` means optional.

## 1. Release Inputs

### 1.1 Web payload

- Desktop release builds `MUST` package a dedicated `webapp.asar`.
- `webapp.asar` `MUST NOT` be created by blindly archiving a mutable development directory.
- The packaging flow `MUST` stage the web payload first and only archive the staged result.
- The staged web payload `MUST` contain the currently referenced bundle hash and `MUST NOT` include stale `bundles/<hash>` directories from prior builds.
- Desktop release builds `SHOULD NOT` include `*.map` files in the shipped `webapp.asar` unless there is an explicit product requirement.

### 1.2 Local development conveniences

- A development symlink such as `apps/desktop/webapp -> ../web/webapp` `MAY` exist for local iteration.
- Release packaging `MUST NOT` rely on that symlink as a trusted publish input.
- If the desktop build consumes a linked web directory, it `MUST` sanitize that directory into a staging area before producing `webapp.asar`.

## 2. Bundled Agent Runtime

### 2.1 Self-contained runtime

- The bundled agent runtime `MUST` be self-contained inside the packaged app resources.
- It `MUST NOT` contain symlinks pointing back to the workspace, build cache, or any absolute path on the build machine.
- It `MUST NOT` depend on source checkout paths such as `../../../../matrix-bot-ts` at release runtime.
- It `MUST` contain the exact Node executable, JS entrypoints, and runtime dependencies required to launch the supervisor and agent processes.

### 2.2 Resource hygiene

- Packaging scripts `SHOULD` remove runtime shims that are not needed in production, such as `npm`, `npx`, and `corepack`, when those shims introduce invalid symlinks or unnecessary bundle weight.
- Resource paths used by the application at runtime `MUST` match the paths produced by the packaging scripts.
- If the runtime places Node under `agent-runtime/bin`, the app `MUST` resolve it from `agent-runtime/bin` on every supported platform.

## 3. Platform And Architecture Targeting

### 3.1 Target selection

- Packaging logic `MUST` build runtime assets for the target platform and architecture, not for the host machine by default.
- Scripts that assemble `agent-runtime` `SHOULD` take explicit target inputs such as platform and architecture.
- Release jobs `MUST NOT` infer final runtime architecture from `process.arch` alone when building cross-architecture outputs.

### 3.2 Universal builds

- macOS universal packaging `MUST` account for both `arm64` and `x64`.
- A universal app `MUST NOT` embed an agent runtime that only works on one architecture.
- If a single universal runtime is not practical, the build `MUST` assemble the correct runtime for each architecture and merge them in a controlled way.

### 3.3 Windows-specific expectations

- Windows packages `MUST` resolve the bundled Node executable from the same path the packaging script writes to.
- Runtime executable detection `MUST` support Windows absolute paths and PATH-based command lookup.
- Unix-only helpers such as `/usr/bin/which` `MUST NOT` be used in Windows agent runtime code paths.

## 4. Service Management

### 4.1 macOS launchd integration

- macOS background services `SHOULD` use `launchd` and a generated `plist`.
- The `plist` `MUST` use absolute paths for the program arguments, working directory, logs, and config file.
- macOS-only paths such as `/usr/bin/caffeinate` and `~/Library/LaunchAgents` `MUST` remain inside darwin-specific code paths.
- The service environment `SHOULD` define an explicit `PATH` because `launchd` runs with a reduced environment.

### 4.2 Other platforms

- Non-darwin platforms `MAY` use in-process child management instead of a system service.
- Platform-specific branches `MUST` remain isolated so that unsupported system utilities are never referenced on the wrong platform.

## 5. Shared Executable Resolution

- The codebase `SHOULD` centralize executable resolution logic for provider CLIs.
- Executable resolution `MUST` support:
  - absolute Unix paths
  - absolute Windows paths
  - PATH lookup on Unix
  - PATH lookup on Windows
- The desktop main process and the bundled agent runtime `SHOULD` share the same semantics for executable detection.

## 6. Release Validation Checklist

The following checks are release-gating for desktop builds.

### 6.1 Pre-package checks

- Generate `webapp.asar` from a staging directory, not directly from the linked development directory.
- Verify that only the active bundle hash remains in the staged `bundles/` directory.
- Build the bundled agent runtime and ensure the expected Node executable exists.
- Verify that the bundled runtime contains no external symlinks.

### 6.2 Packaging checks

- Produce the platform artifacts through the normal release build command.
- On macOS, run `codesign --verify --deep --strict` on the packaged `.app`.
- Verify that the expected output files exist, such as `.dmg`, `.zip`, or platform equivalents.

### 6.3 Smoke tests

- Launch the packaged application binary with a safe smoke-test argument such as `--help`.
- Verify that the packaged web payload resolves from the app bundle.
- Verify that the bundled agent runtime can resolve its Node executable.
- For platforms with background runtime support, verify that the service-manager path at least initializes successfully.

## 7. Current Implementation Hooks

The current desktop release flow is expected to align with the following implementation points:

- [`apps/desktop/scripts/prepare-webapp-asar.ts`](../apps/desktop/scripts/prepare-webapp-asar.ts)
- [`apps/desktop/scripts/prepare-agent-runtime.ts`](../apps/desktop/scripts/prepare-agent-runtime.ts)
- [`apps/desktop/package.json`](../apps/desktop/package.json)

Changes to desktop packaging `SHOULD` update this document when they alter the release contract.

## 8. Release Blockers

The following are release blockers for desktop builds:

- stale web bundles are packaged into `webapp.asar`
- packaged resources contain absolute symlinks or machine-local references
- runtime resource paths differ between build-time output and release-time lookup
- universal or cross-architecture builds embed a host-architecture-only runtime
- Windows code paths rely on Unix-specific executable resolution
- macOS packaged apps fail `codesign --verify --deep --strict`

## 9. Practical Rule

If a desktop artifact depends on the source checkout layout, the build machine's absolute paths,
or the host architecture rather than the target architecture, it is not release-safe and must be fixed before shipping.
