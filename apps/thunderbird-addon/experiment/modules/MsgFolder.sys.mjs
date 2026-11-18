/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JsAccount folder for the "jmap" type. JsAccount's C++ base does not
// discover subfolders, provide the folder database to views, signal
// "FolderLoaded" or build message URIs, so those are implemented here.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { log } from "./Log.sys.mjs";
import { queueChange, runtimeFor, syncServer } from "./AccountRegistry.sys.mjs";
import { notify } from "./Notify.sys.mjs";
import { mailboxIdOf } from "./TbMailStore.sys.mjs";
import { TYPE } from "./IncomingServer.sys.mjs";

/**
 * Tell message lists showing `folder` that a move or delete from it is
 * over; until then they ignore the next Delete (nsMsgDBView waits for it).
 */
function deleteOrMoveDone(folder, ok) {
  try {
    folder.NotifyFolderEvent(ok ? "DeleteOrMoveMsgCompleted" : "DeleteOrMoveMsgFailed");
  } catch (e) {
    log.warn("could not notify the end of a move or delete", e);
  }
}

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

  /**
   * Thunderbird's copy service asks the destination to copy or move. Moves
   * within the account happen locally at once and go to the server through
   * the outbound queue; copies and moves across accounts are not supported.
   * The copy service waits for notifyCompletion before its next request.
   */
  copyMessages(srcFolder, messages, isMove, msgWindow, listener, isFolder, allowUndo) {
    const dest = this.delegator.get();
    const server = this.cppBase.server;
    const finish = status => {
      try {
        MailServices.copy.notifyCompletion(srcFolder, dest, status);
      } catch (e) {
        log.warn("copy completion failed", e);
      }
      if (isMove && !isFolder) {
        // The source's message list waits for this before its next move or delete.
        deleteOrMoveDone(srcFolder, Components.isSuccessCode(status));
      }
    };
    if (!isMove || srcFolder?.server?.key != server.key || isFolder) {
      notify(server, "Copying messages isn't available for JMAP accounts yet.");
      Promise.resolve().then(() => finish(Cr.NS_ERROR_NOT_IMPLEMENTED));
      return;
    }
    const store = runtimeFor(server).store;
    const fromMailboxId = mailboxIdOf(srcFolder);
    const toMailboxId = mailboxIdOf(dest);
    (async () => {
      for (const hdr of messages) {
        const emailId = hdr.getStringProperty("jmapId");
        if (emailId && (await store.moveLocalCopy(fromMailboxId, toMailboxId, emailId))) {
          queueChange(server, { kind: "move", emailId, fromMailboxId, toMailboxId });
        }
      }
      store.flushTouched();
    })().then(
      () => finish(Cr.NS_OK),
      e => {
        log.error("moving messages failed", e);
        finish(Cr.NS_ERROR_FAILURE);
      }
    );
  },

  /**
   * Delete messages. Outside Trash a message moves to its Trash (one copy of
   * an email in several mailboxes only leaves this mailbox); in Trash, or
   * with deleteStorage (Shift+Delete, retention, junk purge, replaced
   * drafts), it is destroyed on the server.
   */
  deleteMessages(messages, msgWindow, deleteStorage, isMove, listener, allowUndo) {
    const folder = this.delegator.get();
    const server = this.cppBase.server;
    if (isMove) {
      // Another account copied these messages and now asks to remove the
      // originals: not supported, so the move ends as a copy. Failing here
      // makes Thunderbird keep the originals and tell the message list.
      notify(server, "Moving messages to another account isn't available for JMAP accounts yet; they were copied instead.");
      throw Components.Exception("moving out of a JMAP account", Cr.NS_ERROR_NOT_IMPLEMENTED);
    }
    const store = runtimeFor(server).store;
    const mailboxId = mailboxIdOf(folder);
    const inTrash = folder.getFlag(Ci.nsMsgFolderFlags.Trash);
    const trash = inTrash ? null : store.trashFolderFor(folder);
    const trashId = trash ? mailboxIdOf(trash) : "";
    (async () => {
      for (const hdr of messages) {
        const emailId = hdr.getStringProperty("jmapId");
        if (!emailId) {
          // Only local (e.g. a draft never imported): nothing on the server.
          folder.msgDatabase.deleteHeader(hdr, null, false, true);
          continue;
        }
        // An email also in other mailboxes only leaves this one.
        const elsewhere = (await store.mailboxesContaining(emailId)).filter(id => id != mailboxId);
        if (inTrash || deleteStorage || !trashId) {
          await store.removeMessage(mailboxId, emailId);
          queueChange(
            server,
            elsewhere.length ? { kind: "removeMailbox", emailId, mailboxId } : { kind: "destroy", emailId }
          );
        } else if (elsewhere.some(id => id != trashId)) {
          await store.removeMessage(mailboxId, emailId);
          queueChange(server, { kind: "removeMailbox", emailId, mailboxId });
        } else if (await store.moveLocalCopy(mailboxId, trashId, emailId)) {
          queueChange(server, { kind: "move", emailId, fromMailboxId: mailboxId, toMailboxId: trashId });
        }
      }
      store.flushTouched();
    })().then(
      () => {
        deleteOrMoveDone(folder, true);
        listener?.onStopCopy(Cr.NS_OK);
      },
      e => {
        log.error("deleting messages failed", e);
        deleteOrMoveDone(folder, false);
        listener?.onStopCopy(Cr.NS_ERROR_FAILURE);
      }
    );
  },

  /**
   * Thunderbird saves a draft (or template) here. It is stored locally at
   * once, its key goes back to the compose window (so the next save replaces
   * it), and its import into this mailbox is queued for the server. The
   * draft it replaces is deleted.
   */
  copyFileMessage(file, msgToReplace, isDraftOrTemplate, newMsgFlags, keywords, msgWindow, listener) {
    const folder = this.delegator.get();
    const server = this.cppBase.server;
    const store = runtimeFor(server).store;
    const mailboxId = mailboxIdOf(folder);
    const DRAFT_KEYWORDS = ["$draft", "$seen"];
    const finish = status => {
      try {
        MailServices.copy.notifyCompletion(file, folder, status);
      } catch (e) {
        log.warn("copy completion failed", e);
      }
    };
    if (!isDraftOrTemplate) {
      // A message file (an .eml dropped on the folder, a message with its
      // attachments removed): copying into the account is not supported yet.
      notify(server, "Copying messages isn't available for JMAP accounts yet.");
      Promise.resolve().then(() => finish(Cr.NS_ERROR_NOT_IMPLEMENTED));
      return;
    }
    (async () => {
      const key = await store.storeLocalMessage(mailboxId, file, DRAFT_KEYWORDS);
      store.flushTouched();
      try {
        listener?.setMessageKey?.(key);
      } catch (e) {
        log.warn("could not report the saved message key", e);
      }
      queueChange(server, { kind: "importDraft", mailboxId, localKey: key, keywords: DRAFT_KEYWORDS });
      if (msgToReplace) {
        folder.deleteMessages([msgToReplace], msgWindow, true, false, null, false);
      }
    })().then(
      () => finish(Cr.NS_OK),
      e => {
        log.error("saving the draft failed", e);
        finish(Cr.NS_ERROR_FAILURE);
      }
    );
  },

  /** Empty Trash: destroy everything in this Trash, or in every Trash of the account. */
  emptyTrash(...args) {
    const urlListener = args.find(a => a && typeof a.OnStopRunningUrl == "function") ?? null;
    const folder = this.delegator.get();
    const server = this.cppBase.server;
    const store = runtimeFor(server).store;
    const trashes = folder.getFlag(Ci.nsMsgFolderFlags.Trash)
      ? [folder]
      : server.rootFolder.getFoldersWithFlags(Ci.nsMsgFolderFlags.Trash);
    (async () => {
      for (const trash of trashes) {
        const mailboxId = mailboxIdOf(trash);
        for (const hdr of [...trash.messages]) {
          const emailId = hdr.getStringProperty("jmapId");
          if (emailId) {
            // An email also in other mailboxes only leaves the Trash.
            const elsewhere = (await store.mailboxesContaining(emailId)).filter(id => id != mailboxId);
            await store.removeMessage(mailboxId, emailId);
            queueChange(
              server,
              elsewhere.length ? { kind: "removeMailbox", emailId, mailboxId } : { kind: "destroy", emailId }
            );
          } else {
            trash.msgDatabase.deleteHeader(hdr, null, false, true);
          }
        }
      }
      store.flushTouched();
    })().then(
      () => urlListener?.OnStopRunningUrl(null, Cr.NS_OK),
      e => {
        log.error("emptying Trash failed", e);
        urlListener?.OnStopRunningUrl(null, Cr.NS_ERROR_FAILURE);
      }
    );
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
