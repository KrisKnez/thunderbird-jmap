/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// "Check for new messages at startup": on by default for JMAP accounts,
// and respected when the user turns it off.

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  importEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import type { JmapClient } from "@thunderbird-jmap/jmap-client";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario, type Report } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

const subjects = (r: Inspection) => (r.accounts[0].messages["Inbox"] ?? []).map(m => m.subject);

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let s: StalwartInstance;
  let client: JmapClient;
  let accountId: string;
  let inbox: string;
  let profile: string;
  let created: Report<Inspection>;

  beforeAll(async () => {
    s = await startStalwart();
    ({ client, accountId } = await connect(s));
    inbox = await mailboxIdByRole(client, accountId, "inbox");
    profile = await createProfile({ xpi: TEST_XPI });
    created = await runScenario<Inspection>({
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

  test("new accounts have 'Check for new messages at startup' turned on", () => {
    expect(created.accounts[0].loginAtStartUp).toBe(true);
  });

  test("mail that arrived while Thunderbird was closed is there after a restart, without Get Messages", async () => {
    await importEmail(client, accountId, { mailboxIds: [inbox], subject: "Arrived while closed", body: "a" });
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "inspect",
      args: { noSync: true, waitIdle: true },
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts[0].lastSyncError).toBeNull();
    expect(subjects(r)).toContain("Arrived while closed");
  });

  test("with 'Check for new messages at startup' turned off, a restart does not sync", async () => {
    const off = await runScenario<Inspection>({ version, profile, scenario: "login-at-startup", args: { value: false } });
    expect(off.ok, off.error).toBe(true);
    await importEmail(client, accountId, { mailboxIds: [inbox], subject: "Waits for Get Messages", body: "b" });
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "inspect",
      args: { noSync: true, waitIdle: true },
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts[0].loginAtStartUp).toBe(false);
    expect(subjects(r)).toContain("Arrived while closed");
    expect(subjects(r)).not.toContain("Waits for Get Messages");
  });

  test("an account created before this check existed gets it turned on once, and syncs at startup", async () => {
    const older = await runScenario<Inspection>({ version, profile, scenario: "as-older-account", args: {} });
    expect(older.ok, older.error).toBe(true);
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "inspect",
      args: { noSync: true, waitIdle: true },
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts[0].loginAtStartUp).toBe(true);
    expect(subjects(r)).toContain("Waits for Get Messages");
  });
});
