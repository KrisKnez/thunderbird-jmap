/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EmailHeaderInfo } from "@thunderbird-jmap/jmap-client";

export type FolderKind = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | null;

export interface MailboxInfo {
  id: string;
  name: string;
  parentId: string | null;
  kind: FolderKind;
  sortOrder: number;
}

export interface LocalFlags {
  read: boolean;
  flagged: boolean;
  answered: boolean;
  forwarded: boolean;
  draft: boolean;
  junk: boolean | null;
  tags: string[];
}

export interface SyncState {
  version: 1;
  mailboxState: string | null;
  emailState: string | null;
  mailboxes: MailboxInfo[];
}

/** Local mail storage the sync engine writes into (Thunderbird, or a fake). */
export interface MailStore {
  /** Create/rename/re-parent/remove local folders to match, keyed by id. */
  applyMailboxes(mailboxes: MailboxInfo[]): Promise<void>;
  localEmailIds(mailboxId: string): Promise<Set<string>>;
  mailboxesContaining(emailId: string): Promise<string[]>;
  /** Add the header (without body) or update its flags/tags. */
  upsertMessage(mailboxId: string, email: EmailHeaderInfo, flags: LocalFlags): Promise<void>;
  removeMessage(mailboxId: string, emailId: string): Promise<void>;
  emailsMissingBody(limit: number): Promise<{ mailboxId: string; emailId: string; blobId: string }[]>;
  /** Store a raw message; resolves false if the message is unknown or already stored. */
  storeBody(mailboxId: string, emailId: string, raw: Uint8Array): Promise<boolean>;
  loadState(): Promise<SyncState | null>;
  saveState(s: SyncState): Promise<void>;
  /**
   * Optional: called after a sync completed successfully, so every local
   * folder now holds a complete copy. A store can use this to detect folders
   * whose local data was lost later and request a full sync by returning
   * emailState null from loadState.
   */
  emailSyncComplete?(): Promise<void>;
}
