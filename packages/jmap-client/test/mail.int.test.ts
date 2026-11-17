/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  createMailbox,
  importEmail,
  setKeywords,
  destroyEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import {
  JmapClient,
  mailboxGet,
  mailboxChanges,
  emailGet,
  emailQuery,
  emailChanges,
} from "../src/index.js";

let s: StalwartInstance;
let client: JmapClient;
let accountId: string;
let inboxId: string;

beforeEach(async () => {
  s = await startStalwart();
  ({ client, accountId } = await connect(s));
  inboxId = await mailboxIdByRole(client, accountId, "inbox");
}, 90_000);

afterEach(async () => {
  await s?.stop();
});

test("mailboxGet(null) lists the inbox", async () => {
  const { list, state } = await mailboxGet(client, accountId, null);
  expect(state).toBeTypeOf("string");
  expect(list.find(m => m.role == "inbox")?.id).toBe(inboxId);
});

test("an imported email comes back from emailGet with its header fields", async () => {
  const id = await importEmail(client, accountId, {
    mailboxIds: [inboxId],
    keywords: ["$seen"],
    from: "Ana Lee <ana@example.com>",
    subject: "Hello there",
    body: "Body text 123",
  });
  const { list } = await emailGet(client, accountId, [id]);
  expect(list[0].subject).toBe("Hello there");
  expect(list[0].from?.[0]).toEqual({ name: "Ana Lee", email: "ana@example.com" });
  expect(list[0].keywords["$seen"]).toBe(true);
  expect(list[0].mailboxIds[inboxId]).toBe(true);
});

test("non-ASCII names and subjects survive the seed helper", async () => {
  const id = await importEmail(client, accountId, {
    mailboxIds: [inboxId],
    from: "Žana Šimić <zana@example.com>",
    subject: "Привет, мир",
    body: "x",
  });
  const { list } = await emailGet(client, accountId, [id]);
  expect(list[0].subject).toBe("Привет, мир");
  expect(list[0].from?.[0].name).toBe("Žana Šimić");
});

test("downloadBlob returns the raw message", async () => {
  const id = await importEmail(client, accountId, {
    mailboxIds: [inboxId],
    subject: "Blob test",
    body: "Unique body 4711",
  });
  const { list } = await emailGet(client, accountId, [id]);
  const raw = await client.downloadBlob(accountId, list[0].blobId);
  expect(new TextDecoder().decode(raw)).toContain("Unique body 4711");
});

test("emailQuery pages and reports the total", async () => {
  for (const n of [1, 2, 3]) {
    await importEmail(client, accountId, { mailboxIds: [inboxId], subject: `m${n}`, body: "b" });
  }
  const page = await emailQuery(client, accountId, { position: 0, limit: 2 });
  expect(page.ids).toHaveLength(2);
  expect(page.total).toBe(3);
});

test("emailChanges reports updated and destroyed ids", async () => {
  const id = await importEmail(client, accountId, { mailboxIds: [inboxId], subject: "c", body: "b" });
  const before = (await emailGet(client, accountId, [])).state;
  await setKeywords(client, accountId, id, ["$seen"]);
  const afterUpdate = await emailChanges(client, accountId, before);
  expect(afterUpdate.updated).toContain(id);
  await destroyEmail(client, accountId, id);
  const afterDestroy = await emailChanges(client, accountId, afterUpdate.newState);
  expect(afterDestroy.destroyed).toContain(id);
});

test("mailboxChanges reports a created mailbox", async () => {
  const before = (await mailboxGet(client, accountId, [])).state;
  const id = await createMailbox(client, accountId, "Projects");
  const changes = await mailboxChanges(client, accountId, before);
  expect(changes.created).toContain(id);
});
