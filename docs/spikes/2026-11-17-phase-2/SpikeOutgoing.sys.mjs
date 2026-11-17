/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// SPIKE (Phase 2 experiment, throwaway): a stand-in "jmap" outgoing server
// that records what Thunderbird asks it to send.

export class SpikeOutgoingServer {
  QueryInterface = ChromeUtils.generateQI(["nsIMsgOutgoingServer"]);

  get type() {
    return "jmap";
  }
  get key() {
    return this._key;
  }
  set key(key) {
    this._key = key;
  }
  initialize(key) {
    this._key = key;
  }
  _pref(name, fallback = "") {
    return Services.prefs.getStringPref(`mail.smtpserver.${this._key}.${name}`, fallback);
  }
  get UID() {
    return this._pref("uid");
  }
  set UID(v) {}
  get description() {
    return "JMAP (spike)";
  }
  set description(v) {}
  get hostname() {
    return "jmap.invalid";
  }
  set hostname(v) {}
  get port() {
    return 443;
  }
  set port(v) {}
  get displayname() {
    return "JMAP (spike)";
  }
  get username() {
    return "";
  }
  set username(v) {}
  get clientid() {
    return "";
  }
  set clientid(v) {}
  get clientidEnabled() {
    return false;
  }
  set clientidEnabled(v) {}
  get authMethod() {
    return Ci.nsMsgAuthMethod.none;
  }
  set authMethod(v) {}
  get socketType() {
    return Ci.nsMsgSocketType.SSL;
  }
  set socketType(v) {}
  get helloArgument() {
    return "";
  }
  get serverURI() {
    return Services.io.newURI("jmap://jmap.invalid");
  }
  get maximumConnectionsNumber() {
    return 1;
  }
  set maximumConnectionsNumber(v) {}
  get password() {
    return "";
  }
  set password(v) {}
  getPasswordWithUI() {
    return "";
  }
  forgetPassword() {}
  verifyLogon() {
    return null;
  }
  clearAllValues() {
    for (const name of Services.prefs.getChildList(`mail.smtpserver.${this._key}.`)) {
      Services.prefs.clearUserPref(name);
    }
  }
  closeCachedConnections() {}
  get wrappedJSObject() {
    return this;
  }

  sendMailMessage(file, recipients, bccRecipients, identity, sender, password, statusListener, dsn, messageId, listener) {
    const record = {
      key: this._key,
      file: file?.path,
      size: file?.fileSize,
      recipients: String(recipients),
      bcc: String(bccRecipients),
      identity: identity?.email,
      sender,
      messageId,
    };
    const prior = JSON.parse(Services.prefs.getStringPref("jmapspike.sends", "[]"));
    Services.prefs.setStringPref("jmapspike.sends", JSON.stringify([...prior, record]));
    const request = {
      QueryInterface: ChromeUtils.generateQI(["nsIRequest"]),
      name: "jmap-send",
      isPending: () => false,
      status: Cr.NS_OK,
      cancel() {},
      suspend() {},
      resume() {},
      loadGroup: null,
      loadFlags: 0,
    };
    listener?.onSendStart(request);
    Promise.resolve().then(() => listener?.onSendStop(this.serverURI, Cr.NS_OK, null, null));
  }
}
