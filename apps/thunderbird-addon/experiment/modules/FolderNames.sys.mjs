/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local folder (file) names for JMAP mailboxes. Pure: no Gecko imports.

/** Longest name we create, so "<name>.msf" and "<name>.sbd" fit in 255 bytes. */
const MAX_NAME = 240;

/**
 * The local folder name for a mailbox id, or null if there is none.
 *
 * Server-supplied ids become file names. RFC 8620 limits ids to
 * [A-Za-z0-9_-], but servers do not all keep to that (Mailflare uses "~"),
 * so other characters are escaped rather than refused:
 *   - a-z, 0-9, "_" and "-" are kept;
 *   - upper-case letters become "~" + lower case (case-insensitive disks);
 *   - anything else becomes "!" + two hex digits per UTF-8 byte.
 * The result uses only [a-z0-9_~!-], so it cannot hold a path separator or
 * a dot, and different ids always give different names. The "mb-" prefix
 * keeps names clear of reserved device names (con, nul…) and the store's
 * own files. Ids that are empty or too long for a file name get null.
 *
 * @param {string} mailboxId
 * @returns {?string}
 */
export function localFolderName(mailboxId) {
  if (typeof mailboxId != "string" || !mailboxId) {
    return null;
  }
  let name = "mb-";
  for (const byte of new TextEncoder().encode(mailboxId)) {
    const c = String.fromCharCode(byte);
    if (/[a-z0-9_-]/.test(c)) {
      name += c;
    } else if (/[A-Z]/.test(c)) {
      name += "~" + c.toLowerCase();
    } else {
      name += "!" + byte.toString(16).padStart(2, "0");
    }
    if (name.length > MAX_NAME) {
      return null;
    }
  }
  return name;
}
