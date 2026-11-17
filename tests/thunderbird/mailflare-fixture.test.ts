/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The local Mailflare + Mailpit fixture itself (no Thunderbird). It lives in
// tests/thunderbird so `mise run check` (and CI) never builds Mailflare.

import { test, expect } from "vitest";
import {
  emailGet,
  emailQuery,
  identityGet,
  mailboxGet,
  submitEmail,
  type JmapClient,
  type Mailbox,
} from "@thunderbird-jmap/jmap-client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect, startMailflare, type MailflareInstance } from "@thunderbird-jmap/test-support";

const podman = async (...args: string[]) => (await promisify(execFile)("podman", args)).stdout.trim();

/** The mailbox with `role` in the folder tree of `address` (Mailflare: one tree per address). */
function roleMailbox(list: Mailbox[], address: string, role: string): Mailbox {
  const root = list.find(m => !m.parentId && m.name.includes(`<${address}>`));
  const found = list.find(m => m.parentId == root?.id && m.role == role);
  if (!found) {
    throw new Error(`no ${role} mailbox for ${address}`);
  }
  return found;
}

async function subjectsIn(client: JmapClient, accountId: string, mailboxId: string): Promise<string[]> {
  const { ids } = await client.call<{ ids: string[] }>("Email/query", {
    accountId,
    filter: { inMailbox: mailboxId },
    limit: 100,
  });
  if (!ids.length) {
    return [];
  }
  return (await emailGet(client, accountId, ids, ["subject"])).list.map(e => e.subject ?? "");
}

async function sendRaw(
  client: JmapClient,
  accountId: string,
  mf: MailflareInstance,
  o: { from: string; to: string; bcc: string; subject: string }
) {
  const raw =
    `From: ${o.from}\r\nTo: ${o.to}\r\nBcc: ${o.bcc}\r\nSubject: ${o.subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${Date.now()}@example.test>\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
    `Žuta ruža.\r\n`;
  const { blobId } = await client.uploadBlob(accountId, new TextEncoder().encode(raw), "message/rfc822");
  const { list } = await mailboxGet(client, accountId, null);
  const identity = (await identityGet(client, accountId)).list.find(i => i.email == o.from)!;
  return submitEmail(client, accountId, {
    blobId,
    identityId: identity.id,
    draftsMailboxId: roleMailbox(list, o.from, "drafts").id,
    sentMailboxId: roleMailbox(list, o.from, "sent").id,
    envelope: { mailFrom: o.from, rcptTo: [o.to, o.bcc] },
  });
}

test("a fresh Mailflare has two identities, takes SMTP mail into the Inbox, and sends into Mailpit", async () => {
  const mf = await startMailflare();
  try {
    expect(mf.addresses).toEqual(["me@example.test", "hello@example.test"]);
    const { client, accountId } = await connect(mf);
    const identities = await identityGet(client, accountId);
    expect(identities.list.map(i => i.email).sort()).toEqual(["hello@example.test", "me@example.test"]);

    await mf.deliver({ from: "out@sender.test", to: "me@example.test", subject: "Fixture in", body: "Čestitke" });
    const { list } = await mailboxGet(client, accountId, null);
    expect(await subjectsIn(client, accountId, roleMailbox(list, "me@example.test", "inbox").id)).toContain("Fixture in");

    const sent = await sendRaw(client, accountId, mf, {
      from: "me@example.test",
      to: "to@dest.test",
      bcc: "hidden@dest.test",
      subject: "Fixture out",
    });
    expect(sent.error).toBeUndefined();
    const [msg] = (await mf.captured()).filter(m => m.subject == "Fixture out");
    expect(msg.from).toBe("me@example.test");
    expect(msg.to).toEqual(["to@dest.test"]);
    expect(msg.bcc).toEqual(["hidden@dest.test"]);
    expect(msg.raw).not.toMatch(/^Bcc:/im);
    expect(msg.text).toContain("Žuta ruža.");
  } finally {
    await mf.stop();
  }
}, 900_000);

test("setSending(false) makes Mailflare refuse to send", async () => {
  const mf = await startMailflare({ localParts: ["me"] });
  try {
    await mf.setSending(false);
    const { client, accountId } = await connect(mf);
    const sent = await sendRaw(client, accountId, mf, {
      from: "me@example.test",
      to: "to@dest.test",
      bcc: "hidden@dest.test",
      subject: "Not sent",
    });
    expect(sent.error?.description).toMatch(/^Sending is not set up/);
    expect((await mf.captured()).filter(m => m.subject == "Not sent")).toEqual([]);
  } finally {
    await mf.stop();
  }
}, 900_000);

test("stopping Mailflare removes its volume too", async () => {
  const mf = await startMailflare({ localParts: ["me"] });
  let volumes: string[] = [];
  try {
    const port = new URL(mf.baseUrl).port;
    const line = (await podman("ps", "--format", "{{.Names}} {{.Ports}}")).split("\n").find(l => l.includes(`:${port}->`))!;
    volumes = (await podman("inspect", line.split(" ")[0], "--format", "{{range .Mounts}}{{.Name}} {{end}}")).split(" ").filter(Boolean);
    expect(volumes.length).toBeGreaterThan(0);
  } finally {
    await mf.stop();
  }
  const left = await podman("volume", "ls", "-q");
  expect(volumes.filter(v => left.includes(v))).toEqual([]);
}, 600_000);
