/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  importEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

interface Opened {
  rendered: boolean;
  bodyText: string;
  headerSubject: string;
  streamedBytes: number;
  streamedContains: boolean;
}

// Bodies are sent as raw 8-bit UTF-8 (Content-Transfer-Encoding: 8bit).
const BODIES: Record<string, string> = {
  "First message": "Body of the first message 7731: Čestitke s Hvara, šećer, žaba, đak.",
  "Second message": "Body of the second message 9902: Dobar dan, gospođo Ćorić! Šaljem žute ruže.",
};

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let s: StalwartInstance;

  beforeAll(async () => {
    s = await startStalwart();
    const { client, accountId } = await connect(s);
    const inbox = await mailboxIdByRole(client, accountId, "inbox");
    let minutes = 0;
    for (const [subject, body] of Object.entries(BODIES)) {
      await importEmail(client, accountId, {
        mailboxIds: [inbox],
        subject,
        body,
        date: new Date(Date.UTC(2026, 10, 1, 9, minutes++)),
      });
    }
  });

  afterAll(async () => {
    await s?.stop();
  });

  const accountArgs = () => ({
    email: "admin@example.com",
    sessionUrl: s.sessionUrl,
    username: s.username,
    secret: s.password,
    authKind: "basic",
  });
  const inboxMessages = (r: Inspection) => r.accounts[0].messages["Inbox"];

  test("bodies download in the background, and a message opens and streams", async () => {
    const profile = await createProfile({ xpi: TEST_XPI });
    const created = await runScenario<Inspection>({ version, profile, scenario: "create-account", args: accountArgs() });
    expect(created.ok, created.error).toBe(true);
    expect(inboxMessages(created).map(m => m.hasBody)).toEqual([true, true]);

    const opened = await runScenario<Opened>({
      version,
      profile,
      scenario: "open-first",
      args: { folderPath: ["Inbox"], bodies: BODIES },
    });
    expect(opened.ok, opened.error).toBe(true);
    expect(Object.keys(BODIES)).toContain(opened.headerSubject);
    expect(opened.rendered, opened.bodyText).toBe(true);
    expect(opened.bodyText).not.toContain("Subject:");
    expect(opened.streamedContains).toBe(true);

    const parsed = await runScenario<{ subject: string; bodyText: string | null }>({
      version,
      profile,
      scenario: "mime-body",
      args: { folderPath: ["Inbox"] },
    });
    expect(parsed.ok, parsed.error).toBe(true);
    expect(parsed.bodyText, "MsgHdrToMimeMessage must see the body").toContain(BODIES[parsed.subject]);
  });

  test("with background download off, opening a message fetches its body first", async () => {
    const profile = await createProfile({
      xpi: TEST_XPI,
      prefs: { "extensions.thunderbird-jmap.backgroundBodyDownload": false },
    });
    const created = await runScenario<Inspection>({ version, profile, scenario: "create-account", args: accountArgs() });
    expect(created.ok, created.error).toBe(true);
    expect(inboxMessages(created).map(m => m.hasBody)).toEqual([false, false]);

    const opened = await runScenario<Opened>({
      version,
      profile,
      scenario: "open-first",
      args: { folderPath: ["Inbox"], bodies: BODIES },
    });
    expect(opened.ok, opened.error).toBe(true);
    expect(opened.rendered, opened.bodyText).toBe(true);
    expect(opened.bodyText, "headers must stay in the header pane").not.toContain("Subject:");

    const after = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: { noSync: true } });
    expect(inboxMessages(after).find(m => m.subject == opened.headerSubject)?.hasBody).toBe(true);
    expect(inboxMessages(after).find(m => m.subject != opened.headerSubject)?.hasBody).toBe(false);
  });
});
