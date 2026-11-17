/* THROWAWAY SPIKE — not production code.
 *
 * Question: can an add-on (Experiment + JsAccount) provide a "jmap" account
 * type whose account, folder and stored message survive a Thunderbird restart?
 *
 * Run 1 creates two accounts:
 *   - "guarded":   has mail.server.X.secondsToLeaveUnavailable set
 *   - "unguarded": does not
 * Each gets an INBOX with one message (header in the folder DB, raw message in
 * Thunderbird's local message store).
 *
 * Later runs record what survived (from prefs, before touching the account
 * manager), reactivate accounts, read everything back, check the folder pane,
 * take a screenshot, write a JSON report into the profile and quit.
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { JSAccountUtils } = ChromeUtils.importESModule(
  "resource:///modules/jsaccount/JSAccountUtils.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const TYPE = "jmap";
const MSG_SCHEME = "jmap-message";
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
var { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
const T0 = Date.now();
const LOG = [];
const BODY_MARKER = "came back out of Thunderbird's local store";

function log(...args) {
  const line =
    `[jmap-spike +${Date.now() - T0}ms] ` +
    args
      .map(a =>
        typeof a == "string"
          ? a
          : a instanceof Error || (a && a.result !== undefined)
            ? String(a)
            : JSON.stringify(a)
      )
      .join(" ");
  LOG.push(line);
  dump(line + "\n");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// nsIMsgProtocolInfo for "jmap" (plain JS XPCOM, adapted from Thunderbird's
// TestJaMsgProtocolInfoComponent.sys.mjs).

function JmapProtocolInfo() {}
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
  set defaultLocalPath(v) {},
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
  getDefaultServerPort: () => 443,
  get canGetMessages() {
    return false;
  },
  get canGetIncomingMessages() {
    return false;
  },
  get defaultDoBiff() {
    return false;
  },
  get showComposeMsgLink() {
    return true;
  },
  get foldersCreatedAsync() {
    return false;
  },
};

function simpleFactory(Ctor) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) {
      return new Ctor().QueryInterface(iid);
    },
  };
}

// ---------------------------------------------------------------------------
// JsAccount incoming server.

const ServerProps = {
  baseContractID: "@mozilla.org/jacppincomingserverdelegator;1",
  baseInterfaces: [
    Ci.nsISupports,
    Ci.nsIMsgIncomingServer,
    Ci.nsIInterfaceRequestor,
    Ci.msgIOverride,
    Ci.nsISupportsWeakReference,
  ],
  delegateInterfaces: ["nsIMsgIncomingServer"],
  contractID: `@mozilla.org/messenger/server;1?type=${TYPE}`,
  classID: "{b669d1d3-231a-4230-8c40-c97128579519}",
};

function JmapServer(aDelegator, aBaseInterfaces) {
  this.delegator = Cu.getWeakReference(aDelegator);
  this.cppBase = aDelegator.cppBase;
  aBaseInterfaces.forEach(iface => this.cppBase instanceof iface);
}
JmapServer.prototype = {
  _JsPrototypeToDelegate: true,
  QueryInterface: ChromeUtils.generateQI(ServerProps.delegateInterfaces),
  get wrappedJSObject() {
    return this;
  },
  delegateList: null,

  // nsIMsgIncomingServer overrides
  get localStoreType() {
    return TYPE;
  },
  get localDatabaseType() {
    return "mailbox";
  },
};

// ---------------------------------------------------------------------------
// JsAccount folder. The C++ base (nsMsgDBFolder) does not discover subfolders
// on its own, so the root folder lists them from a server pref (the real
// add-on would use its cached JMAP Mailbox list).

const FolderProps = {
  baseContractID: "@mozilla.org/jacppmsgfolderdelegator;1",
  baseInterfaces: [
    Ci.nsISupports,
    Ci.nsIMsgFolder,
    Ci.nsIDBChangeListener,
    Ci.nsIUrlListener,
    Ci.nsIJunkMailClassificationListener,
    Ci.nsIMsgTraitClassificationListener,
    Ci.nsIInterfaceRequestor,
    Ci.msgIOverride,
  ],
  delegateInterfaces: ["nsIMsgFolder"],
  contractID: `@mozilla.org/mail/folder-factory;1?name=${TYPE}`,
  classID: "{6bd536ee-197a-44bd-9ed7-69690d302bc5}",
};

const discoveryCalls = { count: 0 };

function JmapFolder(aDelegator, aBaseInterfaces) {
  this.delegator = Cu.getWeakReference(aDelegator);
  this.cppBase = aDelegator.cppBase;
  aBaseInterfaces.forEach(iface => this.cppBase instanceof iface);
  this._discovered = false;
}
JmapFolder.prototype = {
  _JsPrototypeToDelegate: true,
  QueryInterface: ChromeUtils.generateQI(FolderProps.delegateInterfaces),
  get wrappedJSObject() {
    return this;
  },
  delegateList: null,

  // nsIMsgFolder overrides
  get incomingServerType() {
    return TYPE;
  },
  get baseMessageURI() {
    return MSG_SCHEME + this.cppBase.URI.slice(TYPE.length);
  },
  getUriForMsg(msgHdr) {
    return `${this.baseMessageURI}#${msgHdr.messageKey}`;
  },
  generateMessageURI(msgKey) {
    return `${this.baseMessageURI}#${msgKey}`;
  },
  getDBFolderInfoAndDB(folderInfo) {
    const db = this.cppBase.msgDatabase;
    folderInfo.value = db.dBFolderInfo;
    return db;
  },
  updateFolder(msgWindow) {
    // Real add-on: run a JMAP sync for this mailbox, then notify.
    log("updateFolder delegated to JS for", this.cppBase.URI);
    try {
      this.cppBase.msgDatabase.summaryValid = true;
    } catch (e) {
      log("msgDatabase open failed in updateFolder:", e);
    }
    this.delegator.get().NotifyFolderEvent("FolderLoaded");
  },
  get subFolders() {
    const base = this.cppBase;
    if (!this._discovered) {
      this._discovered = true;
      log("subFolders getter delegated to JS for", base.URI, "isServer:", base.isServer);
      try {
        if (base.isServer) {
          discoveryCalls.count++;
          const names = (base.server.getStringValue("spike_folders") || "")
            .split(",")
            .filter(Boolean);
          for (const name of names) {
            if (!base.containsChildNamed(name)) {
              const child = base.addSubfolder(name);
              child.setFlag(Ci.nsMsgFolderFlags.Mail);
              if (name == "INBOX") {
                child.setFlag(Ci.nsMsgFolderFlags.Inbox);
              }
            }
          }
        }
      } catch (e) {
        log("subFolders discovery failed:", e);
      }
    }
    return base.subFolders;
  },
};

// ---------------------------------------------------------------------------
// Message service for jmap-message:// URIs. Messages live in a normal mbox
// store, so display/streaming is delegated to Thunderbird's built-in
// "mailbox:" protocol by pointing it at our folder file + message key.

function parseMessageURI(uri) {
  const hash = uri.indexOf("#");
  if (!uri.startsWith(MSG_SCHEME + "://") || hash == -1) {
    throw Components.Exception(`Bad JMAP message URI: ${uri}`, Cr.NS_ERROR_FAILURE);
  }
  const folderURI = TYPE + uri.slice(MSG_SCHEME.length, hash);
  const key = parseInt(uri.slice(hash + 1), 10);
  const folder = MailUtils.getExistingFolder(folderURI);
  if (!folder) {
    throw Components.Exception(`No folder for ${uri}`, Cr.NS_ERROR_FAILURE);
  }
  return { folder, key };
}

const serviceCalls = [];

function JmapMessageService() {}
JmapMessageService.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgMessageService"]),

  messageURIToMsgHdr(uri) {
    const { folder, key } = parseMessageURI(uri);
    return folder.GetMessageHeader(key);
  },

  _mailboxUrl(uri, extraQuery = "") {
    const { folder, key } = parseMessageURI(uri);
    const path = Services.io.newFileURI(folder.filePath).pathQueryRef;
    const url = Services.io.newURI(
      `mailbox://${path}?number=${key}${extraQuery ? "&" + extraQuery : ""}`
    );
    const msgUrl = url.QueryInterface(Ci.nsIMsgMessageUrl);
    msgUrl.originalSpec = uri;
    msgUrl.uri = uri;
    return url;
  },

  getUrlForUri(uri) {
    serviceCalls.push("getUrlForUri");
    return this._mailboxUrl(uri);
  },

  loadMessage(uri, docShell, interactive, urlListener, autodetectCharset) {
    serviceCalls.push("loadMessage");
    const url = this._mailboxUrl(uri);
    if (urlListener) {
      url.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(urlListener);
    }
    try {
      url.QueryInterface(Ci.nsIMsgI18NUrl).autodetectCharset = autodetectCharset;
    } catch (e) {}
    docShell.loadURI(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
    });
  },

  streamMessage(uri, listener, a3, a4, a5, a6, a7) {
    // TB 153/160: (uri, listener, msgWindow, urlListener, convertData, additionalHeader, localOnly)
    // trunk:      (uri, listener, urlListener, convertData, additionalHeader, localOnly)
    let urlListener, additionalHeader;
    if (typeof a4 == "boolean") {
      [urlListener, additionalHeader] = [a3, a5];
    } else {
      [urlListener, additionalHeader] = [a4, a6];
    }
    serviceCalls.push("streamMessage");
    const url = this._mailboxUrl(uri, additionalHeader);
    if (urlListener) {
      url.QueryInterface(Ci.nsIMsgMailNewsUrl).RegisterListener(urlListener);
    }
    const channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
    channel.asyncOpen(listener);
    return url;
  },

  streamHeaders() {
    serviceCalls.push("streamHeaders");
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

let messageServiceSingleton = null;
const messageServiceFactory = {
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  createInstance(iid) {
    messageServiceSingleton ??= new JmapMessageService();
    return messageServiceSingleton.QueryInterface(iid);
  },
};

function streamViaService(uri) {
  return new Promise(resolve => {
    let data = "";
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        data += NetUtil.readInputStreamToString(stream, count);
      },
      onStopRequest(request, status) {
        resolve({ status, bytes: data.length, bodyFound: data.includes(BODY_MARKER) });
      },
    };
    const svc = MailServices.messageServiceFromURI(uri);
    try {
      // TB 153/160 signature (with msgWindow).
      svc.streamMessage(uri, listener, null, null, false, "", false);
    } catch (e) {
      try {
        // trunk signature (msgWindow removed).
        svc.streamMessage(uri, listener, null, false, "", false);
      } catch (e2) {
        resolve({ error: String(e2) });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Registration.

const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
const COMPONENTS = [
  {
    cid: "{9afada28-e9ca-438d-a452-f34fec3c7833}",
    contract: `@mozilla.org/messenger/protocol/info;1?type=${TYPE}`,
    factory: () => simpleFactory(JmapProtocolInfo),
  },
  {
    cid: ServerProps.classID,
    contract: ServerProps.contractID,
    factory: () => JSAccountUtils.jaFactory(ServerProps, JmapServer),
  },
  {
    cid: FolderProps.classID,
    contract: FolderProps.contractID,
    factory: () => JSAccountUtils.jaFactory(FolderProps, JmapFolder),
  },
  {
    cid: "{3f0c6a52-8d2e-4f7a-9b1c-5e6d7a8b9c0d}",
    contract: `@mozilla.org/messenger/messageservice;1?type=${MSG_SCHEME}`,
    factory: () => messageServiceFactory,
  },
];
const registered = [];

function register() {
  for (const c of COMPONENTS) {
    if (registrar.isContractIDRegistered(c.contract)) {
      log("already registered:", c.contract);
      continue;
    }
    const factory = c.factory();
    registrar.registerFactory(Components.ID(c.cid), "", c.contract, factory);
    registered.push({ cid: c.cid, factory });
  }
  log("registered components:", registered.length);
}

function unregister() {
  for (const { cid, factory } of registered) {
    try {
      registrar.unregisterFactory(Components.ID(cid), factory);
    } catch (e) {
      log("unregister failed", e);
    }
  }
  registered.length = 0;
}

// ---------------------------------------------------------------------------
// Side-effect-free view of account prefs (does not touch the account manager).

function prefSnapshot() {
  const accountKeys = Services.prefs
    .getCharPref("mail.accountmanager.accounts", "")
    .split(",")
    .filter(Boolean);
  const accounts = accountKeys.map(key => {
    const serverKey = Services.prefs.getCharPref(
      `mail.account.${key}.server`,
      ""
    );
    const p = `mail.server.${serverKey}.`;
    return {
      account: key,
      server: serverKey,
      type: Services.prefs.getCharPref(p + "type", ""),
      hostname: Services.prefs.getCharPref(p + "hostname", ""),
      secondsToLeaveUnavailable: Services.prefs.getIntPref(
        p + "secondsToLeaveUnavailable",
        0
      ),
      timeFoundUnavailable: Services.prefs.getIntPref(
        p + "timeFoundUnavailable",
        0
      ),
    };
  });
  const jmapServerPrefs = Services.prefs
    .getChildList("mail.server.")
    .filter(
      n => n.endsWith(".type") && Services.prefs.getCharPref(n, "") == TYPE
    )
    .map(n => ({
      server: n.split(".")[2],
      hostname: Services.prefs.getCharPref(
        n.replace(/\.type$/, ".hostname"),
        ""
      ),
    }));
  return { accountsPref: accountKeys.join(","), accounts, jmapServerPrefs };
}

// ---------------------------------------------------------------------------
// Account + message creation (run 1).

function createSpikeAccount(hostname, guarded) {
  const server = MailServices.accounts.createIncomingServer(
    "spike",
    hostname,
    TYPE
  );
  server.prettyName = guarded ? "JMAP spike (guarded)" : "JMAP spike (unguarded)";
  if (guarded) {
    server.setIntValue("secondsToLeaveUnavailable", 10 * 365 * 24 * 3600);
  }
  server.setStringValue("spike_folders", "INBOX");

  const identity = MailServices.accounts.createIdentity();
  identity.email = `spike@${hostname}`;
  identity.fullName = "Spike";

  const account = MailServices.accounts.createAccount();
  account.addIdentity(identity);
  account.incomingServer = server;

  const root = server.rootFolder;
  log("root", root.URI, "isServer", root.isServer, "folders pref", server.getStringValue("spike_folders"));
  const subs = root.subFolders;
  log("root.subFolders ->", subs.map(f => f.URI), "discoveryCalls", discoveryCalls.count);
  const inbox = findInbox(server);
  if (!inbox) {
    throw new Error("INBOX not created for " + hostname);
  }
  addMessage(inbox, hostname);
  log("created account", account.key, server.key, hostname, "guarded:", guarded);
  return account;
}

function findInbox(server) {
  return server.rootFolder.subFolders.find(f => f.getFlag(Ci.nsMsgFolderFlags.Inbox));
}

function addMessage(folder, hostname) {
  const now = new Date();
  const messageId = `spike-${now.getTime()}@${hostname}`;
  const subject = `Hello from the JMAP spike (${hostname})`;
  const raw = [
    "From: JMAP Spike <spike@example.com>",
    `To: spike@${hostname}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `If you can read this, the body ${BODY_MARKER}.`,
    "",
  ].join("\r\n");

  const file = folder.filePath;
  if (!file.exists()) {
    file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  }

  const store = folder.msgStore;
  const out = store.getNewMsgOutputStream(folder);
  out.write(raw, raw.length);
  const token = store.finishNewMessage(folder, out);

  const db = folder.msgDatabase;
  const hdr = db.createNewHdr();
  hdr.subject = subject;
  hdr.author = "JMAP Spike <spike@example.com>";
  hdr.recipients = `spike@${hostname}`;
  hdr.date = now.getTime() * 1000;
  hdr.messageId = messageId;
  hdr.messageSize = raw.length;
  try {
    hdr.offlineMessageSize = raw.length;
  } catch (e) {}
  try {
    hdr.storeToken = token;
  } catch (e) {
    hdr.setStringProperty("storeToken", token);
  }
  hdr.orFlags(Ci.nsMsgMessageFlags.Offline);
  hdr.setStringProperty("jmapId", "M-spike-1");
  db.addNewHdrToDB(hdr, true);
  db.commit(Ci.nsMsgDBCommitType.kLargeCommit);
  try {
    folder.updateSummaryTotals(true);
  } catch (e) {
    log("updateSummaryTotals not implemented (non-fatal)");
  }
  log("stored message, storeToken:", token);
}

function readMessage(folder, hdr) {
  const stream = folder.getMsgInputStream(hdr);
  const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  sis.init(stream);
  let data = "";
  try {
    let n;
    while ((n = sis.available()) > 0) {
      data += sis.read(n);
    }
  } catch (e) {
    // NS_BASE_STREAM_CLOSED at EOF is fine.
  }
  sis.close();
  return data;
}

// ---------------------------------------------------------------------------
// Live report (uses the account manager).

function liveReport() {
  const out = [];
  for (const account of MailServices.accounts.accounts) {
    const server = account.incomingServer;
    if (!server || server.type != TYPE) {
      continue;
    }
    const entry = {
      account: account.key,
      server: server.key,
      name: server.prettyName,
      folders: [],
      messages: [],
    };
    try {
      const subFolders = server.rootFolder.subFolders;
      entry.folders = subFolders.map(f => ({
        uri: f.URI,
        name: f.prettyName,
        total: f.getTotalMessages(false),
      }));
      const inbox = subFolders.find(f => f.getFlag(Ci.nsMsgFolderFlags.Inbox));
      if (inbox) {
        for (const hdr of inbox.messages) {
          const raw = readMessage(inbox, hdr);
          entry.messages.push({
            key: hdr.messageKey,
            subject: hdr.mime2DecodedSubject,
            jmapId: hdr.getStringProperty("jmapId"),
            rawBytes: raw.length,
            bodyReadBack: raw.includes(BODY_MARKER),
          });
        }
      }
    } catch (e) {
      entry.error = String(e);
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Folder pane check + screenshot.

async function waitFor(fn, timeoutMs = 30000, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) {
        return v;
      }
    } catch (e) {}
    await sleep(stepMs);
  }
  return null;
}

async function checkFolderPane(runNo) {
  const result = {};
  const win = await waitFor(() => {
    const w = Services.wm.getMostRecentWindow("mail:3pane");
    return w && w.document.readyState == "complete" && w;
  });
  if (!win) {
    result.error = "no mail:3pane window";
    return result;
  }
  const about3Pane = await waitFor(() => {
    const a = win.document.getElementById("tabmail")?.currentAbout3Pane;
    return a && a.document.readyState == "complete" && a.folderTree && a;
  });
  if (!about3Pane) {
    result.error = "no about3Pane";
    return result;
  }
  await sleep(2000);
  result.folderPaneRows = [...about3Pane.folderTree.querySelectorAll("li")]
    .map(li => li.querySelector(".name")?.textContent?.trim())
    .filter(Boolean);

  // Open the guarded account's INBOX so the screenshot shows the message list.
  const guarded = MailServices.accounts.accounts.find(
    a => a.incomingServer?.prettyName == "JMAP spike (guarded)"
  );
  const inbox = guarded && findInbox(guarded.incomingServer);
  if (inbox) {
    about3Pane.displayFolder(inbox);
    await sleep(2000);
    result.displayedFolder = about3Pane.gFolder?.URI;
    result.threadPaneRowCount =
      about3Pane.gDBView?.rowCount ?? about3Pane.threadTree?.view?.rowCount ?? null;
    // Click the first message and wait for its body to render.
    try {
      about3Pane.threadTree.selectedIndex = 0;
      const aboutMessage = about3Pane.messageBrowser?.contentWindow;
      const rendered = await waitFor(() => {
        const doc = aboutMessage?.getMessagePaneBrowser?.()?.contentDocument;
        return doc?.body?.textContent?.includes(BODY_MARKER) && doc;
      }, 15000);
      result.messageOpened = !!rendered;
      result.aboutMessageURI = aboutMessage?.gMessageURI;
      result.headerSubject =
        aboutMessage?.document.getElementById("expandedsubjectBox")?.textContent?.trim() ?? null;
      if (rendered) {
        result.renderedBodySnippet = rendered.body.textContent.trim().slice(0, 120);
      }
      await sleep(1000);
    } catch (e) {
      result.openError = String(e);
    }
    try {
      const hdr = [...inbox.messages][0];
      const uri = inbox.getUriForMsg(hdr);
      result.streamTest = await streamViaService(uri);
      result.messageURI = uri;
      try {
        MailServices.messageServiceFromURI(uri);
        result.messageServiceFound = true;
      } catch (e) {
        result.messageServiceFound = false;
        result.messageServiceError = String(e).slice(0, 200);
      }
    } catch (e) {
      result.messageUriError = String(e).slice(0, 200);
    }
  }

  try {
    const wgp = win.browsingContext.currentWindowGlobal;
    const bitmap = await wgp.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const path = PathUtils.join(
      PathUtils.profileDir,
      `jmap-spike-run-${runNo}.png`
    );
    await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
    result.screenshot = path;
  } catch (e) {
    result.screenshotError = String(e);
  }
  return result;
}

// ---------------------------------------------------------------------------

async function runSpike() {
  const runNo = Services.prefs.getIntPref("jmapspike.run", 0) + 1;
  Services.prefs.setIntPref("jmapspike.run", runNo);
  const report = {
    runNo,
    thunderbird: Services.appinfo.version,
    panoramaEnabled: Services.prefs.getBoolPref("mail.panorama.enabled", false),
    log: LOG,
  };
  log("run", runNo, "on Thunderbird", report.thunderbird);

  // Before we register anything: what do the prefs say survived startup?
  report.beforeRegister = prefSnapshot();

  register();

  if (report.beforeRegister.jmapServerPrefs.length == 0 && runNo == 1) {
    createSpikeAccount("guarded.jmap.invalid", true);
    createSpikeAccount("unguarded.jmap.invalid", false);
  } else {
    const accountsBefore = MailServices.accounts.accounts.map(a => ({
      key: a.key,
      hasServer: !!a.incomingServer,
    }));
    report.accountManagerBeforeReactivate = accountsBefore;
    MailServices.accounts.reactivateAccounts();
    log("reactivateAccounts() called");
    // Thunderbird only clears timeFoundUnavailable when the server loads at
    // startup; since we always load late, clear it ourselves.
    report.clearedTimeFoundUnavailable = [];
    for (const s of MailServices.accounts.allServers) {
      if (s.type == TYPE && s.getIntValue("timeFoundUnavailable")) {
        report.clearedTimeFoundUnavailable.push(s.key);
        Services.prefs.clearUserPref(
          `mail.server.${s.key}.timeFoundUnavailable`
        );
      }
    }
  }
  Services.prefs.savePrefFile(null);

  report.afterRegister = prefSnapshot();
  report.live = liveReport();
  report.folderDiscoveryCalls = discoveryCalls.count;
  report.folderPane = await checkFolderPane(runNo);
  report.messageServiceCalls = serviceCalls;

  const reportPath = PathUtils.join(
    PathUtils.profileDir,
    `jmap-spike-run-${runNo}.json`
  );
  await IOUtils.writeJSON(reportPath, report);
  log("report written", reportPath);

  if (Services.prefs.getBoolPref("jmapspike.autoquit", false)) {
    await sleep(500);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  }
}

this.jmapSpike = class extends ExtensionCommon.ExtensionAPI {
  onStartup() {
    log("Experiment onStartup");
    runSpike().catch(e => {
      log("runSpike failed:", e, e?.stack || "");
      IOUtils.writeJSON(
        PathUtils.join(PathUtils.profileDir, "jmap-spike-error.json"),
        { error: String(e), stack: e?.stack, log: LOG }
      ).finally(() => {
        if (Services.prefs.getBoolPref("jmapspike.autoquit", false)) {
          Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
        }
      });
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    unregister();
  }

  getAPI(context) {
    return {
      jmapSpike: {
        async ping() {
          return `pong (registered=${registered.length})`;
        },
      },
    };
  }
};
