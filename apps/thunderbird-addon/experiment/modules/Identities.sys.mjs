/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JMAP identities (Identity/get) → Thunderbird identities of the account.
// Each sends through the account's jmap outgoing server, saves drafts and
// finds its Sent copies in the Drafts/Sent folders of its own folder tree,
// and has Thunderbird's own Sent copy (FCC) turned off: the server makes it.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { identityGet } from "./core.sys.mjs";
import { mailboxIdOf } from "./TbMailStore.sys.mjs";

const JMAP_ID = "jmap_identity_id";

/**
 * The Drafts and Sent folders for a JMAP identity. Mailflare's identity ids
 * are "<mailbox>~<address>", and that mailbox is the root of the identity's
 * own folder tree; other servers have one set of folders for the account.
 */
function foldersFor(incoming, identityId) {
  const root = incoming.rootFolder;
  const owner = identityId.includes("~") ? identityId.slice(0, identityId.indexOf("~")) : null;
  const base = (owner && root.descendants.find(f => mailboxIdOf(f) == owner)) || root;
  return {
    drafts: base.getFolderWithFlags(Ci.nsMsgFolderFlags.Drafts),
    sent: base.getFolderWithFlags(Ci.nsMsgFolderFlags.SentMail),
  };
}

export async function syncIdentities(incoming, client, accountId) {
  const account = MailServices.accounts.findAccountForServer(incoming);
  if (!account) {
    return;
  }
  const { list } = await identityGet(client, accountId);
  const outgoingKey = incoming.getStringValue("jmap_outgoing_key");
  const linked = new Map();
  const unlinked = new Map();
  for (const identity of account.identities) {
    const id = identity.getCharAttribute(JMAP_ID);
    if (id) {
      linked.set(id, identity);
    } else if (identity.email) {
      unlinked.set(identity.email.toLowerCase(), identity);
    }
  }

  const seen = new Set();
  for (const jmap of list) {
    const email = jmap.email.toLowerCase();
    let identity = linked.get(jmap.id);
    if (!identity) {
      // Adopt an identity with the same address (e.g. the one made when the
      // account was created) rather than adding a second one.
      identity = unlinked.get(email);
      unlinked.delete(email);
      if (!identity) {
        identity = MailServices.accounts.createIdentity();
        account.addIdentity(identity);
      }
      identity.setCharAttribute(JMAP_ID, jmap.id);
      if (!identity.fullName && jmap.name) {
        identity.fullName = jmap.name;
      }
    }
    if (identity.email != jmap.email) {
      identity.email = jmap.email;
    }
    if (outgoingKey) {
      identity.smtpServerKey = outgoingKey;
    }
    identity.doFcc = false;
    const { drafts, sent } = foldersFor(incoming, jmap.id);
    // Picker mode "1": this exact folder (not "the account's Drafts folder").
    if (drafts && identity.draftsFolderURI != drafts.URI) {
      identity.draftsFolderPickerMode = "1";
      identity.draftsFolderURI = drafts.URI;
    }
    if (sent && identity.fccFolderURI != sent.URI) {
      identity.fccFolderPickerMode = "1";
      identity.fccFolderURI = sent.URI;
    }
    seen.add(jmap.id);
  }

  for (const [id, identity] of linked) {
    if (!seen.has(id) && account.identities.length > 1) {
      account.removeIdentity(identity);
    }
  }
}
