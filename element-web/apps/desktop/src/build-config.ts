/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, loadJsonFile } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let buildConfig: BuildConfig;

interface BuildConfig {
    // Application User Model ID
    appId: string;
    // Protocol string used for OIDC callbacks
    protocol: string;
    // All protocol aliases registered for the app
    protocols: string[];
    // Subject name of the code signing cert used for Windows packages, if signed
    // used as a basis for the Tray GUID which must be rolled if the certificate changes.
    windowsCertSubjectName: string | undefined;
}

export function getBuildConfig(): BuildConfig {
    if (!buildConfig) {
        const packageJson = loadJsonFile(path.join(__dirname, "..", "package.json")) as JsonObject;
        const protocols = Array.isArray(packageJson["electron_protocols"])
            ? (packageJson["electron_protocols"] as string[]).filter(
                  (value): value is string => typeof value === "string" && value.length > 0,
              )
            : [];
        const primaryProtocol = (packageJson["electron_protocol"] as string) || protocols[0] || "io.dopax.desktop";
        buildConfig = {
            appId: (packageJson["electron_appId"] as string) || "io.dopax.desktop",
            protocol: primaryProtocol,
            protocols: protocols.length > 0 ? protocols : [primaryProtocol],
            windowsCertSubjectName: packageJson["electron_windows_cert_sn"] as string,
        };
    }

    return buildConfig;
}
