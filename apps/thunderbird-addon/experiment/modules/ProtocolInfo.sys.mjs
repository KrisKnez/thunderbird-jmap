/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** nsIMsgProtocolInfo for the "jmap" account type. */
export function JmapProtocolInfo() {}

JmapProtocolInfo.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgProtocolInfo"]),

  get defaultLocalPath() {
    const dir = Services.dirsvc.get("ProfD", Ci.nsIFile);
    dir.append("JmapMail");
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    }
    return dir;
  },
  set defaultLocalPath(value) {},
  get serverIID() {
    return null;
  },
  get requiresUsername() {
    return true;
  },
  get preflightPrettyNameWithEmailAddress() {
    return true;
  },
  get canDelete() {
    return true;
  },
  get canLoginAtStartUp() {
    return false;
  },
  get canDuplicate() {
    return false;
  },
  getDefaultServerPort(isSecure) {
    return isSecure ? 443 : 80;
  },
  get canGetMessages() {
    return true;
  },
  get canGetIncomingMessages() {
    return true;
  },
  get defaultDoBiff() {
    return true;
  },
  get showComposeMsgLink() {
    return true;
  },
  get foldersCreatedAsync() {
    return false;
  },
};
