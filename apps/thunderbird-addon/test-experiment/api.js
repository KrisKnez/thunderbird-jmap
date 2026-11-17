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

  /**
   * Quitting while add-on background scripts are still starting makes
   * shutdown wait on them until AsyncShutdown aborts (a crash). Wait for
   * browser startup and our own background first.
   */
  async function settleStartup(extension) {
    const { ExtensionParent } = ChromeUtils.importESModule(
      "resource://gre/modules/ExtensionParent.sys.mjs"
    );
    await ExtensionParent.browserStartupPromise;
    await waitFor(() => extension.backgroundState == "running", 15000).catch(() => {});
    await sleep(250);
  }

  async function runScenario(name, extension) {
    let report;
    let registry;
    try {
      await waitFor(() => resProto.hasSubstitution("thunderbird-jmap"));
      registry = ChromeUtils.importESModule(
        "resource://thunderbird-jmap/AccountRegistry.sys.mjs"
      );
      await registry.whenReady();
      const { SCENARIOS } = ChromeUtils.importESModule(
        "resource://thunderbird-jmap-test/Scenarios.sys.mjs"
      );
      const scenario = SCENARIOS[name];
      if (!scenario) {
        throw new Error(`Unknown scenario ${name}`);
      }
      const args = JSON.parse(Services.env.get("JMAP_TEST_ARGS") || "null");
      report = { ok: true, ...(await scenario({ registry, args, extension })) };
    } catch (e) {
      report = { ok: false, error: String(e?.message ?? e), errorName: e?.name, stack: e?.stack };
    }
    await IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, `jmaptest-${name}.json`), report);
    if (Services.prefs.getBoolPref("jmaptest.autoquit", false)) {
      await settleStartup(extension);
      // Let syncs still running (e.g. the one started at startup) finish,
      // so quitting never cuts one off halfway through its writes.
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      for (const account of MailServices.accounts.accounts) {
        if (account.incomingServer?.type == "jmap") {
          await registry?.whenIdle(account.incomingServer).catch(() => {});
        }
      }
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    }
  }

  exports.jmapTest = class extends ExtensionCommon.ExtensionAPI {
    onStartup() {
      resProto.setSubstitution(
        "thunderbird-jmap-test",
        Services.io.newURI("test-experiment/", null, this.extension.rootURI)
      );
      const name = Services.env.get("JMAP_TEST_SCENARIO");
      if (name) {
        runScenario(name, this.extension);
      }
    }

    getAPI() {
      return { jmapTest: {} };
    }
  };
})(this);
