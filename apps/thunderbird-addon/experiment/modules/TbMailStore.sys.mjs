/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// MailStore implementation backed by a jmap account's Thunderbird folders.
//
// Local folder names (and so file names) are derived from JMAP mailbox ids,
// which never change; the visible name is the mailbox name, set as the
// folder's `name`. Renames therefore never move files.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { localFolderName } from "./FolderNames.sys.mjs";
import { log } from "./Log.sys.mjs";
import { mergeServerFlags } from "./core.sys.mjs";

/** Header property: the keywords the server last reported (JSON array, lower-case, sorted). */
const SERVER_KEYWORDS = "jmapServerKeywords";
/** Header property: keywords this server does not keep (space-separated), local-only. */
const LOCAL_KEYWORDS = "jmapLocalKeywords";

function keywordList(keywords) {
  return [...new Set(Object.keys(keywords ?? {}).map(k => k.toLowerCase()))].sort();
}

/** The server's keywords as last seen, or null when unknown (headers from before Phase 2). */
function storedServerKeywords(hdr) {
  const value = hdr.getStringProperty(SERVER_KEYWORDS);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

/** The keywords the server last reported for this header ([] when unknown). */
export function serverKeywordsOf(hdr) {
  return storedServerKeywords(hdr) ?? [];
}

/** Keywords known to be local-only for this header. */
export function localOnlyOf(hdr) {
  return (hdr.getStringProperty(LOCAL_KEYWORDS) || "").split(" ").filter(Boolean);
}

/** The header's local state as LocalFlags. */
export function localFlagsOf(hdr) {
  const M = Ci.nsMsgMessageFlags;
  const junk = hdr.getStringProperty("junkscore");
  return {
    read: hdr.isRead,
    flagged: hdr.isFlagged,
    answered: !!(hdr.flags & M.Replied),
    forwarded: !!(hdr.flags & M.Forwarded),
    // Thunderbird keeps no draft flag on a header: $draft follows the server.
    draft: serverKeywordsOf(hdr).includes("$draft"),
    junk: junk == "100" ? true : junk == "0" ? false : null,
    tags: (hdr.getStringProperty("keywords") || "").split(" ").filter(Boolean),
  };
}

const STATE_FILE = "jmap-sync-state.json";
/**
 * Set in a folder database's folder info once the folder holds a complete
 * copy of its mailbox. A known folder without it lost its database (or was
 * recreated), so the next sync must be a full one.
 */
const COMPLETE_MARKER = "jmapComplete";
const F = Ci.nsMsgFolderFlags;
const KIND_FLAGS = {
  inbox: F.Inbox,
  sent: F.SentMail,
  drafts: F.Drafts,
  trash: F.Trash,
  junk: F.Junk,
  archive: F.Archive,
};

/**
 * The mailbox id of a local folder ("" for none). A folder whose database
 * was lost (its .msf deleted or found damaged) refuses to read properties
 * until the database is opened again; opening it creates an empty one,
 * which is then refilled by a full sync, as the folder is no longer marked
 * complete.
 */
export function mailboxIdOf(folder) {
  try {
    return folder.getStringProperty("jmapMailboxId");
  } catch (e) {
    try {
      void folder.msgDatabase;
      return folder.getStringProperty("jmapMailboxId");
    } catch (e2) {
      log.warn(`cannot read folder ${folder.URI}`, e2);
      return "";
    }
  }
}

export class TbMailStore {
  /** @param {nsIMsgIncomingServer} server */
  constructor(server) {
    this.server = server;
    this._state = undefined;
    /** @type {Map<string, Map<string, number>>} mailboxId → (jmapId → msgKey) */
    this._index = new Map();
    /** Folders whose database changed since the last saveState. */
    this._touched = new Set();
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

  /** Sync state; emailState is null when a folder needs a full resync. */
  async loadState() {
    const state = this.readStateSync();
    if (!state) {
      return null;
    }
    const copy = structuredClone(state);
    if (copy.emailState) {
      const incomplete = copy.mailboxes
        .filter(m => localFolderName(m.id))
        .map(m => this.folderForMailbox(m.id))
        .filter(folder => !folder || !this._isComplete(folder));
      if (incomplete.length) {
        log.info(`${incomplete.length} folder(s) lost their local copy; full sync needed`);
        this._index.clear();
        copy.emailState = null;
      }
    }
    return copy;
  }

  /**
   * After a full sync every folder holds a complete copy of its mailbox.
   * After a delta sync nothing new is complete (folders for new mailboxes
   * were marked when created), and a folder whose database was lost while
   * the sync ran must stay unmarked so the next sync refills it.
   */
  async emailSyncComplete({ full } = { full: false }) {
    if (!full) {
      return;
    }
    for (const folder of this._folders()) {
      if (mailboxIdOf(folder)) {
        this._markComplete(folder);
      }
    }
  }

  _isComplete(folder) {
    try {
      return folder.msgDatabase.dBFolderInfo.getCharProperty(COMPLETE_MARKER) == "1";
    } catch (e) {
      return false;
    }
  }

  _markComplete(folder) {
    try {
      const db = folder.msgDatabase;
      if (db.dBFolderInfo.getCharProperty(COMPLETE_MARKER) != "1") {
        db.dBFolderInfo.setCharProperty(COMPLETE_MARKER, "1");
        db.commit(Ci.nsMsgDBCommitType.kLargeCommit);
      }
    } catch (e) {
      log.warn(`could not mark ${folder.URI} complete`, e);
    }
  }

  async saveState(state) {
    this.flushTouched();
    this._state = structuredClone(state);
    const file = this._stateFile();
    await IOUtils.writeJSON(file.path, state, { tmpPath: file.path + ".tmp" });
  }

  /** Commit changed folder databases and refresh their counts. */
  flushTouched() {
    for (const folder of this._touched) {
      try {
        folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
        folder.updateSummaryTotals(true);
      } catch (e) {
        log.warn(`could not commit ${folder.URI}`, e);
      }
    }
    this._touched.clear();
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
    return this._folders().find(f => mailboxIdOf(f) == mailboxId) ?? null;
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
      f => mailboxIdOf(f) == mailbox.id
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
    const id = mailboxIdOf(folder);
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
    const known = new Set((this.readStateSync()?.mailboxes ?? []).map(m => m.id));
    const wanted = new Set(mailboxes.map(m => m.id));
    const gone = this._folders().filter(f => {
      const id = mailboxIdOf(f);
      return id && !wanted.has(id);
    });
    for (const folder of gone) {
      // Descendants go with their removed ancestor.
      if (!gone.some(other => other != folder && other.isAncestorOf(folder))) {
        this._removeFolder(folder);
      }
    }

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
        // Moved to another parent: recreate it there. It is left unmarked,
        // so the next loadState asks for a full sync to refill it.
        this._removeFolder(folder);
        folder = null;
      }
      if (folder) {
        this._applyAttributes(folder, mailbox);
      } else {
        const result = this._ensureChild(parent, mailbox);
        folder = result.folder;
        if (result.created) {
          if (!known.has(mailbox.id)) {
            // A new mailbox: its mail arrives through ordinary changes.
            this._markComplete(folder);
          }
          MailServices.mfn.notifyFolderAdded(folder);
          // The folder pane listens to folder listeners (onFolderAdded),
          // not to the notification service above.
          parent.notifyFolderAdded(folder);
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
    await this.saveState({ ...state, mailboxes });
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
      const id = mailboxIdOf(folder);
      if (id && this._folderIndex(id).has(emailId)) {
        out.push(id);
      }
    }
    return out;
  }

  /** MIME-encoded address list (header attributes are byte strings). */
  _addressHeader(addresses) {
    if (!addresses?.length) {
      return "";
    }
    return MailServices.headerParser.makeMimeHeader(
      addresses.map(a => MailServices.headerParser.makeMailboxObject(a.name ?? "", a.email))
    );
  }

  _flagBits(flags, email) {
    const M = Ci.nsMsgMessageFlags;
    let bits = 0;
    if (flags.read) bits |= M.Read;
    if (flags.flagged) bits |= M.Marked;
    if (flags.answered) bits |= M.Replied;
    if (flags.forwarded) bits |= M.Forwarded;
    if (email.hasAttachment) bits |= M.Attachment;
    return bits;
  }

  async upsertMessage(mailboxId, email, flags) {
    const folder = this.folderForMailbox(mailboxId);
    if (!folder) {
      return;
    }
    const db = folder.msgDatabase;
    const index = this._folderIndex(mailboxId);
    const existingKey = index.get(email.id);
    const existing = existingKey === undefined ? null : db.getMsgHdrForKey(existingKey);
    this._touched.add(folder);
    if (existing) {
      this._updateFlags(db, existing, flags, email);
      return;
    }

    const hdr = db.createNewHdr();
    let subject = email.subject ?? "";
    const re = /^(re\s*:\s*)+/i;
    if (re.test(subject)) {
      subject = subject.replace(re, "");
      hdr.orFlags(Ci.nsMsgMessageFlags.HasRe);
    }
    hdr.subject = subject;
    hdr.setStringProperty("charset", "UTF-8");
    hdr.author = this._addressHeader(email.from);
    hdr.recipients = this._addressHeader(email.to);
    hdr.ccList = this._addressHeader(email.cc);
    const received = Date.parse(email.receivedAt);
    hdr.date = (Date.parse(email.sentAt ?? "") || received) * 1000;
    hdr.setUint32Property("dateReceived", Math.floor(received / 1000));
    // Without a Message-ID, give each email its own (stable) one: search
    // and threading would otherwise take such messages for one another.
    hdr.messageId = email.messageId?.[0] || `${email.id}@jmap.invalid`;
    const references = [...new Set([...(email.references ?? []), ...(email.inReplyTo ?? [])])];
    if (references.length) {
      hdr.setReferences(references.map(r => `<${r}>`).join(" "));
    }
    hdr.messageSize = email.size;
    hdr.orFlags(this._flagBits(flags, email));
    if (flags.tags.length) {
      hdr.setStringProperty("keywords", flags.tags.join(" "));
    }
    if (flags.junk !== null) {
      hdr.setStringProperty("junkscore", flags.junk ? "100" : "0");
    }
    hdr.setStringProperty("jmapId", email.id);
    hdr.setStringProperty(SERVER_KEYWORDS, JSON.stringify(keywordList(email.keywords)));
    hdr.setStringProperty("jmapBlobId", email.blobId);
    hdr.setStringProperty("jmapThreadId", email.threadId);
    db.addNewHdrToDB(hdr, true);
    index.set(email.id, hdr.messageKey);
  }

  /** Update an existing header through the database so views are notified. */
  _updateFlags(db, hdr, serverFlags, email) {
    const key = hdr.messageKey;
    const now = keywordList(email.keywords);
    // Tags and flags the server never had are local and kept.
    const flags = mergeServerFlags(serverFlags, now, storedServerKeywords(hdr), localFlagsOf(hdr));
    // Record the server state first: change listeners compare against it,
    // so the writes below are not taken for local changes to send back.
    hdr.setStringProperty(SERVER_KEYWORDS, JSON.stringify(now));
    if (hdr.isRead != flags.read) db.markRead(key, flags.read, null);
    if (hdr.isFlagged != flags.flagged) db.markMarked(key, flags.flagged, null);
    const M = Ci.nsMsgMessageFlags;
    if (!!(hdr.flags & M.Replied) != flags.answered) db.markReplied(key, flags.answered, null);
    if (!!(hdr.flags & M.Forwarded) != flags.forwarded) db.markForwarded(key, flags.forwarded, null);
    const keywords = flags.tags.join(" ");
    if ((hdr.getStringProperty("keywords") || "") != keywords) {
      db.setStringPropertyByHdr(hdr, "keywords", keywords);
    }
    // $junk / $notjunk from the server (null: unclassified there, or a
    // local verdict the server never had, which mergeServerFlags kept).
    const score = flags.junk === true ? "100" : flags.junk === false ? "0" : "";
    if ((hdr.getStringProperty("junkscore") || "") != score) {
      db.setStringPropertyByHdr(hdr, "junkscore", score);
    }
  }

  /** Every local header of an email (one per folder it is in). */
  headersOf(emailId) {
    const out = [];
    for (const folder of this._folders()) {
      const mailboxId = mailboxIdOf(folder);
      const key = mailboxId ? this._folderIndex(mailboxId).get(emailId) : undefined;
      if (key !== undefined) {
        const hdr = folder.msgDatabase.getMsgHdrForKey(key);
        if (hdr) {
          out.push(hdr);
        }
      }
    }
    return out;
  }

  /** The subject of an email as stored locally ("" if unknown). */
  subjectOf(emailId) {
    return this.headersOf(emailId)[0]?.mime2DecodedSubject ?? "";
  }

  /**
   * After a patch that added `added` keywords, those the server did not keep
   * (absent from its keywords now) are local-only: later diffs skip them.
   */
  noteLocalOnly(emailId, added) {
    for (const hdr of this.headersOf(emailId)) {
      const server = new Set(serverKeywordsOf(hdr));
      const local = new Set(localOnlyOf(hdr));
      let changed = false;
      for (const keyword of added) {
        if (!server.has(keyword) && !local.has(keyword)) {
          local.add(keyword);
          changed = true;
        }
      }
      if (changed) {
        hdr.setStringProperty(LOCAL_KEYWORDS, [...local].sort().join(" "));
        this._touched.add(hdr.folder);
      }
    }
  }

  async removeMessage(mailboxId, emailId) {
    const folder = this.folderForMailbox(mailboxId);
    const index = this._folderIndex(mailboxId);
    const key = index.get(emailId);
    index.delete(emailId);
    if (!folder || key === undefined) {
      return;
    }
    const db = folder.msgDatabase;
    const hdr = db.getMsgHdrForKey(key);
    if (hdr) {
      db.deleteHeader(hdr, null, false, true);
      this._touched.add(folder);
    }
  }

  async emailsMissingBody(limit) {
    const out = [];
    for (const folder of this._folders()) {
      const mailboxId = mailboxIdOf(folder);
      if (!mailboxId) {
        continue;
      }
      for (const hdr of folder.messages) {
        if (out.length >= limit) {
          return out;
        }
        if (!(hdr.flags & Ci.nsMsgMessageFlags.Offline) && hdr.getStringProperty("jmapId")) {
          out.push({
            mailboxId,
            emailId: hdr.getStringProperty("jmapId"),
            blobId: hdr.getStringProperty("jmapBlobId"),
          });
        }
      }
    }
    return out;
  }

  async storeBody(mailboxId, emailId, raw) {
    const folder = this.folderForMailbox(mailboxId);
    const key = this._folderIndex(mailboxId).get(emailId);
    if (!folder || key === undefined) {
      return false;
    }
    const db = folder.msgDatabase;
    const hdr = db.getMsgHdrForKey(key);
    if (!hdr || hdr.flags & Ci.nsMsgMessageFlags.Offline) {
      return false;
    }
    const store = folder.msgStore;
    const out = store.getNewMsgOutputStream(folder);
    try {
      const CHUNK = 0x8000;
      for (let i = 0; i < raw.length; i += CHUNK) {
        const chunk = String.fromCharCode.apply(null, raw.subarray(i, i + CHUNK));
        out.write(chunk, chunk.length);
      }
    } catch (e) {
      store.discardNewMessage(folder, out);
      throw e;
    }
    const token = store.finishNewMessage(folder, out);
    hdr.storeToken = token;
    hdr.offlineMessageSize = raw.length;
    db.markOffline(key, true, null);
    this._touched.add(folder);
    return true;
  }
}
