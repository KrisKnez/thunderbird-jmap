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
    MailServices.mailSession.alertUser(message, null);
  } catch (e) {
    log.warn("could not show a notice", e);
  }
}
