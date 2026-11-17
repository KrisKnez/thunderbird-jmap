/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  createMailbox,
  importEmail,
  setKeywords,
  moveEmail,
  destroyEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import type { JmapClient } from "@thunderbird-jmap/jmap-client";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { AccountReport, Inspection, MessageReport } from "./harness/types.js";

const folder = (a: AccountReport, mailboxId: string) => a.folders.find(f => f.mailboxId == mailboxId)!;
const messages = (a: AccountReport, mailboxId: string): MessageReport[] =>
  a.messages[folder(a, mailboxId).path.join("/")] ?? [];
const bySubject = (list: MessageReport[], subject: string) => list.find(m => m.subject == subject);
const missingFromPane = (a: AccountReport) => a.folders.filter(f => !f.inPane).map(f => f.path.join("/"));

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let s: StalwartInstance;
  let client: JmapClient;
  let accountId: string;
  let profile: string;
  let inbox: string;
  let alpha: string;
  let misc: string;
  const ids: Record<string, string> = {};
  let afterDelta: Inspection;

  beforeAll(async () => {
    s = await startStalwart();
    ({ client, accountId } = await connect(s));
    inbox = await mailboxIdByRole(client, accountId, "inbox");
    alpha = await createMailbox(client, accountId, "Alpha");
    misc = await createMailbox(client, accountId, "Misc");
    for (const n of [1, 2]) {
      await importEmail(client, accountId, { mailboxIds: [misc], subject: `No id ${n}`, body: `n${n}`, messageId: null });
    }
    ids.a = await importEmail(client, accountId, {
      mailboxIds: [inbox],
      keywords: ["$seen", "$flagged"],
      subject: "Seen and flagged",
      body: "a",
    });
    ids.b = await importEmail(client, accountId, {
      mailboxIds: [inbox],
      keywords: ["Work"],
      subject: "Tagged work",
      body: "b",
    });
    ids.z = await importEmail(client, accountId, {
      mailboxIds: [alpha],
      from: "Žana Šimić <zana@example.com>",
      subject: "Привет, мир",
      body: "z",
    });
    profile = await createProfile({ xpi: TEST_XPI });
  });

  afterAll(async () => {
    await s?.stop();
  });

  test("create-account brings in headers with flags, tags and counts", async () => {
    const r = await runScenario<Inspection>({
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
    expect(r.ok, r.error).toBe(true);
    const account = r.accounts[0];
    const inboxMessages = messages(account, inbox);
    expect(bySubject(inboxMessages, "Seen and flagged")).toMatchObject({ read: true, flagged: true, jmapId: ids.a });
    expect(bySubject(inboxMessages, "Tagged work")).toMatchObject({ read: false, flagged: false, tags: ["work"] });
    expect(folder(account, inbox)).toMatchObject({ total: 2, unread: 1 });
    expect(missingFromPane(account), "folders created while the window is open must show").toEqual([]);
    // Without a Message-ID, each message still gets its own, so search and
    // threading never take two of them for one.
    const noId = messages(account, misc).map(m => m.messageId);
    expect(noId).toHaveLength(2);
    expect(noId.every(Boolean)).toBe(true);
    expect(new Set(noId).size).toBe(2);
  });

  test("non-ASCII senders and subjects are stored correctly", async () => {
    const r = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: { noSync: true } });
    expect(r.ok, r.error).toBe(true);
    expect(missingFromPane(r.accounts[0]), "folders must show after a restart").toEqual([]);
    const z = bySubject(messages(r.accounts[0], alpha), "Привет, мир");
    expect(z?.author).toBe("Žana Šimić <zana@example.com>");
  });

  test("server changes between runs are applied: read, move, new mail in two mailboxes, delete", async () => {
    await setKeywords(client, accountId, ids.b, ["$seen", "Work", "$junk"]);
    await moveEmail(client, accountId, ids.a, [alpha]);
    ids.c = await importEmail(client, accountId, { mailboxIds: [inbox, alpha], subject: "In both", body: "c" });
    await destroyEmail(client, accountId, ids.z);

    const r = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: {} });
    expect(r.ok, r.error).toBe(true);
    const account = r.accounts[0];
    expect(account.lastSyncError).toBeNull();
    const inboxMessages = messages(account, inbox);
    const alphaMessages = messages(account, alpha);
    expect(inboxMessages.map(m => m.subject).sort()).toEqual(["In both", "Tagged work"]);
    expect(alphaMessages.map(m => m.subject).sort()).toEqual(["In both", "Seen and flagged"]);
    expect(bySubject(inboxMessages, "Tagged work")).toMatchObject({ read: true, tags: ["work"], junk: true });
    expect(folder(account, inbox)).toMatchObject({ total: 2, unread: 1 });
    expect(folder(account, alpha)).toMatchObject({ total: 2, unread: 1 });
    afterDelta = r;
  });

  test("a folder whose database was lost (.msf deleted) gets its mail back", async () => {
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "lose-folder-db",
      args: { folderPath: ["Inbox"] },
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts[0].messages).toEqual(afterDelta.accounts[0].messages);
    expect(folder(r.accounts[0], inbox)).toMatchObject({ total: 2, unread: 1 });
  });

  test("a folder whose database is lost while a sync is running also gets its mail back", async () => {
    const r = await runScenario<Inspection>({
      version,
      profile,
      scenario: "lose-folder-db",
      args: { folderPath: ["Alpha"], duringSync: true },
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.accounts[0].messages).toEqual(afterDelta.accounts[0].messages);
    expect(folder(r.accounts[0], alpha)).toMatchObject({ total: 2, unread: 1 });
  });

  test("with the server down, the account still loads its local mail and records the error", async () => {
    await s.stop();
    const r = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: {} });
    expect(r.ok, r.error).toBe(true);
    const account = r.accounts[0];
    expect(account.lastSyncError).toBe("JmapNetworkError");
    expect(account.folders).toEqual(afterDelta.accounts[0].folders);
    expect(account.messages).toEqual(afterDelta.accounts[0].messages);
  });
});
