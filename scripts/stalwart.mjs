#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Dev Stalwart server: `node scripts/stalwart.mjs up|down`.
// http://127.0.0.1:18080 — login admin / jmap-dev-password.

import { execFileSync } from "node:child_process";

const NAME = "tbjmap-dev";
const IMAGE = "docker.io/stalwartlabs/stalwart:v1.1.1";
const PORT = 18080;
const PASSWORD = "jmap-dev-password";

const podman = (...args) => execFileSync("podman", args, { stdio: "inherit" });

const cmd = process.argv[2];
if (cmd == "up") {
  podman("rm", "-f", NAME);
  podman("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`,
    "-e", `STALWART_RECOVERY_ADMIN=admin:${PASSWORD}`, IMAGE);
  console.log(`Stalwart: http://127.0.0.1:${PORT}/jmap/session (admin / ${PASSWORD})`);
} else if (cmd == "down") {
  podman("rm", "-f", NAME);
} else {
  console.error("usage: stalwart.mjs up|down");
  process.exit(2);
}
