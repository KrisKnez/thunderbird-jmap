"use strict";
var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
this.probe = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    const out = {};
    const done = () => IOUtils.writeJSON(PathUtils.join(PathUtils.profileDir, "probe.json"), out)
      .finally(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit));
    try {
      const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(Ci.nsISubstitutingProtocolHandler);
      resProto.setSubstitution("probeaddon", Services.io.newURI("lib/", null, this.extension.rootURI));
      const mod = ChromeUtils.importESModule("resource://probeaddon/probe.sys.mjs");
      out.globals = mod.globalsReport();
      const port = Services.env.get("PROBE_PORT");
      Promise.all([mod.jsonTest(`http://127.0.0.1:${port}/json`), mod.sseTest(`http://127.0.0.1:${port}/sse`)])
        .then(([j, s]) => { out.json = j; out.sse = s; }, e => { out.fetchError = String(e); })
        .finally(done);
    } catch (e) { out.error = String(e) + "\n" + e.stack; done(); }
  }
  getAPI() { return { probe: {} }; }
};
