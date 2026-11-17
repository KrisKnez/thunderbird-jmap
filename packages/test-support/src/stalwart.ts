/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

export const STALWART_IMAGE = "docker.io/stalwartlabs/stalwart:v1.1.1";

export interface StalwartInstance {
  baseUrl: string;
  sessionUrl: string;
  username: "admin";
  password: string;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address == "object") {
          resolve(address.port);
        } else {
          reject(new Error("could not determine a free port"));
        }
      });
    });
  });
}

async function waitUntilLive(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz/live`);
      if (res.status == 200) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`Stalwart at ${baseUrl} not live after ${timeoutMs} ms`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Start a throwaway Stalwart container in bootstrap mode. The recovery admin
 * ("admin") has a working JMAP mail account.
 */
export async function startStalwart(opts: { password?: string } = {}): Promise<StalwartInstance> {
  const password = opts.password ?? randomBytes(12).toString("hex");
  const port = await freePort();
  const name = `tbjmap-test-${randomBytes(4).toString("hex")}`;
  await run("podman", [
    "run", "-d", "--rm",
    "--name", name,
    "-p", `127.0.0.1:${port}:8080`,
    "-e", `STALWART_RECOVERY_ADMIN=admin:${password}`,
    STALWART_IMAGE,
  ]);
  const stop = async () => {
    await run("podman", ["rm", "-f", name]).catch(() => {});
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilLive(baseUrl, 60_000);
  } catch (e) {
    await stop();
    throw e;
  }
  return { baseUrl, sessionUrl: `${baseUrl}/jmap/session`, username: "admin", password, stop };
}
