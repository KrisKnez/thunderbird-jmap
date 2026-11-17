/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Add-on logger; level from extensions.thunderbird-jmap.loglevel. */
export const log = console.createInstance({
  prefix: "thunderbird-jmap",
  maxLogLevel: "Warn",
  maxLogLevelPref: "extensions.thunderbird-jmap.loglevel",
});
