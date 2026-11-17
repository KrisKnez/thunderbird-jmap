/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// XPCOM registration of the jmap account type's components.

import { JSAccountUtils } from "resource:///modules/jsaccount/JSAccountUtils.sys.mjs";
import { log } from "./Log.sys.mjs";
import { JmapProtocolInfo } from "./ProtocolInfo.sys.mjs";
import { ServerProps, JmapServer } from "./IncomingServer.sys.mjs";
import { FolderProps, JmapFolder } from "./MsgFolder.sys.mjs";

const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

function plainFactory(Constructor) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) {
      return new Constructor().QueryInterface(iid);
    },
  };
}

const COMPONENTS = [
  {
    cid: "{217e324f-ebd3-4797-be77-a542e7cd2ff7}",
    contract: "@mozilla.org/messenger/protocol/info;1?type=jmap",
    factory: () => plainFactory(JmapProtocolInfo),
  },
  {
    cid: "{659c7abf-65e9-4242-880e-2b251171101b}",
    contract: ServerProps.contractID,
    factory: () => JSAccountUtils.jaFactory(ServerProps, JmapServer),
  },
  {
    cid: "{73fe0dd1-2f8c-4142-bde4-9104d1c2ade7}",
    contract: FolderProps.contractID,
    factory: () => JSAccountUtils.jaFactory(FolderProps, JmapFolder),
  },
];

const registered = [];

/** Register the XPCOM factories (idempotent). */
export function registerComponents() {
  for (const c of COMPONENTS) {
    if (registrar.isContractIDRegistered(c.contract)) {
      continue;
    }
    const factory = c.factory();
    registrar.registerFactory(Components.ID(c.cid), "", c.contract, factory);
    registered.push({ cid: c.cid, factory });
  }
  log.debug(`registered ${registered.length} components`);
}

export function unregisterComponents() {
  for (const { cid, factory } of registered.splice(0)) {
    try {
      registrar.unregisterFactory(Components.ID(cid), factory);
    } catch (e) {
      log.warn(`unregister ${cid} failed`, e);
    }
  }
}
