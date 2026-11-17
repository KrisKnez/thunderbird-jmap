/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, test, expect } from "vitest";
import { JmapClient, JmapNetworkError, type SetError } from "@thunderbird-jmap/jmap-client";
import { Outbox, type OutboxOp, type OutboxStorage } from "../src/index.js";

const SESSION = {
  capabilities: { "urn:ietf:params:jmap:core": { maxObjectsInSet: 500 }, "urn:ietf:params:jmap:mail": {} },
  accounts: { a: { name: "me", isPersonal: true, isReadOnly: false } },
  primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
  username: "me",
  apiUrl: "/jmap/",
  downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  uploadUrl: "/jmap/upload/{accountId}/",
  eventSourceUrl: "/jmap/eventsource/",
  state: "s",
};

let calls: { name: string; args: any }[];
let refuse: Record<string, SetError>;
let networkDown: boolean;
let client: JmapClient;

beforeEach(() => {
  calls = [];
  refuse = {};
  networkDown = false;
  const fetch = async (url: string, init?: RequestInit) => {
    const reply = (body: unknown) =>
      Object.defineProperty(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }), "url", { value: url });
    if (url.endsWith("/jmap/session")) return reply(SESSION);
    if (networkDown) throw new TypeError("connection refused");
    if (url.includes("/jmap/upload/")) return reply({ accountId: "a", blobId: "blob1", type: "message/rfc822", size: 3 });
    const body = JSON.parse(String(init!.body));
    return reply({
      methodResponses: body.methodCalls.map(([name, args, id]: [string, any, string]) => {
        calls.push({ name, args });
        if (name == "Email/import") {
          return [name, { created: { draft: { id: "new1", blobId: "blob1", threadId: "t1" } } }, id];
        }
        const ids = [...Object.keys(args.update ?? {}), ...(args.destroy ?? [])];
        const bad = ids.filter(e => refuse[e]);
        return [
          name,
          {
            newState: "n",
            updated: Object.fromEntries(Object.keys(args.update ?? {}).filter(e => !refuse[e]).map(e => [e, null])),
            destroyed: (args.destroy ?? []).filter((e: string) => !refuse[e]),
            notUpdated: Object.fromEntries(bad.filter(e => args.update?.[e]).map(e => [e, refuse[e]])),
            notDestroyed: Object.fromEntries(bad.filter(e => args.destroy?.includes(e)).map(e => [e, refuse[e]])),
          },
          id,
        ];
      }),
      sessionState: "s",
    });
  };
  client = new JmapClient({ sessionUrl: "https://h.test/jmap/session", credentials: { kind: "basic", username: "me", password: "p" }, fetch });
});

function memoryStorage(): OutboxStorage & { saved: OutboxOp[] } {
  const storage = {
    saved: [] as OutboxOp[],
    async load() {
      return structuredClone(storage.saved);
    },
    async save(ops: OutboxOp[]) {
      storage.saved = structuredClone(ops);
    },
  };
  return storage;
}

function outbox(o: { storage?: OutboxStorage; batchSize?: number } = {}) {
  const applied: OutboxOp[] = [];
  const refused: [OutboxOp, SetError][] = [];
  const imported: unknown[] = [];
  const ob = new Outbox({
    client,
    accountId: "a",
    storage: o.storage ?? memoryStorage(),
    batchSize: o.batchSize,
    hooks: {
      async readDraft() {
        return new TextEncoder().encode("From: me@x\r\n\r\ndraft\r\n");
      },
      async onApplied(op, created) {
        applied.push(op);
        if (created) imported.push(created);
      },
      async onRefused(op, error) {
        refused.push([op, error]);
      },
    },
  });
  return { ob, applied, refused, imported };
}

const kw = (emailId: string, patch: Record<string, true | null>): OutboxOp => ({ kind: "keywords", emailId, patch });
const setCalls = () => calls.filter(c => c.name == "Email/set").map(c => ({ update: c.args.update, destroy: c.args.destroy }));

describe("Outbox", () => {
  test("read → unread → read before a flush sends one patch ending read", async () => {
    const { ob } = outbox();
    await ob.enqueue(kw("e1", { "keywords/$seen": true }));
    await ob.enqueue(kw("e1", { "keywords/$seen": null }));
    await ob.enqueue(kw("e1", { "keywords/$seen": true }));
    expect(ob.size).toBe(1);
    await ob.flush();
    expect(setCalls()).toEqual([{ update: { e1: { "keywords/$seen": true } }, destroy: undefined }]);
    expect(ob.size).toBe(0);
  });

  test("30 updates with batchSize 10 go out as three Email/set calls", async () => {
    const { ob, applied } = outbox({ batchSize: 10 });
    for (let i = 0; i < 30; i++) await ob.enqueue(kw(`e${i}`, { "keywords/$seen": true }));
    expect(await ob.flush()).toEqual({ applied: 30, refused: 0 });
    expect(setCalls().map(c => Object.keys(c.update).length)).toEqual([10, 10, 10]);
    expect(applied).toHaveLength(30);
  });

  test("a network failure keeps every op, and a restart with the same storage still has them", async () => {
    const storage = memoryStorage();
    const { ob } = outbox({ storage });
    await ob.enqueue(kw("e1", { "keywords/$seen": true }));
    await ob.enqueue({ kind: "move", emailId: "e2", fromMailboxId: "m1", toMailboxId: "m2" });
    await ob.enqueue({ kind: "destroy", emailId: "e3" });
    networkDown = true;
    await expect(ob.flush()).rejects.toBeInstanceOf(JmapNetworkError);
    expect(ob.size).toBe(3);
    const again = outbox({ storage }).ob;
    await again.load();
    expect(again.size).toBe(3);
    expect([...again.pendingEmailIds()].sort()).toEqual(["e1", "e2", "e3"]);
  });

  test("a refused op is dropped and reported; the others are applied", async () => {
    refuse.e2 = { type: "invalidProperties", description: "A message belongs to exactly one mailbox" };
    const { ob, applied, refused } = outbox();
    await ob.enqueue(kw("e1", { "keywords/$flagged": true }));
    await ob.enqueue({ kind: "move", emailId: "e2", fromMailboxId: "m1", toMailboxId: "m2" });
    expect(await ob.flush()).toEqual({ applied: 1, refused: 1 });
    expect(refused.map(([op, e]) => [(op as any).emailId, e.description])).toEqual([["e2", "A message belongs to exactly one mailbox"]]);
    expect(applied.map(op => (op as any).emailId)).toEqual(["e1"]);
    expect(ob.size).toBe(0);
  });

  test("destroy after keyword changes sends only the destroy", async () => {
    const { ob } = outbox();
    await ob.enqueue(kw("e1", { "keywords/$seen": true }));
    await ob.enqueue({ kind: "move", emailId: "e1", fromMailboxId: "m1", toMailboxId: "m2" });
    await ob.enqueue({ kind: "destroy", emailId: "e1" });
    await ob.flush();
    expect(setCalls()).toEqual([{ update: undefined, destroy: ["e1"] }]);
  });

  test("moves chain into one patch, mailbox ids are escaped, and a move back cancels out", async () => {
    const { ob } = outbox();
    await ob.enqueue({ kind: "move", emailId: "e1", fromMailboxId: "mbx_A~inbox", toMailboxId: "mbx_A~archive" });
    await ob.enqueue({ kind: "move", emailId: "e1", fromMailboxId: "mbx_A~archive", toMailboxId: "mbx_A~trash" });
    await ob.enqueue({ kind: "move", emailId: "e2", fromMailboxId: "m1", toMailboxId: "m2" });
    await ob.enqueue({ kind: "move", emailId: "e2", fromMailboxId: "m2", toMailboxId: "m1" });
    expect(ob.size).toBe(1);
    await ob.flush();
    expect(setCalls()).toEqual([
      { update: { e1: { "mailboxIds/mbx_A~0inbox": null, "mailboxIds/mbx_A~0trash": true } }, destroy: undefined },
    ]);
  });

  test("keyword changes and a move for one email go out in one patch", async () => {
    const { ob } = outbox();
    await ob.enqueue(kw("e1", { "keywords/$seen": true }));
    await ob.enqueue({ kind: "removeMailbox", emailId: "e1", mailboxId: "m1" });
    await ob.flush();
    expect(setCalls()).toEqual([{ update: { e1: { "keywords/$seen": true, "mailboxIds/m1": null } }, destroy: undefined }]);
  });

  test("a draft is uploaded and imported into its mailbox, and the hook gets the new email", async () => {
    const { ob, imported } = outbox();
    await ob.enqueue({ kind: "importDraft", mailboxId: "mbx_A~drafts", localKey: 7, keywords: ["$draft", "$seen"] });
    expect(ob.pendingEmailIds().size).toBe(0);
    await ob.flush();
    const imp = calls.find(c => c.name == "Email/import")!;
    expect(imp.args.emails.draft).toEqual({ blobId: "blob1", mailboxIds: { "mbx_A~drafts": true }, keywords: { $draft: true, $seen: true } });
    expect(imported).toEqual([{ id: "new1", blobId: "blob1", threadId: "t1" }]);
  });
});
