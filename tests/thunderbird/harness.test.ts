/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The harness itself: a run that writes no report must fail, even when a
// profile still holds the report of an earlier run of the same scenario.

import { test, expect } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ADDON_ID, createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";

test("a report left by an earlier run is never read as this run's", async () => {
  const profile = await createProfile({ xpi: TEST_XPI });
  // Without the add-on nothing can write a report (and nothing quits
  // Thunderbird, so the run ends at its timeout).
  await rm(join(profile, "extensions", `${ADDON_ID}.xpi`));
  await writeFile(join(profile, "jmaptest-ping.json"), JSON.stringify({ ok: true, stale: true }));
  await expect(
    runScenario({ version: TB_VERSIONS[0], profile, scenario: "ping", timeoutMs: 8000 })
  ).rejects.toThrow(/No report/);
});
