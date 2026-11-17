#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Download, verify (SHA256SUMS) and extract Thunderbird Linux builds into
// .cache/thunderbird/<version>/thunderbird/. Versions: argv, else $TB_VERSIONS.
// Already-extracted versions are skipped.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://archive.mozilla.org/pub/thunderbird/releases";

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function fetchVersion(version) {
  const dir = join(ROOT, ".cache/thunderbird", version);
  if (existsSync(join(dir, "thunderbird/thunderbird"))) {
    console.log(`${version}: already present`);
    return;
  }
  const download = join(dir, "download");
  await rm(dir, { recursive: true, force: true });
  await mkdir(download, { recursive: true });

  const name = `thunderbird-${version}.tar.xz`;
  const sumsRes = await fetch(`${BASE}/${version}/SHA256SUMS`);
  if (!sumsRes.ok) throw new Error(`${version}: SHA256SUMS HTTP ${sumsRes.status}`);
  const wanted = (await sumsRes.text())
    .split("\n")
    .find(line => line.endsWith(` linux-x86_64/en-US/${name}`))
    ?.split(" ")[0];
  if (!wanted) throw new Error(`${version}: ${name} not listed in SHA256SUMS`);

  console.log(`${version}: downloading`);
  const res = await fetch(`${BASE}/${version}/linux-x86_64/en-US/${name}`);
  if (!res.ok) throw new Error(`${version}: tarball HTTP ${res.status}`);
  const tarball = join(download, name);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));

  const actual = await sha256(tarball);
  if (actual != wanted) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`${version}: checksum mismatch (expected ${wanted}, got ${actual})`);
  }
  execFileSync("tar", ["-xJf", tarball, "-C", dir]);
  await rm(download, { recursive: true, force: true });
  console.log(`${version}: ready`);
}

const versions = (process.argv.length > 2 ? process.argv.slice(2) : (process.env.TB_VERSIONS ?? "").split(","))
  .map(v => v.trim())
  .filter(Boolean);
if (!versions.length) {
  console.error("usage: fetch-thunderbird.mjs <version>... (or set TB_VERSIONS)");
  process.exit(2);
}
for (const version of versions) {
  await fetchVersion(version);
}
