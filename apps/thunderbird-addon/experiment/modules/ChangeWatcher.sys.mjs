/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local changes to read, flagged, replied/forwarded, tags and junk in JMAP
// folders become keyword patches for the server. The mail session's folder
// listener sees every path that changes them (folder commands, the message
// list, thread marking, auto-read, filters, extensions) and survives folder
// databases being reopened (docs/spikes/2026-11-17-phase-2). Writes made by
// sync produce no patch: the store records the server's keywords, and the
// watcher ignores notifications while the store writes them.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { flagsToKeywords, keywordPatch } from "./core.sys.mjs";
import { isApplyingServerState, localFlagsOf, localOnlyOf, serverKeywordsOf } from "./TbMailStore.sys.mjs";
import { log } from "./Log.sys.mjs";

const WATCHED = new Set(["Status", "Flagged", "Keywords"]);
let listener = null;

function isJmapFolder(folder) {
  return folder?.server?.type == "jmap";
}

/** Enqueue the patch that brings the server in line with this header, if any. */
function check(hdr, enqueue) {
  if (isApplyingServerState()) {
    return;
  }
  const emailId = hdr.getStringProperty("jmapId");
  if (!emailId) {
    return; // not on the server yet (e.g. a draft being saved)
  }
  const patch = keywordPatch(serverKeywordsOf(hdr), flagsToKeywords(localFlagsOf(hdr)), localOnlyOf(hdr));
  if (Object.keys(patch).length) {
    enqueue(hdr.folder.server, { kind: "keywords", emailId, patch });
  }
}

/** enqueue(server, op): hands an Outbox op to the account's runtime. */
export function startWatching(enqueue) {
  if (listener) {
    return;
  }
  listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderAdded() {},
    onMessageAdded() {},
    onFolderRemoved() {},
    onMessageRemoved() {},
    onFolderPropertyChanged() {},
    onFolderIntPropertyChanged() {},
    onFolderBoolPropertyChanged() {},
    onFolderUnicharPropertyChanged() {},
    onFolderPropertyFlagChanged(item, property) {
      if (!WATCHED.has(property) || !(item instanceof Ci.nsIMsgDBHdr) || !isJmapFolder(item.folder)) {
        return;
      }
      try {
        check(item, enqueue);
      } catch (e) {
        log.warn("could not queue a local change", e);
      }
    },
    onFolderEvent(folder, event) {
      // Junk changes only announce the folder: diff its headers.
      if (event != "JunkStatusChanged" || !isJmapFolder(folder)) {
        return;
      }
      try {
        for (const hdr of folder.messages) {
          check(hdr, enqueue);
        }
      } catch (e) {
        log.warn("could not queue junk changes", e);
      }
    },
  };
  MailServices.mailSession.AddFolderListener(
    listener,
    Ci.nsIFolderListener.propertyFlagChanged | Ci.nsIFolderListener.event
  );
}

export function stopWatching() {
  if (listener) {
    MailServices.mailSession.RemoveFolderListener(listener);
    listener = null;
  }
}
