/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  const { log } = await runThunderbird(o);
  return readReport<Report<T>>(o.profile, o.scenario, log);
}
