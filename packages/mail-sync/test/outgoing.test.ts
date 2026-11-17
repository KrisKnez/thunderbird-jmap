/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, test, expect } from "vitest";
import { JmapClient, JmapNetworkError } from "@thunderbird-jmap/jmap-client";
import {
  isRedirect,
  prepareForSubmission,
  sendDraft,
  RedirectNotSupportedError,
  SubmissionRefusedError,
  SubmissionUncertainError,
} from "../src/index.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

const SESSION = {
  capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} },
  accounts: { a: { name: "me", isPersonal: true, isReadOnly: false } },
  primaryAccounts: { "urn:ietf:params:jmap:mail": "a" },
  username: "me",
  apiUrl: "/jmap/",
  downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  uploadUrl: "/jmap/upload/{accountId}/",
  eventSourceUrl: "/jmap/eventsource/",
  state: "s",
};

let fetchCalls: string[];
let uploads: string[];
let apiBodies: any[];
let failOn: "upload" | "api" | null;
let submissionResult: any;
let client: JmapClient;

beforeEach(() => {
  fetchCalls = [];
  uploads = [];
  apiBodies = [];
  failOn = null;
  submissionResult = { created: { send: { id: "sub1" } } };
  const fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push(url);
    const reply = (body: unknown) =>
      Object.defineProperty(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }), "url", { value: url });
    if (url.endsWith("/jmap/session")) {
      return reply(SESSION);
    }
    if (url.includes("/jmap/upload/")) {
      if (failOn == "upload") throw new TypeError("connection refused");
      uploads.push(new TextDecoder().decode(init!.body as Uint8Array));
      return reply({ accountId: "a", blobId: "blob1", type: "message/rfc822", size: 1 });
    }
    if (failOn == "api") throw new TypeError("connection reset");
    const body = JSON.parse(String(init!.body));
    apiBodies.push(body);
    return reply({
      methodResponses: body.methodCalls.map(([name, , id]: [string, unknown, string]) =>
        name == "Email/import" ? [name, { created: { draft: { id: "e1", blobId: "blob1", threadId: "t1" } } }, id] : [name, submissionResult, id]
      ),
      sessionState: "s",
    });
  };
  client = new JmapClient({ sessionUrl: "https://h.test/jmap/session", credentials: { kind: "basic", username: "me", password: "p" }, fetch });
});

const ARGS = {
  raw: bytes("From: me@x.test\r\nTo: To@Y.test\r\nSubject: hi\r\n\r\nbody\r\n"),
  to: ["To@Y.test"],
  bcc: [] as string[],
  identity: { id: "i1", email: "me@x.test" },
  draftsMailboxId: "d",
  sentMailboxId: "s",
};
const submission = () => apiBodies.at(-1).methodCalls.find((c: any) => c[0] == "EmailSubmission/set")[1].create.send;
const countCalls = (name: string) => apiBodies.flatMap(b => b.methodCalls).filter((c: any) => c[0] == name).length;

describe("preparing a message", () => {
  test("prepareForSubmission adds one Bcc header and leaves the body untouched", () => {
    const out = text(prepareForSubmission(bytes("From: a@x\r\nTo: b@y\r\n\r\nbody Bcc: x\r\n"), ["h1@y", "h2@y"]));
    expect(out).toBe("From: a@x\r\nTo: b@y\r\nBcc: h1@y, h2@y\r\n\r\nbody Bcc: x\r\n");
  });

  test("prepareForSubmission handles bare LF line endings", () => {
    const out = text(prepareForSubmission(bytes("From: a@x\nTo: b@y\n\nbody\n"), ["h@y"]));
    expect(out).toBe("From: a@x\nTo: b@y\nBcc: h@y\n\nbody\n");
  });

  test("prepareForSubmission without Bcc returns the bytes unchanged", () => {
    const raw = bytes("From: a@x\r\n\r\nx");
    expect(prepareForSubmission(raw, [])).toEqual(raw);
  });

  test("isRedirect sees Resent- headers only in the header block", () => {
    expect(isRedirect(bytes("Resent-From: a@x\r\nFrom: b@y\r\n\r\nx"))).toBe(true);
    expect(isRedirect(bytes("From: b@y\r\nresent-to: c@z\r\n\r\nx"))).toBe(true);
    expect(isRedirect(bytes("From: b@y\r\n\r\nResent-From: a@x"))).toBe(false);
  });
});

describe("sendDraft", () => {
  test("refuses a redirect before uploading anything", async () => {
    await expect(sendDraft(client, "a", { ...ARGS, raw: bytes("Resent-To: c@z\r\nFrom: me@x.test\r\n\r\nx") })).rejects.toBeInstanceOf(
      RedirectNotSupportedError
    );
    expect(fetchCalls).toEqual([]);
  });

  test("submits Thunderbird's exact recipients, Bcc included and deduplicated, once", async () => {
    const r = await sendDraft(client, "a", { ...ARGS, to: ["To@Y.test"], bcc: ["to@y.test", "h@y.test"] });
    expect(r).toEqual({ submissionId: "sub1" });
    expect(submission().envelope).toEqual({ mailFrom: { email: "me@x.test" }, rcptTo: [{ email: "To@Y.test" }, { email: "h@y.test" }] });
    expect(submission().identityId).toBe("i1");
    expect(countCalls("EmailSubmission/set")).toBe(1);
    expect(uploads[0]).toContain("Bcc: to@y.test, h@y.test\r\n");
  });

  test("a refused submission throws SubmissionRefusedError with the server's description", async () => {
    submissionResult = { notCreated: { send: { type: "forbidden", description: "Sending is not set up for x.test." } } };
    const error = await sendDraft(client, "a", ARGS).catch(e => e);
    expect(error).toBeInstanceOf(SubmissionRefusedError);
    expect(error.error).toEqual({ type: "forbidden", description: "Sending is not set up for x.test." });
  });

  test("a network failure before submitting is a JmapNetworkError; during submitting it is uncertain", async () => {
    failOn = "upload";
    await expect(sendDraft(client, "a", ARGS)).rejects.toBeInstanceOf(JmapNetworkError);
    failOn = "api";
    await expect(sendDraft(client, "a", ARGS)).rejects.toBeInstanceOf(SubmissionUncertainError);
  });
});
