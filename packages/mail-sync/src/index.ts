/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type { FolderKind, MailboxInfo, LocalFlags, SyncState, MailStore } from "./store.js";
export { keywordsToFlags, roleToKind, toMailboxInfos, flagsToKeywords, keywordPatch, mergeServerFlags } from "./mapping.js";
export { SyncEngine, type SyncResult, type LogFn } from "./engine.js";
export {
  isRedirect,
  prepareForSubmission,
  sendDraft,
  RedirectNotSupportedError,
  SubmissionRefusedError,
  SubmissionUncertainError,
} from "./outgoing.js";
export { Outbox, type OutboxOp, type OutboxStorage, type OutboxHooks } from "./outbox.js";
