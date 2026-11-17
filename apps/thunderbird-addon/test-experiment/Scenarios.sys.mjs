/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Test-only scenarios run by the jmapTest Experiment (test build only).

import { MailServices } from "resource:///modules/MailServices.sys.mjs";

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
  async ping({ registry }) {
    return { coreVersion: registry.coreVersion, tbVersion: Services.appinfo.version };
  },

  async "create-account"({ registry, args }) {
    const { accountKey } = await registry.createAccount(args);
    const server = MailServices.accounts.getAccount(accountKey).incomingServer;
    await registry.syncServer(server, "test");
    return report(registry);
  },

  async inspect({ registry, args }) {
    if (!args?.noSync) {
      for (const server of jmapServers()) {
        await registry.syncServer(server, "test").catch(() => {});
      }
    }
    return report(registry);
  },
};
