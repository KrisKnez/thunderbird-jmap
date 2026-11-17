/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from "vitest";
import { startStalwart } from "../src/index.js";

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
