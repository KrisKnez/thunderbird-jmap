/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test-only scenarios run by the jmapTest Experiment (test build only).

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { MailUtils } from "resource:///modules/MailUtils.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = check();
      if (value) {
        return value;
      }
    } catch (e) {
      // Not ready yet.
    }
    if (Date.now() > deadline) {
      return null;
    }
    await sleep(100);
  }
}

function identityFor(email) {
  const identity = MailServices.accounts.allIdentities.find(i => i.email == email);
  if (!identity) {
    throw new Error(`no identity ${email}`);
  }
  return identity;
}

/** A plain RFC 5322 file for sending (Thunderbird's own file has no Bcc header). */
async function messageFile(args) {
  const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
  file.append(`jmaptest-${Date.now()}.eml`);
  const raw =
    (args.resent ? `Resent-From: ${args.from}\r\nResent-To: ${args.to}\r\n` : "") +
    `From: ${args.from}\r\nTo: ${args.to}\r\nSubject: ${args.subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${Date.now()}.${Math.random()}@example.test>\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
    `${args.body ?? "Hello from Thunderbird."}\r\n`;
  await IOUtils.writeUTF8(file.path, raw);
  return file;
}

/** The main window's about:3pane once its folder pane is built, or null. */
async function about3PaneReady() {
  const win = await waitFor(() => {
    const w = Services.wm.getMostRecentWindow("mail:3pane");
    return w?.document.readyState == "complete" && w;
  });
  const about3Pane = await waitFor(() => {
    const a = win?.document.getElementById("tabmail")?.currentAbout3Pane;
    return a?.document.readyState == "complete" && a.folderTree && a.folderPane?.activeModes?.length && a;
  });
  return about3Pane ? { win, about3Pane } : null;
}

function folderByPath(server, path) {
  return server.rootFolder.descendants.find(f => folderPath(f).join("/") == path.join("/"));
}

/** Stream a message through its message service (153/160 and trunk signatures). */
function streamViaService(uri) {
  return new Promise(resolve => {
    let data = "";
    let started = false;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {
        started = true;
      },
      onDataAvailable(request, stream, offset, count) {
        data += NetUtil.readInputStreamToString(stream, count);
      },
      onStopRequest(request, status) {
        // The stream is bytes; message bodies here are UTF-8.
        const bytes = Uint8Array.from(data, c => c.charCodeAt(0));
        resolve({ status, started, data: new TextDecoder().decode(bytes) });
      },
    };
    const service = MailServices.messageServiceFromURI(uri);
    try {
      service.streamMessage(uri, listener, null, null, false, "", false);
    } catch (e) {
      service.streamMessage(uri, listener, null, false, "", false);
    }
  });
}

async function screenshot(win, name) {
  try {
    const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(
      PathUtils.join(PathUtils.profileDir, `${name}.png`),
      new Uint8Array(await blob.arrayBuffer())
    );
  } catch (e) {
    // Screenshots are best effort.
  }
}

const FLAG_NAMES = ["Inbox", "SentMail", "Drafts", "Trash", "Junk", "Archive", "Mail"];

function jmapServers() {
  return MailServices.accounts.accounts
    .map(a => a.incomingServer)
    .filter(server => server?.type == "jmap");
}

function folderPath(folder) {
  const parts = [];
  for (let f = folder; f && !f.isServer; f = f.parent) {
    parts.unshift(f.name);
  }
  return parts;
}

function messagesOf(folder) {
  const out = [];
  try {
    for (const hdr of folder.messages) {
      out.push({
        subject: hdr.mime2DecodedSubject,
        author: hdr.mime2DecodedAuthor,
        read: hdr.isRead,
        flagged: hdr.isFlagged,
        tags: (hdr.getStringProperty("keywords") || "").split(" ").filter(Boolean).sort(),
        jmapId: hdr.getStringProperty("jmapId"),
        hasBody: !!(hdr.flags & Ci.nsMsgMessageFlags.Offline),
        junk: { 100: true, 0: false }[hdr.getStringProperty("junkscore")] ?? null,
        messageId: hdr.messageId,
        serverKeywords: JSON.parse(hdr.getStringProperty("jmapServerKeywords") || "null"),
      });
    }
  } catch (e) {
    // No database yet.
  }
  // Database order changes when headers are re-added; reports compare sets.
  return out.sort((a, b) => (a.jmapId < b.jmapId ? -1 : a.jmapId > b.jmapId ? 1 : 0));
}

/** Everything the integration tests assert on, for every jmap account. */
export async function report(registry) {
  const folderPane = (await about3PaneReady())?.about3Pane.folderPane;
  const accounts = [];
  for (const account of MailServices.accounts.accounts) {
    const server = account.incomingServer;
    if (server?.type != "jmap") {
      continue;
    }
    const folders = [];
    const messages = {};
    for (const folder of server.rootFolder.descendants) {
      const path = folderPath(folder);
      folders.push({
        path,
        mailboxId: folder.getStringProperty("jmapMailboxId"),
        flags: FLAG_NAMES.filter(name => folder.getFlag(Ci.nsMsgFolderFlags[name])),
        total: folder.getTotalMessages(false),
        unread: folder.getNumUnread(false),
        // Shown in the main window's folder pane (what the user sees).
        inPane: !!folderPane?.getRowForFolder(folder),
      });
      messages[path.join("/")] = messagesOf(folder);
    }
    accounts.push({
      accountKey: account.key,
      folders,
      messages,
      lastSyncError: registry.runtimeFor(server).lastSyncError?.name ?? null,
      loginAtStartUp: server.loginAtStartUp,
    });
  }
  const logins = await Services.logins.getAllLogins();
  return {
    accounts,
    prefs: {
      timeFoundUnavailable: jmapServers().map(server =>
        Services.prefs.getIntPref(`mail.server.${server.key}.timeFoundUnavailable`, 0)
      ),
    },
    jmapServerPrefCount: Services.prefs
      .getChildList("mail.server.")
      .filter(name => name.endsWith(".type") && Services.prefs.getCharPref(name, "") == "jmap")
      .length,
    loginCount: logins.filter(login => login.httpRealm == "JMAP").length,
  };
}

export const SCENARIOS = {
  /**
   * Lose a folder's database (as when a corrupt .msf is deleted): close it,
   * delete the .msf, update the folder, and wait for the resulting sync.
   * args: { folderPath: string[] }
   */
  async "lose-folder-db"({ registry, args }) {
    const server = jmapServers()[0];
    const folder = folderByPath(server, args.folderPath);
    if (args.duringSync) {
      // Lose it in the middle of a sync, as when a damaged .msf is found at
      // startup while the startup sync runs: after the sync has read its
      // state (every folder complete), before it finishes. Then sync again.
      await registry.whenIdle(server);
      const store = registry.runtimeFor(server).store;
      const loadState = store.loadState;
      store.loadState = async function () {
        const state = await loadState.call(this);
        store.loadState = loadState;
        folder.ForceDBClosed();
        await IOUtils.remove(folder.filePath.path + ".msf");
        return state;
      };
      await registry.syncServer(server, "test").catch(() => {});
      await registry.syncServer(server, "test").catch(() => {});
      await registry.whenIdle(server);
      return report(registry);
    }
    folder.ForceDBClosed();
    await IOUtils.remove(folder.filePath.path + ".msf");
    folder.updateFolder(null);
    await sleep(100);
    await registry.whenIdle(server);
    return report(registry);
  },

  /**
   * Parse the first message of a folder with MsgHdrToMimeMessage (what
   * global search indexing and message summaries use).
   * args: { folderPath: string[] }
   */
  async "mime-body"({ args }) {
    const { MsgHdrToMimeMessage } = ChromeUtils.importESModule(
      "resource:///modules/gloda/MimeMessage.sys.mjs"
    );
    const folder = folderByPath(jmapServers()[0], args.folderPath);
    const hdr = [...folder.messages][0];
    let outcome = "timeout";
    const mime = await Promise.race([
      new Promise(resolve =>
        MsgHdrToMimeMessage(
          hdr,
          null,
          (aHdr, aMime) => {
            outcome = aMime ? "parsed" : "callback-null";
            resolve(aMime);
          },
          true,
          { saneBodySize: true }
        )
      ),
      sleep(10000).then(() => null),
    ]);
    return {
      outcome,
      subject: hdr.mime2DecodedSubject,
      bodyText: mime ? mime.coerceBodyToPlaintext(folder) : null,
    };
  },

  /**
   * Fill in and submit the add-on's setup page in a tab.
   * args: { email, sessionUrl, username, secret, authKind: "basic"|"bearer" }
   */
  async "setup-page"({ registry, args, extension }) {
    const win = await waitFor(() => {
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      return w?.document.readyState == "complete" && w;
    });
    const tabmail = win.document.getElementById("tabmail");
    const tab = tabmail.openTab("contentTab", {
      url: extension.baseURI.resolve("ui/setup.html"),
    });
    const doc = await waitFor(() => {
      const d = tab.browser.contentDocument;
      return d?.readyState == "complete" && d.getElementById("setup-form") && d;
    });
    if (!doc) {
      throw new Error("setup page did not load in-process");
    }
    const set = (id, value) => {
      const input = doc.getElementById(id);
      input.value = value;
      input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    };
    set("email", args.email);
    set("secret", args.secret);
    doc.getElementById("auth-kind").value = args.authKind == "bearer" ? "bearer" : "basic";
    set("session-url", args.sessionUrl ?? "");
    set("username", args.username ?? "");
    doc.getElementById("setup-form").requestSubmit();
    const status = await waitFor(() => {
      const el = doc.getElementById("status");
      return el?.dataset.state && el.dataset.state != "busy" && el;
    }, 30000);
    const accounts = await registry.listAccounts();
    for (const server of jmapServers()) {
      await registry.whenIdle(server).catch(() => {});
    }
    return {
      statusState: status?.dataset.state ?? null,
      statusText: status?.textContent.trim() ?? "",
      accounts,
    };
  },

  /**
   * Open the first message of a folder in the 3-pane and stream it.
   * args: { folderPath: string[], bodies: {[subject]: expected body text} }
   */
  async "open-first"({ args }) {
    const server = jmapServers()[0];
    const folder = folderByPath(server, args.folderPath);
    const { win, about3Pane } = await about3PaneReady();
    // The message pane registers its header listener when it finishes
    // loading; selecting a message earlier renders headers inline.
    const aboutMessage = await waitFor(() => {
      const w = about3Pane.messageBrowser?.contentWindow;
      return w?.document.getElementById("msgHeaderView")?.loaded && w;
    });
    about3Pane.displayFolder(folder);
    await waitFor(() => about3Pane.gDBView?.rowCount > 0);
    about3Pane.threadTree.selectedIndex = 0;

    const subject = await waitFor(() => aboutMessage.gMessage?.mime2DecodedSubject);
    const expected = args.bodies[subject] ?? "";
    // Wait for the whole document: the in-body header table is only hidden
    // once messageBody.css (linked from the message's <head>) has loaded.
    const doc = await waitFor(() => {
      const d = aboutMessage.getMessagePaneBrowser().contentDocument;
      return expected && d?.readyState == "complete" && d.body?.textContent?.includes(expected) && d;
    }, 15000);
    // innerText: only what is visible (the header table is hidden when the
    // header pane handles the headers).
    const bodyText =
      aboutMessage.getMessagePaneBrowser().contentDocument?.body?.innerText?.trim().slice(0, 500) ?? "";
    const streamed = await streamViaService(aboutMessage.gMessageURI);
    await screenshot(win, "open-first");
    return {
      rendered: !!doc,
      bodyText,
      headerSubject: subject,
      streamedBytes: streamed.data.length,
      streamedContains: !!expected && streamed.data.includes(expected),
    };
  },

  async ping({ registry }) {
    return { coreVersion: registry.coreVersion, tbVersion: Services.appinfo.version };
  },

  async "create-account"({ registry, args }) {
    // As for a user: the main window is open before the account is added.
    await about3PaneReady();
    const { accountKey } = await registry.createAccount(args);
    const server = MailServices.accounts.getAccount(accountKey).incomingServer;
    await registry.syncServer(server, "test");
    await registry.whenIdle(server);
    return report(registry);
  },

  /**
   * Give the store a mailbox tree directly (ids a test server cannot
   * produce, e.g. Mailflare's "mbx_x~inbox"), store one message in one of
   * its folders, and stream that message back through the message service.
   * args: { mailboxes: MailboxInfo[], message: { mailboxId, subject, body } }
   */
  async "apply-mailboxes"({ registry, args }) {
    await about3PaneReady();
    const server = jmapServers()[0];
    const store = registry.runtimeFor(server).store;
    await store.applyMailboxes(args.mailboxes);
    await store.saveState({ ...(await store.loadState()), mailboxes: args.mailboxes });

    const { mailboxId, subject, body } = args.message;
    const raw =
      `From: Tester <tester@example.com>\r\nTo: me@example.com\r\nSubject: ${subject}\r\n` +
      `Date: Sun, 01 Nov 2026 09:00:00 +0000\r\nMessage-ID: <m1@example.com>\r\n\r\n${body}\r\n`;
    await store.upsertMessage(
      mailboxId,
      {
        id: "Mtest1",
        blobId: "Btest1",
        threadId: "Ttest1",
        mailboxIds: { [mailboxId]: true },
        keywords: {},
        size: raw.length,
        receivedAt: "2026-11-01T09:00:00Z",
        sentAt: "2026-11-01T09:00:00Z",
        messageId: ["m1@example.com"],
        inReplyTo: null,
        references: null,
        subject,
        from: [{ name: "Tester", email: "tester@example.com" }],
        to: [{ name: null, email: "me@example.com" }],
        cc: null,
        hasAttachment: false,
      },
      { read: false, flagged: false, answered: false, forwarded: false, draft: false, junk: null, tags: [] }
    );
    await store.storeBody(mailboxId, "Mtest1", new TextEncoder().encode(raw));
    store.flushTouched();
    const folder = store.folderForMailbox(mailboxId);
    const streamed = await streamViaService(folder.getUriForMsg([...folder.messages][0]));
    return { ...(await report(registry)), streamedContains: streamed.data.includes(body) };
  },

  /**
   * Remove every jmap account the way the Remove Account dialog of
   * Thunderbird 158+ does (removeAccount only), then give the add-on a
   * moment to forget the saved login.
   */
  async "remove-account"({ registry }) {
    for (const account of [...MailServices.accounts.accounts]) {
      if (account.incomingServer?.type == "jmap") {
        MailServices.accounts.removeAccount(account, true);
      }
    }
    const jmapLogins = async () =>
      (await Services.logins.getAllLogins()).filter(l => l.httpRealm == "JMAP").length;
    for (let i = 0; i < 50 && (await jmapLogins()); i++) {
      await sleep(100);
    }
    return report(registry);
  },

  /**
   * Stream the first message in a folder whose body is not stored.
   * args: { folderPath: string[] }
   */
  async "stream-missing"({ args }) {
    const folder = folderByPath(jmapServers()[0], args.folderPath);
    const hdr = [...folder.messages].find(h => !(h.flags & Ci.nsMsgMessageFlags.Offline));
    const streamed = await streamViaService(folder.getUriForMsg(hdr));
    return { started: streamed.started, failed: !Components.isSuccessCode(streamed.status) };
  },

  /** The jmap account's JMAP identities and how each would send. */
  async "outgoing-state"({ registry }) {
    for (const server of jmapServers()) {
      await registry.whenIdle(server).catch(() => {});
    }
    const server = jmapServers()[0];
    const account = MailServices.accounts.findAccountForServer(server);
    const out = MailServices.outgoingServer;
    const pathOf = uri => {
      const folder = uri ? MailUtils.getExistingFolder(uri) : null;
      return folder ? folderPath(folder) : null;
    };
    const identities = account.identities
      .filter(i => i.getCharAttribute("jmap_identity_id"))
      .map(i => {
        let via = null;
        try {
          via = out.getServerByIdentity(i);
        } catch (e) {
          // The outgoing list failed to load.
        }
        return {
          email: i.email,
          jmapIdentityId: i.getCharAttribute("jmap_identity_id"),
          outgoingKey: i.smtpServerKey,
          outgoingType: via?.type ?? null,
          outgoingHost: via?.serverURI?.host ?? null,
          doFcc: i.doFcc,
          draftFolderPath: pathOf(i.draftsFolderURI),
          fccFolderPath: pathOf(i.fccFolderURI),
        };
      })
      .sort((a, b) => (a.email < b.email ? -1 : 1));
    return {
      identities,
      identityCount: account.identities.length,
      accountOutgoingKey: server.getStringValue("jmap_outgoing_key"),
    };
  },

  /** An SMTP server nobody can reach, made the default: any fallback would land here. */
  async "add-smtp-account"() {
    const out = MailServices.outgoingServer;
    const smtp = out.createServer("smtp");
    smtp.QueryInterface(Ci.nsISmtpServer).hostname = "fallback.invalid";
    out.defaultServer = smtp;
    return { smtpKey: smtp.key };
  },

  /**
   * Send through Thunderbird's own sending code from a JMAP identity.
   * args: { from, to, bcc?, subject, mode?: "now" | "later" }
   */
  async send({ args }) {
    const identity = identityFor(args.from);
    if (args.mode == "later") {
      let local = null;
      try {
        local = MailServices.accounts.localFoldersServer;
      } catch (e) {
        // No Local Folders yet (the Outbox lives there).
      }
      if (!local) {
        MailServices.accounts.createLocalMailAccount();
      }
    }
    const file = await messageFile(args);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    fields.from = args.from;
    fields.to = args.to;
    fields.bcc = args.bcc ?? "";
    fields.subject = args.subject;
    const done = Promise.withResolvers();
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener", "nsIMsgCopyServiceListener"]),
      onStartSending() {},
      onSendProgress() {},
      onStatus() {},
      onStopSending(msgId, status) {
        if (args.mode != "later") {
          done.resolve({ status });
        }
      },
      onGetDraftFolderURI() {},
      onSendNotPerformed(msgId, status) {
        done.resolve({ status, notPerformed: true });
      },
      onTransportSecurityError() {},
      // Queuing ("later") ends with the copy into the Outbox.
      onStartCopy() {},
      onProgress() {},
      setMessageKey() {},
      getMessageId() {
        return "";
      },
      onStopCopy(status) {
        if (args.mode == "later") {
          done.resolve({ status });
        }
      },
    };
    const mode = args.mode == "later" ? Ci.nsIMsgSend.nsMsgQueueForLater : Ci.nsIMsgSend.nsMsgDeliverNow;
    Cc["@mozilla.org/messengercompose/send;1"]
      .createInstance(Ci.nsIMsgSend)
      .sendMessageFile(identity, "", fields, file, false, false, mode, null, listener, null);
    return Promise.race([done.promise, sleep(60000).then(() => ({ status: -1, timeout: true }))]);
  },

  /**
   * Send the queued message from the Outbox the way the Send Later service
   * does for each one (nsMsgSendUnsent). The service itself cannot find its
   * Outbox in a headless run (NS_ERROR_UNEXPECTED, inside Thunderbird).
   * args: { from }
   */
  async "send-unsent"({ args }) {
    const identity = identityFor(args.from);
    const local = MailServices.accounts.localFoldersServer.rootFolder;
    const outbox = local.getFolderWithFlags(Ci.nsMsgFolderFlags.Queue) ?? local.getChildNamed("Unsent Messages");
    const hdr = [...outbox.messages][0];
    if (!hdr) {
      throw new Error("the Outbox is empty");
    }
    const streamed = await streamViaService(outbox.getUriForMsg(hdr));
    const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
    file.append(`jmaptest-unsent-${Date.now()}.eml`);
    await IOUtils.writeUTF8(file.path, streamed.data);
    const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
    fields.from = args.from;
    fields.to = hdr.recipients;
    fields.subject = hdr.mime2DecodedSubject;
    const done = Promise.withResolvers();
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener"]),
      onStartSending() {},
      onSendProgress() {},
      onStatus() {},
      onStopSending(msgId, status) {
        done.resolve({ status });
      },
      onGetDraftFolderURI() {},
      onSendNotPerformed(msgId, status) {
        done.resolve({ status, notPerformed: true });
      },
      onTransportSecurityError() {},
    };
    Cc["@mozilla.org/messengercompose/send;1"]
      .createInstance(Ci.nsIMsgSend)
      .sendMessageFile(identity, "", fields, file, false, false, Ci.nsIMsgSend.nsMsgSendUnsent, null, listener, null);
    return Promise.race([done.promise, sleep(60000).then(() => ({ status: -1, timeout: true }))]);
  },

  /**
   * Call the identity's outgoing server as Thunderbird's sender does, with a
   * listener that keeps the error text (Thunderbird would show it in a
   * modal alert). args: { from, to, subject, resent? }
   */
  async "send-direct"({ args }) {
    const identity = identityFor(args.from);
    const server = MailServices.outgoingServer.getServerByIdentity(identity);
    const file = await messageFile(args);
    const recipients = MailServices.headerParser.parseEncodedHeaderW(args.to);
    const done = Promise.withResolvers();
    const listener = {
      onSendStart() {},
      onSendStop(serverURI, exitCode, secInfo, errorMessage) {
        done.resolve({ exitCode, errorMessage: errorMessage ?? null });
      },
    };
    server.sendMailMessage(file, recipients, [], identity, args.from, "", null, false, "", listener);
    const outcome = await Promise.race([done.promise, sleep(60000).then(() => ({ exitCode: -1, errorMessage: "timeout" }))]);
    return { serverType: server.type, ...outcome };
  },

  /** Make the jmap account look as Phase 1 left it: no outgoing server, one unlinked identity. */
  async "as-phase-1-account"() {
    const server = jmapServers()[0];
    const account = MailServices.accounts.findAccountForServer(server);
    const out = MailServices.outgoingServer;
    const key = server.getStringValue("jmap_outgoing_key");
    const outgoing = key ? out.getServerByKey(key) : null;
    if (outgoing) {
      out.deleteServer(outgoing);
    }
    server.setStringValue("jmap_outgoing_key", "");
    const keep = account.defaultIdentity;
    for (const identity of [...account.identities]) {
      if (identity != keep) {
        account.removeIdentity(identity);
      }
    }
    keep.setCharAttribute("jmap_identity_id", "");
    keep.smtpServerKey = "";
    keep.doFcc = true;
    return { kept: keep.email };
  },

  /** Make every jmap server look as created by a version without the startup check. */
  async "as-older-account"({ registry }) {
    for (const server of jmapServers()) {
      server.loginAtStartUp = false;
      Services.prefs.clearUserPref(`mail.server.${server.key}.jmap_startup_check_default_applied`);
    }
    return report(registry);
  },

  /** Set "Check for new messages at startup" on every jmap server. args: { value: boolean } */
  async "login-at-startup"({ registry, args }) {
    for (const server of jmapServers()) {
      server.loginAtStartUp = args.value;
    }
    return report(registry);
  },

  /**
   * Report on every jmap account. args: { noSync?: true, waitIdle?: true }:
   * noSync skips the scenario's own sync; waitIdle waits for syncs already
   * under way (such as the one started at startup) to finish first.
   */
  async inspect({ registry, args }) {
    if (args?.waitIdle) {
      for (const server of jmapServers()) {
        await registry.whenIdle(server).catch(() => {});
      }
    }
    if (!args?.noSync) {
      for (const server of jmapServers()) {
        await registry.syncServer(server, "test").catch(() => {});
        await registry.whenIdle(server).catch(() => {});
      }
    }
    return report(registry);
  },
};
