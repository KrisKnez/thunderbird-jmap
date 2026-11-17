# Phase 2 experiment (2026-11-17)

Throwaway code answering the four questions of the Phase 2 design (§9).
The code here was run from the test Experiment and then removed from the
add-on; it is kept only as a record. Results: `outgoing-*.json`,
`change-paths-*.json`.

## 1. A `jmap` outgoing server from an add-on — works (153.7, 158, 160)

`SpikeOutgoing.sys.mjs` registered at
`@mozilla.org/messenger/outgoing/server;1?type=jmap` (same startup as the
account type). `createServer("jmap")` made `jmap1`; the JMAP identity got
`smtpServerKey = jmap1`; a second SMTP server (`fallback.invalid`) was made
the default to catch any fallback.

- `nsIMsgSend.sendMessageFile` from the JMAP identity called our
  `sendMailMessage` with `recipients` and `bccRecipients` separately; status
  0; nothing reached the fallback server.
- After a restart `jmap1` was still in `outgoingServer.servers` and was what
  `getServerByIdentity` returned, on all three versions (headless runs).
- Version difference: 153/158 set `server.key = key`; 160 calls
  `server.initialize(key, newServer)`. Implement both.
- Code reading (not reproduced headless): if anything reads
  `outgoingServer.servers` before the add-on registers its type, 153/158
  throw for **every** server until it does, and 160 drops the jmap server
  from its cached list (JMAP identities then fall back to the default
  server). `createServer()` pushes into the cached list, so a missing server
  can be recreated under the same key at startup.

## 2. Which notification sees local changes (153.7 and 160 identical)

| Change | Folder listener (`mailSession`, `onFolderPropertyFlagChanged`) | DB listener (`nsIDBChangeListener`) |
|---|---|---|
| `folder.markMessagesRead`, `hdr.markRead`, `db.markRead` (thread marking), select → auto read, view toggle/markThreadRead | `Status` | flags |
| flag (folder or view) | `Flagged` | flags |
| `folder.add/removeKeywordsToMessages` | `Keywords` | `keywords` |
| keywords written straight to the DB (`setStringPropertyByHdr`) | — | `keywords` |
| junk (folder `setJunkScoreForMessages`, view junk) | folder event `JunkStatusChanged` only (no message list) | `junkscore` |
| after the folder DB was closed and reopened | still fires | **detached** (must re-attach) |

`MailServices.mfn.msgsJunkStatusChanged` fired for the view's junk command
(with the messages), not for a direct `setJunkScoreForMessages`.

Filters: the after-the-fact `MarkRead` action calls `folder.markMessagesRead`
(Thunderbird source), so the folder listener sees it; the spike's
`applyFilters` call itself had wrong arguments and did not run.

## 3. Folder overrides on the JsAccount folder — reached

Recording overrides on `JmapFolder.prototype`:
- `MailServices.copy.copyMessages(src, [hdr], dest, isMove=true, …)` →
  destination's `copyMessages` (isMove true).
- `folder.deleteMessages(…)` → `deleteMessages`.
- `MailServices.copy.copyFileMessage(file, drafts, null, isDraft=true, …)` →
  Drafts' `copyFileMessage`.
- The message list's Delete (`nsMsgDBView::DeleteMessages`) calls
  `m_folder->DeleteMessages` (source); in the headless run the command had no
  selection and returned quietly, so the real UI path is left to the Phase 2
  tests.

## 4. Mailflare locally — works, with fixture steps

`mailflare-up.sh`: image built from `hieunc229/mailflare@5330fa4`
(`podman build`, ~1.3 GB), Mailpit `v1.33.1` as the outbound relay.
- First run: `POST /api/setup/prepare`, `POST /api/auth/register`
  (`skipDns: true`).
- **JMAP auth takes API keys only** (Basic: the password part is the key):
  log in (`POST /api/auth/login`), `POST /api/api-keys` with
  `scopes: ["jmap"]` and the mailbox id (header `Sec-Fetch-Site: same-origin`).
- Unprivileged container: inbound SMTP needs `SMTP_INBOUND_PORT=2525`.
- A manual domain stays `pending`, so inbound mail is refused ("No routing")
  and sending fails ("Sending is not set up"). Test-only fix: set
  `domains.status = 'active'` and `sending_provider = 'cloudflare'` in
  `/data/mailflare.sqlite` (self-hosted "cloudflare" sends through
  `SMTP_URL`).
- Seed mail from a sender domain without SPF/DMARC (e.g. `sender.test`);
  `example.org` mail is filed as spam.
- Same shapes as the owner's server: `mbx_<id>~inbox` mailbox ids, one
  identity `mbx_<id>~<address>`, `msg~…` blob ids.
- Sending: `Email/import` (Drafts, `$draft`) + `EmailSubmission/set` →
  delivered to To and Bcc; one Sent copy with a **new Message-ID**; draft
  destroyed (reported in the implicit `Email/set`).
- **Mailflare bug:** a send that fails (no sending provider) still leaves a
  Sent copy, and the draft stays.
- Mailpit prepends a `Bcc:` line for envelope-only recipients to the stored
  raw message (control test); tests must not mistake it for a leak.
