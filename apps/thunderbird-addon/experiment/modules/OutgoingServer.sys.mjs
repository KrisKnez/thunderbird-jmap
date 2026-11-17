/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The "jmap" outgoing server type (nsIMsgOutgoingServer), one per JMAP
// account, and the guard that keeps a JMAP identity's mail from ever going
// through another account's SMTP server:
//  - while the add-on is not running the server is "parked" as an SMTP server
//    with an unreachable host, so sending fails instead of falling back, and
//    Thunderbird 153/158 never meet an unknown server type;
//  - at startup it is turned back into a jmap server, and recreated under the
//    same key if Thunderbird cached its server list before our type existed.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { log } from "./Log.sys.mjs";

export const OUTGOING_TYPE = "jmap";
export const PARKED_HOST = "jmap-parked.invalid";
const INCOMING_PREF = "jmap_incoming";
const OUTGOING_KEY = "jmap_outgoing_key";

const branch = key => `mail.smtpserver.${key}.`;

function listedKeys() {
  return Services.prefs.getCharPref("mail.smtpservers", "").split(",").filter(Boolean);
}

function jmapIncomingServers() {
  return MailServices.accounts.allServers.filter(server => server.type == "jmap");
}

export class JmapOutgoingServer {
  QueryInterface = ChromeUtils.generateQI(["nsIMsgOutgoingServer"]);
  _key = "";

  get type() {
    return OUTGOING_TYPE;
  }
  // Thunderbird 153/158 set the key; 160 calls initialize().
  get key() {
    return this._key;
  }
  set key(key) {
    this._key = key;
  }
  initialize(key) {
    this._key = key;
  }

  _get(name, fallback = "") {
    return Services.prefs.getStringPref(branch(this._key) + name, fallback);
  }
  _set(name, value) {
    Services.prefs.setStringPref(branch(this._key) + name, value);
  }

  /** The JMAP account this server sends for. */
  get incoming() {
    const key = this._get(INCOMING_PREF);
    if (!key) {
      return null;
    }
    try {
      return MailServices.accounts.getIncomingServer(key);
    } catch (e) {
      return null;
    }
  }

  get UID() {
    return this._get("uid");
  }
  set UID(value) {
    this._set("uid", value);
  }
  get description() {
    return this._get("description") || `JMAP (${this.incoming?.prettyName ?? ""})`;
  }
  set description(value) {
    this._set("description", value);
  }
  get displayname() {
    return this.description;
  }
  get hostname() {
    return this.incoming?.hostName ?? "";
  }
  set hostname(value) {}
  get port() {
    return this.incoming?.port ?? 443;
  }
  set port(value) {}
  get username() {
    return this.incoming?.username ?? "";
  }
  set username(value) {}
  get clientid() {
    return "";
  }
  set clientid(value) {}
  get clientidEnabled() {
    return false;
  }
  set clientidEnabled(value) {}
  get authMethod() {
    return Ci.nsMsgAuthMethod.passwordCleartext;
  }
  set authMethod(value) {}
  get socketType() {
    return Ci.nsMsgSocketType.SSL;
  }
  set socketType(value) {}
  get helloArgument() {
    return "";
  }
  get serverURI() {
    return Services.io.newURI(`jmap://${this.hostname || "jmap.invalid"}`);
  }
  get maximumConnectionsNumber() {
    return 1;
  }
  set maximumConnectionsNumber(value) {}
  get password() {
    return "";
  }
  set password(value) {}
  getPasswordWithUI() {
    return "";
  }
  forgetPassword() {}
  verifyLogon() {
    return null;
  }
  clearAllValues() {
    for (const name of Services.prefs.getChildList(branch(this._key))) {
      Services.prefs.clearUserPref(name);
    }
  }
  closeCachedConnections() {}
  get wrappedJSObject() {
    return this;
  }

  sendMailMessage(file, recipients, bccRecipients, identity, sender, password, statusListener, requestDSN, messageId, listener) {
    listener?.onSendStart(sendRequest());
    Promise.resolve().then(() =>
      listener?.onSendStop(this.serverURI, Cr.NS_ERROR_FAILURE, null, "Sending through JMAP is not ready yet.")
    );
  }
}

/** A minimal nsIRequest for onSendStart. */
export function sendRequest() {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIRequest"]),
    name: "jmap-send",
    status: Cr.NS_OK,
    isPending: () => false,
    cancel() {},
    suspend() {},
    resume() {},
    loadGroup: null,
    loadFlags: 0,
  };
}

/** Create the jmap outgoing server for a JMAP account; returns its key. */
export function createOutgoingServer(incoming) {
  const outgoing = MailServices.outgoingServer.createServer(OUTGOING_TYPE);
  Services.prefs.setStringPref(branch(outgoing.key) + INCOMING_PREF, incoming.key);
  incoming.setStringValue(OUTGOING_KEY, outgoing.key);
  return outgoing.key;
}

/** Point the account's JMAP identities at its outgoing server. */
function linkIdentities(incoming, key) {
  const account = MailServices.accounts.findAccountForServer(incoming);
  for (const identity of account?.identities ?? []) {
    if (identity.getCharAttribute("jmap_identity_id")) {
      identity.smtpServerKey = key;
    }
  }
}

function unpark(key) {
  Services.prefs.setCharPref(branch(key) + "type", OUTGOING_TYPE);
  Services.prefs.clearUserPref(branch(key) + "hostname");
  Services.prefs.clearUserPref(branch(key) + "port");
}

/** Startup: every JMAP account has a live jmap outgoing server from this add-on. */
export function ensureOutgoingServers() {
  const service = MailServices.outgoingServer;
  const incomings = jmapIncomingServers();
  for (const incoming of incomings) {
    const key = incoming.getStringValue(OUTGOING_KEY);
    if (key && listedKeys().includes(key)) {
      unpark(key);
    }
  }
  // Load the whole list now that no unknown type is in it: on 153/158 a
  // failed earlier load left it empty, and creating a server into an empty
  // list would hide every other account's server.
  try {
    void service.servers;
  } catch (e) {
    log.warn("the outgoing server list did not load", e);
  }
  for (const incoming of incomings) {
    const key = incoming.getStringValue(OUTGOING_KEY);
    if (!key || !listedKeys().includes(key)) {
      linkIdentities(incoming, createOutgoingServer(incoming));
      continue;
    }
    let server = null;
    try {
      server = service.getServerByKey(key);
    } catch (e) {
      log.warn(`outgoing server ${key} did not load`, e);
    }
    if (server?.wrappedJSObject instanceof JmapOutgoingServer) {
      continue;
    }
    // Cached before our type was registered (dropped, or loaded as the parked
    // SMTP server), or left over from an older copy of the add-on: replace it.
    if (server) {
      service.deleteServer(server);
    } else {
      Services.prefs.setCharPref("mail.smtpservers", listedKeys().filter(k => k != key).join(","));
    }
    linkIdentities(incoming, createOutgoingServer(incoming));
  }
}

/** Shutdown: park every jmap outgoing server as an unreachable SMTP server. */
export function parkOutgoingServers() {
  for (const incoming of jmapIncomingServers()) {
    const key = incoming.getStringValue(OUTGOING_KEY);
    if (key && listedKeys().includes(key)) {
      Services.prefs.setCharPref(branch(key) + "type", "smtp");
      Services.prefs.setCharPref(branch(key) + "hostname", PARKED_HOST);
      Services.prefs.setIntPref(branch(key) + "port", 1);
    }
  }
}

/** Remove the outgoing servers that belonged to a removed JMAP account. */
export function deleteOutgoingServersFor(incomingKey) {
  const service = MailServices.outgoingServer;
  for (const key of listedKeys()) {
    if (Services.prefs.getStringPref(branch(key) + INCOMING_PREF, "") != incomingKey) {
      continue;
    }
    let server = null;
    try {
      server = service.getServerByKey(key);
    } catch (e) {
      // List did not load; remove by prefs below.
    }
    if (server) {
      service.deleteServer(server);
    } else {
      Services.prefs.setCharPref("mail.smtpservers", listedKeys().filter(k => k != key).join(","));
      for (const name of Services.prefs.getChildList(branch(key))) {
        Services.prefs.clearUserPref(name);
      }
    }
  }
}
