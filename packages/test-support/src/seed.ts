/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Stalwart-only seeding helpers for tests. These write to the server
// (Email/import, Email/set, Mailbox/set) and must never be used by product code.

import { randomBytes } from "node:crypto";
import { JmapClient, JmapError, mailboxGet } from "@thunderbird-jmap/jmap-client";
import type { StalwartInstance } from "./stalwart.js";

export async function connect(
  s: StalwartInstance
): Promise<{ client: JmapClient; accountId: string }> {
  const client = new JmapClient({
    sessionUrl: s.sessionUrl,
    credentials: { kind: "basic", username: s.username, password: s.password },
    fetch: (url, init) => fetch(url, init),
  });
  return { client, accountId: await client.primaryMailAccountId() };
}

export async function mailboxIdByRole(
  client: JmapClient,
  accountId: string,
  role: string
): Promise<string> {
  const { list } = await mailboxGet(client, accountId, null);
  const mailbox = list.find(m => m.role == role);
  if (!mailbox) {
    throw new Error(`No mailbox with role ${role}`);
  }
  return mailbox.id;
}

export async function createMailbox(
  client: JmapClient,
  accountId: string,
  name: string,
  parentId?: string
): Promise<string> {
  const res = await client.call<any>("Mailbox/set", {
    accountId,
    create: { k: { name, parentId: parentId ?? null } },
  });
  const id = res.created?.k?.id;
  if (!id) {
    throw new JmapError(`Mailbox/set create failed: ${JSON.stringify(res.notCreated)}`);
  }
  return id;
}

function utf8Base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** RFC 2047-encode a header word if it is not printable ASCII. */
function encodeWord(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${utf8Base64(text)}?=`;
}

/** Encode the display name of "Name <addr>"; bare addresses pass through. */
function encodeAddress(address: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(address);
  if (!m || !m[1]) {
    return address;
  }
  return `${encodeWord(m[1].replace(/^"|"$/g, ""))} <${m[2]}>`;
}

export async function importEmail(
  client: JmapClient,
  accountId: string,
  o: {
    mailboxIds: string[];
    keywords?: string[];
    from?: string;
    to?: string;
    subject: string;
    body: string;
    messageId?: string;
    date?: Date;
  }
): Promise<string> {
  const date = o.date ?? new Date();
  const messageId = o.messageId ?? `${randomBytes(8).toString("hex")}@example.com`;
  const raw =
    [
      `From: ${encodeAddress(o.from ?? "Sender <sender@example.com>")}`,
      `To: ${encodeAddress(o.to ?? "admin@example.com")}`,
      `Subject: ${encodeWord(o.subject)}`,
      `Date: ${date.toUTCString()}`,
      `Message-ID: <${messageId}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      o.body,
    ].join("\r\n") + "\r\n";
  const { blobId } = await client.uploadBlob(accountId, new TextEncoder().encode(raw), "message/rfc822");
  const res = await client.call<any>("Email/import", {
    accountId,
    emails: {
      k: {
        blobId,
        mailboxIds: Object.fromEntries(o.mailboxIds.map(id => [id, true])),
        keywords: Object.fromEntries((o.keywords ?? []).map(k => [k, true])),
        receivedAt: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    },
  });
  const id = res.created?.k?.id;
  if (!id) {
    throw new JmapError(`Email/import failed: ${JSON.stringify(res.notCreated)}`);
  }
  return id;
}

async function emailSet(client: JmapClient, accountId: string, args: Record<string, unknown>) {
  const res = await client.call<any>("Email/set", { accountId, ...args });
  const failed = res.notUpdated ?? res.notDestroyed;
  if (failed && Object.keys(failed).length) {
    throw new JmapError(`Email/set failed: ${JSON.stringify(failed)}`);
  }
}

export function setKeywords(client: JmapClient, accountId: string, emailId: string, keywords: string[]) {
  return emailSet(client, accountId, {
    update: { [emailId]: { keywords: Object.fromEntries(keywords.map(k => [k, true])) } },
  });
}

export function moveEmail(client: JmapClient, accountId: string, emailId: string, mailboxIds: string[]) {
  return emailSet(client, accountId, {
    update: { [emailId]: { mailboxIds: Object.fromEntries(mailboxIds.map(id => [id, true])) } },
  });
}

export function destroyEmail(client: JmapClient, accountId: string, emailId: string) {
  return emailSet(client, accountId, { destroy: [emailId] });
}

export async function renameMailbox(client: JmapClient, accountId: string, mailboxId: string, name: string) {
  const res = await client.call<any>("Mailbox/set", { accountId, update: { [mailboxId]: { name } } });
  if (res.notUpdated && Object.keys(res.notUpdated).length) {
    throw new JmapError(`Mailbox/set update failed: ${JSON.stringify(res.notUpdated)}`);
  }
}

export async function destroyMailbox(client: JmapClient, accountId: string, mailboxId: string) {
  const res = await client.call<any>("Mailbox/set", {
    accountId,
    destroy: [mailboxId],
    onDestroyRemoveEmails: true,
  });
  if (res.notDestroyed && Object.keys(res.notDestroyed).length) {
    throw new JmapError(`Mailbox/set destroy failed: ${JSON.stringify(res.notDestroyed)}`);
  }
}
