/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, test, expect } from "vitest";
import { createProfile, ROOT_VERSION, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  test("the add-on loads and its bundled core module imports", async () => {
    const profile = await createProfile({ xpi: TEST_XPI });
    const report = await runScenario<{ coreVersion: string; tbVersion: string }>({
      version,
      profile,
      scenario: "ping",
    });
    expect(report.ok, report.error).toBe(true);
    expect(report.coreVersion).toBe(ROOT_VERSION);
    expect(report.tbVersion.split(".")[0]).toBe(version.split(".")[0]);
  });
});
