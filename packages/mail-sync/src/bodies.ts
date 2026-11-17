/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { JmapClient } from "@thunderbird-jmap/jmap-client";
import type { LogFn } from "./engine.js";
import type { MailStore } from "./store.js";

/** Run `fn` over `items` with at most `concurrency` in flight. */
async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** How long a body whose download failed is left alone before it is tried again. */
export const RETRY_FAILED_MS = 60 * 60 * 1000;

const entryKey = (mailboxId: string, emailId: string) => `${mailboxId}\n${emailId}`;

/** Downloads raw messages into the store, sharing concurrent downloads of a blob. */
export class BodyFetcher {
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  /** (mailbox, email) → when its body last failed to download. */
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly client: JmapClient,
    private readonly store: MailStore,
    private readonly accountId: string,
    private readonly log: LogFn,
    private readonly now: () => number = Date.now
  ) {}

  private download(blobId: string): Promise<Uint8Array> {
    let promise = this.inflight.get(blobId);
    if (!promise) {
      promise = this.client
        .downloadBlob(this.accountId, blobId)
        .finally(() => this.inflight.delete(blobId));
      this.inflight.set(blobId, promise);
    }
    return promise;
  }

  async fetchBody(mailboxId: string, emailId: string, blobId: string): Promise<void> {
    await this.store.storeBody(mailboxId, emailId, await this.download(blobId));
  }

  /**
   * Store up to `limit` missing bodies (one download per blob). A body that
   * fails is logged and left alone for RETRY_FAILED_MS, so bodies that keep
   * failing never fill the window and hold up the rest.
   */
  async downloadPending(o: { concurrency?: number; limit?: number } = {}): Promise<number> {
    const limit = o.limit ?? 200;
    const now = this.now();
    for (const [key, at] of this.failedAt) {
      if (now - at >= RETRY_FAILED_MS) {
        this.failedAt.delete(key);
      }
    }
    // Ask for enough entries to see past every recently failed one.
    const missing = (await this.store.emailsMissingBody(limit + this.failedAt.size))
      .filter(m => !this.failedAt.has(entryKey(m.mailboxId, m.emailId)))
      .slice(0, limit);
    const byBlob = new Map<string, { mailboxId: string; emailId: string }[]>();
    for (const m of missing) {
      byBlob.set(m.blobId, [...(byBlob.get(m.blobId) ?? []), m]);
    }
    let stored = 0;
    await pool([...byBlob], o.concurrency ?? 4, async ([blobId, copies]) => {
      let raw: Uint8Array;
      try {
        raw = await this.download(blobId);
      } catch (e) {
        this.log("warn", `body download failed for blob ${blobId}: ${e}`);
        for (const { mailboxId, emailId } of copies) {
          this.failedAt.set(entryKey(mailboxId, emailId), this.now());
        }
        return;
      }
      for (const { mailboxId, emailId } of copies) {
        // Only real stores count: a store that keeps declining must not keep
        // a caller's "download until nothing is left" loop alive.
        if (await this.store.storeBody(mailboxId, emailId, raw)) {
          stored++;
        }
      }
    });
    return stored;
  }
}
