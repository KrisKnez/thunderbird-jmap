#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bump the repo-wide major.minor.patch version and copy it everywhere.
//
// Usage: node scripts/bump-version.mjs <major|minor|patch> [--root <dir>]
//
// Source of truth: the root package.json "version". The new version is
// written to the root package.json, every package.json directly under
// packages/*, apps/* and tests/*, and every apps/*/manifest.json.
// Prints the new version. Exit 2 on a bad level, 1 on a bad root version.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = ["major", "minor", "patch"];

function parseArgs(argv) {
  const args = [...argv];
  let root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const i = args.indexOf("--root");
  if (i != -1) {
    root = args[i + 1];
    args.splice(i, 2);
  }
  return { level: args[0], root };
}

export function nextVersion(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) {
    throw new Error(`Root version "${version}" is not major.minor.patch`);
  }
  const [major, minor, patch] = m.slice(1).map(Number);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
  throw new Error(`Unknown level ${level}`);
}

function versionedFiles(root) {
  const files = [join(root, "package.json")];
  for (const group of ["packages", "apps", "tests"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of ["package.json", ...(group == "apps" ? ["manifest.json"] : [])]) {
        const file = join(dir, entry.name, name);
        if (existsSync(file)) files.push(file);
      }
    }
  }
  return files;
}

function main() {
  const { level, root } = parseArgs(process.argv.slice(2));
  if (!LEVELS.includes(level)) {
    console.error(`usage: bump-version.mjs <${LEVELS.join("|")}> [--root <dir>]`);
    process.exit(2);
  }
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let version;
  try {
    version = nextVersion(rootPkg.version, level);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const file of versionedFiles(root)) {
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.version = version;
    writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }
  console.log(version);
}

main();
