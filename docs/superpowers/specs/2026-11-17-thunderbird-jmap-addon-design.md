# Thunderbird JMAP Add-on — Design

Date: 2026-11-17
Status: Draft for review

## 1. Intent

Add JMAP (RFC 8620 core, RFC 8621 mail) support to **stock Thunderbird** as an
**add-on**, so a JMAP mailbox appears and behaves like a real account
(folder pane, message list, reading, flags, moves, sending), without a
custom Thunderbird build.

This is explicitly a **"for now"** solution. Thunderbird's desktop roadmap
lists native JMAP as a 2027 priority (Thundermail runs on JMAP), and the
add-on mechanism this design depends on (WebExtension Experiments) is being
phased out on Thunderbird's monthly release channel. The design therefore
keeps the JMAP logic portable so it outlives the Thunderbird-specific layer.

The owner has not stated who the add-on is for. **Assumption (my call):**
personal use against the owner's own JMAP server first; publishing on
addons.thunderbird.net (ATN) is possible later but not a v1 goal.

## 2. Goals, non-goals, anti-goals

### Goals (v1)
- A JMAP account type ("jmap") that shows up in the folder pane like IMAP.
- JMAP mailboxes ↔ Thunderbird folders, including hierarchy and special
  folders (Inbox, Sent, Drafts, Trash, Junk, Archive).
- Messages synced down (headers + full raw message stored locally), so
  reading, local search, filters and offline reading work.
- Changes made in Thunderbird go to the server: read/unread, flagged, tags,
  move, copy, delete, folder create/rename/delete.
- Sending through JMAP (`EmailSubmission`), not SMTP.
- New mail arrives promptly (JMAP push, with polling as a fallback).
- Survives Thunderbird restarts and works on the current monthly release and
  the current ESR.
- JMAP client and sync logic have no Thunderbird dependencies.

### Non-goals (v1)
- Contacts (JMAP for Contacts) and calendars (JMAP for Calendars) — later.
- OAuth sign-in — later (v1 uses password / app password / API token).
- Server-side search, Sieve, vacation responses, quotas, shared mailboxes
  from other accounts, JMAP-over-WebSocket.
- Queuing changes made while offline (reading offline is a goal; changing
  things offline is not).
- Integration with Thunderbird's built-in account setup wizard.
- Publishing on ATN.

### Anti-goals (it fails even if it "works" if…)
- It loses or silently deletes the user's mail or accounts (e.g. an account
  vanishing after a restart, or a sync bug destroying server-side mail).
- It leaves a user's profile broken or littered after the add-on is disabled
  or removed.
- The JMAP logic becomes entangled with Thunderbird internals so it cannot
  be reused once Experiments go away.

## 3. Constraints and facts

Researched 2026-11-17; verified by a throwaway spike (Appendix A).

- **Versions:** current monthly release is **Thunderbird 160**; current ESR
  is **153.7**. The owner's Flatpak install is 158. Supported and tested:
  **153.7.0esr, 158.0, 160.0** (`strict_min_version` 153.0). Because the
  monthly channel loses Experiments around 2027, ESR is the long-term
  target.
- **Test server:** Stalwart **v1.1.1** (`docker.io/stalwartlabs/stalwart:v1.1.1`).
  Run with `STALWART_RECOVERY_ADMIN=admin:<pw>` and no config file, it
  starts in bootstrap mode on port 8080, and the recovery admin already has
  a working JMAP mail account (mailboxes, `Email/import`, upload, SSE push
  verified). Its session returns **relative** `apiUrl`/`downloadUrl`/
  `uploadUrl`/`eventSourceUrl`; the client resolves them against the
  session URL. Proper domain/user setup is only needed for sending.
- **Add-on APIs cannot create account types.** The standard MailExtension
  APIs can read accounts and import messages into existing folders, but not
  register a new account type. A real account type needs a **WebExtension
  Experiment** (privileged JS shipped in the add-on).
- **Experiments are being phased out on the monthly channel.** Removal was
  announced for TB 153, then postponed by a year (June 2026). ESR is not
  affected. Expect the monthly-channel cutoff around mid-to-late 2027.
- **JsAccount** (`mailnews/jsaccount`) still ships in 160 and 153.7. It lets
  JS objects override methods of Thunderbird's C++ base server/folder
  classes. It is effectively unmaintained (only used by its own tests; its
  tracking bug untouched since 2016).
- **Panorama** (Thunderbird's new global message database,
  `mail.panorama.enabled`) is **off** in 160 and 153.7. When it is turned
  on, JsAccount-based folders may break.
- **Outgoing servers are pluggable by type** via
  `@mozilla.org/messenger/outgoing/server;1?type=<type>` and
  `nsIMsgOutgoingServer.sendMailMessage(file, …)` — Thunderbird's own
  Exchange support uses this.
- **Internal interfaces drift between versions.** Example found in the
  spike: `nsIMsgMessageService.streamMessage` takes a `msgWindow` argument in
  153/160 but not on trunk (162).
- Every major JMAP server (Stalwart, Fastmail, Cyrus, Apache James) also
  offers IMAP; JMAP's value here is the protocol itself (efficient deltas,
  push, one session), not reachability.
- Prior art: Owl for Exchange (Experiment + JsAccount add-on, now superseded
  by native EWS); `Kaan88/thunderbird-jmap` (MPL-2.0 Thunderbird *fork* with
  native JMAP, Stalwart-focused, Windows builds) — its JS protocol layer is a
  useful reference.

## 4. Approaches considered

| # | Approach | Trade-offs |
|---|---|---|
| 1 | **Experiment add-on with a real account type (JsAccount)** | Native-looking account, works on 160/ESR today. Biggest build; depends on unmaintained internals; breaks across versions; monthly channel loses Experiments ~2027. |
| 2 | Standard-API add-on mirroring JMAP into local folders (`messages.import`, events for write-back) | Survives updates and the Experiments cutoff; ATN-friendly. Not its own account; full download; fiddly two-way sync via events; sending and calendars need workarounds. |
| 3 | Local bridge (IMAP/SMTP on localhost ↔ JMAP) | No add-on internals at all. Separate program to run; writing an IMAP server is its own large project; JMAP benefits stop at the bridge. |

**Picked: #1, "for now"** (owner's decision). Exit paths when Experiments
end on the monthly channel: stay on ESR; port the Thunderbird layer to
approach #2 reusing `jmap-client` + `mail-sync` unchanged; or move to
Thunderbird's native JMAP when it ships.

## 5. Decided "how"

Owner's decisions:
- Approach #1 (Experiment + JsAccount).
- **mise** for tool versions and tasks, **pnpm** workspaces, **monorepo**.

My calls (stated to and not objected to by the owner; open to override):

| Piece | Choice |
|---|---|
| Add-on format | Manifest V3 MailExtension + one Experiment API |
| Where sync runs | Inside the Experiment (privileged, parent process). MV3 background scripts can be suspended when idle, which would kill push. |
| Languages | TypeScript for `jmap-client` and `mail-sync`; plain JS with JSDoc for the Thunderbird layer (no TS types exist for Thunderbird internals) |
| JMAP client | Own thin client (zero runtime deps); reference jmap-jam and Kaan88's code |
| Build | Node + pnpm + esbuild; zip step produces the `.xpi` (no `node_modules` shipped) |
| Dev Thunderbird | Mozilla Linux tarballs of 160 and ESR 153 with throwaway profiles, never the owner's Flatpak profile |
| Test server | Stalwart in Podman, reset per test run |
| Tests | Vitest for packages; headless Thunderbird harness for integration (§11) |
| Secrets | Thunderbird's login manager; never extension storage |
| License | MPL-2.0 (matches Thunderbird; lets us adapt Thunderbird/Kaan88 code) — *my call* |

## 6. Architecture

```
thunderbird-jmap/
├── mise.toml                 # pins node + pnpm; tasks (below)
├── pnpm-workspace.yaml
├── packages/
│   ├── jmap-client/          # TS. JMAP protocol only. No Thunderbird imports.
│   └── mail-sync/            # TS. Sync engine against a MailStore interface.
├── apps/
│   └── thunderbird-addon/    # manifest, setup UI, Experiment (JS); bundles packages
├── dev/
│   └── stalwart/             # container config + seed users/mail
├── tests/
│   └── thunderbird/          # headless Thunderbird integration harness
└── docs/
```

**mise tasks:** `build`, `test` (packages), `tb:fetch` (download TB 160 +
ESR into a git-ignored cache, verify SHA256), `tb:run` (launch with a
throwaway profile + add-on), `tb:test` (integration harness on both
versions), `stalwart:up` / `stalwart:down`. No Turborepo/Nx.

### Layers

1. **`jmap-client`** — session discovery and fetch (`/.well-known/jmap`),
   auth (Basic and Bearer), batched method calls with back-references,
   error mapping (method-level and request-level), `Mailbox`, `Email`,
   `Identity`, `EmailSubmission`, `Thread` as needed, blob upload/download,
   push via the session's `eventSourceUrl` (SSE). `fetch` is injected so the
   package runs in Node (tests) and in Thunderbird's privileged context.
2. **`mail-sync`** — owns sync state (JMAP state strings), initial and delta
   sync, the JMAP↔local mapping rules (§7), and the outbound change queue. It
   talks to Thunderbird only through a **`MailStore` interface** (create /
   rename / delete folder, add message with raw bytes + metadata, update
   flags/keywords, move/remove local copies, look up by JMAP id, persist sync
   state). A future approach-#2 port implements the same interface with
   standard MailExtension APIs.
3. **Thunderbird layer (Experiment, JS)** — registers XPCOM components,
   implements the JsAccount server and folder, the message service, the
   outgoing server, the `MailStore` backed by Thunderbird folders, startup
   handling, and a small Experiment API for the setup UI.
4. **Setup UI** — an extension page (MV3 background opens it from a menu /
   toolbar action / options page) where the user enters email, password or
   API token, and optionally the session URL; it calls the Experiment API.

The packages are bundled by esbuild into one ES module inside the `.xpi`.
The Experiment registers a `resource://` substitution for the add-on root
and loads it with `ChromeUtils.importESModule`. Verified on 160 and 153.7:
in that privileged module `fetch`, `Headers`, `ReadableStream`,
`TextDecoder`, `AbortController`, `URL` and `btoa` exist, and a streaming
`fetch` body delivers SSE events as they arrive (so push uses streaming
`fetch`, which can send the `Authorization` header that `EventSource`
cannot). `setTimeout` does **not** exist there; timers come from
`resource://gre/modules/Timer.sys.mjs` and are injected into the packages.

## 7. JMAP ↔ Thunderbird mapping

- **Account:** one Thunderbird account per JMAP account (the session's
  primary mail account in v1). Server type `jmap`; hostname = session host;
  username = login. Identities created from `Identity/get` (email, name);
  each identity's outgoing server is the account's JMAP outgoing server.
- **Mailbox → folder:** hierarchy from `parentId`. The JMAP mailbox id is
  stored on the folder (string property, e.g. `jmapMailboxId`) because names
  can change. Roles map to folder flags: `inbox`→Inbox, `sent`→SentMail,
  `drafts`→Drafts, `trash`→Trash, `junk`→Junk, `archive`→Archive.
  Thunderbird renames a top-level `INBOX` to `Inbox` — map by id/role, never
  by name.
- **Email → message(s):** an Email with several `mailboxIds` becomes one
  local copy per folder (Thunderbird has no labels). Each local header
  stores the JMAP Email id (`jmapId`) and blob id. **Deleting or moving one
  local copy changes only that mailbox** (remove/replace that id in
  `mailboxIds`); an Email is moved to Trash only when its last non-Trash
  mailbox is removed, and destroyed only by deleting from Trash or an
  explicit permanent delete (*my call*). Raw message bytes
  (`downloadUrl` + `blobId`) are written to the folder's local store; the
  header gets the store token, size and offline flag.
- **Keywords ↔ flags/tags:** `$seen`↔Read, `$flagged`↔Marked,
  `$answered`↔Replied, `$forwarded`↔Forwarded, `$junk`/`$notjunk`↔junk
  score, `$draft` for drafts; any other keyword ↔ Thunderbird tag of the
  same key (lower-cased; JMAP keywords are case-insensitive).
- **Message URIs:** `jmap-message://user@host/<folder path>#<msgKey>`
  (folder URIs are `jmap://user@host/<path>`).

## 8. Sync

- **Initial sync:** `Mailbox/get` → create folders; then per mailbox
  `Email/query` (paged, newest first) + `Email/get` for header properties in
  batches bounded by the server's `maxObjectsInGet`; then download raw
  messages with bounded concurrency. Show headers as soon as they arrive;
  bodies may lag. **Opening a message whose body is not stored yet
  downloads it first, then displays it** (the message service awaits the
  download before handing Thunderbird the `mailbox://` URL) (*my call*).
  Every body is eventually stored (full offline copy); a sync window is a
  later option if mailbox size demands it.
- **Delta sync:** `Mailbox/changes` and `Email/changes` from stored states;
  apply created/updated/destroyed. On `cannotCalculateChanges`, fall back to
  a full resync of the affected mailbox.
- **Triggers:** Thunderbird's `updateFolder` (folder opened), "Get
  Messages", the biff timer, and push `StateChange` events.
- **Push:** SSE on `eventSourceUrl` with `types=Email,Mailbox`,
  `closeafter=no` and a ping interval; reconnect with backoff; polling as a
  fallback when push is unavailable.
- **Outbound changes:** folder overrides (§9) enqueue operations into a
  per-account serial queue (`Email/set` keyword patches and `mailboxIds`
  patches, `Mailbox/set`). Local state updates optimistically; on server
  error the local change is reverted and the user is told.
- **Conflict policy (my call):** the server is the source of truth; a delta
  sync overwrites local keyword/mailbox state for messages without a pending
  outbound change.
- **State storage:** per-account sync state (states, mailbox id map) lives
  with the account (server prefs or a JSON file in the account's local
  directory); per-message ids live on message headers.
- **New mail:** new messages get the New flag; the folder/server biff state
  and notifications are raised so Thunderbird's new-mail alerts and message
  filters run as they do for other accounts.

## 9. Thunderbird integration recipe

Proven in the spike (Appendix A) unless marked *unverified*.

**Registration** (Experiment parent script with `"events": ["startup"]`,
via `nsIComponentRegistrar.registerFactory`):
- `@mozilla.org/messenger/protocol/info;1?type=jmap` — plain JS
  `nsIMsgProtocolInfo` (default local path in the profile, capabilities).
- `@mozilla.org/messenger/server;1?type=jmap` — JsAccount server
  (`JSAccountUtils.jaFactory` over `@mozilla.org/jacppincomingserverdelegator;1`),
  overriding `localStoreType` = `jmap`, `localDatabaseType` = `mailbox`.
- `@mozilla.org/mail/folder-factory;1?name=jmap` — JsAccount folder over
  `@mozilla.org/jacppmsgfolderdelegator;1`.
- `@mozilla.org/messenger/messageservice;1?type=jmap-message` — JS
  `nsIMsgMessageService`.
- `@mozilla.org/messenger/outgoing/server;1?type=jmap` — JS
  `nsIMsgOutgoingServer` (*unverified*).

**Startup survival (critical).** Thunderbird loads accounts **before**
add-ons start, on every launch. An account whose type isn't registered yet
is **deleted** unless its server has
`mail.server.<key>.secondsToLeaveUnavailable` set. Therefore:
1. Set `secondsToLeaveUnavailable` (long value) when creating the account.
2. On startup, after registering components, call
   `MailServices.accounts.reactivateAccounts()`.
3. Then clear `mail.server.<key>.timeFoundUnavailable` — Thunderbird sets
   it on every startup and only clears it when the server loads at startup,
   so without this the account is deleted once the timeout passes.
4. The same timing applies to the outgoing server: an unregistered type is
   skipped (not deleted) at load; the add-on must make it available again
   after registering (*unverified — check early*).

**Folder overrides JsAccount does not provide** (each was needed in the
spike):
- `subFolders` — the C++ base does not discover children after a restart;
  the root folder must list them (from the cached JMAP mailbox list) via
  `addSubfolder`.
- `getDBFolderInfoAndDB` — required by the message list; without it the
  list is empty and counts show -1.
- `updateFolder` — must end with `NotifyFolderEvent("FolderLoaded")`; this
  is where a mailbox sync is triggered.
- `baseMessageURI`, `getUriForMsg`, `generateMessageURI` — otherwise message
  URIs come out as `#<key>` and nothing can open.
- Further overrides needed for write-back (not spiked): `markMessagesRead`,
  `markAllMessagesRead`, `markMessagesFlagged`, `addKeywordsToMessages`,
  `removeKeywordsFromMessages`, `deleteMessages`, `copyMessages`,
  `copyFileMessage` (drafts/templates), `createSubfolder`, `rename`,
  `deleteSelf`, `emptyTrash`, `getNewMessages`, and summary-count updates.

**Message display/streaming.** The message service converts
`jmap-message://…#key` into
`mailbox://<escaped folder file path>?number=<key>` (setting
`originalSpec`/`uri` to the JMAP URI) and lets Thunderbird's built-in
mailbox protocol read from the folder's store. `loadMessage` loads that URL
into the given docShell; `streamMessage` opens a channel on it. Verified:
display (header pane, body, reply/forward buttons) and raw streaming.
Signature adapters handle the 160 vs trunk difference.

**Sending** (*unverified*): `sendMailMessage(file, …)` reads the RFC 5322
file, uploads it as a blob, `Email/import`s it into Drafts, then
`EmailSubmission/set` with `onSuccessUpdateEmail` moving it to Sent and
clearing `$draft`. To avoid duplicate sent copies, JMAP identities have
Thunderbird's own "place a copy in Sent" (FCC) turned off; the server-side
move plus sync provides the Sent copy.

**Store.** Use the server's default pluggable store (mbox). Write raw
messages with `msgStore.getNewMsgOutputStream(folder)` /
`finishNewMessage`, then create the header with `db.createNewHdr()` /
`addNewHdrToDB`.

**Disable / uninstall.** On disable, accounts become unavailable and are
parked at the next start (guard pref). On uninstall, offer to remove JMAP
accounts and their local data; never delete server data. Builder decides
the exact UX, within the anti-goals.

## 10. Account setup and auth

- Setup page asks for email address and secret, with an "advanced" field
  for the session URL. Discovery: `https://<domain>/.well-known/jmap`
  (RFC 8620 §2.2); manual URL when discovery fails.
- Auth in v1: HTTP Basic (Stalwart, Cyrus) and Bearer API tokens
  (Fastmail). Secrets in Thunderbird's login manager keyed by session
  origin. OAuth later.
- On success: create server, account and identities via the Experiment API,
  apply the startup-survival prefs, kick off initial sync.

## 11. Testing

- **Packages:** Vitest unit tests with recorded JMAP responses, plus
  integration tests against Stalwart in Podman (`stalwart:up` seeds users
  and mail).
- **Thunderbird integration (pattern proven in the spike):** a test build of
  the `.xpi` includes a test-only Experiment that runs scenarios at startup
  and writes JSON reports (and screenshots) into the profile; the harness
  launches headless Thunderbird (`MOZ_HEADLESS=1`) with a throwaway profile
  and a sideloaded `.xpi`, restarts it as needed, and asserts on the
  reports. No Marionette needed. Run on TB 153.7.0esr, 158.0 and 160.0.
- **Canary (my call):** also run the integration suite against the current
  beta, and once with `mail.panorama.enabled=true`, to see breakage before
  it reaches users. Failures there are warnings, not blockers.

## 12. Milestones (order chosen to reach a usable version early)

Each phase gets its own implementation plan.

- **Phase 1 — read-only account (done):** scaffold (monorepo, mise tasks, Vitest,
  Stalwart dev server, Thunderbird download + headless harness);
  `jmap-client` (session/auth, batching, Mailbox/Email get/query/changes,
  blob download); account type (port of the spike); read-only sync
  (mailboxes → folders, headers + bodies, delta sync, on-open body fetch,
  Get Messages + polling); setup page.
- **Phase 2 — everyday use (done):** sending (JMAP outgoing server, drafts) and
  core write-back (read/flagged/tags, move, delete, error revert). Design:
  `2026-11-17-phase-2-two-way-account-design.md`; Redirect and copying
  messages are not in it (copy moves to Phase 3).
- **Phase 3 — complete mail:** push (SSE) and new-mail behavior
  (notifications, filters); copy, folder create/rename/delete.
- **Phase 4 — hardening:** large mailboxes, network errors,
  disable/uninstall, Fastmail testing (only if a test token is provided).

Later: contacts, calendars, OAuth, ATN publishing.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Experiments removed on monthly (~2027) | ESR remains; portable `jmap-client`/`mail-sync`; port to approach #2 or native JMAP |
| JsAccount breaks (unmaintained) or Panorama enabled | Canary runs on beta and with Panorama on; keep the Thunderbird layer thin |
| Interface drift between versions | Adapters per known difference; integration tests on every supported version |
| Outgoing server availability at startup | Verify in milestone 2; same reactivate pattern as incoming |
| Large mailbox performance (JS writing to store) | Batch DB commits, bounded concurrency, headers-first; measure in hardening |
| Data loss via sync bugs | Server is source of truth; destructive ops only on explicit user action; tests against Stalwart |
| Parked/orphan accounts after disable/uninstall | Uninstall flow; document behavior |

## 14. Left to the builder

- Exact folder-override set beyond the spike-proven ones, and how each maps
  to JMAP calls.
- Sync-state storage format and location; batching sizes and concurrency.
- Setup page UI details and error messages.
- Stalwart container configuration and seeding.
- How the test-only Experiment is excluded from release builds.
- Logging approach (respecting a debug pref).

## Appendix A — Spike evidence (2026-11-17)

Throwaway add-on (Experiment + JsAccount), run headless on Mozilla's
**Thunderbird 160.0** and **153.7.0esr** tarballs, three launches each
(create → restart → restart):

- Account type registered from the add-on; a guarded and an unguarded
  account were created, each with an Inbox and one message (header in the
  folder DB, raw message in the mbox store).
- Thunderbird loaded accounts before the add-on on every restart: the
  **unguarded account was deleted** (its server prefs left orphaned); the
  **guarded account survived**, was reactivated, and kept its folder and
  message; `timeFoundUnavailable` was re-set each startup and cleared by the
  add-on.
- Folder pane showed the account and Inbox with unread count; the message
  list showed the message; clicking it **displayed** it through the JMAP
  message service (header pane, body, reply/forward); streaming the raw
  message through the service returned the full message.
- No console errors on either version in the final runs.
- Spike code is kept for reference in `docs/spikes/2026-11-17-account-type/`.

## Appendix B — Calls made after the builder review

The reviewer asked which server, how large the mailbox, and which
Thunderbird the owner runs. The owner chose to proceed; these defaults
were set (override any):

- Login: Basic and Bearer both in v1; Stalwart is the primary test server.
- Multi-mailbox Emails: deleting/moving one local copy only affects that
  mailbox (§7).
- Bodies: headers first, background download, on-open fetch (§8).
- Versions: 158 added to the test matrix; ESR is the long-term target.
- Milestones regrouped into four phases, read-only first (§12).
