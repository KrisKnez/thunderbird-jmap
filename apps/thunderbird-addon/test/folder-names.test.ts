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

test("ids with characters RFC 8620 does not allow are escaped, not refused", () => {
  // Mailflare's mailbox ids look like "mbx_<owner>~inbox".
  expect(localFolderName("mbx_A~inbox")).toBe("mb-mbx_~a!7einbox");
  expect(localFolderName("..")).toBe("mb-!2e!2e");
  expect(localFolderName("a/b")).toBe("mb-a!2fb");
  expect(localFolderName("a\\b")).toBe("mb-a!5cb");
  expect(localFolderName("ä")).toBe("mb-!c3!a4");
});

test("different ids never share a name, and names are lower-case and filename-safe", () => {
  const ids = ["~", "!7e", "!", "A", "~a", "a", "x.y", "x!2ey", "a b", "a:b"];
  const names = ids.map(localFolderName);
  expect(new Set(names).size).toBe(ids.length);
  for (const name of names) {
    expect(name).toMatch(/^mb-[a-z0-9_~!-]+$/);
  }
});

test("empty ids and ids whose names would be too long for a file are refused", () => {
  for (const bad of ["", 42, null, "x".repeat(238), "A".repeat(119)]) {
    expect(localFolderName(bad), JSON.stringify(bad)).toBeNull();
  }
  expect(localFolderName("x".repeat(237))).toBe("mb-" + "x".repeat(237));
});
