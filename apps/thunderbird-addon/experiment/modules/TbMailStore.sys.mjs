/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// MailStore implementation backed by a jmap account's Thunderbird folders.
//
// Local folder names (and so file names) are derived from JMAP mailbox ids,
// which never change; the visible name is the mailbox name, set as the
// folder's pretty name. Renames therefore never move files.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { localFolderName } from "./FolderNames.sys.mjs";
import { log } from "./Log.sys.mjs";

const STATE_FILE = "jmap-sync-state.json";
const F = Ci.nsMsgFolderFlags;
const KIND_FLAGS = {
  inbox: F.Inbox,
  sent: F.SentMail,
  drafts: F.Drafts,
  trash: F.Trash,
  junk: F.Junk,
  archive: F.Archive,
};

export class TbMailStore {
  /** @param {nsIMsgIncomingServer} server */
  constructor(server) {
    this.server = server;
    this._state = undefined;
    /** @type {Map<string, Map<string, number>>} mailboxId → (jmapId → msgKey) */
    this._index = new Map();
  }

  // --- sync state ---------------------------------------------------------

  _stateFile() {
    const file = this.server.localPath.clone();
    file.append(STATE_FILE);
    return file;
  }

  /** Synchronous read (folder discovery runs inside a sync XPCOM getter). */
  readStateSync() {
    if (this._state === undefined) {
      this._state = null;
      const file = this._stateFile();
      if (file.exists()) {
        try {
          const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
            Ci.nsIFileInputStream
          );
          stream.init(file, -1, 0, 0);
          const text = NetUtil.readInputStreamToString(stream, stream.available(), {
            charset: "UTF-8",
          });
          stream.close();
          this._state = JSON.parse(text);
        } catch (e) {
          log.error(`unreadable sync state ${file.path}`, e);
        }
      }
    }
    return this._state;
  }

  async loadState() {
    const state = this.readStateSync();
    return state ? structuredClone(state) : null;
  }

  async saveState(state) {
    this._state = structuredClone(state);
    const file = this._stateFile();
    await IOUtils.writeJSON(file.path, state, { tmpPath: file.path + ".tmp" });
  }

  // --- folders ------------------------------------------------------------

  _root() {
    return this.server.rootFolder;
  }

  _folders() {
    return this._root().descendants;
  }

  /** The local folder of a mailbox, or null. */
  folderForMailbox(mailboxId) {
    return this._folders().find(f => f.getStringProperty("jmapMailboxId") == mailboxId) ?? null;
  }

  /** Recreate the folder tree from the saved mailbox list (root.subFolders getter). */
  discoverFolders() {
    const state = this.readStateSync();
    if (!state) {
      return;
    }
    const byId = new Map();
    for (const mailbox of state.mailboxes) {
      const parent = mailbox.parentId ? byId.get(mailbox.parentId) : this._root();
      if (parent && localFolderName(mailbox.id)) {
        byId.set(mailbox.id, this._ensureChild(parent, mailbox).folder);
      }
    }
  }

  _childDirectory(parent) {
    const dir = parent.filePath.clone();
    if (!parent.isServer) {
      dir.leafName += ".sbd";
    }
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    }
  }

  _ensureChild(parent, mailbox) {
    let folder = parent.subFolders.find(
      f => f.getStringProperty("jmapMailboxId") == mailbox.id
    );
    let created = false;
    if (!folder) {
      this._childDirectory(parent);
      folder = parent.addSubfolder(localFolderName(mailbox.id));
      const file = folder.filePath;
      if (!file.exists()) {
        file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      }
      created = true;
    }
    folder.setStringProperty("jmapMailboxId", mailbox.id);
    this._applyAttributes(folder, mailbox);
    return { folder, created };
  }

  _applyAttributes(folder, mailbox) {
    if (folder.name != mailbox.name) {
      folder.name = mailbox.name;
    }
    folder.setFlag(F.Mail);
    const wanted = KIND_FLAGS[mailbox.kind] ?? 0;
    for (const flag of Object.values(KIND_FLAGS)) {
      if (wanted & flag) {
        folder.setFlag(flag);
      } else if (folder.getFlag(flag)) {
        folder.clearFlag(flag);
      }
    }
  }

  _removeFolder(folder) {
    const id = folder.getStringProperty("jmapMailboxId");
    try {
      folder.parent.propagateDelete(folder, true);
    } catch (e) {
      log.error(`could not remove folder ${folder.URI}`, e);
    }
    this._index.delete(id);
  }

  async applyMailboxes(mailboxes) {
    const root = this._root();
    void root.subFolders; // make sure the saved tree was discovered
    const wanted = new Set(mailboxes.map(m => m.id));
    const gone = this._folders().filter(f => {
      const id = f.getStringProperty("jmapMailboxId");
      return id && !wanted.has(id);
    });
    for (const folder of gone) {
      // Descendants go with their removed ancestor.
      if (!gone.some(other => other != folder && other.isAncestorOf(folder))) {
        this._removeFolder(folder);
      }
    }

    let recreated = false;
    const byId = new Map();
    for (const mailbox of mailboxes) {
      const parent = mailbox.parentId ? byId.get(mailbox.parentId) : root;
      if (!parent) {
        continue;
      }
      if (!localFolderName(mailbox.id)) {
        log.warn(`skipping mailbox with invalid id ${JSON.stringify(mailbox.id)}`);
        continue;
      }
      let folder = this.folderForMailbox(mailbox.id);
      if (folder && folder.parent?.URI != parent.URI) {
        // Moved to another parent: recreate it there, then resync its mail.
        this._removeFolder(folder);
        folder = null;
        recreated = true;
      }
      if (folder) {
        this._applyAttributes(folder, mailbox);
      } else {
        const result = this._ensureChild(parent, mailbox);
        folder = result.folder;
        if (result.created) {
          MailServices.mfn.notifyFolderAdded(folder);
        }
      }
      byId.set(mailbox.id, folder);
    }

    const state = this.readStateSync() ?? {
      version: 1,
      mailboxState: null,
      emailState: null,
      mailboxes: [],
    };
    await this.saveState({
      ...state,
      mailboxes,
      ...(recreated ? { emailState: null } : {}),
    });
  }

  // --- messages -----------------------------------------------------------

  /** jmapId → msgKey for a mailbox's folder, built lazily from its database. */
  _folderIndex(mailboxId) {
    let index = this._index.get(mailboxId);
    if (!index) {
      index = new Map();
      const folder = this.folderForMailbox(mailboxId);
      if (folder) {
        for (const hdr of folder.messages) {
          const id = hdr.getStringProperty("jmapId");
          if (id) {
            index.set(id, hdr.messageKey);
          }
        }
      }
      this._index.set(mailboxId, index);
    }
    return index;
  }

  async localEmailIds(mailboxId) {
    return new Set(this._folderIndex(mailboxId).keys());
  }

  async mailboxesContaining(emailId) {
    const out = [];
    for (const folder of this._folders()) {
      const id = folder.getStringProperty("jmapMailboxId");
      if (id && this._folderIndex(id).has(emailId)) {
        out.push(id);
      }
    }
    return out;
  }

  async upsertMessage() {
    throw new Error("TbMailStore.upsertMessage is not implemented yet");
  }

  async removeMessage() {
    throw new Error("TbMailStore.removeMessage is not implemented yet");
  }

  async emailsMissingBody() {
    return [];
  }

  async storeBody() {
    throw new Error("TbMailStore.storeBody is not implemented yet");
  }
}
