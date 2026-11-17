/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JsAccount incoming server for the "jmap" type.

import { log } from "./Log.sys.mjs";
import { syncServer } from "./AccountRegistry.sys.mjs";

export const TYPE = "jmap";

export const ServerProps = {
  baseContractID: "@mozilla.org/jacppincomingserverdelegator;1",
  baseInterfaces: [
    Ci.nsISupports,
    Ci.nsIMsgIncomingServer,
    Ci.nsIInterfaceRequestor,
    Ci.msgIOverride,
    Ci.nsISupportsWeakReference,
  ],
  delegateInterfaces: ["nsIMsgIncomingServer"],
  contractID: `@mozilla.org/messenger/server;1?type=${TYPE}`,
  classID: Components.ID("{659c7abf-65e9-4242-880e-2b251171101b}"),
};

export function JmapServer(delegator, baseInterfaces) {
  this.delegator = Cu.getWeakReference(delegator);
  this.cppBase = delegator.cppBase;
  baseInterfaces.forEach(iface => this.cppBase instanceof iface);
}

JmapServer.prototype = {
  _JsPrototypeToDelegate: true,
  QueryInterface: ChromeUtils.generateQI(ServerProps.delegateInterfaces),
  get wrappedJSObject() {
    return this;
  },
  delegateList: null,

  // nsIMsgIncomingServer overrides
  get localStoreType() {
    return TYPE;
  },
  get localDatabaseType() {
    return "mailbox";
  },

  /** "Get Messages": sync the whole account. */
  getNewMessages(folder, msgWindow, urlListener) {
    const server = this.delegator.get();
    syncServer(server, "getNewMessages").then(
      () => notifyStopped(urlListener, Cr.NS_OK),
      () => notifyStopped(urlListener, Cr.NS_ERROR_FAILURE)
    );
  },

  /** Periodic new-mail check. */
  performBiff(msgWindow) {
    syncServer(this.delegator.get(), "biff").catch(() => {});
  },
};

function notifyStopped(urlListener, status) {
  try {
    urlListener?.OnStopRunningUrl(null, status);
  } catch (e) {
    log.warn("url listener failed", e);
  }
}
