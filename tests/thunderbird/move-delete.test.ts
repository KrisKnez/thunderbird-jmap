/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Moving and deleting messages, on Stalwart and a local Mailflare (one
// folder per message, one folder tree per address).

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import { emailGet, type JmapClient } from "@thunderbird-jmap/jmap-client";
import {
  connect,
  createMailbox,
  importEmail,
  mailboxIdByRole,
  startMailflare,
  startStalwart,
  type MailflareInstance,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

type Kind = "stalwart" | "mailflare";
interface OpResult extends Inspection {
  queued: number;
  stats: { applied: number; refused: number };
  notices: string[];
  stopCopy?: number | null;
  copyError?: string;
  localCopies?: string[];
}
const SUBJECTS = ["M1", "D1", "D2", "C1", "X1", "T1", "T2", "A1", "L1"];

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  describe.each<Kind>(["stalwart", "mailflare"])("%s", kind => {
    let stalwart: StalwartInstance | undefined;
    let mailflare: MailflareInstance | undefined;
    let client: JmapClient;
    let accountId: string;
    let profile: string;
    const ids: Record<string, string> = {};
    const box: Record<string, string> = {}; // role or name → mailbox id
    const path: Record<string, string[]> = {}; // role or name → local folder path

    /** Mailbox ids the server has the email in ([] if it is gone). */
    const mailboxesOf = async (id: string) => {
      const { list } = await emailGet(client, accountId, [id], ["mailboxIds"]);
      return list.length ? Object.keys(list[0].mailboxIds).sort() : [];
    };
    const op = (args: Record<string, unknown>) => runScenario<OpResult>({ version, profile, scenario: "folder-op", args });
    const subjectsIn = (r: Inspection, folder: string[]) => (r.accounts[0].messages[folder.join("/")] ?? []).map(m => m.subject).sort();

    beforeAll(async () => {
      if (kind == "stalwart") {
        stalwart = await startStalwart();
        ({ client, accountId } = await connect(stalwart));
        box.inbox = await mailboxIdByRole(client, accountId, "inbox");
        box.trash = await mailboxIdByRole(client, accountId, "trash");
        box.alpha = await createMailbox(client, accountId, "Alpha");
        box.old = await createMailbox(client, accountId, "Old");
        for (const subject of SUBJECTS) {
          ids[subject] = await importEmail(client, accountId, { mailboxIds: [box.inbox], subject, body: subject });
        }
        ids.TWO = await importEmail(client, accountId, { mailboxIds: [box.inbox, box.alpha], subject: "TWO", body: "two" });
        ids.TWO2 = await importEmail(client, accountId, { mailboxIds: [box.inbox, box.alpha], subject: "TWO2", body: "two" });
        for (const [n, minutes] of [[1, 1], [2, 2], [3, 3]]) {
          ids[`OLD${n}`] = await importEmail(client, accountId, {
            mailboxIds: [box.old],
            subject: `OLD${n}`,
            body: "o",
            date: new Date(Date.UTC(2026, 0, 1, 9, minutes)),
          });
        }
        Object.assign(path, { inbox: ["Inbox"], trash: ["Deleted Items"], target: ["Alpha"], old: ["Old"] });
        box.target = box.alpha;
      } else {
        mailflare = await startMailflare();
        ({ client, accountId } = await connect(mailflare));
        for (const subject of SUBJECTS) {
          await mailflare.deliver({ from: "out@sender.test", to: "me@example.test", subject, body: subject });
        }
        await mailflare.deliver({ from: "out@sender.test", to: "hello@example.test", subject: "H1", body: "h" });
        const { ids: all } = await client.call<{ ids: string[] }>("Email/query", { accountId, limit: 100 });
        for (const e of (await emailGet(client, accountId, all, ["subject"])).list) {
          ids[e.subject!] = e.id;
        }
        const { list } = await client.call<{ list: { id: string; name: string; role: string | null; parentId: string | null }[] }>(
          "Mailbox/get",
          { accountId }
        );
        const root = (address: string) => list.find(m => !m.parentId && m.name.includes(`<${address}>`))!;
        const me = root("me@example.test");
        const hello = root("hello@example.test");
        const role = (parent: string, r: string) => list.find(m => m.parentId == parent && m.role == r)!.id;
        Object.assign(box, {
          inbox: role(me.id, "inbox"),
          trash: role(me.id, "trash"),
          target: role(me.id, "archive"),
          otherTree: role(hello.id, "archive"),
        });
        Object.assign(path, {
          inbox: [me.name, "Inbox"],
          trash: [me.name, "Trash"],
          target: [me.name, "Archive"],
          otherTree: [hello.name, "Archive"],
        });
      }
      profile = await createProfile({ xpi: TEST_XPI });
      const server = stalwart ?? mailflare!;
      const created = await runScenario<Inspection>({
        version,
        profile,
        scenario: "create-account",
        args: {
          email: kind == "stalwart" ? "admin@example.com" : "me@example.test",
          sessionUrl: server.sessionUrl,
          username: server.username,
          secret: server.password,
          authKind: "basic",
        },
      });
      expect(created.ok, created.error).toBe(true);
    }, 900_000);

    afterAll(async () => {
      await stalwart?.stop();
      await mailflare?.stop();
    });

    test("moving a message to another folder moves it on the server", async () => {
      const r = await op({ op: "move", folderPath: path.inbox, toPath: path.target, subject: "M1" });
      expect(r.ok, r.error).toBe(true);
      expect(r.queued).toBe(0);
      expect(await mailboxesOf(ids.M1)).toEqual([box.target]);
      expect(subjectsIn(r, path.target)).toContain("M1");
      expect(subjectsIn(r, path.inbox)).not.toContain("M1");
    });

    test("Delete moves to Trash; Delete in Trash and Shift+Delete destroy", async () => {
      const toTrash = await op({ op: "delete", folderPath: path.inbox, subject: "D1" });
      expect(toTrash.ok, toTrash.error).toBe(true);
      expect(await mailboxesOf(ids.D1)).toEqual([box.trash]);
      expect(subjectsIn(toTrash, path.trash)).toContain("D1");

      const fromTrash = await op({ op: "delete", folderPath: path.trash, subject: "D1" });
      expect(fromTrash.ok, fromTrash.error).toBe(true);
      expect(await mailboxesOf(ids.D1)).toEqual([]);

      const shift = await op({ op: "delete-storage", folderPath: path.inbox, subject: "D2" });
      expect(shift.ok, shift.error).toBe(true);
      if (kind == "stalwart") {
        expect(await mailboxesOf(ids.D2)).toEqual([]);
        expect(subjectsIn(shift, path.trash)).not.toContain("D2");
      } else {
        // Mailflare's rule: a destroy outside Trash moves to Trash; only a
        // second one deletes. The server's state shows after the sync.
        expect(await mailboxesOf(ids.D2)).toEqual([box.trash]);
        expect(subjectsIn(shift, path.trash)).toContain("D2");
      }
    });

    test("deleting one copy of an email in two mailboxes removes only that mailbox (Stalwart)", async () => {
      if (kind != "stalwart") return;
      const r = await op({ op: "delete", folderPath: path.inbox, subject: "TWO" });
      expect(r.ok, r.error).toBe(true);
      expect(await mailboxesOf(ids.TWO)).toEqual([box.alpha]);
      expect(subjectsIn(r, path.trash)).not.toContain("TWO");
    });

    test("Empty Trash deletes on the server", async () => {
      const del = await op({ op: "delete", folderPath: path.inbox, subject: "C1" });
      expect(del.ok, del.error).toBe(true);
      expect(await mailboxesOf(ids.C1)).toEqual([box.trash]);
      const emptied = await op({ op: "empty-trash", folderPath: path.trash });
      expect(emptied.ok, emptied.error).toBe(true);
      expect(await mailboxesOf(ids.C1)).toEqual([]);
      expect(subjectsIn(emptied, path.trash)).not.toContain("C1");
    });

    test("a retention policy deletes on the server (Stalwart)", async () => {
      if (kind != "stalwart") return;
      const r = await op({ op: "retention", folderPath: path.old, keep: 1 });
      expect(r.ok, r.error).toBe(true);
      // Which one Thunderbird keeps differs (153/158 prune by message order,
      // 160 by date); what it deletes must be gone from the server too.
      const kept = subjectsIn(r, path.old);
      expect(kept).toHaveLength(1);
      for (const subject of ["OLD1", "OLD2", "OLD3"]) {
        expect(await mailboxesOf(ids[subject]), subject).toEqual(kept.includes(subject) ? [box.old] : []);
      }
    });

    test("on Mailflare a move between the two address trees is undone and reported", async () => {
      if (kind != "mailflare") return;
      const r = await op({ op: "move", folderPath: path.inbox, toPath: path.otherTree, subject: "X1" });
      expect(r.ok, r.error).toBe(true);
      expect(r.notices).toEqual([
        expect.stringMatching(
          /^me@example\.test: The server refused a change to “.+”: Messages cannot move between accounts' mailboxes\. It now shows as it is on the server\.$/
        ),
      ]);
      expect(subjectsIn(r, path.otherTree)).toEqual([]);
      expect(subjectsIn(r, path.inbox)).toContain("X1");
      expect(await mailboxesOf(ids.X1)).toEqual([box.inbox]);
    });

    test("copying a message is refused with a notice and changes nothing", async () => {
      const r = await op({ op: "copy", folderPath: path.target, toPath: path.inbox, subject: "M1" });
      expect(r.ok, r.error).toBe(true);
      expect(r.notices.some(n => n.endsWith("Copying messages isn't available for JMAP accounts yet."))).toBe(true);
      expect(await mailboxesOf(ids.M1)).toEqual([box.target]);
      expect(subjectsIn(r, path.inbox)).not.toContain("M1");
    });

    test("two Deletes in a row in the message list both reach the server", async () => {
      const r = await op({ op: "delete-twice", folderPath: path.inbox, subjects: ["T1", "T2"] });
      expect(r.ok, r.error).toBe(true);
      expect(await mailboxesOf(ids.T1)).toEqual([box.trash]);
      expect(await mailboxesOf(ids.T2)).toEqual([box.trash]);
      expect(subjectsIn(r, path.inbox)).not.toContain("T2");
    });

    test("an add-on deleting a message is told when it is done", async () => {
      const r = await op({ op: "delete-api", folderPath: path.inbox, subject: "A1" });
      expect(r.ok, r.error).toBe(true);
      expect(r.stopCopy).toBe(0);
      expect(await mailboxesOf(ids.A1)).toEqual([box.trash]);
    });

    test("moving a message to Local Folders fails and leaves it in the account and on the server", async () => {
      // Copying out is not supported (the message service has no copyMessage):
      // the copy fails at once, so this folder is never asked to delete it.
      const r = await op({ op: "move", folderPath: path.inbox, toLocal: "Saved", subject: "L1" });
      expect(r.ok, r.error).toBe(true);
      expect(r.copyError).toBeTruthy();
      expect(r.localCopies).toEqual([]);
      expect(subjectsIn(r, path.inbox)).toContain("L1");
      expect(await mailboxesOf(ids.L1)).toEqual([box.inbox]);
    });

    test("Shift+Delete of one copy of an email in two mailboxes keeps the other (Stalwart)", async () => {
      if (kind != "stalwart") return;
      const r = await op({ op: "delete-storage", folderPath: path.inbox, subject: "TWO2" });
      expect(r.ok, r.error).toBe(true);
      expect(await mailboxesOf(ids.TWO2)).toEqual([box.alpha]);
      expect(subjectsIn(r, path.inbox)).not.toContain("TWO2");
    });
  });
});
