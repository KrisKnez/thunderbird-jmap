/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EmailHeaderInfo } from "@thunderbird-jmap/jmap-client";
import type { LocalFlags, MailboxInfo, MailStore, SyncState } from "../src/index.js";

export interface FakeMessage {
  email: EmailHeaderInfo;
  flags: LocalFlags;
  body?: Uint8Array;
}

/** In-memory MailStore for tests. */
export class FakeStore implements MailStore {
  folders = new Map<string, MailboxInfo>();
  messages = new Map<string, Map<string, FakeMessage>>();
  state: SyncState | null = null;

  private folder(mailboxId: string): Map<string, FakeMessage> {
    let folder = this.messages.get(mailboxId);
    if (!folder) {
      folder = new Map();
      this.messages.set(mailboxId, folder);
    }
    return folder;
  }

  async applyMailboxes(mailboxes: MailboxInfo[]): Promise<void> {
    const keep = new Set(mailboxes.map(m => m.id));
    for (const id of [...this.folders.keys()]) {
      if (!keep.has(id)) {
        this.folders.delete(id);
        this.messages.delete(id);
      }
    }
    for (const m of mailboxes) {
      this.folders.set(m.id, { ...m });
    }
  }

  async localEmailIds(mailboxId: string): Promise<Set<string>> {
    return new Set(this.messages.get(mailboxId)?.keys() ?? []);
  }

  async mailboxesContaining(emailId: string): Promise<string[]> {
    return [...this.messages].filter(([, f]) => f.has(emailId)).map(([id]) => id);
  }

  async upsertMessage(mailboxId: string, email: EmailHeaderInfo, flags: LocalFlags): Promise<void> {
    const folder = this.folder(mailboxId);
    const existing = folder.get(email.id);
    folder.set(email.id, { email, flags, body: existing?.body });
  }

  async removeMessage(mailboxId: string, emailId: string): Promise<void> {
    this.messages.get(mailboxId)?.delete(emailId);
  }

  async emailsMissingBody(limit: number) {
    const out: { mailboxId: string; emailId: string; blobId: string }[] = [];
    for (const [mailboxId, folder] of this.messages) {
      for (const [emailId, m] of folder) {
        if (!m.body && out.length < limit) {
          out.push({ mailboxId, emailId, blobId: m.email.blobId });
        }
      }
    }
    return out;
  }

  async storeBody(mailboxId: string, emailId: string, raw: Uint8Array): Promise<void> {
    const m = this.messages.get(mailboxId)?.get(emailId);
    if (m) {
      m.body = raw;
    }
  }

  async loadState(): Promise<SyncState | null> {
    return this.state && structuredClone(this.state);
  }

  async saveState(s: SyncState): Promise<void> {
    this.state = structuredClone(s);
  }

  /** Test helper: message map of one folder (empty if none). */
  in(mailboxId: string): Map<string, FakeMessage> {
    return this.messages.get(mailboxId) ?? new Map();
  }
}
