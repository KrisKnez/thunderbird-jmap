/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test-only scenarios run by the jmapTest Experiment (test build only).

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
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

function folderByPath(server, path) {
  return server.rootFolder.descendants.find(f => folderPath(f).join("/") == path.join("/"));
}

/** Stream a message through its message service (153/160 and trunk signatures). */
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
        resolve({ status, data });
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
      });
    }
  } catch (e) {
    // No database yet.
  }
  return out;
}

/** Everything the integration tests assert on, for every jmap account. */
export async function report(registry) {
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
      });
      messages[path.join("/")] = messagesOf(folder);
    }
    accounts.push({
      accountKey: account.key,
      folders,
      messages,
      lastSyncError: registry.runtimeFor(server).lastSyncError?.name ?? null,
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
    const win = await waitFor(() => {
      const w = Services.wm.getMostRecentWindow("mail:3pane");
      return w?.document.readyState == "complete" && w;
    });
    const about3Pane = await waitFor(() => {
      const a = win.document.getElementById("tabmail")?.currentAbout3Pane;
      return a?.document.readyState == "complete" && a.folderTree && a;
    });
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
    const { accountKey } = await registry.createAccount(args);
    const server = MailServices.accounts.getAccount(accountKey).incomingServer;
    await registry.syncServer(server, "test");
    await registry.whenIdle(server);
    return report(registry);
  },

  async inspect({ registry, args }) {
    if (!args?.noSync) {
      for (const server of jmapServers()) {
        await registry.syncServer(server, "test").catch(() => {});
        await registry.whenIdle(server).catch(() => {});
      }
    }
    return report(registry);
  },
};
