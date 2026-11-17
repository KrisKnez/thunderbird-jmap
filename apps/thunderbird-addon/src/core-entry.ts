/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bundled by esbuild into experiment/modules/core.sys.mjs.

declare const __CORE_VERSION__: string;

/** The repo version this bundle was built from. */
export const CORE_VERSION: string = __CORE_VERSION__;

export {
  JmapClient,
  discoverSessionUrl,
  discoverSession,
  JmapError,
  JmapAuthError,
  JmapHttpError,
  JmapRequestError,
  JmapMethodError,
  JmapNetworkError,
  mailboxGet,
  emailGet,
  identityGet,
} from "@thunderbird-jmap/jmap-client";
export {
  SyncEngine,
  keywordsToFlags,
  roleToKind,
  toMailboxInfos,
  sendDraft,
  RedirectNotSupportedError,
  SubmissionRefusedError,
  SubmissionUncertainError,
} from "@thunderbird-jmap/mail-sync";
