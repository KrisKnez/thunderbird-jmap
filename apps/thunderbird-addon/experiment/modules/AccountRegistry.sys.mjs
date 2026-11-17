/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CORE_VERSION } from "./core.sys.mjs";
import { log } from "./Log.sys.mjs";

export const coreVersion = CORE_VERSION;

let resolveReady;
const ready = new Promise(resolve => (resolveReady = resolve));

/** Resolves once the add-on finished its startup work. */
export function whenReady() {
  return ready;
}

/** Called by the Experiment's onStartup. */
export function startup() {
  log.debug(`starting, core ${CORE_VERSION}`);
  resolveReady();
}
