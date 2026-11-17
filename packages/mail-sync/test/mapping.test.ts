/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, test, expect } from "vitest";
import { keywordsToFlags, roleToKind, toMailboxInfos, flagsToKeywords, keywordPatch, mergeServerFlags } from "../src/index.js";

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

test("server-internal $keywords are not tags, but Thunderbird's $labelN tags are", () => {
  const flags = keywordsToFlags({ $hasnoattachment: true, $MDNSent: true, $label1: true, Work: true });
  expect(flags.tags).toEqual(["$label1", "work"]);
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

describe("keywords going back to the server", () => {
  const NONE = { read: false, flagged: false, answered: false, forwarded: false, draft: false, junk: null, tags: [] as string[] };

  test("flagsToKeywords lists the keywords the local flags stand for", () => {
    expect(flagsToKeywords({ ...NONE, read: true, answered: true, junk: false, tags: ["work"] })).toEqual([
      "$answered",
      "$notjunk",
      "$seen",
      "work",
    ]);
  });

  test("keywordPatch sends only differences and never removes hidden $ keywords", () => {
    expect(keywordPatch(["$seen", "$hasnoattachment", "work"], ["$flagged", "work"], [])).toEqual({
      "keywords/$seen": null,
      "keywords/$flagged": true,
    });
  });

  test("keywordPatch skips keywords known to be local-only", () => {
    expect(keywordPatch(["$seen"], ["$seen", "work"], ["work"])).toEqual({});
  });

  test("keywordPatch escapes keywords for the JSON pointer", () => {
    expect(keywordPatch([], ["a/b~c"], [])).toEqual({ "keywords/a~1b~0c": true });
  });

  test("mergeServerFlags keeps a tag the server never had and drops one the server removed", () => {
    const local = { ...NONE, tags: ["mine", "gone"] };
    const merged = mergeServerFlags({ ...NONE, tags: [] }, [], ["gone"], local);
    expect(merged.tags).toEqual(["mine"]);
  });

  test("mergeServerFlags keeps Replied/Forwarded/junk the server never stored, and follows it once it has", () => {
    const local = { ...NONE, answered: true, forwarded: true, junk: true };
    // Mailflare: only $seen/$flagged are ever stored.
    expect(mergeServerFlags({ ...NONE, read: true }, ["$seen"], ["$seen"], local)).toMatchObject({
      read: true,
      answered: true,
      forwarded: true,
      junk: true,
    });
    // A server that had $answered and $junk, and dropped them.
    expect(mergeServerFlags({ ...NONE }, [], ["$answered", "$junk"], local)).toMatchObject({
      answered: false,
      forwarded: true,
      junk: null,
    });
  });

  test("mergeServerFlags with no earlier server keywords takes the server's flags", () => {
    const local = { ...NONE, read: true, tags: ["x"] };
    expect(mergeServerFlags({ ...NONE, tags: ["y"] }, ["y"], null, local)).toEqual({ ...NONE, tags: ["y"] });
  });
});
