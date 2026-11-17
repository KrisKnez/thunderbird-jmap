/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Mailbox } from "@thunderbird-jmap/jmap-client";
import type { FolderKind, LocalFlags, MailboxInfo } from "./store.js";

const SYSTEM_KEYWORDS = new Set([
  "$seen",
  "$flagged",
  "$answered",
  "$forwarded",
  "$draft",
  "$junk",
  "$notjunk",
]);

/**
 * Is this keyword a user tag? Keywords starting with "$" are registered
 * system keywords ($hasattachment, $mdnsent, …) and not tags, except
 * Thunderbird's own default tags $label1…$label5.
 */
function isTag(keyword: string): boolean {
  return !keyword.startsWith("$") || /^\$label\d+$/.test(keyword);
}

/** JMAP keywords (case-insensitive) → Thunderbird-style flags and tags. */
export function keywordsToFlags(keywords: Record<string, true>): LocalFlags {
  const set = new Set(Object.keys(keywords).map(k => k.toLowerCase()));
  return {
    read: set.has("$seen"),
    flagged: set.has("$flagged"),
    answered: set.has("$answered"),
    forwarded: set.has("$forwarded"),
    draft: set.has("$draft"),
    junk: set.has("$junk") ? true : set.has("$notjunk") ? false : null,
    tags: [...set].filter(k => !SYSTEM_KEYWORDS.has(k) && isTag(k)).sort(),
  };
}

const KINDS: Record<string, FolderKind> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  junk: "junk",
  archive: "archive",
};

export function roleToKind(role: string | null): FolderKind {
  return (role && KINDS[role.toLowerCase()]) || null;
}

/**
 * JMAP mailboxes → MailboxInfos in depth-first tree order (parents before
 * children; siblings by sortOrder, then name). A mailbox whose parent is not
 * in the list is treated as top level.
 */
export function toMailboxInfos(list: Mailbox[]): MailboxInfo[] {
  const ids = new Set(list.map(m => m.id));
  const infos: MailboxInfo[] = list.map(m => ({
    id: m.id,
    name: m.name,
    parentId: m.parentId && ids.has(m.parentId) ? m.parentId : null,
    kind: roleToKind(m.role),
    sortOrder: m.sortOrder ?? 0,
  }));
  const children = new Map<string | null, MailboxInfo[]>();
  for (const info of infos) {
    children.set(info.parentId, [...(children.get(info.parentId) ?? []), info]);
  }
  const ordered: MailboxInfo[] = [];
  const visit = (parentId: string | null) => {
    const kids = (children.get(parentId) ?? []).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    );
    for (const kid of kids) {
      ordered.push(kid);
      visit(kid.id);
    }
  };
  visit(null);
  return ordered;
}

/** The keywords the local flags stand for (lower-case, sorted). */
export function flagsToKeywords(flags: LocalFlags): string[] {
  const out: string[] = [];
  if (flags.read) out.push("$seen");
  if (flags.flagged) out.push("$flagged");
  if (flags.answered) out.push("$answered");
  if (flags.forwarded) out.push("$forwarded");
  if (flags.draft) out.push("$draft");
  if (flags.junk === true) out.push("$junk");
  if (flags.junk === false) out.push("$notjunk");
  out.push(...flags.tags.map(t => t.toLowerCase()));
  return [...new Set(out)].sort();
}

/** Keywords the add-on maps to local state; any other $ keyword is the server's own. */
function isManaged(keyword: string): boolean {
  return SYSTEM_KEYWORDS.has(keyword) || isTag(keyword);
}

/** RFC 6901 escaping for a keyword inside a "keywords/<k>" patch path. */
export function escapePointer(keyword: string): string {
  return keyword.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The Email/set patch that turns the server's keywords into `desired`:
 * one entry per keyword ("keywords/<k>": true | null), differences only.
 * Server-only $ keywords (e.g. $hasnoattachment) are never removed, and
 * keywords known to be local-only (the server does not keep them) are skipped.
 */
export function keywordPatch(
  serverKeywords: string[],
  desired: string[],
  localOnly: string[]
): Record<string, true | null> {
  const server = new Set(serverKeywords.map(k => k.toLowerCase()));
  const want = new Set(desired.map(k => k.toLowerCase()));
  const skip = new Set(localOnly.map(k => k.toLowerCase()));
  const patch: Record<string, true | null> = {};
  for (const k of want) {
    if (!server.has(k) && !skip.has(k)) patch[`keywords/${escapePointer(k)}`] = true;
  }
  for (const k of server) {
    if (!want.has(k) && !skip.has(k) && isManaged(k)) patch[`keywords/${escapePointer(k)}`] = null;
  }
  return patch;
}

/**
 * Local flags after a sync. The server decides everything it reports or
 * once reported (previousServerKeywords: what it reported last time, null
 * when unknown). A tag, Replied, Forwarded or junk verdict the server never
 * had is local (some servers, e.g. Mailflare, keep only $seen and $flagged)
 * and is kept.
 */
export function mergeServerFlags(
  server: LocalFlags,
  serverKeywords: string[],
  previousServerKeywords: string[] | null,
  local: LocalFlags
): LocalFlags {
  if (!previousServerKeywords) {
    return server;
  }
  const prev = new Set(previousServerKeywords.map(k => k.toLowerCase()));
  const now = new Set(serverKeywords.map(k => k.toLowerCase()));
  const had = (k: string) => prev.has(k) || now.has(k);
  const junkKnown = had("$junk") || had("$notjunk");
  return {
    ...server,
    answered: server.answered || (!had("$answered") && local.answered),
    forwarded: server.forwarded || (!had("$forwarded") && local.forwarded),
    junk: server.junk !== null ? server.junk : junkKnown ? null : local.junk,
    tags: [...new Set([...server.tags, ...local.tags.filter(t => !prev.has(t.toLowerCase()))])].sort(),
  };
}
