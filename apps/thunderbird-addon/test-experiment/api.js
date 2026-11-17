/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global Services, ChromeUtils, Cc, Ci, IOUtils, PathUtils */

"use strict";

// All Experiment scripts of this add-on share one global; keep declarations
// in a function scope so they cannot collide.
(function (exports) {
  // Test-only Experiment (test build only). When JMAP_TEST_SCENARIO is set it
  // waits for the add-on, runs that scenario, writes
  // <profile>/jmaptest-<scenario>.json and quits.

  var { ExtensionCommon } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionCommon.sys.mjs"
  );
  var { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
    Ci.nsISubstitutingProtocolHandler
  );

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitFor(check, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting");
      }
      await sleep(100);
    }
  }

  const SCENARIOS = {
    async ping({ registry }) {
      return { coreVersion: registry.coreVersion, tbVersion: Services.appinfo.version };
    },
  };

  async function runScenario(name) {
    let report;
    try {
      await waitFor(() => resProto.hasSubstitution("thunderbird-jmap"));
      const registry = ChromeUtils.importESModule(
        "resource://thunderbird-jmap/AccountRegistry.sys.mjs"
      );
      await registry.whenReady();
      const scenario = SCENARIOS[name];
      if (!scenario) {
        throw new Error(`Unknown scenario ${name}`);
      }
      const args = JSON.parse(Services.env.get("JMAP_TEST_ARGS") || "null");
      report = { ok: true, ...(await scenario({ registry, args })) };
    } catch (e) {
      report = { ok: false, error: String(e?.message ?? e), errorName: e?.name, stack: e?.stack };
    }
    await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, `jmaptest-${name}.json`), report);
    if (Services.prefs.getBoolPref("jmaptest.autoquit", false)) {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }

  exports.jmapTest = class extends ExtensionCommon.ExtensionAPI {
    onStartup() {
      const name = Services.env.get("JMAP_TEST_SCENARIO");
      if (name) {
        runScenario(name);
      }
    }

    getAPI() {
      return { jmapTest: {} };
    }
  };
})(this);
