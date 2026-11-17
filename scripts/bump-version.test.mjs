/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bump-version.mjs");

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
const readVersion = path => JSON.parse(readFileSync(path, "utf8")).version;

function fixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "bump-"));
  writeJson(join(root, "package.json"), { name: "root", private: true, version });
  writeJson(join(root, "packages/a/package.json"), { name: "a", version: "9.9.9" });
  writeJson(join(root, "apps/addon/package.json"), { name: "addon" });
  writeJson(join(root, "apps/addon/manifest.json"), { manifest_version: 3, version: "0.0.1" });
  writeJson(join(root, "tests/tb/package.json"), { name: "tb", private: true, version });
  writeJson(join(root, "packages/a/node_modules/dep/package.json"), { name: "dep", version: "1.2.3" });
  return root;
}

const run = (root, ...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf8" });

const ALL = ["package.json", "packages/a/package.json", "apps/addon/package.json", "apps/addon/manifest.json", "tests/tb/package.json"];

test("minor bump sets every workspace package and manifest to the new version", () => {
  const root = fixture("0.1.0");
  const r = run(root, "minor");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.2.0");
  for (const f of ALL) assert.equal(readVersion(join(root, f)), "0.2.0", f);
  assert.equal(readVersion(join(root, "packages/a/node_modules/dep/package.json")), "1.2.3");
});

test("patch and major follow semver", () => {
  const root = fixture("0.2.0");
  assert.equal(run(root, "patch").stdout.trim(), "0.2.1");
  assert.equal(run(root, "major").stdout.trim(), "1.0.0");
  assert.equal(readVersion(join(root, "apps/addon/manifest.json")), "1.0.0");
});

test("an unknown level fails with exit code 2 and changes nothing", () => {
  const root = fixture("0.3.0");
  const r = run(root, "huge");
  assert.equal(r.status, 2);
  assert.equal(readVersion(join(root, "package.json")), "0.3.0");
  assert.equal(readVersion(join(root, "packages/a/package.json")), "9.9.9");
});

test("a root version that is not major.minor.patch fails with exit code 1", () => {
  const root = fixture("1.0");
  const r = run(root, "patch");
  assert.equal(r.status, 1);
  assert.equal(readVersion(join(root, "package.json")), "1.0");
});
