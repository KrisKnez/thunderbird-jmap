/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, test, expect } from "vitest";
import {
  startStalwart,
  connect,
  importEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import type { JmapClient } from "@thunderbird-jmap/jmap-client";
import { SyncEngine } from "../src/index.js";
import { FakeStore } from "./fake-store.js";

let s: StalwartInstance;
let client: JmapClient;
let accountId: string;
let inbox: string;
let ids: string[];

beforeEach(async () => {
  s = await startStalwart();
  ({ client, accountId } = await connect(s));
  inbox = await mailboxIdByRole(client, accountId, "inbox");
  ids = [];
  for (const n of [1, 2, 3]) {
    ids.push(await importEmail(client, accountId, { mailboxIds: [inbox], subject: `S${n}`, body: `seeded body ${n}` }));
  }
}, 90_000);

afterEach(async () => {
  await s?.stop();
});

/** The client, with downloadBlob calls counted. */
function counting(): { client: JmapClient; downloads: () => number } {
  let n = 0;
  const wrapped = Object.create(client) as JmapClient;
  wrapped.downloadBlob = (...args) => {
    n++;
    return client.downloadBlob(...args);
  };
  return { client: wrapped, downloads: () => n };
}

const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : "");

test("downloadPendingBodies stores every missing body", async () => {
  const store = new FakeStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();

  expect(await engine.downloadPendingBodies()).toBe(3);
  for (const [n, id] of ids.entries()) {
    expect(text(store.in(inbox).get(id)?.body)).toContain(`seeded body ${n + 1}`);
  }
  expect(await engine.downloadPendingBodies()).toBe(0);
}, 60_000);

test("fetchBody stores one body, and concurrent calls share one download", async () => {
  const store = new FakeStore();
  const { client: c, downloads } = counting();
  const engine = new SyncEngine({ client: c, store, accountId });
  await engine.sync();
  const blobId = store.in(inbox).get(ids[1])!.email.blobId;

  await Promise.all([
    engine.fetchBody(inbox, ids[1], blobId),
    engine.fetchBody(inbox, ids[1], blobId),
  ]);

  expect(downloads()).toBe(1);
  expect(text(store.in(inbox).get(ids[1])?.body)).toContain("seeded body 2");
  expect(store.in(inbox).get(ids[0])?.body).toBeUndefined();
}, 60_000);

test("a body that fails to download is skipped and the others still store", async () => {
  const store = new FakeStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();
  const broken = store.in(inbox).get(ids[0])!;
  broken.email = { ...broken.email, blobId: "no-such-blob" };

  expect(await engine.downloadPendingBodies()).toBe(2);
  expect(store.in(inbox).get(ids[0])?.body).toBeUndefined();
  expect(text(store.in(inbox).get(ids[2])?.body)).toContain("seeded body 3");
}, 60_000);
