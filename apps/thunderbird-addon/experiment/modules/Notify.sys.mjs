/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Non-blocking notices to the user (Thunderbird's alert bar in the main window).

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { log } from "./Log.sys.mjs";

export function notify(server, text) {
  const message = `${server.prettyName}: ${text}`;
  log.info(`notice: ${message}`);
  try {
    // (message, url, silent) on 153–160; not silent: the main window shows it.
    MailServices.mailSession.alertUser(message, null, false);
  } catch (e) {
    log.warn("could not show a notice", e);
  }
}
