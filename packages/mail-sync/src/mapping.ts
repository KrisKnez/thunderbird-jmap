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
