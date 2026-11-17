#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Build the add-on: node scripts/build.mjs [--test]
// → build/<release|test>/ and dist/thunderbird-jmap[-test].xpi

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(APP, "../..");
const test = process.argv.includes("--test");
const variant = test ? "test" : "release";
const out = join(APP, "build", variant);
const xpi = join(APP, "dist", test ? "thunderbird-jmap-test.xpi" : "thunderbird-jmap.xpi");
const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
const HEADER = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const manifest = JSON.parse(await readFile(join(APP, "manifest.json"), "utf8"));
if (manifest.version != version) {
  throw new Error(`manifest.json version ${manifest.version} != package.json ${version}; run the bump script`);
}
if (test) {
  manifest.experiment_apis.jmapTest = {
    schema: "test-experiment/schema.json",
    parent: {
      scopes: ["addon_parent"],
      paths: [["jmapTest"]],
      script: "test-experiment/api.js",
      events: ["startup"],
    },
  };
}
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

for (const item of ["background.js", "experiment", "ui", ...(test ? ["test-experiment"] : [])]) {
  if (existsSync(join(APP, item))) {
    await cp(join(APP, item), join(out, item), { recursive: true });
  }
}
await cp(join(ROOT, "LICENSE"), join(out, "LICENSE"));

await build({
  entryPoints: [join(APP, "src/core-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "firefox128",
  outfile: join(out, "experiment/modules/core.sys.mjs"),
  define: { __CORE_VERSION__: JSON.stringify(version) },
  banner: { js: HEADER },
  legalComments: "none",
  logLevel: "warning",
});

await mkdir(dirname(xpi), { recursive: true });
await rm(xpi, { force: true });
execFileSync("zip", ["-qr", "-X", xpi, "."], { cwd: out });
console.log(xpi);
