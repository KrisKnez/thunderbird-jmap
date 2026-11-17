/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JsAccount incoming server for the "jmap" type.

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
};
