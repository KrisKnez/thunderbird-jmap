/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The harness itself: a run that writes no report must fail, even when a
// profile still holds the report of an earlier run of the same scenario.

import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";

test("a report left by an earlier run is never read as this run's", async () => {
  const profile = await createProfile({ xpi: TEST_XPI });
  await writeFile(join(profile, "jmaptest-ping.json"), JSON.stringify({ ok: true, stale: true }));
  // Killed long before the scenario could write a report of its own.
  await expect(
    runScenario({ version: TB_VERSIONS[0], profile, scenario: "ping", timeoutMs: 1000 })
  ).rejects.toThrow(/No report/);
});
