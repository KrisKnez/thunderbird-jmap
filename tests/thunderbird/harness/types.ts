/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Shape of the test Experiment's account report (see Scenarios.sys.mjs). */
export interface FolderReport {
  path: string[];
  mailboxId: string;
  flags: string[];
  total: number;
  unread: number;
  /** Shown in the main window's folder pane. */
  inPane: boolean;
}

export interface MessageReport {
  subject: string;
  author: string;
  read: boolean;
  flagged: boolean;
  tags: string[];
  jmapId: string;
  hasBody: boolean;
  /** From junkscore: true (junk), false (not junk), null (unclassified). */
  junk: boolean | null;
  messageId: string;
  /** Keywords the server last reported for this email (lower-case, sorted); null if unknown. */
  serverKeywords: string[] | null;
}

export interface AccountReport {
  accountKey: string;
  folders: FolderReport[];
  messages: Record<string, MessageReport[]>;
  lastSyncError: string | null;
  /** "Check for new messages at startup" in the account's server settings. */
  loginAtStartUp: boolean;
}

export interface Inspection {
  accounts: AccountReport[];
  prefs: { timeFoundUnavailable: number[] };
  jmapServerPrefCount: number;
  loginCount: number;
}
