# Phase 1 — Read-only JMAP Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Thunderbird add-on that adds a JMAP account type, mirrors a JMAP server's mailboxes and messages into it (read-only), survives restarts, and opens messages — tested against Stalwart on Thunderbird 153.7.0esr, 158.0 and 160.0.

**Architecture:** pnpm monorepo managed by mise. `packages/jmap-client` (JMAP protocol) and `packages/mail-sync` (sync engine over a `MailStore` interface) are TypeScript with no Thunderbird dependencies; esbuild bundles them into one ES module inside the `.xpi`. `apps/thunderbird-addon` is a Manifest V3 MailExtension whose Experiment (plain JS) registers a JsAccount-based `jmap` account type, a `jmap-message` message service and a `MailStore` backed by Thunderbird folders. A headless-Thunderbird harness drives a test-only Experiment and asserts on JSON reports.

**Tech Stack:** mise, Node 24.16.0, pnpm 10.12.1, TypeScript, esbuild, Vitest, Podman + Stalwart v1.1.1, Thunderbird Experiments + JsAccount.

**Spec:** `docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md` (read it first; Appendix A and `docs/spikes/2026-11-17-account-type/` hold the proven Thunderbird recipe).

## Global Constraints

- Tool versions pinned in `mise.toml`: `node = "24.16.0"`, `pnpm = "10.12.1"`.
- Thunderbird test matrix: `153.7.0esr`, `158.0`, `160.0` (Linux x86_64 en-US tarballs from `https://archive.mozilla.org/pub/thunderbird/releases/<v>/linux-x86_64/en-US/thunderbird-<v>.tar.xz`, verified against that release's `SHA256SUMS`). Manifest `strict_min_version`: `"153.0"`.
- Stalwart image: `docker.io/stalwartlabs/stalwart:v1.1.1`, started with `STALWART_RECOVERY_ADMIN=admin:<password>` and no config (bootstrap mode, HTTP on container port 8080). Tests use the recovery admin's mail account.
- `packages/*` have zero runtime dependencies and never reference Thunderbird globals (`Services`, `ChromeUtils`, `Ci`, …). `fetch` and timers are injected.
- Thunderbird-side code is plain JS (`.sys.mjs` modules + `experiment/api.js`) with JSDoc.
- License MPL-2.0; every source file starts with the MPL-2.0 header comment.
- **Versioning (owner's rule):** one `major.minor.patch` version for the repo, in the root `package.json`; `node scripts/bump-version.mjs <major|minor|patch>` copies it into every workspace `package.json` and `apps/*/manifest.json`. **Every "Commit" step below first bumps** by the commit's Conventional Commit type: breaking change (`!` / `BREAKING CHANGE`) → `major`; `feat` → `minor`; anything else → `patch`. The bumped files are part of the same commit. `CORE_VERSION` and the add-on version are the root version.
- **Phase 1 is read-only:** no code path may call `Email/set`, `Mailbox/set` or `EmailSubmission/set` against the user's server (test helpers may, against Stalwart only).
- Secrets live only in Thunderbird's login manager (origin = session URL origin, `httpRealm` = `"JMAP"`).
- Fixed identifiers (use exactly):

| Name | Value |
|---|---|
| Add-on id | `{ddb4c26d-c465-4ac4-a04d-eddc8783806f}` |
| `resource://` substitution | `thunderbird-jmap` → add-on root `experiment/modules/` |
| Account/server type, folder scheme | `jmap` |
| Message URI scheme | `jmap-message` |
| Protocol info | `@mozilla.org/messenger/protocol/info;1?type=jmap` — `{217e324f-ebd3-4797-be77-a542e7cd2ff7}` |
| Incoming server | `@mozilla.org/messenger/server;1?type=jmap` — `{659c7abf-65e9-4242-880e-2b251171101b}` |
| Folder factory | `@mozilla.org/mail/folder-factory;1?name=jmap` — `{73fe0dd1-2f8c-4142-bde4-9104d1c2ade7}` |
| Message service | `@mozilla.org/messenger/messageservice;1?type=jmap-message` — `{ffcf99c6-e5d4-4eff-9d5d-d4196153a16a}` |
| Server string prefs | `jmap_session_url`, `jmap_account_id`, `jmap_auth_kind` (`"basic"`\|`"bearer"`) |
| Server int pref | `secondsToLeaveUnavailable` = `315360000` |
| Folder string property | `jmapMailboxId` |
| Header string properties | `jmapId`, `jmapBlobId`, `jmapThreadId` |
| Add-on prefs | `extensions.thunderbird-jmap.loglevel` (default `"Warn"`), `extensions.thunderbird-jmap.backgroundBodyDownload` (default `true`) |
| Sync state file | `<server.localPath>/jmap-sync-state.json` |

## Review Focus

1. **Mailbox names that aren't valid file names** (`Reports: Q3/Q4 ✓`, a non-inbox mailbox literally named `INBOX`) — folder appears with the server's name and maps by `jmapMailboxId`, never by name. Test owned by Task 8.
2. **Non-ASCII senders and subjects** (`Žana Šimić`, `Привет, мир`) — thread pane shows them correctly (author/recipients are byte-string attributes, so they must be MIME-encoded). Test owned by Task 9.
3. **More messages than one request returns** (120 emails with batch size 50) — every email is synced, none duplicated. Test owned by Task 5.
4. **Wrong password at account creation** — `createAccount` rejects with an auth error and leaves no account, server prefs or login behind. Test owned by Task 8.
5. **Server unreachable at startup** — the account still loads from local data with its folders and messages; the failed sync is logged and nothing is deleted. Test owned by Task 9.

---

## File Structure

```
mise.toml  package.json  pnpm-workspace.yaml  tsconfig.base.json  .prettierrc.json  .gitignore  LICENSE  README.md
scripts/
  fetch-thunderbird.mjs        # tb:fetch — download + verify + extract matrix into .cache/thunderbird/<v>/
  run-thunderbird.mjs          # tb:run — dev profile, sideloaded xpi, non-headless
  stalwart.mjs                 # stalwart:up / stalwart:down for manual dev (port 18080)
packages/test-support/         # Stalwart lifecycle + seeding helpers (dev-only)
  src/stalwart.ts  src/seed.ts  src/index.ts  test/stalwart.test.ts
packages/jmap-client/
  src/errors.ts  src/credentials.ts  src/session.ts  src/client.ts  src/mail.ts  src/types.ts  src/index.ts
  test/session.test.ts  test/client.test.ts  test/mail.int.test.ts
packages/mail-sync/
  src/store.ts  src/mapping.ts  src/engine.ts  src/bodies.ts  src/index.ts
  test/fake-store.ts  test/mapping.test.ts  test/engine.int.test.ts  test/bodies.int.test.ts
apps/thunderbird-addon/
  manifest.json  background.js
  ui/setup.html  ui/setup.js  ui/setup.css
  experiment/schema.json  experiment/api.js
  experiment/modules/
    Log.sys.mjs  Compat.sys.mjs  Registration.sys.mjs  ProtocolInfo.sys.mjs
    IncomingServer.sys.mjs  MsgFolder.sys.mjs  MessageService.sys.mjs
    TbMailStore.sys.mjs  AccountRegistry.sys.mjs
  src/core-entry.ts            # bundled → build/addon/experiment/modules/core.sys.mjs
  test-experiment/schema.json  test-experiment/api.js   # only in the test build
  scripts/build.mjs            # build/ + dist/thunderbird-jmap.xpi (+ dist/thunderbird-jmap-test.xpi)
tests/thunderbird/
  harness/thunderbird.ts  harness/scenario.ts
  addon-loads.test.ts  account.test.ts  sync.test.ts  open-message.test.ts
```

---

### Task 1: Workspace scaffold + Stalwart test support

**Files:**
- Create: root files listed above, `scripts/stalwart.mjs`, `packages/test-support/**`
- Test: `packages/test-support/test/stalwart.test.ts`

**Interfaces:**
- Produces (`@thunderbird-jmap/test-support`):
  - `startStalwart(opts?: { password?: string }): Promise<StalwartInstance>`
  - `interface StalwartInstance { baseUrl: string; sessionUrl: string; username: "admin"; password: string; stop(): Promise<void> }` — `baseUrl` is `http://127.0.0.1:<random free port>`, `sessionUrl` is `${baseUrl}/jmap/session`. Container name `tbjmap-test-<random>`, removed by `stop()`. Readiness: poll `GET ${baseUrl}/healthz/live` until 200 (timeout 60 s).
  - Seeding helpers are added in Task 3 (they need the client).

- [ ] **Step 1: Write root config.** `mise.toml` with `[tools]` pins and tasks: `install` (`pnpm install`), `typecheck` (`pnpm -r typecheck`), `test` (`pnpm -r --filter "./packages/*" test`), `build`, `build:test`, `tb:fetch`, `tb:run`, `tb:test`, `stalwart:up`, `stalwart:down`, `check` (depends on `typecheck`, `test`); `[env] TB_VERSIONS = "153.7.0esr,158.0,160.0"`. Tasks whose scripts don't exist yet are added by the task that creates them. `pnpm-workspace.yaml` covers `packages/*`, `apps/*`, `tests/*`. Root `package.json` is private with devDependencies `typescript`, `vitest`, `esbuild`, `prettier`, `@types/node`. `tsconfig.base.json`: `strict`, `target`/`lib` `ES2023`, `module`/`moduleResolution` `NodeNext`, `noEmit`. `.gitignore`: `node_modules/`, `.cache/`, `build/`, `dist/`, `*.xpi`, `tests/thunderbird/out/`. `LICENSE` = MPL-2.0 text from `https://www.mozilla.org/media/MPL/2.0/index.txt`.

- [ ] **Step 2: Write the failing test** `packages/test-support/test/stalwart.test.ts`:

```ts
test("starts Stalwart with a JMAP mail account", async () => {
  const s = await startStalwart();
  try {
    const res = await fetch(s.sessionUrl, { headers: { Authorization: "Basic " + btoa(`${s.username}:${s.password}`) } });
    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session.capabilities).toHaveProperty(["urn:ietf:params:jmap:mail"]);
    expect(session.primaryAccounts["urn:ietf:params:jmap:mail"]).toBeTypeOf("string");
  } finally { await s.stop(); }
}, 90_000);
```

- [ ] **Step 3: Run it:** `mise install && mise run install && pnpm --filter @thunderbird-jmap/test-support test` → FAIL (`startStalwart` not defined).
- [ ] **Step 4: Implement `startStalwart` in `src/stalwart.ts`** using `podman run -d --rm --name … -p 127.0.0.1:<port>:8080 -e STALWART_RECOVERY_ADMIN=admin:<pw> docker.io/stalwartlabs/stalwart:v1.1.1` via `node:child_process`; free port via a temporary `net` server on port 0. `scripts/stalwart.mjs up|down` runs the same image as container `tbjmap-dev` on `127.0.0.1:18080` with password `jmap-dev-password`.
- [ ] **Step 5: Run it** → PASS. Run `mise run typecheck` → no errors.
- [ ] **Step 6: Commit** `chore: scaffold monorepo and Stalwart test support`.

---

### Task 2: jmap-client — credentials, session, requests, errors

**Files:**
- Create: `packages/jmap-client/src/{errors,credentials,session,client,types,index}.ts`
- Test: `packages/jmap-client/test/session.test.ts`, `test/client.test.ts`

**Interfaces:**
- Produces:
  - `type Credentials = { kind: "basic"; username: string; password: string } | { kind: "bearer"; token: string }`
  - `authorizationHeader(c: Credentials): string`
  - `resolveUrlTemplate(template: string, sessionUrl: string): string` — absolute → unchanged; starting with `/` → session origin + template; otherwise relative to the session URL's directory. Never percent-encodes `{` `}`.
  - `discoverSessionUrl(input: string, opts: { fetch: FetchLike; credentials: Credentials }): Promise<string>` — input with a scheme is used as the start URL; an email address `x@domain` → `https://domain/.well-known/jmap`. Follows redirects; returns the final response URL.
  - `interface Session { apiUrl: string; downloadUrl: string; uploadUrl: string; eventSourceUrl: string; state: string; username: string; accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean }>; primaryAccounts: Record<string, string>; capabilities: Record<string, unknown>; maxObjectsInGet: number; maxCallsInRequest: number }` (URLs already resolved; limits read from `capabilities["urn:ietf:params:jmap:core"]`).
  - `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`
  - `class JmapClient { constructor(o: { sessionUrl: string; credentials: Credentials; fetch: FetchLike }); getSession(refresh?: boolean): Promise<Session>; primaryMailAccountId(): Promise<string>; request(calls: MethodCall[], using?: string[]): Promise<MethodResponse[]>; call<T>(name: string, args: Record<string, unknown>, using?: string[]): Promise<T> }`
  - `type MethodCall = [name: string, args: Record<string, unknown>, callId: string]`; `type MethodResponse = [name: string, result: Record<string, unknown>, callId: string]`
  - Errors (all extend `JmapError`): `JmapAuthError` (HTTP 401/403), `JmapHttpError { status }`, `JmapRequestError { type, status }` (problem-details body), `JmapMethodError { type, description? }` (`["error", …]` response; `call` throws it), `JmapNetworkError` (fetch rejected).
  - Default `using`: `["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]`.

- [ ] **Step 1: Write failing unit tests** (fake `fetch` returning canned `Response`s):
  - `resolveUrlTemplate("/jmap/download/{accountId}/{blobId}/{name}?accept={type}", "http://127.0.0.1:18080/jmap/session")` → `"http://127.0.0.1:18080/jmap/download/{accountId}/{blobId}/{name}?accept={type}"`; absolute `https://a.example/x/{blobId}` unchanged; `"api/"` with session `https://h/jmap/session` → `"https://h/jmap/api/"`.
  - `authorizationHeader({kind:"basic",username:"ü",password:"p"})` → `"Basic " + base64(UTF-8 "ü:p")`; bearer → `"Bearer t"`.
  - `discoverSessionUrl("me@example.org", …)` requests `https://example.org/.well-known/jmap` and returns the fake's final `response.url`.
  - `getSession()` resolves all four URLs, reads `maxObjectsInGet` and caches (second call does not fetch).
  - `call()` throws `JmapMethodError` with `type === "cannotCalculateChanges"` for `[["error",{type:"cannotCalculateChanges"},"0"]]`; HTTP 401 → `JmapAuthError`; HTTP 400 with `{"type":"urn:ietf:params:jmap:error:notRequest"}` → `JmapRequestError` with that type; rejected fetch → `JmapNetworkError`.
- [ ] **Step 2: Run** `pnpm --filter @thunderbird-jmap/jmap-client test` → FAIL.
- [ ] **Step 3: Implement** the modules above. Base64 of UTF-8 via `TextEncoder` + `btoa` over a binary string (works in Node and Thunderbird).
- [ ] **Step 4: Run** → PASS; `mise run typecheck` clean.
- [ ] **Step 5: Commit** `feat(jmap-client): session discovery, auth, request batching, errors`.

---

### Task 3: jmap-client — mail methods and blobs; seeding helpers

**Files:**
- Create: `packages/jmap-client/src/mail.ts`, `packages/test-support/src/seed.ts`
- Modify: `packages/jmap-client/src/client.ts` (blob methods), both `index.ts`
- Test: `packages/jmap-client/test/mail.int.test.ts`

**Interfaces:**
- Consumes: `JmapClient`, errors (Task 2); `startStalwart` (Task 1).
- Produces (`jmap-client`):
  - `JmapClient.downloadBlob(accountId: string, blobId: string, type?: string): Promise<Uint8Array>` (template vars `accountId`, `blobId`, `name` = `"message.eml"`, `type` = `type ?? "message/rfc822"`, each `encodeURIComponent`'d)
  - `JmapClient.uploadBlob(accountId: string, data: Uint8Array | string, type: string): Promise<{ blobId: string; size: number; type: string }>`
  - Types: `Mailbox { id; name; parentId: string|null; role: string|null; sortOrder: number }`, `EmailAddress { name: string|null; email: string }`, `EmailHeaderInfo { id; blobId; threadId; mailboxIds: Record<string,true>; keywords: Record<string,true>; size: number; receivedAt: string; sentAt: string|null; messageId: string[]|null; inReplyTo: string[]|null; references: string[]|null; subject: string|null; from: EmailAddress[]|null; to: EmailAddress[]|null; cc: EmailAddress[]|null; hasAttachment: boolean }`
  - `EMAIL_HEADER_PROPERTIES: readonly string[]` — exactly the keys of `EmailHeaderInfo`.
  - `mailboxGet(c, accountId, ids: string[] | null): Promise<{ state: string; list: Mailbox[]; notFound: string[] }>`
  - `mailboxChanges(c, accountId, sinceState): Promise<Changes>`; `emailChanges(c, accountId, sinceState, maxChanges?: number): Promise<Changes>` where `Changes = { oldState; newState; hasMoreChanges: boolean; created: string[]; updated: string[]; destroyed: string[] }`
  - `emailQuery(c, accountId, o: { position: number; limit: number; sort?: { property: string; isAscending: boolean }[] }): Promise<{ ids: string[]; position: number; total?: number; queryState: string }>`
  - `emailGet(c, accountId, ids: string[], properties = EMAIL_HEADER_PROPERTIES): Promise<{ state: string; list: EmailHeaderInfo[]; notFound: string[] }>`
- Produces (`test-support`, Stalwart-only helpers): `connect(s: StalwartInstance): Promise<{ client: JmapClient; accountId: string }>`, `createMailbox(client, accountId, name, parentId?: string): Promise<string>`, `importEmail(client, accountId, o: { mailboxIds: string[]; keywords?: string[]; from?: string; to?: string; subject: string; body: string; messageId?: string; date?: Date }): Promise<string /* emailId */>`, `setKeywords(client, accountId, emailId, keywords: string[])`, `moveEmail(client, accountId, emailId, mailboxIds: string[])`, `destroyEmail(client, accountId, emailId)`, `mailboxIdByRole(client, accountId, role): Promise<string>`. These use `Email/set`/`Mailbox/set`/`Email/import` directly via `client.call`.

- [ ] **Step 1: Write failing integration tests** (`beforeAll` starts Stalwart; `afterAll` stops it):
  - `mailboxGet(null)` lists a mailbox with `role === "inbox"`.
  - `importEmail` then `emailGet([id])` returns `subject`, `from[0].email`, `keywords["$seen"] === true` when imported with `["$seen"]`, `mailboxIds[inboxId] === true`.
  - `downloadBlob(accountId, email.blobId)` decodes (UTF-8) to text containing the imported body.
  - `emailQuery({position:0,limit:2})` after importing 3 emails returns 2 ids and `total === 3`.
  - `emailChanges(stateBefore)` after `setKeywords` lists the id in `updated`; after `destroyEmail` in `destroyed`.
  - `mailboxChanges(stateBefore)` after `createMailbox("Projects")` lists it in `created`.
- [ ] **Step 2: Run** `pnpm --filter @thunderbird-jmap/jmap-client test` → FAIL.
- [ ] **Step 3: Implement** `mail.ts`, blob methods and seed helpers. `importEmail` builds an RFC 5322 message (CRLF, `MIME-Version`, `Content-Type: text/plain; charset=utf-8`, RFC 2047-encode non-ASCII `Subject`/display names), uploads it, then `Email/import`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(jmap-client): mailbox/email methods, blob upload/download; seeding helpers`.

---

### Task 4: mail-sync — MailStore interface, mapping, fake store

**Files:**
- Create: `packages/mail-sync/src/{store,mapping,index}.ts`, `test/fake-store.ts`
- Test: `packages/mail-sync/test/mapping.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `EmailHeaderInfo` types (Task 3).
- Produces:
  - `type FolderKind = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | null`
  - `interface MailboxInfo { id: string; name: string; parentId: string | null; kind: FolderKind; sortOrder: number }`
  - `interface LocalFlags { read: boolean; flagged: boolean; answered: boolean; forwarded: boolean; draft: boolean; junk: boolean | null; tags: string[] }` (`junk`: `$junk`→true, `$notjunk`→false, neither→null; `tags`: every other keyword lower-cased, sorted, excluding `$seen $flagged $answered $forwarded $draft $junk $notjunk`)
  - `keywordsToFlags(keywords: Record<string, true>): LocalFlags`
  - `roleToKind(role: string | null): FolderKind`
  - `toMailboxInfos(list: Mailbox[]): MailboxInfo[]` — parents before children; siblings by `sortOrder` then `name`; a mailbox whose parent is missing is placed at top level.
  - `interface SyncState { version: 1; mailboxState: string | null; emailState: string | null; mailboxes: MailboxInfo[] }`
  - `interface MailStore {`
    `applyMailboxes(mailboxes: MailboxInfo[]): Promise<void>;` // create/rename/re-parent/remove local folders to match, keyed by id
    `localEmailIds(mailboxId: string): Promise<Set<string>>;`
    `mailboxesContaining(emailId: string): Promise<string[]>;`
    `upsertMessage(mailboxId: string, email: EmailHeaderInfo, flags: LocalFlags): Promise<void>;` // add header (no body) or update flags/tags
    `removeMessage(mailboxId: string, emailId: string): Promise<void>;`
    `emailsMissingBody(limit: number): Promise<{ mailboxId: string; emailId: string; blobId: string }[]>;`
    `storeBody(mailboxId: string, emailId: string, raw: Uint8Array): Promise<void>;`
    `loadState(): Promise<SyncState | null>; saveState(s: SyncState): Promise<void> }`
  - `class FakeStore implements MailStore` (test file) — in-memory; also exposes `folders: Map<id, MailboxInfo>` and `messages: Map<mailboxId, Map<emailId, { email; flags; body?: Uint8Array }>>` for assertions.

- [ ] **Step 1: Write failing tests:** `keywordsToFlags({$seen:true,$Flagged:true,Work:true,$notjunk:true})` → `{read:true, flagged:true, answered:false, forwarded:false, draft:false, junk:false, tags:["work"]}` (keyword matching is case-insensitive); `roleToKind("inbox") === "inbox"`, `roleToKind("important") === null`; `toMailboxInfos` puts `Alpha` (parent `Projects`) after `Projects` and an orphan at top level.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mail-sync): store interface, keyword and mailbox mapping`.

---

### Task 5: mail-sync — header sync engine (initial + delta)

**Files:**
- Create: `packages/mail-sync/src/engine.ts`
- Test: `packages/mail-sync/test/engine.int.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces:
  - `class SyncEngine { constructor(o: { client: JmapClient; store: MailStore; accountId: string; batchSize?: number /* default min(session.maxObjectsInGet, 500) */; log?: (level: "debug"|"info"|"warn"|"error", msg: string) => void }); sync(): Promise<SyncResult> }`
  - `interface SyncResult { full: boolean; mailboxesChanged: boolean; added: number; updated: number; removed: number }`
- Algorithm (what the tests pin):
  - Mailboxes: no `mailboxState` → `Mailbox/get` all; else `Mailbox/changes` loop until `!hasMoreChanges`, then `Mailbox/get` all (simple, mailboxes are few). `cannotCalculateChanges` → full. Always `store.applyMailboxes(toMailboxInfos(list))`.
  - Emails, full (no `emailState`, or `cannotCalculateChanges`): first `Email/get {ids: []}` to capture state S0; page `Email/query` (sort `receivedAt` descending) in `batchSize` pages; `emailGet` each page; for every email and every id in `mailboxIds` → `upsertMessage`; for every mailbox, remove local ids not seen on the server; set `emailState = S0`; then run one delta pass from S0.
  - Emails, delta: `Email/changes` loop; `emailGet(created ∪ updated)` in batches; for each email, upsert into its current mailboxes and `removeMessage` from `mailboxesContaining(id)` that are no longer in `mailboxIds`; for each destroyed id, remove from all `mailboxesContaining(id)`.
  - `saveState` after mailboxes and after emails. A thrown error leaves the last saved state intact.

- [ ] **Step 1: Write failing integration tests** (fresh Stalwart per `describe`; `FakeStore`):
  - Initial sync mirrors server: seeds Inbox ×2 (one `$seen $flagged`), mailbox `Projects/Alpha` ×1 → store has all mailboxes (Inbox `kind` `"inbox"`), 3 messages, correct flags; `result.full === true`.
  - Email in two mailboxes appears in both; `destroyEmail` + `sync()` removes it from both.
  - Delta: after `setKeywords(id, ["$seen"])`, `moveEmail(id2, [alphaId])`, a new import and a destroy → `sync()` returns `full === false`; store reflects all four changes.
  - `cannotCalculateChanges` → full resync: wrap the client so the next `Email/changes` throws `new JmapMethodError("cannotCalculateChanges")`; after `sync()`, `result.full === true` and store still matches server (no duplicates).
  - **(Review Focus 3)** 120 emails with `batchSize: 50` → 120 local messages in Inbox, no duplicates.
  - A failing `sync()` (client whose `request` throws `JmapNetworkError` mid-way) rejects and a following `sync()` with a working client converges.
- [ ] **Step 2: Run** `pnpm --filter @thunderbird-jmap/mail-sync test` → FAIL.
- [ ] **Step 3: Implement `SyncEngine`.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mail-sync): initial and delta header sync`.

---

### Task 6: mail-sync — message bodies

**Files:**
- Create: `packages/mail-sync/src/bodies.ts`
- Modify: `engine.ts` (expose methods), `index.ts`
- Test: `packages/mail-sync/test/bodies.int.test.ts`

**Interfaces:**
- Produces on `SyncEngine`:
  - `downloadPendingBodies(o?: { concurrency?: number /* 4 */; limit?: number /* 200 per call */ }): Promise<number>` — downloads blobs from `store.emailsMissingBody(limit)` and `storeBody`s them; returns count stored; one failed download is logged and skipped, not fatal.
  - `fetchBody(mailboxId: string, emailId: string, blobId: string): Promise<void>` — downloads and stores one body now; concurrent calls for the same email share one download.

- [ ] **Step 1: Write failing tests:** after `sync()`, `downloadPendingBodies()` returns 3 and every `FakeStore` message has a body whose text contains its seeded body; `fetchBody` on one message stores it (and two concurrent calls trigger one `downloadBlob`, checked with a counting wrapper); a blob id that 404s is skipped and the others still store.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mail-sync): background and on-demand body download`.

---

### Task 7: Thunderbird tooling — fetch, build, harness, add-on that loads

**Files:**
- Create: `scripts/fetch-thunderbird.mjs`, `apps/thunderbird-addon/{manifest.json, background.js, experiment/schema.json, experiment/api.js, experiment/modules/Log.sys.mjs, src/core-entry.ts, scripts/build.mjs, package.json}`, `apps/thunderbird-addon/test-experiment/{schema.json, api.js}`, `tests/thunderbird/{package.json, vitest.config.ts, harness/thunderbird.ts, harness/scenario.ts, addon-loads.test.ts}`
- Modify: `mise.toml` (tasks `tb:fetch`, `build`, `build:test`, `tb:test`)

**Interfaces:**
- Produces:
  - `mise run tb:fetch` → `.cache/thunderbird/<v>/thunderbird/thunderbird` for each `TB_VERSIONS` entry (skips already-extracted versions; fails on checksum mismatch).
  - `mise run build` → `apps/thunderbird-addon/dist/thunderbird-jmap.xpi`; `mise run build:test` → `dist/thunderbird-jmap-test.xpi` (adds `test-experiment/` and its `experiment_apis.jmapTest` manifest entry). esbuild: entry `src/core-entry.ts`, `format: "esm"`, `target: "firefox128"`, `bundle: true`, output `build/<variant>/experiment/modules/core.sys.mjs`.
  - Main Experiment `api.js`: on `onStartup` sets the `thunderbird-jmap` resource substitution to `<rootURI>experiment/modules/`, imports `resource://thunderbird-jmap/AccountRegistry.sys.mjs` (a stub exporting `whenReady(): Promise<void>` and `coreVersion: string` in this task); on non-app shutdown clears the substitution and sends `startupcache-invalidate`.
  - `core-entry.ts` re-exports `JmapClient`, `discoverSessionUrl`, error classes, `SyncEngine`, mapping helpers, and `CORE_VERSION` (from `package.json`).
  - Harness (`harness/thunderbird.ts`): `tbBinary(version: string): string`; `createProfile(o: { xpi: string; prefs?: Record<string, string|number|boolean> }): Promise<string>` (writes the spike's `user.js` prefs minus autoquit plus `jmaptest.autoquit=true`, copies xpi to `extensions/{ddb4c26d-c465-4ac4-a04d-eddc8783806f}.xpi`); `runThunderbird(o: { version: string; profile: string; scenario: string; args?: unknown; timeoutMs?: number /* 120000 */ }): Promise<{ exitCode: number; log: string }>` (headless; passes `JMAP_TEST_SCENARIO` and `JMAP_TEST_ARGS` = JSON env vars); `readReport<T>(profile: string, scenario: string): Promise<T>` (reads `<profile>/jmaptest-<scenario>.json`, throws with the run log tail if missing).
  - Test Experiment (`jmapTest`): on startup, if `JMAP_TEST_SCENARIO` is set, waits for the `thunderbird-jmap` substitution, imports `AccountRegistry.sys.mjs`, awaits `whenReady()`, runs the named scenario from a `SCENARIOS` map, writes `{ ok: true, ...result }` or `{ ok: false, error, stack }` to the report file, then quits. Scenario `"ping"` returns `{ coreVersion, tbVersion: Services.appinfo.version }`.

- [ ] **Step 1: Write the failing test** `tests/thunderbird/addon-loads.test.ts`: `describe.each(TB_VERSIONS)` → create profile with the test xpi, run scenario `"ping"`, report `ok === true`, `coreVersion` equals the root `package.json` version, `tbVersion` starts with the matrix version's major.
- [ ] **Step 2: Run** `mise run build:test && mise run tb:fetch && pnpm --filter tests-thunderbird test addon-loads` → FAIL.
- [ ] **Step 3: Implement** the scripts, manifest (MV3, id above, `strict_min_version` `"153.0"`, `experiment_apis.jmap` with `events: ["startup"]`, background script), Experiment entry, stub registry, test Experiment, harness.
- [ ] **Step 4: Run** → PASS on all three versions.
- [ ] **Step 5: Commit** `feat(addon): build pipeline, Experiment bootstrap, headless test harness`.

---

### Task 8: Account type, startup survival, folders

**Files:**
- Create: `experiment/modules/{Registration,ProtocolInfo,IncomingServer,MsgFolder,TbMailStore,AccountRegistry,Compat}.sys.mjs` (replace stub registry)
- Modify: `experiment/api.js`, `experiment/schema.json` (`createAccount`, `listAccounts`), `test-experiment/api.js` (scenarios)
- Test: `tests/thunderbird/account.test.ts`

**Interfaces:**
- Consumes: core bundle (Tasks 2–6), harness (Task 7).
- Produces:
  - Experiment API `browser.jmap.createAccount(d: { email: string; sessionUrl?: string; username?: string; secret: string; authKind: "basic" | "bearer" }): Promise<{ accountKey: string }>` — discovers the session (`sessionUrl` wins over discovery), validates credentials with `getSession()`, takes the primary mail account; only then creates server (`type "jmap"`, hostname = session URL host incl. port, username = `username ?? email`), identity (`email`), account; sets the three `jmap_*` string prefs and `secondsToLeaveUnavailable`; stores the secret in the login manager; starts the initial sync (Task 9 fills in messages). On any failure before creation nothing is created; on failure after creation everything created is removed.
  - `browser.jmap.listAccounts(): Promise<{ accountKey: string; email: string; sessionUrl: string }[]>`
  - `AccountRegistry.sys.mjs`: `whenReady(): Promise<void>`; `createAccount(d)` (as above); `runtimeFor(server: nsIMsgIncomingServer): AccountRuntime` where `AccountRuntime = { client: JmapClient; engine: SyncEngine; store: TbMailStore; lastSyncError: Error | null }` (built lazily, `fetch` from the module global, timers from `Timer.sys.mjs`; `lastSyncError` set/cleared by each `syncServer` run); `syncServer(server, reason: string): Promise<SyncResult>` (serialized per account; concurrent calls coalesce into one follow-up run).
  - Startup sequence in `whenReady`: register the four components; `MailServices.accounts.reactivateAccounts()`; for every `jmap` server clear `mail.server.<key>.timeFoundUnavailable`; then resolve.
  - `TbMailStore` folder side: `applyMailboxes` creates folders with `addSubfolder` under the right parent, sets `jmapMailboxId`, special-folder flags from `kind` (Inbox, SentMail, Drafts, Trash, Junk, Archive) plus `Mail`, renames on name change, removes folders whose id disappeared; persists the mailbox list into the state file; `loadState`/`saveState` read/write `jmap-sync-state.json`.
  - `MsgFolder` overrides (proven in spike): `subFolders` (root discovers the whole tree from the state file once), `getDBFolderInfoAndDB`, `updateFolder` (kicks `syncServer(server, "updateFolder")` without awaiting; immediately `NotifyFolderEvent("FolderLoaded")`), `baseMessageURI`/`getUriForMsg`/`generateMessageURI`, `incomingServerType`.
  - `ProtocolInfo`: as spike, but `canGetMessages`, `canGetIncomingMessages`, `defaultDoBiff` = `true`; default local path `<profile>/JmapMail`.
  - `Compat.sys.mjs`: `streamMessageArgs(args: unknown[]): { urlListener: nsIUrlListener | null; additionalHeader: string }` (153/160 vs trunk layouts, as in spike).
  - Test scenarios: `"create-account"` (args = `createAccount` input; waits for initial sync; returns `report()`), `"inspect"` (awaits `syncServer` for each account unless `args.noSync`; returns `report()`), where `report()` = `{ accounts: [{ accountKey, folders: [{ path: string[] /* pretty names from root */, mailboxId, flags: string[] /* Inbox, SentMail, … */, total, unread }], messages: {[path: string]: { subject, author, read, flagged, tags, jmapId, hasBody }[]} }], prefs: { timeFoundUnavailable: number[] } }`.

- [ ] **Step 1: Write failing tests** `account.test.ts` (`describe.each(TB_VERSIONS)`, fresh Stalwart + fresh profile per version; seed mailboxes `Projects`, `Projects/Alpha`, **(Review Focus 1)** `Reports: Q3/Q4 ✓` and a non-inbox mailbox named `INBOX`):
  - `create-account` → folder paths include `["Inbox"]` with flag `Inbox`, `["Projects","Alpha"]`, `["Reports: Q3/Q4 ✓"]`, and a second folder whose `mailboxId` is the non-inbox `INBOX` mailbox's id; every folder has the matching `mailboxId`.
  - Restart → `inspect` with `noSync` → same folders and ids; restart again → same; `prefs.timeFoundUnavailable` all `0`.
  - Server-side `Mailbox/set` rename of `Projects` → `Work` + `inspect` → path `["Work","Alpha"]`, same ids.
  - **(Review Focus 4)** `create-account` with a wrong password → report `ok === false`, error name `JmapAuthError`; a following `inspect` shows no `jmap` accounts and no `mail.server.*.type = "jmap"` prefs and no login for the origin (scenario returns `jmapServerPrefCount` and `loginCount` too).
- [ ] **Step 2: Run** `mise run build:test && pnpm --filter tests-thunderbird test account` → FAIL.
- [ ] **Step 3: Implement** the modules (port from `docs/spikes/2026-11-17-account-type/addon/api/implementation.js`, split by the file responsibilities above).
- [ ] **Step 4: Run** → PASS on all three versions.
- [ ] **Step 5: Commit** `feat(addon): jmap account type, startup survival, mailbox folders`.

---

### Task 9: Messages — headers, flags, delta sync in Thunderbird

**Files:**
- Modify: `TbMailStore.sys.mjs` (message side), `IncomingServer.sys.mjs`, `MsgFolder.sys.mjs`, `test-experiment/api.js`
- Test: `tests/thunderbird/sync.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 8.
- Produces:
  - `TbMailStore.upsertMessage`: new → `db.createNewHdr()`, set `subject` (UTF-8), `author`/`recipients`/`ccList` via `MailServices.headerParser.makeMimeHeader(...)` (MIME-encoded byte strings), `date` = (`sentAt ?? receivedAt`) in µs, `dateReceived` property, `messageId` (first, without `<>`), references (`inReplyTo` ∪ `references`, `<…>` joined by spaces), `messageSize`, flags from `LocalFlags` (Read, Marked, Replied, Forwarded, HasRe from subject, Attachment), tags as keywords, `jmapId`/`jmapBlobId`/`jmapThreadId`; `addNewHdrToDB(hdr, true)`. Existing → update flags/keywords only. `removeMessage` → `db.deleteHeader(hdr, null, true, true)`. `localEmailIds`/`mailboxesContaining` use a per-folder `Map<jmapId, msgKey>` built lazily from the DB.
  - Folder unread/total counts stay correct after adds/removes/flag changes (the C++ base's `updateSummaryTotals` is not implemented — override it so counts are re-read from the DB folder info; verify via `getNumUnread(false)` / `getTotalMessages(false)`).
  - `IncomingServer` overrides `getNewMessages(folder, msgWindow, urlListener)` and `performBiff(msgWindow)` → `syncServer(server, "getNewMessages"|"biff")`, calling `urlListener.OnStopRunningUrl` when done; `MsgFolder.getNewMessages(msgWindow, listener)` delegates to the server.
  - A failed sync is logged (`Log.sys.mjs`) and never removes local data.

- [ ] **Step 1: Write failing tests** `sync.test.ts` (per version):
  - `create-account` with Inbox ×2 (one `$seen $flagged`, one with keyword `Work`) → Inbox messages have correct `read`, `flagged`, `tags: ["work"]`; Inbox `total === 2`, `unread === 1`.
  - **(Review Focus 2)** a message from `Žana Šimić <zana@example.com>` with subject `Привет, мир` → report `author` decodes (`mime2DecodedAuthor`) to `Žana Šimić <zana@example.com>` and subject equals `Привет, мир`.
  - Server changes between runs (`setKeywords` read, `moveEmail` Inbox→Alpha, new import, `destroyEmail`) → restart → `inspect` (sync) → all four reflected; counts updated.
  - An email in Inbox and Alpha appears in both folders.
  - **(Review Focus 5)** stop Stalwart, restart Thunderbird → `inspect` (sync attempted) → report `ok === true`, same folders and messages as before, `lastSyncError` (returned by the scenario) is a `JmapNetworkError`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS on all three versions.
- [ ] **Step 5: Commit** `feat(addon): sync message headers and flags into Thunderbird folders`.

---

### Task 10: Opening messages — message service, bodies

**Files:**
- Create: `experiment/modules/MessageService.sys.mjs`
- Modify: `TbMailStore.sys.mjs` (`emailsMissingBody`, `storeBody`), `AccountRegistry.sys.mjs` (after each sync, start `downloadPendingBodies` unless `extensions.thunderbird-jmap.backgroundBodyDownload` is false), `Registration.sys.mjs`, `test-experiment/api.js`
- Test: `tests/thunderbird/open-message.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 8, 9; `Compat.streamMessageArgs`.
- Produces:
  - `TbMailStore.storeBody`: write via `folder.msgStore.getNewMsgOutputStream(folder)` / `finishNewMessage`, set `storeToken`, `offlineMessageSize`, `Offline` flag; `emailsMissingBody` = headers without the `Offline` flag.
  - Message service (proven in spike): `messageURIToMsgHdr`, `getUrlForUri`, `loadMessage`, `streamMessage` build `mailbox://<escaped folder file path>?number=<key>` with `originalSpec`/`uri` = the `jmap-message` URI. **New:** if the header lacks `Offline`, `loadMessage`/`streamMessage` first `await runtime.engine.fetchBody(...)`, then proceed. Other methods throw `NS_ERROR_NOT_IMPLEMENTED` except `isMsgInMemCache` → `false`.
  - Scenario `"open-first"` (args `{ folderPath: string[] }`): selects the folder and first row in the 3-pane, waits up to 15 s for the message pane body; returns `{ rendered: boolean, bodyText, headerSubject, streamedBytes, streamedContains: boolean }` and saves `open-first.png`.

- [ ] **Step 1: Write failing tests** (per version): with background download on → after `create-account`, `inspect` shows every message `hasBody === true`; `open-first` on Inbox renders the seeded body text and streaming returns the full message. With `extensions.thunderbird-jmap.backgroundBodyDownload=false` → messages `hasBody === false`, `open-first` still renders the body, and afterwards that message `hasBody === true`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS on all three versions.
- [ ] **Step 5: Commit** `feat(addon): open messages via jmap-message service with on-demand body fetch`.

---

### Task 11: Setup page, toolbar button, dev launcher

**Files:**
- Create: `apps/thunderbird-addon/ui/{setup.html,setup.js,setup.css}`, `scripts/run-thunderbird.mjs`
- Modify: `manifest.json` (`action` with title "Add JMAP account"), `background.js` (`browser.action.onClicked` → `browser.tabs.create({ url: "ui/setup.html" })`), `mise.toml` (`tb:run`)
- Test: `tests/thunderbird/account.test.ts` (one added case)

**Interfaces:**
- Consumes: `browser.jmap.createAccount`, `browser.jmap.listAccounts` (Task 8).
- Produces: setup page with fields Email, Password-or-token (password input), Login type (`Password` → `basic`, `API token` → `bearer`), an "Advanced" disclosure with Session URL and Username; submit disables the form, calls `createAccount`, shows success ("Account added — your folders will appear in the folder pane.") or the error message (auth errors: "The server rejected the email or password."); http session URLs allowed only for `localhost`/`127.0.0.1` (otherwise "Use an https:// address."). `mise run tb:run [-- --version 160.0]` launches non-headless Thunderbird with a persistent dev profile `.cache/profiles/dev-<version>` and the fresh dev xpi.
- [ ] **Step 1: Write the failing test:** scenario `"setup-page"` opens `ui/setup.html` in a tab, fills the form with the Stalwart credentials (via the page's DOM), submits, waits for the success text, returns `listAccounts()`; test asserts one account with the Stalwart session URL.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual check:** `mise run stalwart:up && mise run tb:run` → click "Add JMAP account", enter `admin` / `jmap-dev-password` with Session URL `http://127.0.0.1:18080/jmap/session` → folders appear; open a message; restart Thunderbird → still there.
- [ ] **Step 6: Commit** `feat(addon): setup page and dev launcher`.

---

## Self-review notes

- Spec coverage (Phase 1 scope): account type + startup survival (T8), mailbox↔folder mapping incl. roles/hierarchy/rename (T4, T8), headers/flags/tags/multi-mailbox (T4, T5, T9), initial + delta + `cannotCalculateChanges` (T5), headers-first + on-open body fetch (T6, T10), polling via biff/Get Messages (T9), setup + Basic/Bearer (T2, T8, T11), login manager secrets (T8), version matrix incl. 158 (T7), relative session URLs (T2), test harness pattern (T7). Out of Phase 1 by design: write-back, sending, push, uninstall flow.
- Known unknown flagged in-task: folder count refresh mechanism (T9) — pinned by test, mechanism left to implementer.
