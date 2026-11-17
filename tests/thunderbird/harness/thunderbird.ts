/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const ADDON_ID = "{ddb4c26d-c465-4ac4-a04d-eddc8783806f}";
export const TEST_XPI = join(REPO_ROOT, "apps/thunderbird-addon/dist/thunderbird-jmap-test.xpi");
export const ROOT_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
export const TB_VERSIONS = (process.env.TB_VERSIONS ?? "153.7.0esr,158.0,160.0")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const OUT = join(REPO_ROOT, "tests/thunderbird/out");

export function tbBinary(version: string): string {
  return join(REPO_ROOT, ".cache/thunderbird", version, "thunderbird/thunderbird");
}

const BASE_PREFS: Record<string, string | number | boolean> = {
  "xpinstall.signatures.required": false,
  "extensions.autoDisableScopes": 0,
  "extensions.enabledScopes": 15,
  "extensions.startupScanScopes": 15,
  "extensions.experiments.enabled": true,
  "browser.dom.window.dump.enabled": true,
  "devtools.console.stdout.chrome": true,
  "mail.provider.suppress_dialog_on_startup": true,
  "mail.shell.checkDefaultClient": false,
  "mail.rights.override": true,
  "datareporting.policy.dataSubmissionEnabled": false,
  "app.update.auto": false,
  "app.update.enabled": false,
  "extensions.thunderbird-jmap.loglevel": "Debug",
  "jmaptest.autoquit": true,
};

/** A fresh profile with the add-on sideloaded. */
export async function createProfile(o: {
  xpi: string;
  prefs?: Record<string, string | number | boolean>;
}): Promise<string> {
  await mkdir(join(OUT, "profiles"), { recursive: true });
  const profile = await mkdtemp(join(OUT, "profiles", "p-"));
  await mkdir(join(profile, "extensions"));
  await copyFile(o.xpi, join(profile, "extensions", `${ADDON_ID}.xpi`));
  const prefs = { ...BASE_PREFS, ...o.prefs };
  const lines = Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(profile, "user.js"), lines.join("\n") + "\n");
  return profile;
}

let runCounter = 0;

/** Run headless Thunderbird once with a test scenario; resolves when it exits. */
export function runThunderbird(o: {
  version: string;
  profile: string;
  scenario: string;
  args?: unknown;
  timeoutMs?: number;
}): Promise<{ exitCode: number; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tbBinary(o.version), ["--headless", "-no-remote", "-profile", o.profile], {
      env: {
        ...process.env,
        MOZ_HEADLESS: "1",
        MOZ_HEADLESS_WIDTH: "1280",
        MOZ_HEADLESS_HEIGHT: "800",
        JMAP_TEST_SCENARIO: o.scenario,
        JMAP_TEST_ARGS: JSON.stringify(o.args ?? null),
      },
    });
    let log = "";
    child.stdout.on("data", d => (log += d));
    child.stderr.on("data", d => (log += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 120_000);
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", async code => {
      clearTimeout(timer);
      await writeFile(join(o.profile, `run-${++runCounter}-${o.scenario}.log`), log).catch(() => {});
      resolve({ exitCode: code ?? -1, log });
    });
  });
}

/** Read the JSON report a scenario wrote; throws with the log tail if missing. */
export async function readReport<T>(profile: string, scenario: string, log = ""): Promise<T> {
  try {
    return JSON.parse(await readFile(join(profile, `jmaptest-${scenario}.json`), "utf8"));
  } catch {
    throw new Error(`No report for scenario "${scenario}" in ${profile}.\n--- log tail ---\n${log.slice(-4000)}`);
  }
}
