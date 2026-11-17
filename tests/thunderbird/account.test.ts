/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  createMailbox,
  renameMailbox,
  destroyMailbox,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import type { JmapClient } from "@thunderbird-jmap/jmap-client";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { FolderReport, Inspection } from "./harness/types.js";

const byPath = (folders: FolderReport[], path: string) =>
  folders.find(f => f.path.join("/") == path);

/** Load extension pages in-process so the scenario can fill in the form. */
const IN_PROCESS_PAGES = { "extensions.webextensions.remote": false };

/** path → mailboxId, for comparing folder trees across runs. */
const tree = (folders: FolderReport[]) =>
  Object.fromEntries(folders.map(f => [f.path.join("/"), f.mailboxId]));

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let s: StalwartInstance;
  let client: JmapClient;
  let accountId: string;
  let profile: string;
  let created: Inspection;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    s = await startStalwart();
    ({ client, accountId } = await connect(s));
    ids.projects = await createMailbox(client, accountId, "Projects");
    ids.alpha = await createMailbox(client, accountId, "Alpha", ids.projects);
    ids.reports = await createMailbox(client, accountId, "Reports: Q3/Q4 ✓");
    // Stalwart refuses a second top-level "INBOX", so the look-alike lives under Projects.
    ids.fakeInbox = await createMailbox(client, accountId, "INBOX", ids.projects);
    profile = await createProfile({ xpi: TEST_XPI });
  });

  afterAll(async () => {
    await s?.stop();
  });

  const accountArgs = (secret = s.password) => ({
    email: "admin@example.com",
    sessionUrl: s.sessionUrl,
    username: s.username,
    secret,
    authKind: "basic",
  });

  test("create-account mirrors the mailboxes as folders", async () => {
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "create-account",
      args: accountArgs(),
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts).toHaveLength(1);
    const folders = r.accounts[0].folders;
    expect(folders.find(f => f.flags.includes("Inbox"))?.path).toEqual(["Inbox"]);
    expect(byPath(folders, "Projects")?.mailboxId).toBe(ids.projects);
    expect(byPath(folders, "Projects/Alpha")?.mailboxId).toBe(ids.alpha);
    expect(byPath(folders, "Reports: Q3/Q4 ✓")?.mailboxId).toBe(ids.reports);
    const fakeInbox = folders.find(f => f.mailboxId == ids.fakeInbox);
    expect(fakeInbox?.path).toEqual(["Projects", "INBOX"]);
    expect(fakeInbox?.flags).not.toContain("Inbox");
    expect(folders.every(f => f.mailboxId)).toBe(true);
    created = r;
  });

  test("the folders survive two restarts and the unavailable marker is cleared", async () => {
    for (const _ of [1, 2]) {
      const r = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: { noSync: true } });
      expect(r.ok, r.error).toBe(true);
      expect(r.accounts).toHaveLength(1);
      expect(tree(r.accounts[0].folders)).toEqual(tree(created.accounts[0].folders));
      expect(r.prefs.timeFoundUnavailable).toEqual([0]);
    }
  });

  test("server-side rename and deletion are mirrored, keeping folder ids", async () => {
    await renameMailbox(client, accountId, ids.projects, "Work");
    await destroyMailbox(client, accountId, ids.reports);
    const r = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: {} });
    expect(r.ok, r.error).toBe(true);
    const folders = r.accounts[0].folders;
    expect(byPath(folders, "Work")?.mailboxId).toBe(ids.projects);
    expect(byPath(folders, "Work/Alpha")?.mailboxId).toBe(ids.alpha);
    expect(byPath(folders, "Work/INBOX")?.mailboxId).toBe(ids.fakeInbox);
    expect(byPath(folders, "Projects")).toBeUndefined();
    expect(folders.find(f => f.mailboxId == ids.reports)).toBeUndefined();
  });

  test("the setup page creates an account", async () => {
    const fresh = await createProfile({ xpi: TEST_XPI, prefs: IN_PROCESS_PAGES });
    const r = await runScenario<{
      statusState: string;
      statusText: string;
      accounts: { accountKey: string; email: string; sessionUrl: string }[];
    }>({ version, profile: fresh, scenario: "setup-page", args: accountArgs() });
    expect(r.ok, r.error).toBe(true);
    expect(r.statusState, r.statusText).toBe("success");
    expect(r.statusText).toBe("Account added — your folders will appear in the folder pane.");
    expect(r.accounts).toEqual([
      expect.objectContaining({ email: "admin@example.com", sessionUrl: s.sessionUrl }),
    ]);
  });

  test("the setup page explains a rejected password", async () => {
    const fresh = await createProfile({ xpi: TEST_XPI, prefs: IN_PROCESS_PAGES });
    const r = await runScenario<{ statusState: string; statusText: string; accounts: unknown[] }>({
      version,
      profile: fresh,
      scenario: "setup-page",
      args: accountArgs("wrong-password"),
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.statusState).toBe("error");
    expect(r.statusText).toBe("The server rejected the email or password.");
    expect(r.accounts).toEqual([]);
  });

  test("a wrong password creates no account, server prefs or login", async () => {
    const fresh = await createProfile({ xpi: TEST_XPI });
    const r = await runScenario<Inspection>({
      version,
      profile: fresh,
      scenario: "create-account",
      args: accountArgs("wrong-password"),
    });
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe("JmapAuthError");
    const after = await runScenario<Inspection>({ version, profile: fresh, scenario: "inspect", args: { noSync: true } });
    expect(after.ok, after.error).toBe(true);
    expect(after.accounts).toHaveLength(0);
    expect(after.jmapServerPrefCount).toBe(0);
    expect(after.loginCount).toBe(0);
  });
});
