/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// nsIMsgMessageService for jmap-message:// URIs. Message bodies live in the
// folder's local mbox store, so display and streaming are delegated to the
// built-in mailbox: protocol, pointed at the folder file and message key.
// A message whose body is not stored yet is downloaded first.

import { MailUtils } from "resource:///modules/MailUtils.sys.mjs";
import { runtimeFor } from "./AccountRegistry.sys.mjs";
import { streamMessageArgs } from "./Compat.sys.mjs";
import { TYPE } from "./IncomingServer.sys.mjs";
import { log } from "./Log.sys.mjs";
import { MESSAGE_SCHEME } from "./MsgFolder.sys.mjs";

/** jmap-message://user@host/path#key → { folder, key } */
function parseMessageURI(uri) {
  const hash = uri.indexOf("#");
  if (!uri.startsWith(`${MESSAGE_SCHEME}://`) || hash == -1) {
    throw Components.Exception(`Bad JMAP message URI: ${uri}`, Cr.NS_ERROR_FAILURE);
  }
  const folderURI = TYPE + uri.slice(MESSAGE_SCHEME.length, hash);
  const key = parseInt(uri.slice(hash + 1), 10);
  const folder = MailUtils.getExistingFolder(folderURI);
  if (!folder || Number.isNaN(key)) {
    throw Components.Exception(`No message for ${uri}`, Cr.NS_ERROR_FAILURE);
  }
  return { folder, key };
}

function hasBody(folder, key) {
  return !!(folder.GetMessageHeader(key).flags & Ci.nsMsgMessageFlags.Offline);
}

/** Download and store the body of one message. */
async function fetchBody(folder, key) {
  const hdr = folder.GetMessageHeader(key);
  const runtime = runtimeFor(folder.server);
  const engine = await runtime.getEngine();
  await engine.fetchBody(
    folder.getStringProperty("jmapMailboxId"),
    hdr.getStringProperty("jmapId"),
    hdr.getStringProperty("jmapBlobId")
  );
  runtime.store.flushTouched();
}

/**
 * The mailbox: URL for a message. `additionalHeader` is the value of the
 * "header=" parameter (e.g. "filter&emitter=js"); callers rely on the
 * service to prepend "header=", as the built-in mailbox service does.
 */
function mailboxUrl(uri, additionalHeader = "") {
  const { folder, key } = parseMessageURI(uri);
  const path = Services.io.newFileURI(folder.filePath).pathQueryRef;
  const query = `number=${key}${additionalHeader ? "&header=" + additionalHeader : ""}`;
  const url = Services.io.newURI(`mailbox://${path}?${query}`);
  const messageUrl = url.QueryInterface(Ci.nsIMsgMessageUrl);
  messageUrl.originalSpec = uri;
  messageUrl.uri = uri;
  return url;
}

function notifyFailed(urlListener) {
  try {
    urlListener?.OnStopRunningUrl(null, Cr.NS_ERROR_FAILURE);
  } catch (e) {
    log.warn("url listener failed", e);
  }
}

export function JmapMessageService() {}

JmapMessageService.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgMessageService"]),

  messageURIToMsgHdr(uri) {
    const { folder, key } = parseMessageURI(uri);
    return folder.GetMessageHeader(key);
  },

  getUrlForUri(uri) {
    return mailboxUrl(uri);
  },

  loadMessage(uri, docShell, interactive, urlListener, autodetectCharset) {
    const load = () => {
      const url = mailboxUrl(uri);
      if (urlListener) {
        url.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(urlListener);
      }
      try {
        url.QueryInterface(Ci.nsIMsgI18NUrl).autodetectCharset = autodetectCharset;
      } catch (e) {
        // Not an i18n URL; fine.
      }
      docShell.loadURI(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
      });
    };
    const { folder, key } = parseMessageURI(uri);
    if (hasBody(folder, key)) {
      load();
      return;
    }
    fetchBody(folder, key).then(
      () => {
        // The user may have moved on to another message meanwhile.
        const pane = docShell.browsingContext?.embedderElement?.ownerDocument?.defaultView;
        const shown = pane?.gMessageURI;
        if (shown === undefined || shown == uri) {
          load();
        }
      },
      e => {
        log.error(`could not download ${uri}`, e);
        notifyFailed(urlListener);
      }
    );
  },

  streamMessage(uri, listener, ...rest) {
    const { urlListener, additionalHeader, localOnly } = streamMessageArgs(rest);
    const { folder, key } = parseMessageURI(uri);
    if (localOnly && !hasBody(folder, key)) {
      // The caller asked not to touch the network.
      throw Components.Exception(`${uri} is not stored locally`, Cr.NS_ERROR_FAILURE);
    }
    const url = mailboxUrl(uri, additionalHeader);
    if (urlListener) {
      url.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(urlListener);
    }
    // Run the URL through the built-in mailbox service with the consumer
    // attached (RunMailboxUrl), like its own streamMessage does: opening a
    // plain channel would drop the consumer when "header=filter" asks the
    // mailbox protocol to insert the MIME converter.
    const open = () =>
      Cc["@mozilla.org/messenger/messageservice;1?type=mailbox-message"]
        .getService(Ci.nsIMsgMessageFetchPartService)
        .fetchMimePart(url, uri, listener, null, null);
    if (hasBody(folder, key)) {
      open();
    } else {
      fetchBody(folder, key).then(open, e => {
        log.error(`could not download ${uri}`, e);
        try {
          // Stream listeners expect a start before every stop.
          listener.onStartRequest(null);
          listener.onStopRequest(null, Cr.NS_ERROR_FAILURE);
        } catch (e2) {
          log.warn("stream listener failed", e2);
        }
      });
    }
    return url;
  },

  streamHeaders() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },
  copyMessage() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },
  CopyMessages() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },
  saveMessageToDisk() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },
  Search() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },
  isMsgInMemCache() {
    return false;
  },
};
