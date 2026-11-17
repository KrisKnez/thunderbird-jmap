#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Launch Thunderbird with a persistent dev profile and the freshly built
// add-on: node scripts/run-thunderbird.mjs [--version 160.0] [--headless]
// Profile: .cache/profiles/dev-<version> (kept between runs).

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADDON_ID = "{ddb4c26d-c465-4ac4-a04d-eddc8783806f}";

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const version = versionIndex == -1 ? "160.0" : args[versionIndex + 1];
const headless = args.includes("--headless");

const binary = join(ROOT, ".cache/thunderbird", version, "thunderbird/thunderbird");
if (!existsSync(binary)) {
  execFileSync(process.execPath, [join(ROOT, "scripts/fetch-thunderbird.mjs"), version], {
    stdio: "inherit",
  });
}
execFileSync(process.execPath, [join(ROOT, "apps/thunderbird-addon/scripts/build.mjs")], {
  stdio: "inherit",
});

const profile = join(ROOT, ".cache/profiles", `dev-${version}`);
mkdirSync(join(profile, "extensions"), { recursive: true });
const prefs = {
  "xpinstall.signatures.required": false,
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 15,
  "extensions.startupScanScopes": 15,
  "extensions.experiments.enabled": true,
  "extensions.thunderbird-jmap.loglevel": "Debug",
  "browser.dom.window.dump.enabled": true,
  "devtools.console.stdout.chrome": true,
  "devtools.chrome.enabled": true,
  "devtools.debugger.remote-enabled": true,
  "mail.shell.checkDefaultClient": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "app.update.auto": false,
  "app.update.enabled": false,
};
writeFileSync(
  join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n") + "\n"
);
copyFileSync(
  join(ROOT, "apps/thunderbird-addon/dist/thunderbird-jmap.xpi"),
  join(profile, "extensions", `${ADDON_ID}.xpi`)
);

console.log(`Thunderbird ${version}, profile ${profile}`);
const child = spawn(binary, ["-no-remote", "-profile", profile, ...(headless ? ["--headless"] : [])], {
  stdio: "inherit",
  env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
});
child.on("exit", code => process.exit(code ?? 1));
