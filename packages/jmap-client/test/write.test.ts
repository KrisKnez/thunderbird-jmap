/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, test, expect } from "vitest";
import {
  JmapClient,
  emailSet,
  emailImport,
  identityGet,
  identityChanges,
  submitEmail,
  SUBMISSION_USING,
} from "../src/index.js";
import { fakeFetch, json, STALWART_LIKE_SESSION } from "./fake-fetch.js";

type Call = [string, any, string];
type Responder = (name: string, args: any, callId: string) => [string, any, string];

let requests: { using: string[]; calls: Call[] }[];
let responder: Responder;
let client: JmapClient;

const sentCalls = () => requests.flatMap(r => r.calls).map(([name, args]) => [name, args] as [string, any]);
const lastUsing = () => requests.at(-1)!.using;

beforeEach(() => {
  requests = [];
  responder = (name, args, id) => [name, {}, id];
  const { fetch } = fakeFetch((url, init) => {
    if (url.endsWith("/jmap/session")) {
      return json(STALWART_LIKE_SESSION, { url });
    }
    const body = JSON.parse(String(init?.body));
    requests.push({ using: body.using, calls: body.methodCalls });
    return json({ methodResponses: body.methodCalls.map(([n, a, id]: Call) => responder(n, a, id)), sessionState: "s" });
  });
  client = new JmapClient({
    sessionUrl: "https://h.test/jmap/session",
    credentials: { kind: "basic", username: "u", password: "p" },
    fetch,
  });
});

const ARGS = {
  blobId: "b1",
  draftsMailboxId: "d",
  sentMailboxId: "s",
  identityId: "i",
  envelope: { mailFrom: "me@x.test", rcptTo: ["to@y.test", "bcc@y.test"] },
};

describe("Email/set and Email/import", () => {
  test("emailSet sends individual keyword patches and returns per-email results", async () => {
    responder = (name, args, id) => [
      name,
      { newState: "n1", updated: { e1: null }, destroyed: [], notUpdated: { e2: { type: "invalidProperties", description: "one mailbox" } }, notDestroyed: {} },
      id,
    ];
    const r = await emailSet(client, "a", {
      update: { e1: { "keywords/$seen": true }, e2: { "mailboxIds/m1": null, "mailboxIds/m2": true } },
    });
    expect(sentCalls()[0][0]).toBe("Email/set");
    expect(sentCalls()[0][1].update).toEqual({
      e1: { "keywords/$seen": true },
      e2: { "mailboxIds/m1": null, "mailboxIds/m2": true },
    });
    expect(r.newState).toBe("n1");
    expect(Object.keys(r.updated)).toEqual(["e1"]);
    expect(r.notUpdated.e2.type).toBe("invalidProperties");
    expect(r.destroyed).toEqual([]);
  });

  test("emailSet fills missing result maps so callers can index them", async () => {
    responder = (name, args, id) => [name, { newState: "n2", destroyed: ["e9"] }, id];
    const r = await emailSet(client, "a", { destroy: ["e9"] });
    expect(sentCalls()[0][1].destroy).toEqual(["e9"]);
    expect(r).toEqual({ newState: "n2", updated: {}, destroyed: ["e9"], notUpdated: {}, notDestroyed: {} });
  });

  test("emailImport returns created and notCreated", async () => {
    responder = (name, args, id) => [
      name,
      { created: { k: { id: "e1", blobId: "b1", threadId: "t1", size: 3 } }, notCreated: { j: { type: "blobNotFound" } } },
      id,
    ];
    const r = await emailImport(client, "a", {
      k: { blobId: "b1", mailboxIds: { d: true }, keywords: { $draft: true } },
      j: { blobId: "bx", mailboxIds: { d: true }, keywords: {} },
    });
    expect(sentCalls()[0]).toEqual(["Email/import", {
      accountId: "a",
      emails: {
        k: { blobId: "b1", mailboxIds: { d: true }, keywords: { $draft: true } },
        j: { blobId: "bx", mailboxIds: { d: true }, keywords: {} },
      },
    }]);
    expect(r.created.k).toEqual({ id: "e1", blobId: "b1", threadId: "t1" });
    expect(r.notCreated.j.type).toBe("blobNotFound");
  });
});

describe("identities and submission", () => {
  test("identityGet and identityChanges use the submission capability", async () => {
    responder = (name, args, id) =>
      name == "Identity/get"
        ? [name, { state: "is1", list: [{ id: "i1", email: "me@x.test", name: "Me", replyTo: null }] }, id]
        : [name, { oldState: "is1", newState: "is2", hasMoreChanges: false, created: [], updated: ["i1"], destroyed: [] }, id];
    const got = await identityGet(client, "a");
    expect(lastUsing()).toEqual(SUBMISSION_USING);
    expect(got).toEqual({ state: "is1", list: [{ id: "i1", email: "me@x.test", name: "Me" }] });
    const changes = await identityChanges(client, "a", "is1");
    expect(lastUsing()).toEqual(SUBMISSION_USING);
    expect(sentCalls()[1]).toEqual(["Identity/changes", { accountId: "a", sinceState: "is1" }]);
    expect(changes.updated).toEqual(["i1"]);
  });

  test("submitEmail imports into Drafts and submits with an explicit envelope in one request", async () => {
    responder = (name, args, id) =>
      name == "Email/import"
        ? [name, { created: { draft: { id: "e1", blobId: "b1", threadId: "t1" } } }, id]
        : [name, { created: { send: { id: "sub1" } } }, id];
    const r = await submitEmail(client, "a", ARGS);
    expect(requests).toHaveLength(1);
    const [[imp, importArgs], [sub, subArgs]] = sentCalls();
    expect([imp, sub]).toEqual(["Email/import", "EmailSubmission/set"]);
    expect(importArgs.emails.draft).toMatchObject({
      blobId: "b1",
      mailboxIds: { d: true },
      keywords: { $draft: true, $seen: true },
    });
    expect(subArgs.create.send).toMatchObject({
      identityId: "i",
      emailId: "#draft",
      envelope: { mailFrom: { email: "me@x.test" }, rcptTo: [{ email: "to@y.test" }, { email: "bcc@y.test" }] },
    });
    expect(subArgs.onSuccessUpdateEmail["#send"]).toEqual({
      "mailboxIds/d": null,
      "mailboxIds/s": true,
      "keywords/$draft": null,
    });
    expect(lastUsing()).toEqual(SUBMISSION_USING);
    expect(r).toEqual({ submissionId: "sub1", draftId: "e1" });
  });

  test("submitEmail reports a refused submission without throwing", async () => {
    responder = (name, args, id) =>
      name == "Email/import"
        ? [name, { created: { draft: { id: "e1", blobId: "b1", threadId: "t1" } } }, id]
        : [name, { notCreated: { send: { type: "forbidden", description: "Sending is not set up" } } }, id];
    const r = await submitEmail(client, "a", ARGS);
    expect(r.error).toEqual({ type: "forbidden", description: "Sending is not set up" });
    expect(r.submissionId).toBeUndefined();
    expect(r.draftId).toBe("e1");
  });

  test("submitEmail reports a failed import as the error", async () => {
    responder = (name, args, id) =>
      name == "Email/import"
        ? [name, { notCreated: { draft: { type: "invalidProperties", description: "New messages can only be created in a Drafts mailbox" } } }, id]
        : [name, { notCreated: { send: { type: "invalidProperties", properties: ["emailId"] } } }, id];
    const r = await submitEmail(client, "a", ARGS);
    expect(r.error).toEqual({ type: "invalidProperties", description: "New messages can only be created in a Drafts mailbox" });
    expect(r.draftId).toBeUndefined();
  });
});
