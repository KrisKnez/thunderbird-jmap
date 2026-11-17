/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    globalSetup: ["harness/global-setup.ts"],
  },
});
