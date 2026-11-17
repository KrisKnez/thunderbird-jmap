/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Drafts saved in Thunderbird reach the server, on Stalwart and a local
// Mailflare (which only creates new messages in Drafts mailboxes).

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import { emailGet, type JmapClient } from "@thunderbird-jmap/jmap-client";
import {
  connect,
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
interface SaveResult extends Inspection {
  status: number;
  queued: number;
  notices: string[];
}

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  describe.each<Kind>(["stalwart", "mailflare"])("%s", kind => {
    let stalwart: StalwartInstance | undefined;
    let mailflare: MailflareInstance | undefined;
    let client: JmapClient;
    let accountId: string;
    let profile: string;
    let drafts: string;
    let draftsPath: string[];
    let from: string;

    /** Subjects and keywords of the emails in the server's Drafts mailbox. */
    const serverDrafts = async () => {
      const { ids } = await client.call<{ ids: string[] }>("Email/query", { accountId, filter: { inMailbox: drafts }, limit: 100 });
      if (!ids.length) return [];
      const { list } = await emailGet(client, accountId, ids, ["subject", "keywords"]);
      return list.map(e => ({ subject: e.subject, draft: !!e.keywords.$draft })).sort((a, b) => (a.subject! < b.subject! ? -1 : 1));
    };
    const save = (args: Record<string, unknown>) =>
      runScenario<SaveResult>({ version, profile, scenario: "save-draft", args: { from, to: "to@dest.test", ...args } });
    const localDrafts = (r: Inspection) => r.accounts[0].messages[draftsPath.join("/")] ?? [];

    beforeAll(async () => {
      if (kind == "stalwart") {
        stalwart = await startStalwart();
        ({ client, accountId } = await connect(stalwart));
        drafts = await mailboxIdByRole(client, accountId, "drafts");
        draftsPath = ["Drafts"];
        from = "admin@example.com";
      } else {
        mailflare = await startMailflare({ localParts: ["me"] });
        ({ client, accountId } = await connect(mailflare));
        const { list } = await client.call<{ list: { id: string; name: string; role: string | null; parentId: string | null }[] }>(
          "Mailbox/get",
          { accountId }
        );
        const root = list.find(m => !m.parentId)!;
        drafts = list.find(m => m.parentId == root.id && m.role == "drafts")!.id;
        draftsPath = [root.name, "Drafts"];
        from = "me@example.test";
      }
      profile = await createProfile({ xpi: TEST_XPI });
      const server = stalwart ?? mailflare!;
      const created = await runScenario<Inspection>({
        version,
        profile,
        scenario: "create-account",
        args: { email: from, sessionUrl: server.sessionUrl, username: server.username, secret: server.password, authKind: "basic" },
      });
      expect(created.ok, created.error).toBe(true);
    }, 900_000);

    afterAll(async () => {
      await stalwart?.stop();
      await mailflare?.stop();
    });

    test("saving a draft puts it in the identity's Drafts on the server", async () => {
      const r = await save({ subject: "Draft one" });
      expect(r.ok, r.error).toBe(true);
      expect(r.status).toBe(0);
      expect(r.queued).toBe(0);
      expect(await serverDrafts()).toEqual([{ subject: "Draft one", draft: true }]);
      const local = localDrafts(r).filter(m => m.subject == "Draft one");
      expect(local).toHaveLength(1);
      expect(local[0].jmapId).toBeTruthy();
    });

    test("saving the draft again replaces it: one draft on the server", async () => {
      const r = await save({ subject: "Draft one, edited", replace: "Draft one" });
      expect(r.ok, r.error).toBe(true);
      expect(r.status).toBe(0);
      expect(await serverDrafts()).toEqual([{ subject: "Draft one, edited", draft: true }]);
      expect(localDrafts(r).map(m => m.subject)).toEqual(["Draft one, edited"]);
    });

    test("on Mailflare a message saved outside Drafts is refused with a notice and leaves nothing behind", async () => {
      if (kind != "mailflare") return;
      const archive = [draftsPath[0], "Archive"];
      const r = await save({ subject: "Template one", intoFolder: archive });
      expect(r.ok, r.error).toBe(true);
      expect(r.notices).toEqual([
        expect.stringMatching(/^me@example\.test: The server refused a change to “Template one”: New messages can only be created in a Drafts mailbox\. It now shows as it is on the server\.$/),
      ]);
      expect(r.accounts[0].messages[archive.join("/")] ?? []).toEqual([]);
    });

    test("a draft saved while the server is down reaches the server after a restart (Mailflare)", async () => {
      if (kind != "mailflare") return;
      await mailflare!.down();
      try {
        const r = await save({ subject: "Offline draft" });
        expect(r.ok, r.error).toBe(true);
        expect(r.queued).toBeGreaterThan(0);
        expect(localDrafts(r).map(m => m.subject)).toContain("Offline draft");
      } finally {
        await mailflare!.up();
      }
      const back = await runScenario<SaveResult>({ version, profile, scenario: "outbox-state", args: { sync: true } });
      expect(back.ok, back.error).toBe(true);
      expect(back.queued).toBe(0);
      expect((await serverDrafts()).map(d => d.subject)).toContain("Offline draft");
    });
  });
});
