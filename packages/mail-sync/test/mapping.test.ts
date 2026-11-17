/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, test, expect } from "vitest";
import { keywordsToFlags, roleToKind, toMailboxInfos } from "../src/index.js";

describe("keywordsToFlags", () => {
  test("maps system keywords case-insensitively and keeps the rest as lower-case tags", () => {
    expect(keywordsToFlags({ $seen: true, $Flagged: true, Work: true, $notjunk: true })).toEqual({
      read: true,
      flagged: true,
      answered: false,
      forwarded: false,
      draft: false,
      junk: false,
      tags: ["work"],
    });
  });
  test("$junk is true, absence of both junk keywords is null, tags are sorted", () => {
    const flags = keywordsToFlags({ $junk: true, $answered: true, zeta: true, Alpha: true });
    expect(flags.junk).toBe(true);
    expect(flags.answered).toBe(true);
    expect(flags.tags).toEqual(["alpha", "zeta"]);
    expect(keywordsToFlags({}).junk).toBeNull();
  });
});

describe("roleToKind", () => {
  test("known roles map, others are null", () => {
    expect(roleToKind("inbox")).toBe("inbox");
    expect(roleToKind("archive")).toBe("archive");
    expect(roleToKind("important")).toBeNull();
    expect(roleToKind(null)).toBeNull();
  });
});

describe("toMailboxInfos", () => {
  test("parents come before children, siblings by sortOrder then name, orphans go top level", () => {
    const infos = toMailboxInfos([
      { id: "a", name: "Alpha", parentId: "p", role: null, sortOrder: 0 },
      { id: "o", name: "Orphan", parentId: "missing", role: null, sortOrder: 0 },
      { id: "p", name: "Projects", parentId: null, role: null, sortOrder: 5 },
      { id: "i", name: "Inbox", parentId: null, role: "inbox", sortOrder: 1 },
      { id: "b", name: "Beta", parentId: null, role: null, sortOrder: 5 },
    ]);
    expect(infos.map(m => m.id)).toEqual(["o", "i", "b", "p", "a"]);
    expect(infos.find(m => m.id == "o")?.parentId).toBeNull();
    expect(infos.find(m => m.id == "i")?.kind).toBe("inbox");
  });
});
