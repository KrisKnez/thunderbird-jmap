/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local changes (read, flagged, tags, junk) reaching the server, from every
// path Thunderbird has, on Stalwart (standard) and a local Mailflare (keeps
// only $seen and $flagged).

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
import type { Inspection, MessageReport } from "./harness/types.js";

type Kind = "stalwart" | "mailflare";
interface ChangeResult extends Inspection {
  queued: number;
  stats: { applied: number; refused: number };
}

const PATHS: [path: string, subject: string, keyword: string][] = [
  ["folder-read", "W1", "$seen"],
  ["hdr-read", "W2", "$seen"],
  ["view-toggle-read", "W3", "$seen"],
  ["thread-read", "W4", "$seen"],
  ["select-auto-read", "W5", "$seen"],
  ["folder-flag", "W6", "$flagged"],
  ["add-tag", "W7", "work"],
  ["view-junk", "W8", "$junk"],
];
/** Mailflare keeps only $seen and $flagged. */
const keeps = (kind: Kind, keyword: string) => kind == "stalwart" || keyword == "$seen" || keyword == "$flagged";

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  describe.each<Kind>(["stalwart", "mailflare"])("%s", kind => {
    let stalwart: StalwartInstance | undefined;
    let mailflare: MailflareInstance | undefined;
    let client: JmapClient;
    let accountId: string;
    let profile: string;
    let folderPath: string[];
    const ids: Record<string, string> = {};

    const keywordsOf = async (id: string) => {
      const { list } = await emailGet(client, accountId, [id], ["keywords"]);
      return Object.keys(list[0].keywords).map(k => k.toLowerCase());
    };
    const patchOnServer = (id: string, patch: Record<string, true | null>) =>
      client.call("Email/set", { accountId, update: { [id]: patch } });
    const inFolder = (r: Inspection, subject: string): MessageReport =>
      r.accounts[0].messages[folderPath.join("/")].find(m => m.subject == subject)!;

    beforeAll(async () => {
      if (kind == "stalwart") {
        stalwart = await startStalwart();
        ({ client, accountId } = await connect(stalwart));
        const inbox = await mailboxIdByRole(client, accountId, "inbox");
        for (const [, subject] of PATHS) {
          ids[subject] = await importEmail(client, accountId, { mailboxIds: [inbox], subject, body: subject });
        }
        const bulk = await createMailbox(client, accountId, "Bulk");
        for (let i = 1; i <= 30; i++) {
          ids[`B${i}`] = await importEmail(client, accountId, { mailboxIds: [bulk], subject: `B${i}`, body: "b" });
        }
        folderPath = ["Inbox"];
      } else {
        mailflare = await startMailflare({ localParts: ["me"] });
        ({ client, accountId } = await connect(mailflare));
        for (const [, subject] of PATHS) {
          await mailflare.deliver({ from: "out@sender.test", to: "me@example.test", subject, body: subject });
        }
        const { ids: all } = await client.call<{ ids: string[] }>("Email/query", { accountId, limit: 100 });
        for (const e of (await emailGet(client, accountId, all, ["subject"])).list) {
          ids[e.subject!] = e.id;
        }
        folderPath = ["me <me@example.test>", "Inbox"];
      }
      profile = await createProfile({
        xpi: TEST_XPI,
        prefs: { "extensions.thunderbird-jmap.outboxBatchSize": 10 },
      });
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

    test("every change path reaches the server (Mailflare keeps tags and junk local)", async () => {
      const r = await runScenario<ChangeResult>({
        version,
        profile,
        scenario: "change-all",
        args: { folderPath, changes: PATHS.map(([path, subject]) => ({ path, subject })) },
      });
      expect(r.ok, r.error).toBe(true);
      expect(r.accounts[0].lastSyncError).toBeNull();
      expect(r.queued).toBe(0);
      for (const [path, subject, keyword] of PATHS) {
        const onServer = await keywordsOf(ids[subject]);
        if (keeps(kind, keyword)) {
          expect(onServer, `${path} → ${keyword}`).toContain(keyword);
        } else {
          expect(onServer, `${path}: Mailflare drops ${keyword}`).not.toContain(keyword);
          expect(inFolder(r, subject).localOnly, `${path}: ${keyword} is local-only`).toContain(keyword);
        }
      }
      expect(inFolder(r, "W7").tags).toEqual(["work"]);
      expect(inFolder(r, "W8").junk).toBe(true);
    });

    test("a change made by another client reaches Thunderbird and is not sent back", async () => {
      await patchOnServer(ids.W1, { "keywords/$flagged": true });
      const r = await runScenario<ChangeResult>({ version, profile, scenario: "outbox-state", args: { sync: true } });
      expect(r.ok, r.error).toBe(true);
      expect(inFolder(r, "W1").flagged).toBe(true);
      expect(r.queued).toBe(0);
      expect(r.stats).toEqual({ applied: 0, refused: 0 });
    });

    test("tags: Mailflare's stay after the next sync; Stalwart's follow another client's removal", async () => {
      if (kind == "stalwart") {
        await patchOnServer(ids.W7, { "keywords/work": null });
      }
      const r = await runScenario<ChangeResult>({ version, profile, scenario: "outbox-state", args: { sync: true } });
      expect(r.ok, r.error).toBe(true);
      expect(inFolder(r, "W7").tags).toEqual(kind == "stalwart" ? [] : ["work"]);
      expect(r.stats).toEqual({ applied: 0, refused: 0 });
    });

    test("changes made while the server is down are sent once it is back, after a restart (Mailflare)", async () => {
      // Mailflare keeps its data across a container restart; this Stalwart does not.
      if (kind != "mailflare") return;
      await mailflare!.down();
      try {
        const offline = await runScenario<ChangeResult>({
          version,
          profile,
          scenario: "change-all",
          args: { folderPath, changes: [{ path: "folder-flag", subject: "W7" }, { path: "folder-read", subject: "W8" }] },
        });
        expect(offline.ok, offline.error).toBe(true);
        expect(offline.queued).toBeGreaterThan(0);
        expect(offline.accounts[0].lastSyncError).toBe("JmapNetworkError");
      } finally {
        await mailflare!.up();
      }
      expect(await keywordsOf(ids.W7)).not.toContain("$flagged");
      const back = await runScenario<ChangeResult>({ version, profile, scenario: "outbox-state", args: { sync: true } });
      expect(back.ok, back.error).toBe(true);
      expect(back.queued).toBe(0);
      expect(await keywordsOf(ids.W7)).toContain("$flagged");
      expect(await keywordsOf(ids.W8)).toContain("$seen");
    });

    test("marking 30 messages read with batch size 10 reaches the server for all 30 (Stalwart)", async () => {
      if (kind != "stalwart") return;
      const r = await runScenario<ChangeResult>({
        version,
        profile,
        scenario: "change-all",
        args: { folderPath: ["Bulk"], changes: [{ path: "folder-read-all", subject: "" }] },
      });
      expect(r.ok, r.error).toBe(true);
      expect(r.queued).toBe(0);
      expect(r.stats.applied).toBe(30);
      const { list } = await emailGet(client, accountId, Array.from({ length: 30 }, (_, i) => ids[`B${i + 1}`]), ["keywords"]);
      expect(list.filter(e => e.keywords.$seen)).toHaveLength(30);
    });
  });
});
