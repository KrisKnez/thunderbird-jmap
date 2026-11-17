/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type { FetchLike, MethodCall, MethodResponse } from "./types.js";
export {
  JmapError,
  JmapAuthError,
  JmapHttpError,
  JmapRequestError,
  JmapMethodError,
  JmapNetworkError,
} from "./errors.js";
export { authorizationHeader, type Credentials } from "./credentials.js";
export {
  resolveUrlTemplate,
  discoverSessionUrl,
  discoverSession,
  parseSession,
  type Session,
  type SrvRecord,
  type DiscoveredSession,
} from "./session.js";
export { JmapClient, DEFAULT_USING } from "./client.js";
export {
  mailboxGet,
  mailboxChanges,
  emailChanges,
  emailQuery,
  emailGet,
  EMAIL_HEADER_PROPERTIES,
  type Mailbox,
  type EmailAddress,
  type EmailHeaderInfo,
  type Changes,
  emailSet,
  emailImport,
  type SetError,
  type EmailSetResult,
  type ImportedEmail,
} from "./mail.js";
export {
  SUBMISSION_USING,
  identityGet,
  identityChanges,
  submitEmail,
  type Identity,
} from "./submission.js";
