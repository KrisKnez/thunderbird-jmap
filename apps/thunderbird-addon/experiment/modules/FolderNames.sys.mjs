/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local folder (file) names for JMAP mailboxes. Pure: no Gecko imports.

const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * The local folder name for a mailbox id, or null if the id is not a valid
 * RFC 8620 Id. Server-supplied ids become file names, so anything outside
 * [A-Za-z0-9_-] (e.g. "..", "/") is refused. The "mb-" prefix keeps names
 * clear of reserved device names (con, nul…) and the store's own files;
 * upper-case letters become "~" + lower case for case-insensitive disks.
 *
 * @param {string} mailboxId
 * @returns {?string}
 */
export function localFolderName(mailboxId) {
  if (typeof mailboxId != "string" || !JMAP_ID.test(mailboxId)) {
    return null;
  }
  return "mb-" + mailboxId.replace(/[A-Z]/g, c => "~" + c.toLowerCase());
}
