/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./thunderbird.js";

/** Start every run with no leftover profiles from earlier runs. */
export default async function setup(): Promise<void> {
  await rm(join(REPO_ROOT, "tests/thunderbird/out/profiles"), { recursive: true, force: true });
}
