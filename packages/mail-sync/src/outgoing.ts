/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Preparing a composed message for JMAP submission and sending it.

import { JmapNetworkError, submitEmail, type JmapClient, type SetError } from "@thunderbird-jmap/jmap-client";

/** Thunderbird's Redirect: refused, as some servers would send to the original recipients. */
export class RedirectNotSupportedError extends Error {
  constructor() {
    super("Redirect isn't available for JMAP accounts.");
    this.name = "RedirectNotSupportedError";
  }
}

/** The server answered and did not send the message. */
export class SubmissionRefusedError extends Error {
  constructor(readonly error: SetError) {
    super(error.description ?? error.type);
    this.name = "SubmissionRefusedError";
  }
}

/** The connection failed while the submission request was out: it may have been sent. */
export class SubmissionUncertainError extends Error {
  constructor(readonly cause: unknown) {
    super("The connection was lost while sending.");
    this.name = "SubmissionUncertainError";
  }
}

/** Where the header block ends: index of the blank line's first byte, and the line ending used. */
function headerEnd(raw: Uint8Array): { at: number; eol: string } {
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] == 0x0a && raw[i + 1] == 0x0a) {
      return { at: i + 1, eol: "\n" };
    }
    if (raw[i] == 0x0d && raw[i + 1] == 0x0a && raw[i + 2] == 0x0d && raw[i + 3] == 0x0a) {
      return { at: i + 2, eol: "\r\n" };
    }
  }
  return { at: raw.length, eol: "\r\n" };
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** A Resent-* header in the header block marks Thunderbird's Redirect. */
export function isRedirect(raw: Uint8Array): boolean {
  const head = latin1(raw.subarray(0, headerEnd(raw).at));
  return /^resent-(from|to|cc|bcc|date|sender|message-id)\s*:/im.test(head);
}

/**
 * Add a Bcc header listing the Bcc recipients (Thunderbird's file has none).
 * Servers that rebuild the message from the draft (Mailflare) read it there;
 * standard servers remove it during delivery (RFC 8621 §7.5).
 */
export function prepareForSubmission(raw: Uint8Array, bcc: string[]): Uint8Array {
  if (!bcc.length) {
    return raw;
  }
  const { at, eol } = headerEnd(raw);
  const line = new TextEncoder().encode(`Bcc: ${bcc.join(", ")}${eol}`);
  const out = new Uint8Array(raw.length + line.length);
  out.set(raw.subarray(0, at), 0);
  out.set(line, at);
  out.set(raw.subarray(at), at + line.length);
  return out;
}

function unique(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter(a => {
    const key = a.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Send a composed message from a JMAP identity: refuse a redirect, add the
 * Bcc header, upload, then import into Drafts and submit to exactly these
 * recipients in one request. Never retried here.
 */
export async function sendDraft(
  client: JmapClient,
  accountId: string,
  o: {
    raw: Uint8Array;
    bcc: string[];
    to: string[];
    identity: { id: string; email: string };
    draftsMailboxId: string;
    sentMailboxId: string;
  }
): Promise<{ submissionId: string }> {
  if (isRedirect(o.raw)) {
    throw new RedirectNotSupportedError();
  }
  const prepared = prepareForSubmission(o.raw, o.bcc);
  const { blobId } = await client.uploadBlob(accountId, prepared, "message/rfc822");
  let result;
  try {
    result = await submitEmail(client, accountId, {
      blobId,
      identityId: o.identity.id,
      draftsMailboxId: o.draftsMailboxId,
      sentMailboxId: o.sentMailboxId,
      envelope: { mailFrom: o.identity.email, rcptTo: unique([...o.to, ...o.bcc]) },
    });
  } catch (e) {
    if (e instanceof JmapNetworkError) {
      throw new SubmissionUncertainError(e);
    }
    throw e;
  }
  if (result.error || !result.submissionId) {
    throw new SubmissionRefusedError(result.error ?? { type: "serverFail" });
  }
  return { submissionId: result.submissionId };
}
