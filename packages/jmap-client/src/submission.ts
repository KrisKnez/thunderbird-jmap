/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Identities and sending (RFC 8621 §6, §7).

import type { JmapClient } from "./client.js";
import type { Changes, SetError } from "./mail.js";

export const SUBMISSION_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

export interface Identity {
  id: string;
  email: string;
  name: string;
}

export async function identityGet(c: JmapClient, accountId: string): Promise<{ state: string; list: Identity[] }> {
  const r = await c.call<{ state: string; list: Identity[] }>("Identity/get", { accountId }, SUBMISSION_USING);
  return { state: r.state, list: r.list.map(i => ({ id: i.id, email: i.email, name: i.name ?? "" })) };
}

export function identityChanges(c: JmapClient, accountId: string, sinceState: string): Promise<Changes> {
  return c.call("Identity/changes", { accountId, sinceState }, SUBMISSION_USING);
}

/**
 * Send an uploaded raw message in one request: import it into Drafts as a
 * draft, submit it with an explicit envelope, and on success move it from
 * Drafts to Sent and clear $draft. Errors from either step come back as
 * `error`; nothing is retried.
 */
export async function submitEmail(
  c: JmapClient,
  accountId: string,
  o: {
    blobId: string;
    draftsMailboxId: string;
    sentMailboxId: string;
    identityId: string;
    envelope: { mailFrom: string; rcptTo: string[] };
  }
): Promise<{ submissionId?: string; error?: SetError; draftId?: string }> {
  const responses = await c.request(
    [
      [
        "Email/import",
        {
          accountId,
          emails: {
            draft: {
              blobId: o.blobId,
              mailboxIds: { [o.draftsMailboxId]: true },
              keywords: { $draft: true, $seen: true },
            },
          },
        },
        "import",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            send: {
              identityId: o.identityId,
              emailId: "#draft",
              envelope: {
                mailFrom: { email: o.envelope.mailFrom },
                rcptTo: o.envelope.rcptTo.map(email => ({ email })),
              },
            },
          },
          onSuccessUpdateEmail: {
            "#send": {
              [`mailboxIds/${o.draftsMailboxId}`]: null,
              [`mailboxIds/${o.sentMailboxId}`]: true,
              "keywords/$draft": null,
            },
          },
        },
        "submit",
      ],
    ],
    SUBMISSION_USING
  );
  const result = (callId: string) => responses.find(r => r[2] == callId);
  const imported = result("import");
  const draftId = imported?.[0] == "Email/import" ? (imported[1] as any).created?.draft?.id : undefined;
  if (!draftId) {
    const error =
      imported?.[0] == "error"
        ? { type: String(imported[1].type), description: imported[1].description as string | undefined }
        : ((imported?.[1] as any)?.notCreated?.draft as SetError | undefined);
    return { error: error ?? { type: "serverFail", description: "No result for Email/import" } };
  }
  const submitted = result("submit");
  if (submitted?.[0] == "error") {
    return { draftId, error: { type: String(submitted[1].type), description: submitted[1].description as string | undefined } };
  }
  const sub = submitted?.[1] as any;
  const submissionId = sub?.created?.send?.id;
  if (submissionId) {
    return { submissionId, draftId };
  }
  return { draftId, error: sub?.notCreated?.send ?? { type: "serverFail", description: "No result for EmailSubmission/set" } };
}
