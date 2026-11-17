# Phase 2 — Two-way JMAP Account — Design

Date: 2026-11-17
Status: Approved by the owner (2026-11-17); updated with the experiment
(§9), the builder review and the owner's answer on automatic deletions
(§5.4).
Builds on: `2026-11-17-thunderbird-jmap-addon-design.md` (the main design;
its §7 mapping, §8 sync and §9 recipe still apply unless changed here).

## 1. Intent

Phase 1 made a JMAP mailbox readable in Thunderbird. Phase 2 makes it a real,
everyday account: what the owner does in Thunderbird reaches the server, and
mail is sent through the JMAP server itself.

What the owner told us:
- **They also use other apps on the same mailbox.** So every change made in
  Thunderbird must reach the server, and Thunderbird must never quietly
  disagree with what the other apps show.
- **Their Mailflare server (a deployment of the open-source
  `hieunc229/mailflare`, AGPL-3.0) is a testing server**, and a local copy
  may be run for tests. Which server they will use for real is open; the
  owner asked to build to the JMAP standard and to make sure nothing breaks
  on Mailflare (*interpretation of "Yes do it"*, see §11).

## 2. Goals, non-goals, anti-goals

### Goals
- Read/unread, flagged, tags, junk/not-junk set in Thunderbird reach the
  server, from **every** path that changes them (message list, "mark thread
  read", filters, other add-ons, the message pane).
- Moving and deleting messages within the account reach the server, with the
  main design's per-copy semantics (§7): delete moves to Trash; deleting from
  Trash, or a permanent delete, destroys.
- Drafts saved in Thunderbird are stored on the server (visible in other
  apps); sending a draft or a new message goes through JMAP
  (`EmailSubmission`), from the right identity, with the server making the one
  Sent copy.
- Every JMAP identity on the server (Mailflare: one per address, e.g.
  `kristijan@` and `hello@`) is a Thunderbird identity that sends through the
  account's JMAP outgoing server and uses its own Drafts and Sent folders.
- A change the server refuses is undone in Thunderbird and the user is told.
- Changes made while offline or before a crash are not lost: they are sent
  when the server is reachable again.
- Works on the JMAP standard (tested on Stalwart) and degrades safely on
  Mailflare (tested on a local Mailflare).

### Non-goals (Phase 2)
- Copying messages, creating/renaming/deleting folders, push (Phase 3).
- Moving messages to or from other accounts (e.g. into Local Folders). These
  stay unsupported as today; Thunderbird reports the failure.
- Thunderbird's Undo (Ctrl+Z) for moves and deletes of JMAP messages
  (*my call*: undo needs Thunderbird's copy/move transactions; cost: an
  accidental delete is recovered from Trash by hand).
- Templates on servers that refuse new messages outside Drafts (Mailflare):
  saving a template there fails with a clear message (*my call*).
- Delayed send, DSN, read receipts (MDN).

### Anti-goals (a failure even if everything else works)
- **A message from a JMAP identity sent through another account's SMTP
  server**, or sent twice, or sent without the intended Bcc recipients.
- Tags or flags in Thunderbird silently wiped because the server ignores them.
- A local change that never reaches the server while Thunderbird shows it as
  done, or a server refusal that leaves Thunderbird disagreeing with the
  other apps.
- Server data deleted by anything other than an explicit user action or a
  deletion setting the user turned on in Thunderbird (§5.4).

## 3. Constraints and facts

### JMAP standard (RFC 8620/8621)
- `Email/set` patches: keywords one by one (`keywords/$seen: true`) and
  mailbox membership (`mailboxIds/<id>: null|true`). Patch keywords
  individually, never by replacing the whole `keywords` object, so keywords
  the add-on hides locally (`$`-prefixed server keywords) survive.
- `EmailSubmission/set`: when `envelope` is null the server derives
  recipients from To, Cc **and Bcc** headers, and the server **MUST remove
  any Bcc header during delivery** (RFC 8621 §7.5).

### Mailflare (read from its source, `src/lib/jmap/`)
- Stores only `$seen` and `$flagged`; other keywords (tags, `$answered`,
  `$forwarded`, `$junk`) are accepted and **silently ignored**.
- A message belongs to exactly one mailbox; cannot move between the
  per-address mailbox trees; received mail cannot go into Sent.
- `Email/set destroy`: outside Trash moves to Trash; in Trash (or a draft)
  deletes.
- New messages (`Email/import`, `Email/set create`) are allowed **only in a
  Drafts mailbox**.
- `EmailSubmission/set` **rebuilds** the outgoing message from the draft's
  parsed fields (from = identity address, to/cc/bcc, subject, text, HTML,
  attachments, In-Reply-To, References), sets its own Message-ID, writes its
  own Sent copy and deletes the draft. It **ignores `envelope`**, so Bcc
  recipients must be in the draft's Bcc header. OpenPGP/S-MIME and extra
  headers do not survive. The draft must belong to the identity's mailbox.
- Session advertises an `eventSourceUrl` (push, Phase 3).
- Self-hosts as one Docker container (SQLite, local files); outbound mail
  through any SMTP relay (`SMTP_URL`), inbound through a built-in SMTP
  listener.

### Thunderbird (read from 153.7 and 160 sources)
- Outgoing servers are pluggable by type through
  `@mozilla.org/messenger/outgoing/server;1?type=<type>` (Thunderbird's own
  `smtp`, `ews`, `graph` use it). `MailServices.outgoingServer.createServer(type)`
  stores `mail.smtpserver.<key>.type`; identities point to a server through
  `smtpServerKey`.
- Sending calls `server.sendMailMessage(file, recipients, bccRecipients,
  identity, sender, password, statusListener, requestDSN, messageId,
  listener)`. The file has **no Bcc header**; Bcc recipients come separately.
- **The outgoing server list is built once and cached; a server whose type is
  not registered at that moment is dropped, and `getServerByIdentity` then
  falls back to the default server (another account's SMTP).** Add-on types
  register after startup (the Phase 1 timing problem, now on the outgoing
  side).
- Some paths change read state straight in the message database and bypass
  the folder (e.g. "mark thread as read", `nsMsgDBView::MarkThreadRead`), so
  folder-method overrides alone miss them.
- 153/158 initialise an outgoing server with `server.key = key`; 160 calls
  `server.initialize(key, newServer)`. If the outgoing list is read before the
  add-on registers `jmap`, 153/158 throw for every server until it is
  registered; 160 drops the jmap server from its cached list.
  `createServer()` adds to the cached list.
- Redirect sends the original message unchanged (Resent-* headers); the new
  recipients exist only in the `recipients` argument of `sendMailMessage`.

## 4. Approaches

**Catching local changes to flags, tags and junk**
- **A. Override folder commands** (`markMessagesRead`, `markMessagesFlagged`,
  keyword methods). Simple, but misses every path that writes the database
  directly (thread marking, filters, add-ons): those changes never reach the
  server.
- **B. Watch the folders' message databases** and send what changed.
  Catches every path; must not echo the sync's own writes back.
- **Chosen: B** (owner, 2026-11-17).

**Moves, deletes, drafts:** Thunderbird asks the folder to do these
(`copyMessages` with isMove, `deleteMessages`, `copyFileMessage`), so the JMAP
folder overrides them. No alternative.

**Sending**
- **Outgoing server type `jmap`** so the normal Send, progress, Outbox
  ("Send Later") and error dialogs work. **Chosen** (owner agreed with the
  recommendation).
- Intercepting the compose window (MailExtension `onBeforeSend`): loses
  Thunderbird's sending pipeline. Rejected.
- SMTP: Mailflare offers none for clients, and it bypasses JMAP. Rejected.

## 5. Design

### 5.1 Identities and the outgoing server
- On account creation, and on each sync when `Identity/changes` reports
  changes, `Identity/get` defines the account's Thunderbird identities: one
  per JMAP identity (email, name), linked by a stored `jmap_identity_id`.
  Identities the user created by hand are left alone (*my call*).
- Each identity's Drafts and Sent folders are the mailboxes with role
  `drafts`/`sent` that belong to that identity. Mailflare encodes the owning
  mailbox in the identity id; generically, the builder matches by the
  identity's position in the mailbox tree, falling back to the account's
  top-level role mailboxes (*left to the builder, with a test per server*).
- Thunderbird's own "place a copy in Sent" (FCC) is **off** for these
  identities: the server makes the Sent copy (main design §9).
- One outgoing server of type `jmap` per JMAP account, created with
  `createServer("jmap")`, linked to the account (stores the incoming server
  key) and set as `smtpServerKey` on every identity of the account.
- **Fallback guard (anti-goal).** The experiment showed the `jmap` server
  loads and survives restarts on all three versions, but early readers of
  the outgoing list could still drop it (§3). So:
  - at startup, after registering the type, the add-on checks that every
    JMAP identity resolves to its `jmap` server; if not, it removes the stale
    key from `mail.smtpservers` and recreates it with `createServer("jmap")`
    (same key), then checks again;
  - whenever the add-on is not running (on its shutdown, including disable
    and uninstall), the server is parked as type `smtp` with an unreachable
    host (`jmap-parked.invalid`), so other accounts keep working on 153/158
    and a JMAP identity's mail fails instead of going through another
    account; startup turns it back into `jmap` (recreate as above);
  - remaining window (*accepted, my call*): after a crash the server is
    still typed `jmap`; between Thunderbird's start and the add-on's start a
    send could fall back. The startup check closes it within seconds; tested
    by sending as soon as the add-on is ready.

### 5.2 Capturing local changes (approach B)
- The add-on observes header changes with the **mail session's folder
  listener** (`onFolderPropertyFlagChanged`): `Status` (read, replied,
  forwarded), `Flagged` and `Keywords`. The experiment (§9) showed it sees
  every UI and folder path — including thread marking, auto-read on display
  and database writes — on 153.7 and 160, and keeps working after a folder
  database is closed and reopened (a per-database listener does not).
- Junk: the folder event `JunkStatusChanged` names no messages, so on it the
  add-on diffs the junk state of that folder's messages against
  `jmapServerKeywords` (cheap: header properties only).
- Not observed (*accepted, my call*): keywords written straight into a folder
  database, bypassing the folder (no standard Thunderbird path does this).
  The Phase 2 tests check that MailExtension `messages.update` (tags, junk)
  is seen.
- **Echo suppression by diff, not by flag:** each header stores the last
  keywords the server reported for that email (`jmapServerKeywords`). On any
  change event, the add-on computes the keywords the local state implies and
  diffs them against `jmapServerKeywords`; only differences are queued.
  Sync writes update both sides together, so they produce no diff and no
  echo (*my call*).
- **Local-only tags (Mailflare):** sync never removes a local tag or flag
  that is absent from `jmapServerKeywords` — the server never had it, so it
  is local. A tag the server once reported and later dropped is removed
  locally (another app removed it). On Mailflare, tags, Replied and Forwarded
  therefore stay local and are never wiped; on standard servers they sync
  both ways.
- Changes to an email with several local copies (several `mailboxIds`) apply
  once per email.

### 5.3 The outbound queue
- One serial queue per account, **persisted** to a file in the account's
  directory (`jmap-outbox.json`, *my call*) so offline changes and changes
  pending at a crash survive restarts.
- Operations: keyword patches, mailbox moves, destroys, draft imports and
  draft deletions. Adjacent keyword patches for one email merge.
- Sent in batches as `Email/set` within the server's limits; per-email
  results are applied individually.
- Network failure: keep the queue, retry with backoff, and on each sync.
  Server refusal (`notUpdated`/`notDestroyed`, e.g. Mailflare's "one folder
  per message"): drop the operation, **undo it locally** (restore flags, put
  the message back in its folder) and tell the user in a non-blocking way
  (*builder decides the UI*, e.g. Thunderbird's notification bar), naming
  the message and the server's reason.
- While an email has queued operations, a delta sync does not overwrite the
  local state those operations change (main design §8 conflict policy);
  once the queue for it is empty, the server wins again.
- Keywords the server silently ignores (Mailflare) come back in the next
  `Email/get` without the change; per §5.2 they become local-only rather than
  being "undone".

### 5.4 Moving and deleting
- Moving within the account (`copyMessages` with isMove from one JMAP folder
  to another): move the local copies at once (optimistic) and queue a
  `mailboxIds` patch: remove the source mailbox, add the target.
- Deleting (`deleteMessages`): from a folder other than Trash, move to the
  account's Trash (as a move); from Trash, or a permanent delete
  (Shift+Delete), queue `Email/set destroy`. Deleting one local copy of a
  multi-mailbox email only removes that mailbox (main design §7).
- The local move must not trigger a download: bodies already stored travel
  with the message; others download later as usual.
- **Automatic deletions reach the server, as for IMAP** (owner,
  2026-11-17): junk auto-purge, retention policies ("delete messages older
  than…"), "Empty Trash on exit", a filter's Delete action, and the Empty
  Trash command (`emptyTrash` override: destroy every email in the Trash
  mailbox) all go through the same delete path. All of these are settings
  the user turns on (off by default); their deletions also disappear from
  the user's other apps.

### 5.5 Drafts
- Saving a draft (`copyFileMessage` into the identity's Drafts folder):
  store it locally as now, upload the file and `Email/import` it into that
  Drafts mailbox with `$draft` and `$seen`; record the returned email id on
  the local header. Thunderbird deletes the previous version of a draft when
  saving a new one; that deletion destroys the old server draft.
- Opening a server draft from another app for editing works as reading does
  (Phase 1); saving it again follows the same path.

### 5.6 Sending
`sendMailMessage(file, recipients, bccRecipients, identity, …)`:
1. Read the RFC 5322 file. If there are Bcc recipients, add a `Bcc:` header
   listing them (needed by Mailflare; standard servers strip it on delivery,
   RFC 8621 §7.5).
2. Upload the bytes; `Email/import` into the identity's Drafts mailbox with
   `$draft` and `$seen`.
3. `EmailSubmission/set` with `identityId`, `emailId: "#draft"`, an
   **explicit envelope** (`mailFrom` = identity address, `rcptTo` =
   Thunderbird's `recipients` + `bccRecipients`), and `onSuccessUpdateEmail`
   moving the email to the identity's Sent mailbox and clearing `$draft`.
   Standard servers send to exactly Thunderbird's recipients and strip the
   Bcc header; Mailflare ignores the envelope, uses the draft's To/Cc/Bcc
   (hence step 1) and writes its own Sent copy. Both end with one Sent copy
   on the server, synced down.
4. Report progress and the final status through the listener so
   Thunderbird's send dialog and Outbox behave as for SMTP. Errors from the
   server are shown with the server's description.
- **Redirect is refused** for JMAP identities (*my call*): a message with
  `Resent-` headers fails with a clear message. On Mailflare it would go to
  the original recipients, and the add-on cannot tell servers apart.
- **A failed send says so plainly**, including that a Sent copy may appear
  anyway: Mailflare writes its Sent copy before a send fails (§9).
- **No automatic resend:** if the submission's outcome is unknown (network
  error after the request was sent), report failure and leave the draft in
  Drafts; never submit the same message twice. A user retry is a new send
  (*my call*).
- "Send Later" uses Thunderbird's Outbox as usual; sending the Outbox goes
  through the same path.

### 5.7 Sync interplay
- Sync stores `jmapServerKeywords` on every header it writes or updates.
- After the queue sends operations, the next sync confirms them; local state
  then matches the server or becomes local-only per §5.2.
- Phase 1 behaviour is otherwise unchanged (startup sync, Get Messages,
  periodic check).

## 6. Testing

- **Stalwart** (as today): the standard behaviour of every operation.
- **Local Mailflare** (*my call*): a test fixture builds the container from a
  pinned commit of `hieunc229/mailflare` (fetched at test time, never copied
  into this repo), with SQLite and local files, and outbound `SMTP_URL`
  pointing at Mailpit (pinned) on a private container network, so test sends
  are inspected there and never delivered. Setup as proven in the
  experiment (`docs/spikes/2026-11-17-phase-2/`): register, mark the domain
  active and its sending provider `cloudflare` in its SQLite database
  (test-only), create a `jmap`-scoped API key (Mailflare's JMAP accepts API
  keys only), seed mail over SMTP on port 2525 from a sender domain without
  SPF/DMARC. Mailpit prepends a `Bcc:` line for envelope-only recipients;
  Bcc tests account for it.
- **Required scenarios** (each on both servers unless noted):
  - read/flag/tag/junk changes from the message list, "mark thread read", a
    message filter, and the message pane reach the server; a change made in
    another client reaches Thunderbird (Phase 1) and is not echoed back;
  - on Mailflare, a tag survives the next sync (local-only); on Stalwart, a
    tag removed by another client disappears locally;
  - move and delete (to Trash, from Trash, Shift+Delete); a Mailflare-refused
    move (between address trees) is undone and reported;
  - offline: changes made with the server stopped are sent after it returns,
    across a restart;
  - draft save appears on the server in the identity's Drafts; resaving
    replaces it;
  - send from each identity: captured message has the right From and
    recipients, **Bcc recipients receive it, no recipient sees a Bcc
    header**, exactly one Sent copy appears after sync, the draft is gone;
  - **fallback guard:** with the `jmap` type registered late (as at
    startup), sending from a JMAP identity never reaches another SMTP server
    (a second, SMTP-only account in the test profile proves it);
  - send failure (server refuses) shows an error and leaves nothing sent;
  - Redirect from a JMAP identity is refused; with the add-on disabled,
    sending from a JMAP identity fails and other accounts still send.
- All of this on Thunderbird 153.7 ESR, 158 and 160, as in Phase 1.

## 7. Risks and unverified points

| Risk | Handling |
|---|---|
| Outgoing type from an add-on is dropped at startup and identities fall back to another SMTP server | Experiment first (§9); fallback guard (§5.1); dedicated test |
| Database change notifications missed (DB closed/reopened, cross-folder views) | Experiment proves the listener choice; tests cover each change path |
| Mailflare container does not build or run headless | Experiment; if impossible, test Mailflare behaviour against a scripted stand-in built from its source (*fallback, my call*) |
| Optimistic local moves then refused: message briefly in the wrong folder | Undo + notification; tested |
| Mailflare drops Thunderbird's MIME specifics (encryption, headers, Message-ID) | Documented limitation of that server; not worked around |
| Duplicate send after an ambiguous failure | No automatic resend (§5.6) |
| JsAccount overrides for `copyMessages`/`deleteMessages`/`copyFileMessage` behave differently per version | Covered by the version matrix |

## 8. Order of work

1. **Experiment** (§9) — before any production code.
2. Identities + outgoing server + sending (largest risk, biggest value).
3. Change capture + persisted queue + flags/tags/junk.
4. Moves and deletes.
5. Drafts.
6. Mailflare test fixture early enough to run 2–5 against it.

## 9. Experiment (first task)

A throwaway spike in `docs/spikes/` answering, on 153.7, 158 and 160:
1. Can an add-on register `@mozilla.org/messenger/outgoing/server;1?type=jmap`
   so a server created with `createServer("jmap")` survives a restart and is
   what `getServerByIdentity` returns? What makes the outgoing service
   reload, and can a JMAP identity be kept from falling back to the default
   server?
2. Which change notification sees read/flag/keyword/junk changes from the
   message list, thread marking, filters and the message pane, including
   after the folder database was closed and reopened?
3. Do `copyMessages` (isMove), `deleteMessages` and `copyFileMessage`
   overrides on the JsAccount folder get called for the normal UI paths?
4. Does Mailflare's Docker image build and serve JMAP locally with SMTP out
   to a capture server and SMTP in?
The answers update this document before the plan is written.

**Results (2026-11-17, `docs/spikes/2026-11-17-phase-2/README.md`):**
1. Works on 153.7, 158, 160: the `jmap` outgoing server receives sends
   (recipients and Bcc separately) and survives restarts; no fallback seen.
   Guard still needed for early readers (§5.1).
2. The mail session's folder listener sees all read/flag/keyword paths and
   survives database reopen; junk needs the folder event plus a diff (§5.2).
3. `copyMessages` (move), `deleteMessages`, `copyFileMessage` overrides are
   reached through the copy service and folder calls.
4. Mailflare runs locally with the fixture steps in §6; sending, Bcc and the
   Sent copy behave as described in §3; a failed send leaves a Sent copy.

## 10. Left to the builder
- Listener mechanism (after the experiment), queue file format, batching.
- Notification UI for refusals and send errors.
- How identities map to Drafts/Sent on servers other than Mailflare and
  Stalwart.
- Mailflare fixture details (pinned commit, build caching, ports).

## 11. Calls made in this design (for the owner to check)
- "Yes do it" read as: build to the JMAP standard, degrade safely on
  Mailflare (not: Mailflare-only).
- Echo suppression by diffing against last server keywords (§5.2).
- Local-only tags/flags kept when the server never stored them (§5.2).
- Persisted outbound queue file (§5.3).
- No Thunderbird Undo for JMAP moves/deletes in Phase 2.
- Templates unsupported on Mailflare.
- Hand-made identities left alone.
- Bcc header added to the uploaded draft (§5.6).
- No automatic resend after an ambiguous failure.
- Local Mailflare + mail-capture server for tests; Mailflare's domain state
  set directly in its database for tests.
- Explicit envelope for every send; Redirect refused (§5.6).
- Outgoing server parked as an unreachable SMTP server while the add-on is
  not running; post-crash startup window accepted (§5.1).
- Keywords written straight into a database are not observed (§5.2).
