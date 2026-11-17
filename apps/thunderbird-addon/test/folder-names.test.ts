/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from "vitest";
// @ts-expect-error -- plain JS module without type declarations
import { localFolderName } from "../experiment/modules/FolderNames.sys.mjs";

test("valid JMAP ids get a fixed prefix and case-safe encoding", () => {
  expect(localFolderName("Ab-c_9")).toBe("mb-~ab-c_9");
  expect(localFolderName("con")).toBe("mb-con");
});

test("ids outside RFC 8620's character set or length are rejected", () => {
  for (const bad of ["", "..", ".", "a/b", "a\\b", "a.b", "x".repeat(256), "ä"]) {
    expect(localFolderName(bad), JSON.stringify(bad)).toBeNull();
  }
  expect(localFolderName("x".repeat(255))).toBe("mb-" + "x".repeat(255));
});
