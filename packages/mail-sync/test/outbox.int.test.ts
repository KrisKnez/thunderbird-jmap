/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  createMailbox,
  importEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import { emailGet, type JmapClient } from "@thunderbird-jmap/jmap-client";
import { Outbox, type OutboxOp } from "../src/index.js";

let s: StalwartInstance;
let client: JmapClient;
let accountId: string;
let inbox: string;

beforeEach(async () => {
  s = await startStalwart();
  ({ client, accountId } = await connect(s));
  inbox = await mailboxIdByRole(client, accountId, "inbox");
}, 90_000);

afterEach(async () => {
  await s?.stop();
});

test("on Stalwart, queued keyword, move and destroy ops change the server", async () => {
  const alpha = await createMailbox(client, accountId, "Alpha");
  const a = await importEmail(client, accountId, { mailboxIds: [inbox], keywords: ["$hasnoattachment"], subject: "A", body: "a" });
  const b = await importEmail(client, accountId, { mailboxIds: [inbox], subject: "B", body: "b" });
  let saved: OutboxOp[] = [];
  const ob = new Outbox({
    client,
    accountId,
    storage: { load: async () => saved, save: async ops => void (saved = ops) },
    hooks: { readDraft: async () => null, onApplied: async () => {}, onRefused: async () => {} },
  });
  await ob.enqueue({ kind: "keywords", emailId: a, patch: { "keywords/$seen": true, "keywords/work": true } });
  await ob.enqueue({ kind: "move", emailId: a, fromMailboxId: inbox, toMailboxId: alpha });
  await ob.enqueue({ kind: "destroy", emailId: b });
  expect(await ob.flush()).toEqual({ applied: 3, refused: 0 });

  const { list, notFound } = await emailGet(client, accountId, [a, b], ["id", "keywords", "mailboxIds"]);
  expect(notFound).toEqual([b]);
  expect(Object.keys(list[0].mailboxIds)).toEqual([alpha]);
  expect(Object.keys(list[0].keywords).sort()).toEqual(["$hasnoattachment", "$seen", "work"]);
  expect(saved).toEqual([]);
}, 60_000);
