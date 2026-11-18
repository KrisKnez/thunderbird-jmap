/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The outbound queue: local changes waiting to reach the server, kept in
// order, persisted before enqueue() returns, sent serially in batches.

import {
  emailImport,
  emailSet,
  JmapAuthError,
  JmapHttpError,
  JmapMethodError,
  JmapRequestError,
  type ImportedEmail,
  type JmapClient,
  type SetError,
} from "@thunderbird-jmap/jmap-client";
import type { LogFn } from "./engine.js";
import { escapePointer } from "./mapping.js";

export type OutboxOp =
  | { kind: "keywords"; emailId: string; patch: Record<string, true | null> }
  | { kind: "move"; emailId: string; fromMailboxId: string; toMailboxId: string }
  | { kind: "removeMailbox"; emailId: string; mailboxId: string }
  | { kind: "destroy"; emailId: string }
  | { kind: "importDraft"; mailboxId: string; localKey: number; keywords: string[] };

type ImportDraftOp = Extract<OutboxOp, { kind: "importDraft" }>;
type EmailOp = Exclude<OutboxOp, ImportDraftOp>;

export interface OutboxStorage {
  load(): Promise<OutboxOp[]>;
  save(ops: OutboxOp[]): Promise<void>;
}

export interface OutboxHooks {
  /** The raw draft to import; null drops the op (the local draft is gone). */
  readDraft(op: ImportDraftOp): Promise<Uint8Array | null>;
  onApplied(op: OutboxOp, imported?: ImportedEmail): Promise<void>;
  onRefused(op: OutboxOp, error: SetError): Promise<void>;
}

const isEmailOp = (op: OutboxOp): op is EmailOp => op.kind != "importDraft";

/**
 * A request-level failure caused by what was sent (not by the network, the
 * credentials or a server that is down): the ops are refused, not retried.
 */
function isRefusal(e: unknown): e is JmapMethodError | JmapRequestError | JmapHttpError {
  if (e instanceof JmapAuthError) return false;
  if (e instanceof JmapMethodError) return e.type != "serverUnavailable";
  if (e instanceof JmapRequestError || e instanceof JmapHttpError) {
    return e.status >= 400 && e.status < 500 && e.status != 429;
  }
  return false;
}

function refusalOf(e: JmapMethodError | JmapRequestError | JmapHttpError): SetError {
  if (e instanceof JmapHttpError) return { type: `HTTP ${e.status}` };
  if (e instanceof JmapRequestError) return { type: e.type, description: e.detail };
  return { type: e.type, description: e.description };
}

/**
 * Add `op` to the queue, merging it with what is already queued for the
 * same email. Ops being sent (`sending`) are never merged into or removed:
 * the new op goes after them.
 */
function coalesce(ops: OutboxOp[], op: OutboxOp, sending: Set<OutboxOp>): OutboxOp[] {
  if (!isEmailOp(op)) {
    return [...ops, op];
  }
  const same = (o: OutboxOp) => isEmailOp(o) && o.emailId == op.emailId && !sending.has(o);
  if (op.kind == "destroy") {
    return [...ops.filter(o => !same(o)), op];
  }
  if (ops.some(o => same(o) && o.kind == "destroy")) {
    return ops; // already being destroyed
  }
  if (op.kind == "keywords") {
    // The watcher sends the whole difference from the server each time, so
    // the newest replaces what is queued, and an empty one cancels it.
    const rest = ops.filter(o => !(same(o) && o.kind == "keywords"));
    return Object.keys(op.patch).length ? [...rest, op] : rest;
  }
  if (op.kind == "move") {
    const index = ops.findIndex(o => same(o) && o.kind == "move" && o.toMailboxId == op.fromMailboxId);
    if (index >= 0) {
      const earlier = ops[index] as typeof op;
      if (earlier.fromMailboxId == op.toMailboxId) {
        return ops.filter((_, i) => i != index); // moved back: nothing to do
      }
      return ops.map((o, i) => (i == index ? { ...earlier, toMailboxId: op.toMailboxId } : o));
    }
  }
  return [...ops, op];
}

/** The Email/set patch entries for one op. */
function patchOf(op: EmailOp): Record<string, true | null> {
  switch (op.kind) {
    case "keywords":
      return op.patch;
    case "move":
      return {
        [`mailboxIds/${escapePointer(op.fromMailboxId)}`]: null,
        [`mailboxIds/${escapePointer(op.toMailboxId)}`]: true,
      };
    case "removeMailbox":
      return { [`mailboxIds/${escapePointer(op.mailboxId)}`]: null };
    default:
      return {};
  }
}

export class Outbox {
  private ops: OutboxOp[] = [];
  private running: Promise<void> | null = null;
  /** Ops in the request now on its way to the server. */
  private readonly sending = new Set<OutboxOp>();
  /** The save that will write the queue as it is at the end of this tick. */
  private pendingSave: Promise<void> | null = null;
  private readonly client: JmapClient;
  private readonly accountId: string;
  private readonly storage: OutboxStorage;
  private readonly hooks: OutboxHooks;
  private readonly batchSizeOption?: number;
  private readonly log: LogFn;
  private readonly later: (fn: () => void) => void;

  constructor(o: {
    client: JmapClient;
    accountId: string;
    storage: OutboxStorage;
    hooks: OutboxHooks;
    batchSize?: number;
    log?: LogFn;
    /** Run `fn` after the current task (Thunderbird's modules have no global setTimeout). */
    later?: (fn: () => void) => void;
  }) {
    this.client = o.client;
    this.accountId = o.accountId;
    this.storage = o.storage;
    this.hooks = o.hooks;
    this.batchSizeOption = o.batchSize;
    this.log = o.log ?? (() => {});
    this.later = o.later ?? (fn => setTimeout(fn, 0));
  }

  async load(): Promise<void> {
    this.ops = await this.storage.load();
  }

  /** Queue a change; resolves once the queue (with it) is saved. */
  enqueue(op: OutboxOp): Promise<void> {
    const before = this.ops;
    this.ops = coalesce(this.ops, op, this.sending);
    return this.ops == before ? Promise.resolve() : this.save();
  }

  /** Write the queue once for all changes made in this tick. */
  private save(): Promise<void> {
    this.pendingSave ??= new Promise<void>(resolve => this.later(resolve)).then(() => {
      this.pendingSave = null;
      return this.storage.save(this.ops);
    });
    return this.pendingSave;
  }

  /** Emails with changes still waiting for the server. */
  pendingEmailIds(): Set<string> {
    return new Set(this.ops.filter(isEmailOp).map(op => op.emailId));
  }

  get size(): number {
    return this.ops.length;
  }

  /**
   * Send everything queued, one flush at a time. A request the server
   * rejects outright is narrowed down to the email that caused it, whose
   * ops are refused; network, credential and server-side failures throw
   * and keep the queue.
   */
  flush(): Promise<{ applied: number; refused: number }> {
    const run = async () => {
      const total = { applied: 0, refused: 0 };
      let single = false;
      while (this.ops.length) {
        const head = this.ops[0];
        let r: { applied: number; refused: number };
        try {
          r = isEmailOp(head) ? await this.sendBatch(single ? 1 : undefined) : await this.sendDraft(head);
          single = false;
        } catch (e) {
          if (!isRefusal(e)) throw e;
          if (isEmailOp(head) && !single) {
            single = true; // try the first email alone
            continue;
          }
          r = await this.refuse(isEmailOp(head) ? this.takeBatch(1) : [head], refusalOf(e));
          single = false;
        }
        total.applied += r.applied;
        total.refused += r.refused;
      }
      return total;
    };
    // Serialize: start after any flush in progress, whatever its outcome.
    const next = (this.running ?? Promise.resolve()).then(run);
    const settled = next.then(
      () => {},
      () => {}
    );
    this.running = settled;
    settled.then(() => {
      if (this.running === settled) this.running = null;
    });
    return next;
  }

  private async batchSize(): Promise<number> {
    if (this.batchSizeOption) return this.batchSizeOption;
    const core = (await this.client.getSession()).capabilities["urn:ietf:params:jmap:core"] as
      | { maxObjectsInSet?: number }
      | undefined;
    return core?.maxObjectsInSet ?? 50;
  }

  /** Remove sent ops from the queue (by identity) and persist. */
  private async drop(sent: OutboxOp[]): Promise<void> {
    const gone = new Set(sent);
    this.ops = this.ops.filter(op => !gone.has(op));
    await this.storage.save(this.ops);
  }

  /** The leading email ops, for at most `limit` emails. */
  private takeBatch(limit: number): EmailOp[] {
    const batch: EmailOp[] = [];
    const emails = new Set<string>();
    for (const op of this.ops) {
      if (!isEmailOp(op)) break;
      if (!emails.has(op.emailId) && emails.size >= limit) break;
      emails.add(op.emailId);
      batch.push(op);
    }
    return batch;
  }

  /** Report ops as refused and drop them. */
  private async refuse(ops: OutboxOp[], error: SetError): Promise<{ applied: number; refused: number }> {
    for (const op of ops) {
      this.log("info", `server refused ${op.kind}${isEmailOp(op) ? ` for ${op.emailId}` : ""}: ${error.type} ${error.description ?? ""}`);
      await this.hooks.onRefused(op, error);
    }
    await this.drop(ops);
    return { applied: 0, refused: ops.length };
  }

  /** One Email/set for the leading email ops, at most `limit` (default: the batch size) emails. */
  private async sendBatch(limit?: number): Promise<{ applied: number; refused: number }> {
    const batch = this.takeBatch(limit ?? (await this.batchSize()));
    // An email's ops become one patch, merged in order: later entries win,
    // as if they were applied one after another.
    const update: Record<string, Record<string, true | null>> = {};
    const destroy: string[] = [];
    for (const op of batch) {
      if (op.kind == "destroy") destroy.push(op.emailId);
      else update[op.emailId] = { ...update[op.emailId], ...patchOf(op) };
    }
    for (const op of batch) this.sending.add(op);
    let result;
    try {
      result = await emailSet(this.client, this.accountId, {
        ...(Object.keys(update).length ? { update } : {}),
        ...(destroy.length ? { destroy } : {}),
      });
    } finally {
      this.sending.clear();
    }
    let applied = 0;
    let refused = 0;
    for (const op of batch) {
      const error = op.kind == "destroy" ? result.notDestroyed[op.emailId] : result.notUpdated[op.emailId];
      if (error) {
        refused++;
        this.log("info", `server refused ${op.kind} for ${op.emailId}: ${error.type} ${error.description ?? ""}`);
        await this.hooks.onRefused(op, error);
      } else {
        applied++;
        await this.hooks.onApplied(op);
      }
    }
    await this.drop(batch);
    return { applied, refused };
  }

  private async sendDraft(op: ImportDraftOp): Promise<{ applied: number; refused: number }> {
    const raw = await this.hooks.readDraft(op);
    if (!raw) {
      await this.drop([op]);
      return { applied: 0, refused: 0 };
    }
    this.sending.add(op);
    let r;
    try {
      const { blobId } = await this.client.uploadBlob(this.accountId, raw, "message/rfc822");
      r = await emailImport(this.client, this.accountId, {
        draft: {
          blobId,
          mailboxIds: { [op.mailboxId]: true },
          keywords: Object.fromEntries(op.keywords.map(k => [k, true as const])),
        },
      });
    } finally {
      this.sending.clear();
    }
    const created = r.created.draft;
    if (created) {
      await this.hooks.onApplied(op, created);
      await this.drop([op]);
      return { applied: 1, refused: 0 };
    }
    await this.hooks.onRefused(op, r.notCreated.draft ?? { type: "serverFail" });
    await this.drop([op]);
    return { applied: 0, refused: 1 };
  }
}
