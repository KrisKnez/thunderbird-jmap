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
  moveEmail,
  destroyEmail,
  mailboxIdByRole,
  type StalwartInstance,
} from "@thunderbird-jmap/test-support";
import {
  JmapClient,
  JmapMethodError,
  JmapNetworkError,
  emailGet,
  emailQuery,
} from "@thunderbird-jmap/jmap-client";
import { SyncEngine } from "../src/index.js";
import { FakeStore } from "./fake-store.js";

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

/** mailboxId → sorted email ids, straight from the server. */
async function serverView(): Promise<Record<string, string[]>> {
  const { ids } = await emailQuery(client, accountId, { position: 0, limit: 1000 });
  const { list } = await emailGet(client, accountId, ids, ["id", "mailboxIds"]);
  const view: Record<string, string[]> = {};
  for (const e of list) {
    for (const m of Object.keys(e.mailboxIds)) {
      (view[m] ??= []).push(e.id);
    }
  }
  for (const m in view) view[m].sort();
  return view;
}

function storeView(store: FakeStore): Record<string, string[]> {
  const view: Record<string, string[]> = {};
  for (const [m, folder] of store.messages) {
    if (folder.size) view[m] = [...folder.keys()].sort();
  }
  return view;
}

/** A client whose `call` throws `error` once, on the `nth` call named `name`. */
function failOn(name: string, error: Error, nth = 1): JmapClient {
  let seen = 0;
  const wrapped = Object.create(client) as JmapClient;
  wrapped.call = async <T>(n: string, args: Record<string, unknown>, using?: string[]) => {
    if (n == name && ++seen == nth) throw error;
    return client.call<T>(n, args, using);
  };
  return wrapped;
}

const subject = (n: string) => ({ subject: n, body: `body of ${n}` });

test("initial sync mirrors mailboxes, messages and flags", async () => {
  const projects = await createMailbox(client, accountId, "Projects");
  const alpha = await createMailbox(client, accountId, "Alpha", projects);
  const a = await importEmail(client, accountId, { mailboxIds: [inbox], keywords: ["$seen", "$flagged"], ...subject("A") });
  const b = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("B") });
  await importEmail(client, accountId, { mailboxIds: [alpha], ...subject("C") });
  const store = new FakeStore();

  const result = await new SyncEngine({ client, store, accountId }).sync();

  expect(result.full).toBe(true);
  expect(store.folders.get(inbox)?.kind).toBe("inbox");
  expect(store.folders.get(alpha)?.parentId).toBe(projects);
  expect(storeView(store)).toEqual(await serverView());
  expect(store.in(inbox).get(a)?.flags).toMatchObject({ read: true, flagged: true });
  expect(store.in(inbox).get(b)?.flags.read).toBe(false);
}, 60_000);

test("an email in two mailboxes appears in both and is removed from both when destroyed", async () => {
  const alpha = await createMailbox(client, accountId, "Alpha");
  const id = await importEmail(client, accountId, { mailboxIds: [inbox, alpha], ...subject("Both") });
  const store = new FakeStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();
  expect(store.in(inbox).has(id)).toBe(true);
  expect(store.in(alpha).has(id)).toBe(true);

  await destroyEmail(client, accountId, id);
  await engine.sync();
  expect(store.in(inbox).has(id)).toBe(false);
  expect(store.in(alpha).has(id)).toBe(false);
}, 60_000);

test("delta sync applies keyword changes, moves, new mail and deletions", async () => {
  const alpha = await createMailbox(client, accountId, "Alpha");
  const a = await importEmail(client, accountId, { mailboxIds: [inbox], keywords: ["$flagged"], ...subject("A") });
  const b = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("B") });
  const c = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("C") });
  const store = new FakeStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();

  await setKeywords(client, accountId, a, ["$seen"]);
  await moveEmail(client, accountId, b, [alpha]);
  const d = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("D") });
  await destroyEmail(client, accountId, c);
  const result = await engine.sync();

  expect(result.full).toBe(false);
  expect(storeView(store)).toEqual(await serverView());
  expect(store.in(inbox).get(a)?.flags).toMatchObject({ read: true, flagged: false });
  expect(store.in(alpha).has(b)).toBe(true);
  expect(store.in(inbox).has(b)).toBe(false);
  expect(store.in(inbox).has(d)).toBe(true);
  expect(store.in(inbox).has(c)).toBe(false);
}, 60_000);

test("cannotCalculateChanges triggers a full resync that still matches the server", async () => {
  await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("A") });
  const store = new FakeStore();
  await new SyncEngine({ client, store, accountId }).sync();
  await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("B") });

  const flaky = failOn("Email/changes", new JmapMethodError("cannotCalculateChanges"));
  const result = await new SyncEngine({ client: flaky, store, accountId }).sync();

  expect(result.full).toBe(true);
  expect(storeView(store)).toEqual(await serverView());
  expect(store.in(inbox).size).toBe(2);
}, 60_000);

test("120 emails with batchSize 50 are all synced exactly once", async () => {
  for (let n = 0; n < 120; n++) {
    await importEmail(client, accountId, { mailboxIds: [inbox], ...subject(`bulk ${n}`) });
  }
  const store = new FakeStore();
  await new SyncEngine({ client, store, accountId, batchSize: 50 }).sync();
  expect(store.in(inbox).size).toBe(120);
  expect(storeView(store)).toEqual(await serverView());
}, 120_000);

test("a sync that fails midway rejects, and the next sync converges", async () => {
  for (let n = 0; n < 5; n++) {
    await importEmail(client, accountId, { mailboxIds: [inbox], ...subject(`m${n}`) });
  }
  const store = new FakeStore();
  const broken = failOn("Email/get", new JmapNetworkError(new TypeError("fetch failed")), 3);
  await expect(new SyncEngine({ client: broken, store, accountId, batchSize: 2 }).sync()).rejects.toBeInstanceOf(
    JmapNetworkError
  );

  await new SyncEngine({ client, store, accountId, batchSize: 2 }).sync();
  expect(storeView(store)).toEqual(await serverView());
}, 60_000);

test("a store that clears emailState while applying mailboxes gets a full email sync", async () => {
  class ResettingStore extends FakeStore {
    resetNext = false;
    override async applyMailboxes(mailboxes: Parameters<FakeStore["applyMailboxes"]>[0]) {
      await super.applyMailboxes(mailboxes);
      if (this.resetNext && this.state) {
        this.state = { ...this.state, emailState: null };
        this.resetNext = false;
      }
    }
  }
  await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("A") });
  const store = new ResettingStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();

  store.resetNext = true;
  const result = await engine.sync();

  expect(result.full).toBe(true);
  expect(storeView(store)).toEqual(await serverView());
}, 60_000);

/** A client whose Email/query never returns more than `max` ids (RFC 8620 §5.5 allows clamping). */
function clampingQueries(max: number): JmapClient {
  const wrapped = Object.create(client) as JmapClient;
  wrapped.call = async <T>(n: string, args: Record<string, unknown>, using?: string[]) => {
    if (n == "Email/query" && typeof args.limit == "number" && args.limit > max) {
      args = { ...args, limit: max };
    }
    return client.call<T>(n, args, using);
  };
  return wrapped;
}

test("a server that clamps query pages still gets every email synced, and a full resync deletes nothing", async () => {
  for (let n = 0; n < 20; n++) {
    await importEmail(client, accountId, { mailboxIds: [inbox], ...subject(`clamped ${n}`) });
  }
  const store = new FakeStore();
  await new SyncEngine({ client: clampingQueries(7), store, accountId, batchSize: 50 }).sync();
  expect(store.in(inbox).size).toBe(20);

  let first = true;
  const flaky = clampingQueries(7);
  const plainCall = flaky.call;
  flaky.call = async <T>(n: string, args: Record<string, unknown>, using?: string[]) => {
    if (n == "Email/changes" && first) {
      first = false;
      throw new JmapMethodError("cannotCalculateChanges");
    }
    return plainCall.call(flaky, n, args, using) as Promise<T>;
  };
  const result = await new SyncEngine({ client: flaky, store, accountId, batchSize: 50 }).sync();
  expect(result.full).toBe(true);
  expect(store.in(inbox).size).toBe(20);
}, 120_000);

test("emailSyncComplete is called after a successful sync, telling whether it was full, and not after a failed one", async () => {
  class HookedStore extends FakeStore {
    completed: boolean[] = [];
    async emailSyncComplete(o: { full: boolean }): Promise<void> {
      this.completed.push(o.full);
    }
  }
  await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("A") });
  const store = new HookedStore();
  await new SyncEngine({ client, store, accountId }).sync();
  expect(store.completed).toEqual([true]);
  await new SyncEngine({ client, store, accountId }).sync();
  expect(store.completed, "a delta sync is not full").toEqual([true, false]);

  const broken = failOn("Email/changes", new JmapNetworkError(new TypeError("fetch failed")));
  await expect(new SyncEngine({ client: broken, store, accountId }).sync()).rejects.toBeInstanceOf(JmapNetworkError);
  expect(store.completed).toEqual([true, false]);
}, 60_000);

test("an email with queued changes is left alone by delta and full syncs, and refreshEmails applies the server state", async () => {
  const alpha = await createMailbox(client, accountId, "Alpha");
  const a = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("A") });
  const store = new FakeStore();
  const pending = new Set<string>();
  const engine = new SyncEngine({ client, store, accountId, isPending: id => pending.has(id) });
  await engine.sync();

  // Locally the user moved A to Alpha and marked it read; the queue has not sent it yet.
  pending.add(a);
  const copy = store.in(inbox).get(a)!;
  await store.removeMessage(inbox, a);
  await store.upsertMessage(alpha, copy.email, { ...copy.flags, read: true });
  await setKeywords(client, accountId, a, ["$flagged"]); // another client changes A meanwhile

  await engine.sync();
  expect(store.in(alpha).get(a)?.flags.read).toBe(true);
  expect(store.in(inbox).has(a)).toBe(false);

  await store.saveState({ ...(await store.loadState())!, emailState: null }); // force a full sync
  await engine.sync();
  expect(store.in(alpha).has(a)).toBe(true);
  expect(store.in(inbox).has(a)).toBe(false);

  // The queue gave up on it (refused): the server state comes back.
  pending.delete(a);
  await engine.refreshEmails([a]);
  expect(store.in(inbox).get(a)?.flags).toMatchObject({ read: false, flagged: true });
  expect(store.in(alpha).has(a)).toBe(false);
}, 60_000);

test("refreshEmails removes local copies of an email the server no longer has", async () => {
  const a = await importEmail(client, accountId, { mailboxIds: [inbox], ...subject("A") });
  const store = new FakeStore();
  const engine = new SyncEngine({ client, store, accountId });
  await engine.sync();
  await destroyEmail(client, accountId, a);
  await engine.refreshEmails([a]);
  expect(store.in(inbox).has(a)).toBe(false);
}, 60_000);
