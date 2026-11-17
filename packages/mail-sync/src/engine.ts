/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  JmapMethodError,
  emailChanges,
  emailGet,
  emailQuery,
  mailboxChanges,
  mailboxGet,
  type EmailHeaderInfo,
  type JmapClient,
} from "@thunderbird-jmap/jmap-client";
import { BodyFetcher } from "./bodies.js";
import { keywordsToFlags, toMailboxInfos } from "./mapping.js";
import type { MailboxInfo, MailStore, SyncState } from "./store.js";

export type LogFn = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

export interface SyncResult {
  full: boolean;
  mailboxesChanged: boolean;
  added: number;
  updated: number;
  removed: number;
}

const NEWEST_FIRST = [{ property: "receivedAt", isAscending: false }];

function isMethodError(e: unknown, type: string): boolean {
  return e instanceof JmapMethodError && e.type == type;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Mirrors one JMAP mail account's mailboxes and email headers into a MailStore. */
export class SyncEngine {
  readonly client: JmapClient;
  readonly store: MailStore;
  readonly accountId: string;
  private readonly batchSizeOption?: number;
  protected readonly log: LogFn;
  private knownMailboxes = new Set<string>();
  private readonly bodies: BodyFetcher;
  private readonly isPending: (emailId: string) => boolean;

  constructor(o: {
    client: JmapClient;
    store: MailStore;
    accountId: string;
    batchSize?: number;
    log?: LogFn;
    /** Clock for retry timing (tests). */
    now?: () => number;
    /**
     * Emails with local changes still queued for the server. Syncs leave
     * their local copies alone until the queue is done with them.
     */
    isPending?: (emailId: string) => boolean;
  }) {
    this.client = o.client;
    this.store = o.store;
    this.accountId = o.accountId;
    this.batchSizeOption = o.batchSize;
    this.log = o.log ?? (() => {});
    this.isPending = o.isPending ?? (() => false);
    this.bodies = new BodyFetcher(this.client, this.store, this.accountId, this.log, o.now);
  }

  /** Download and store bodies the store is missing; returns how many were stored. */
  downloadPendingBodies(o?: { concurrency?: number; limit?: number }): Promise<number> {
    return this.bodies.downloadPending(o);
  }

  /** Download and store one message body now (e.g. when the user opens it). */
  fetchBody(mailboxId: string, emailId: string, blobId: string): Promise<void> {
    return this.bodies.fetchBody(mailboxId, emailId, blobId);
  }

  protected async batchSize(): Promise<number> {
    if (this.batchSizeOption) return this.batchSizeOption;
    const { maxObjectsInGet } = await this.client.getSession();
    return Math.min(maxObjectsInGet, 500);
  }

  async sync(): Promise<SyncResult> {
    const result: SyncResult = { full: false, mailboxesChanged: false, added: 0, updated: 0, removed: 0 };
    let state: SyncState = (await this.store.loadState()) ?? {
      version: 1,
      mailboxState: null,
      emailState: null,
      mailboxes: [],
    };

    const mailboxes = await this.syncMailboxes(state.mailboxState);
    result.mailboxesChanged = mailboxes.changed;
    // Re-read: a store may clear emailState while applying mailboxes to ask
    // for a full email sync (e.g. after recreating a folder).
    state = {
      ...((await this.store.loadState()) ?? state),
      mailboxState: mailboxes.state,
      mailboxes: mailboxes.list,
    };
    await this.store.saveState(state);

    let emailState = state.emailState;
    if (emailState) {
      try {
        emailState = await this.deltaEmails(emailState, result);
      } catch (e) {
        if (!isMethodError(e, "cannotCalculateChanges")) throw e;
        this.log("info", "Email/changes cannot calculate changes; running a full sync");
        emailState = null;
      }
    }
    if (!emailState) {
      result.full = true;
      emailState = await this.fullEmails(result);
    }
    state = { ...(await this.store.loadState())!, emailState };
    await this.store.saveState(state);
    await this.store.emailSyncComplete?.({ full: result.full });
    this.log("info", `sync done: ${JSON.stringify(result)}`);
    return result;
  }

  /** Fetch all mailboxes and apply them; report whether anything changed. */
  private async syncMailboxes(
    since: string | null
  ): Promise<{ state: string; list: MailboxInfo[]; changed: boolean }> {
    let changed = true;
    if (since) {
      changed = false;
      try {
        for (let state = since; ; ) {
          const ch = await mailboxChanges(this.client, this.accountId, state);
          if (ch.created.length || ch.updated.length || ch.destroyed.length) changed = true;
          state = ch.newState;
          if (!ch.hasMoreChanges) break;
        }
      } catch (e) {
        if (!isMethodError(e, "cannotCalculateChanges")) throw e;
        changed = true;
      }
    }
    const { state, list } = await mailboxGet(this.client, this.accountId, null);
    const infos = toMailboxInfos(list);
    await this.store.applyMailboxes(infos);
    this.knownMailboxes = new Set(infos.map(m => m.id));
    return { state, list: infos, changed };
  }

  /** Make sure every mailbox an email references exists locally. */
  private async ensureMailboxes(ids: string[]): Promise<void> {
    if (ids.every(id => this.knownMailboxes.has(id))) return;
    const state = (await this.store.loadState())!;
    const mailboxes = await this.syncMailboxes(null);
    await this.store.saveState({ ...state, mailboxState: mailboxes.state, mailboxes: mailboxes.list });
  }

  /**
   * Fetch emails and apply the server's state to their local copies, even
   * if changes for them are queued (the queue gave up on them).
   */
  async refreshEmails(ids: string[]): Promise<void> {
    const result: SyncResult = { full: false, mailboxesChanged: false, added: 0, updated: 0, removed: 0 };
    for (const batch of chunks(ids, await this.batchSize())) {
      const { list, notFound } = await emailGet(this.client, this.accountId, batch);
      for (const email of list) await this.applyEmail(email, result, true);
      for (const id of notFound) await this.removeEverywhere(id, result, true);
    }
  }

  /** Put an email into exactly the local folders of its current mailboxes. */
  private async applyEmail(email: EmailHeaderInfo, result: SyncResult, force = false): Promise<void> {
    if (!force && this.isPending(email.id)) return;
    const current = Object.keys(email.mailboxIds);
    await this.ensureMailboxes(current);
    const local = await this.store.mailboxesContaining(email.id);
    const flags = keywordsToFlags(email.keywords);
    for (const mailboxId of current) {
      if (!this.knownMailboxes.has(mailboxId)) continue;
      await this.store.upsertMessage(mailboxId, email, flags);
      if (local.includes(mailboxId)) result.updated++;
      else result.added++;
    }
    for (const mailboxId of local) {
      if (!current.includes(mailboxId)) {
        await this.store.removeMessage(mailboxId, email.id);
        result.removed++;
      }
    }
  }

  private async removeEverywhere(emailId: string, result: SyncResult, force = false): Promise<void> {
    if (!force && this.isPending(emailId)) return;
    for (const mailboxId of await this.store.mailboxesContaining(emailId)) {
      await this.store.removeMessage(mailboxId, emailId);
      result.removed++;
    }
  }

  /**
   * Full email sync: capture the state first, page through every email
   * (anchor paging, so concurrent deletions cannot shift a page past an
   * email), drop local copies the server no longer has, then catch up with
   * one delta pass from the captured state.
   */
  private async fullEmails(result: SyncResult): Promise<string> {
    const batch = await this.batchSize();
    const startState = (await emailGet(this.client, this.accountId, [])).state;
    const seen = new Set<string>();
    let anchor: string | undefined;
    let listed = 0;
    for (;;) {
      let page;
      try {
        page = await emailQuery(this.client, this.accountId, {
          position: 0,
          limit: batch,
          sort: NEWEST_FIRST,
          ...(anchor ? { anchor, anchorOffset: 1 } : {}),
        });
      } catch (e) {
        if (!anchor || !isMethodError(e, "anchorNotFound")) throw e;
        this.log("info", "query anchor vanished; restarting the full listing");
        anchor = undefined;
        listed = 0;
        continue;
      }
      if (!page.ids.length) break;
      listed += page.ids.length;
      for (const ids of chunks(page.ids, batch)) {
        const { list } = await emailGet(this.client, this.accountId, ids);
        for (const email of list) {
          seen.add(email.id);
          await this.applyEmail(email, result);
        }
      }
      anchor = page.ids[page.ids.length - 1];
      // A short page is not the end: servers may clamp `limit`. Stop at the
      // reported total, or else at an empty page.
      if (page.total !== undefined && listed >= page.total) break;
    }
    for (const mailboxId of this.knownMailboxes) {
      for (const emailId of await this.store.localEmailIds(mailboxId)) {
        if (!seen.has(emailId) && !this.isPending(emailId)) {
          await this.store.removeMessage(mailboxId, emailId);
          result.removed++;
        }
      }
    }
    return this.deltaEmails(startState, result);
  }

  /** Apply Email/changes since `since`; returns the new state. */
  private async deltaEmails(since: string, result: SyncResult): Promise<string> {
    const batch = await this.batchSize();
    let state = since;
    for (;;) {
      const ch = await emailChanges(this.client, this.accountId, state);
      const changed = [...new Set([...ch.created, ...ch.updated])];
      for (const ids of chunks(changed, batch)) {
        const { list, notFound } = await emailGet(this.client, this.accountId, ids);
        for (const email of list) await this.applyEmail(email, result);
        for (const id of notFound) await this.removeEverywhere(id, result);
      }
      for (const id of ch.destroyed) await this.removeEverywhere(id, result);
      state = ch.newState;
      if (!ch.hasMoreChanges) break;
    }
    return state;
  }
}
