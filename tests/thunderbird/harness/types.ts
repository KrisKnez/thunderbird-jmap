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
}

export interface MessageReport {
  subject: string;
  author: string;
  read: boolean;
  flagged: boolean;
  tags: string[];
  jmapId: string;
  hasBody: boolean;
}

export interface AccountReport {
  accountKey: string;
  folders: FolderReport[];
  messages: Record<string, MessageReport[]>;
  lastSyncError: string | null;
}

export interface Inspection {
  accounts: AccountReport[];
  prefs: { timeFoundUnavailable: number[] };
  jmapServerPrefCount: number;
  loginCount: number;
}
