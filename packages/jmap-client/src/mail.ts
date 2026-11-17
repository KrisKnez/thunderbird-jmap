/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JmapClient } from "./client.js";

export interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailHeaderInfo {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: string;
  sentAt: string | null;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  subject: string | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  hasAttachment: boolean;
}

export const EMAIL_HEADER_PROPERTIES: readonly string[] = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "sentAt",
  "messageId",
  "inReplyTo",
  "references",
  "subject",
  "from",
  "to",
  "cc",
  "hasAttachment",
];

export interface Changes {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

const MAILBOX_PROPERTIES = ["id", "name", "parentId", "role", "sortOrder"];

export function mailboxGet(
  c: JmapClient,
  accountId: string,
  ids: string[] | null
): Promise<{ state: string; list: Mailbox[]; notFound: string[] }> {
  return c.call("Mailbox/get", { accountId, ids, properties: MAILBOX_PROPERTIES });
}

export function mailboxChanges(c: JmapClient, accountId: string, sinceState: string): Promise<Changes> {
  return c.call("Mailbox/changes", { accountId, sinceState });
}

export function emailChanges(
  c: JmapClient,
  accountId: string,
  sinceState: string,
  maxChanges?: number
): Promise<Changes> {
  return c.call("Email/changes", {
    accountId,
    sinceState,
    ...(maxChanges ? { maxChanges } : {}),
  });
}

export function emailQuery(
  c: JmapClient,
  accountId: string,
  o: {
    position: number;
    limit: number;
    sort?: { property: string; isAscending: boolean }[];
    /** Page from this id (RFC 8620 §5.5); overrides position. */
    anchor?: string;
    anchorOffset?: number;
  }
): Promise<{ ids: string[]; position: number; total?: number; queryState: string }> {
  return c.call("Email/query", {
    accountId,
    limit: o.limit,
    calculateTotal: true,
    ...(o.anchor
      ? { anchor: o.anchor, anchorOffset: o.anchorOffset ?? 0 }
      : { position: o.position }),
    ...(o.sort ? { sort: o.sort } : {}),
  });
}

export function emailGet(
  c: JmapClient,
  accountId: string,
  ids: string[],
  properties: readonly string[] = EMAIL_HEADER_PROPERTIES
): Promise<{ state: string; list: EmailHeaderInfo[]; notFound: string[] }> {
  return c.call("Email/get", { accountId, ids, properties });
}
