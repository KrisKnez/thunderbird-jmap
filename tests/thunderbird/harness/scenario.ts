/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readReport, runThunderbird } from "./thunderbird.js";

export type Report<T> = T & { ok: boolean; error?: string; errorName?: string; stack?: string };

/** Launch Thunderbird with one scenario and return its report. */
export async function runScenario<T>(o: {
  version: string;
  profile: string;
  scenario: string;
  args?: unknown;
  timeoutMs?: number;
}): Promise<Report<T>> {
  // A report from an earlier run of this scenario must never pass for this one's.
  await rm(join(o.profile, `jmaptest-${o.scenario}.json`), { force: true });
  const { log } = await runThunderbird(o);
  return readReport<Report<T>>(o.profile, o.scenario, log);
}
