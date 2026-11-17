/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mailbox ids outside RFC 8620's character set. Mailflare sends ids such as
// "mbx_<owner>~inbox"; Stalwart cannot produce them, so the scenario hands
// the mailbox tree to the add-on's store directly.

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import { startStalwart, type StalwartInstance } from "@thunderbird-jmap/test-support";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

const MAILBOXES = [
  { id: "mbx_Me1", name: "Me <me@example.com>", parentId: null, kind: null, sortOrder: 0 },
  { id: "mbx_Me1~inbox", name: "Inbox", parentId: "mbx_Me1", kind: "inbox", sortOrder: 1 },
  { id: "mbx_Me1~sent", name: "Sent", parentId: "mbx_Me1", kind: "sent", sortOrder: 2 },
];
const EXPECTED = [
  ["Me <me@example.com>", "mbx_Me1", true],
  ["Me <me@example.com>/Inbox", "mbx_Me1~inbox", true],
  ["Me <me@example.com>/Sent", "mbx_Me1~sent", true],
];
const MESSAGE = { mailboxId: "mbx_Me1~inbox", subject: "Tilde mailbox", body: "Body in a tilde mailbox 5150" };

const summary = (r: Inspection) =>
  r.accounts[0].folders.map(f => [f.path.join("/"), f.mailboxId, f.inPane]).sort();

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let s: StalwartInstance;
  let profile: string;

  beforeAll(async () => {
    s = await startStalwart();
    profile = await createProfile({ xpi: TEST_XPI });
    const created = await runScenario<Inspection>({
      version,
      profile,
      scenario: "create-account",
      args: {
        email: "admin@example.com",
        sessionUrl: s.sessionUrl,
        username: s.username,
        secret: s.password,
        authKind: "basic",
      },
    });
    expect(created.ok, created.error).toBe(true);
  });

  afterAll(async () => {
    await s?.stop();
  });

  test("mailboxes with '~' in their ids become folders that show and whose mail opens", async () => {
    const r = await runScenario<Inspection & { streamedContains: boolean }>({
      version,
      profile,
      scenario: "apply-mailboxes",
      args: { mailboxes: MAILBOXES, message: MESSAGE },
    });
    expect(r.ok, r.error).toBe(true);
    expect(summary(r)).toEqual(EXPECTED);
    expect(r.accounts[0].messages["Me <me@example.com>/Inbox"]?.map(m => m.subject)).toEqual([MESSAGE.subject]);
    expect(r.streamedContains, "the stored message must stream back").toBe(true);
  });

  test("after a restart those folders and their mail are still there", async () => {
    // The tree above exists only locally; a sync (such as the one at
    // startup) would rightly replace it with the server's real mailboxes.
    // With the server gone, the restart shows what was stored.
    await s.stop();
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "inspect",
      args: { noSync: true, waitIdle: true },
    });
    expect(r.ok, r.error).toBe(true);
    expect(summary(r)).toEqual(EXPECTED);
    expect(r.accounts[0].messages["Me <me@example.com>/Inbox"]?.map(m => m.subject)).toEqual([MESSAGE.subject]);
  });
});
