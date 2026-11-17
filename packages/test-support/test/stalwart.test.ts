/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "vitest";
import { startStalwart } from "../src/index.js";

const podman = async (...args: string[]) => (await promisify(execFile)("podman", args)).stdout.trim();

/** The named volumes of the container publishing `baseUrl`'s port. */
async function volumesOf(baseUrl: string): Promise<string[]> {
  const port = new URL(baseUrl).port;
  const line = (await podman("ps", "--format", "{{.Names}} {{.Ports}}")).split("\n").find(l => l.includes(`:${port}->`))!;
  const name = line.split(" ")[0];
  return (await podman("inspect", name, "--format", "{{range .Mounts}}{{.Name}} {{end}}")).split(" ").filter(Boolean);
}

test("starts Stalwart with a JMAP mail account", async () => {
  const s = await startStalwart();
  try {
    const res = await fetch(s.sessionUrl, {
      headers: { Authorization: "Basic " + btoa(`${s.username}:${s.password}`) },
    });
    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session.capabilities).toHaveProperty(["urn:ietf:params:jmap:mail"]);
    expect(session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBeTypeOf("string");
  } finally {
    await s.stop();
  }
}, 90_000);

test("stopping Stalwart removes its volumes too", async () => {
  const s = await startStalwart();
  let volumes: string[] = [];
  try {
    volumes = await volumesOf(s.baseUrl);
    expect(volumes.length).toBeGreaterThan(0);
  } finally {
    await s.stop();
  }
  const left = await podman("volume", "ls", "-q");
  expect(volumes.filter(v => left.includes(v))).toEqual([]);
}, 90_000);
