/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapters for Thunderbird interface differences between supported versions.

/**
 * nsIMsgMessageService.streamMessage arguments after (uri, listener):
 *   153/160: (msgWindow, urlListener, convertData, additionalHeader, localOnly)
 *   trunk:   (urlListener, convertData, additionalHeader, localOnly)
 *
 * @param {Array} args - the arguments after (uri, listener).
 * @returns {{urlListener: ?nsIUrlListener, additionalHeader: string, localOnly: boolean}}
 */
export function streamMessageArgs(args) {
  if (typeof args[1] == "boolean") {
    return { urlListener: args[0] ?? null, additionalHeader: args[2] ?? "", localOnly: !!args[3] };
  }
  return { urlListener: args[1] ?? null, additionalHeader: args[3] ?? "", localOnly: !!args[4] };
}
