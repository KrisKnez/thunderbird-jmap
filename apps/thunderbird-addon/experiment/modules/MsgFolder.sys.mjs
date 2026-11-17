/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JsAccount folder for the "jmap" type. JsAccount's C++ base does not
// discover subfolders, provide the folder database to views, signal
// "FolderLoaded" or build message URIs, so those are implemented here.

import { log } from "./Log.sys.mjs";
import { runtimeFor, syncServer } from "./AccountRegistry.sys.mjs";
import { TYPE } from "./IncomingServer.sys.mjs";

export const MESSAGE_SCHEME = "jmap-message";

export const FolderProps = {
  baseContractID: "@mozilla.org/jacppmsgfolderdelegator;1",
  baseInterfaces: [
    Ci.nsISupports,
    Ci.nsIMsgFolder,
    Ci.nsIDBChangeListener,
    Ci.nsIUrlListener,
    Ci.nsIJunkMailClassificationListener,
    Ci.nsIMsgTraitClassificationListener,
    Ci.nsIInterfaceRequestor,
    Ci.msgIOverride,
  ],
  delegateInterfaces: ["nsIMsgFolder"],
  contractID: `@mozilla.org/mail/folder-factory;1?name=${TYPE}`,
  classID: Components.ID("{73fe0dd1-2f8c-4142-bde4-9104d1c2ade7}"),
};

export function JmapFolder(delegator, baseInterfaces) {
  this.delegator = Cu.getWeakReference(delegator);
  this.cppBase = delegator.cppBase;
  baseInterfaces.forEach(iface => this.cppBase instanceof iface);
  this._discovered = false;
}

JmapFolder.prototype = {
  _JsPrototypeToDelegate: true,
  QueryInterface: ChromeUtils.generateQI(FolderProps.delegateInterfaces),
  get wrappedJSObject() {
    return this;
  },
  delegateList: null,

  // nsIMsgFolder overrides

  get incomingServerType() {
    return TYPE;
  },

  get subFolders() {
    const base = this.cppBase;
    // isServer can still be false on the first calls while the root folder
    // is being set up, so only mark discovery done once it really ran.
    if (!this._discovered && base.isServer) {
      this._discovered = true;
      try {
        runtimeFor(base.server).store.discoverFolders();
      } catch (e) {
        log.error("folder discovery failed", e);
      }
    }
    return base.subFolders;
  },

  getDBFolderInfoAndDB(folderInfo) {
    const db = this.cppBase.msgDatabase;
    folderInfo.value = db.dBFolderInfo;
    return db;
  },

  updateFolder(msgWindow) {
    const base = this.cppBase;
    syncServer(base.server, "updateFolder").catch(() => {});
    try {
      base.msgDatabase.summaryValid = true;
    } catch (e) {
      log.warn(`no database for ${base.URI}`, e);
    }
    this.delegator.get().NotifyFolderEvent("FolderLoaded");
  },

  /**
   * The C++ base cannot re-read counts from JS (and lacks this method on
   * 153/160), so adjust the pending counters until the displayed counts match
   * the database. The folder cache keeps base + pending across restarts.
   */
  updateSummaryTotals(force) {
    const base = this.cppBase;
    let info;
    try {
      info = base.msgDatabase.dBFolderInfo;
    } catch (e) {
      return;
    }
    const unreadDelta = info.numUnreadMessages - base.getNumUnread(false);
    if (unreadDelta) {
      base.changeNumPendingUnread(unreadDelta);
    }
    const totalDelta = info.numMessages - base.getTotalMessages(false);
    if (totalDelta) {
      base.changeNumPendingTotalMessages(totalDelta);
    }
  },

  getNewMessages(msgWindow, urlListener) {
    this.cppBase.server.getNewMessages(this.delegator.get(), msgWindow, urlListener);
  },

  get baseMessageURI() {
    return MESSAGE_SCHEME + this.cppBase.URI.slice(TYPE.length);
  },

  getUriForMsg(msgHdr) {
    return `${this.baseMessageURI}#${msgHdr.messageKey}`;
  },

  generateMessageURI(msgKey) {
    return `${this.baseMessageURI}#${msgKey}`;
  },
};
