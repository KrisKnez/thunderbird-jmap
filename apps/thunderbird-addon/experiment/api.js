/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global Services, ChromeUtils, Cc, Ci */

"use strict";

// All Experiment scripts of this add-on share one global; keep declarations
// in a function scope so they cannot collide.
(function (exports) {
  // Privileged entry point. Maps resource://thunderbird-jmap/ to the bundled
  // modules and starts the account registry.

  var { ExtensionCommon } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionCommon.sys.mjs"
  );

  var { ExtensionUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );

  const SUBSTITUTION = "thunderbird-jmap";
  const registry = () =>
    ChromeUtils.importESModule(`resource://${SUBSTITUTION}/AccountRegistry.sys.mjs`);
  const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
    Ci.nsISubstitutingProtocolHandler
  );

  exports.jmap = class extends ExtensionCommon.ExtensionAPI {
    onStartup() {
      resProto.setSubstitution(
        SUBSTITUTION,
        Services.io.newURI("experiment/modules/", null, this.extension.rootURI)
      );
      registry().startup();
    }

    onShutdown(isAppShutdown) {
      if (isAppShutdown) {
        return;
      }
      registry().shutdown();
      resProto.setSubstitution(SUBSTITUTION, null);
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }

    getAPI() {
      return {
        jmap: {
          async createAccount(details) {
            try {
              return await registry().createAccount(details);
            } catch (e) {
              throw new ExtensionUtils.ExtensionError(`${e.name}: ${e.message}`);
            }
          },
          async listAccounts() {
            return registry().listAccounts();
          },
        },
      };
    }
  };
})(this);
