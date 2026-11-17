# Phase 2 — Two-way JMAP Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the JMAP account two-way. Changes in Thunderbird (read, flag, tags, junk, move, delete, drafts) reach the server, and mail is sent through JMAP from each server identity.

**Architecture:**
- **Packages** (`jmap-client`, `mail-sync`): protocol and queue logic, no Thunderbird APIs:
  - write methods and submission;
  - keyword diffs and the "local-only" rule;
  - a persisted, serial outbound queue (`Outbox`);
  - preparing a message for submission.
- **Add-on modules:** adapt that logic to Thunderbird:
  - a `jmap` outgoing server type;
  - identity sync;
  - a mail-session folder listener that turns local changes into queue operations;
  - JsAccount folder overrides for move, delete, Empty Trash and draft save.
- **Tests:** a local Mailflare + Mailpit fixture joins Stalwart.

**Tech Stack:** as Phase 1. TypeScript 7 / Vitest 5 in packages; Thunderbird Experiment ES modules; podman containers: Stalwart `v1.1.1`, Mailflare built from a pinned commit, Mailpit.

**Spec:** `docs/superpowers/specs/2026-11-17-phase-2-two-way-account-design.md` (builds on `docs/superpowers/specs/2026-11-17-thunderbird-jmap-addon-design.md`; experiment record `docs/spikes/2026-11-17-phase-2/README.md`).

## Global Constraints

- **Versions:** Thunderbird 153.7.0esr, 158.0 and 160.0 (`TB_VERSIONS`). Every Thunderbird test runs on all three.
- **Commits:** directly to `main`, Conventional Commits. Before every commit run `node scripts/bump-version.mjs <major|minor|patch>`: `feat` → minor, anything else → patch. The bumped files go in the same commit.
- **Run tools:** with `mise exec` / `mise run` (Volta shadows mise on this machine). Full Thunderbird suite: `mise run tb:test` (~15 min; run it in the background).
- **Headers:** every new source file starts with the repo's MPL-2.0 header (license unchanged unless the owner decides otherwise).
- **Patching:** keywords are patched one by one (`keywords/<k>: true|null`), never by replacing `keywords`. Server `$` keywords the add-on hides locally must survive.
- **Never send real mail:**
  - test sends go to Mailpit;
  - Mailflare is built from `hieunc229/mailflare@5330fa4fff72cb0f38564822ff873e8ab854dee8` and fetched at test time, never copied into this repo (AGPL-3.0);
  - Mailpit image: `docker.io/axllent/mailpit:v1.33.1`.
- **CI stays fast:** Mailflare-backed tests live only in `tests/thunderbird` (run by `mise run tb:test`, not by `mise run check`).
- **Anti-goals (spec §2):**
  - no JMAP-identity mail through another account's SMTP; nothing sent twice; no lost Bcc recipients;
  - no silent tag loss;
  - no local change shown as done that never reaches the server;
  - server data deleted only by user action or a deletion setting the user turned on.
- **Copy:** the user-facing texts in Tasks 5, 8 and 9 are fixed as written there.

## Plan decision (deviation from spec §6, recorded here)

Stalwart `v1.1.1` in recovery-admin mode has no user with an email address. It refuses `Identity/set` ("E-mail address not configured"), so it cannot submit mail.

- **Standard submission path:** checked by request-shape tests against a fake fetch (Task 3).
- **End-to-end sending:** runs on the local Mailflare (Task 5).
- **Write-back** (`Email/set`): still runs on both servers.

Cost if wrong: a standard server that handles submission differently from RFC 8621 is not caught until someone uses one.

## Review Focus

1. **Quick toggles:** a message is toggled read → unread → read before the queue sends. The server ends up read, and one patch (or none) is sent, never a stale "unread" (Task 7).
2. **Multi-mailbox delete:** deleting one copy of an email that is in two mailboxes on Stalwart removes only that mailbox. The email stays in the other one and is not moved to Trash (Task 9).
3. **Sending offline:** sending while the server is unreachable fails with a clear message, nothing is half-sent, and the message is not lost (Task 5).
4. **Two addresses, like the owner's server:** a Mailflare account with `me@` and `hello@` gives two Thunderbird identities. Each sends from its own address, and each Sent copy lands in its own Sent folder (Tasks 4–5).
5. **Large selections:** marking 30 messages read with a forced batch size of 10 sends three `Email/set` calls, and all 30 are read on the server (Tasks 7–8).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/jmap-client/src/mail.ts` (modify) | `emailSet`, `emailImport` + result types |
| `packages/jmap-client/src/submission.ts` (create) | `Identity`, `identityGet`, `identityChanges`, `submitEmail`, `SUBMISSION_USING` |
| `packages/mail-sync/src/mapping.ts` (modify) | `flagsToKeywords`, `keywordPatch`, `mergeServerFlags` |
| `packages/mail-sync/src/engine.ts` (modify) | `isPending` option, `refreshEmails()` |
| `packages/mail-sync/src/outbox.ts` (create) | `Outbox`: queue, coalescing, persistence, batching, results |
| `packages/mail-sync/src/outgoing.ts` (create) | `prepareForSubmission`, `isRedirect`, `sendDraft` |
| `packages/test-support/src/mailflare.ts` (create) | `startMailflare()` fixture (Mailflare + Mailpit) |
| `apps/thunderbird-addon/experiment/modules/OutgoingServer.sys.mjs` (create) | `JmapOutgoingServer` (nsIMsgOutgoingServer), guard, parking |
| `apps/thunderbird-addon/experiment/modules/Identities.sys.mjs` (create) | JMAP identities → Thunderbird identities |
| `apps/thunderbird-addon/experiment/modules/ChangeWatcher.sys.mjs` (create) | Folder listener → `Outbox` operations |
| `apps/thunderbird-addon/experiment/modules/Notify.sys.mjs` (create) | `notify(server, text)` via `mailSession.alertUser` |
| `apps/thunderbird-addon/experiment/modules/TbMailStore.sys.mjs` (modify) | Server keywords per header, local-only rule, local move, draft raw I/O |
| `apps/thunderbird-addon/experiment/modules/MsgFolder.sys.mjs` (modify) | `copyMessages` (move), `deleteMessages`, `emptyTrash`, `copyFileMessage` |
| `apps/thunderbird-addon/experiment/modules/AccountRegistry.sys.mjs` (modify) | Runtime gets `outbox`; startup guard; shutdown parking; flush scheduling |
| `apps/thunderbird-addon/experiment/modules/Registration.sys.mjs` (modify) | Register the outgoing server factory |
| `apps/thunderbird-addon/test-experiment/Scenarios.sys.mjs` (modify) | New scenarios per task |
| `tests/thunderbird/*.test.ts` (create per task) | Integration tests |

---

### Task 1: jmap-client write and submission methods

**Files:**
- Modify: `packages/jmap-client/src/mail.ts`
- Create: `packages/jmap-client/src/submission.ts`
- Modify: `packages/jmap-client/src/index.ts`
- Test: `packages/jmap-client/test/write.test.ts` (fake fetch, `test/fake-fetch.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface SetError { type: string; description?: string; properties?: string[] }
  export interface EmailSetResult {
    newState: string;
    updated: Record<string, unknown>;
    destroyed: string[];
    notUpdated: Record<string, SetError>;
    notDestroyed: Record<string, SetError>;
  }
  export function emailSet(c: JmapClient, accountId: string,
    o: { update?: Record<string, Record<string, unknown>>; destroy?: string[] }): Promise<EmailSetResult>;
  export interface ImportedEmail { id: string; blobId: string; threadId: string }
  export function emailImport(c: JmapClient, accountId: string,
    emails: Record<string, { blobId: string; mailboxIds: Record<string, true>; keywords: Record<string, true> }>
  ): Promise<{ created: Record<string, ImportedEmail>; notCreated: Record<string, SetError> }>;
  export const SUBMISSION_USING: string[]; // core, mail, submission
  export interface Identity { id: string; email: string; name: string }
  export function identityGet(c: JmapClient, accountId: string): Promise<{ state: string; list: Identity[] }>;
  export function identityChanges(c: JmapClient, accountId: string, sinceState: string): Promise<Changes>;
  export function submitEmail(c: JmapClient, accountId: string, o: {
    blobId: string; draftsMailboxId: string; sentMailboxId: string; identityId: string;
    envelope: { mailFrom: string; rcptTo: string[] };
  }): Promise<{ submissionId?: string; error?: SetError; draftId?: string }>;
  ```
  `submitEmail` sends **one** request:
  1. `Email/import` into Drafts with `$draft` and `$seen`;
  2. `EmailSubmission/set` with `emailId: "#draft"`, the envelope as `{ mailFrom: { email }, rcptTo: [{ email }…] }`, and `onSuccessUpdateEmail` moving the email from Drafts to Sent and clearing `$draft`.
- Consumes: `JmapClient.request`, `call`, `uploadBlob` (Phase 1).

- [ ] **Step 1: Write the failing tests**

```ts
test("emailSet sends individual keyword patches and returns per-email results", async () => {
  // fake answers notUpdated for "e2"
  const r = await emailSet(client, "a", { update: { e1: { "keywords/$seen": true }, e2: { "mailboxIds/m1": null, "mailboxIds/m2": true } } });
  expect(sentCalls()[0][1].update).toEqual({ e1: { "keywords/$seen": true }, e2: { "mailboxIds/m1": null, "mailboxIds/m2": true } });
  expect(r.notUpdated.e2.type).toBe("invalidProperties");
});
test("submitEmail imports into Drafts and submits with an explicit envelope in one request", async () => {
  await submitEmail(client, "a", { blobId: "b1", draftsMailboxId: "d", sentMailboxId: "s", identityId: "i",
    envelope: { mailFrom: "me@x.test", rcptTo: ["to@y.test", "bcc@y.test"] } });
  const [[imp, importArgs], [sub, subArgs]] = sentCalls();
  expect([imp, sub]).toEqual(["Email/import", "EmailSubmission/set"]);
  expect(importArgs.emails.draft).toMatchObject({ blobId: "b1", mailboxIds: { d: true }, keywords: { $draft: true, $seen: true } });
  expect(subArgs.create.send).toMatchObject({ identityId: "i", emailId: "#draft",
    envelope: { mailFrom: { email: "me@x.test" }, rcptTo: [{ email: "to@y.test" }, { email: "bcc@y.test" }] } });
  expect(subArgs.onSuccessUpdateEmail["#send"]).toEqual({ "mailboxIds/d": null, "mailboxIds/s": true, "keywords/$draft": null });
  expect(lastUsing()).toEqual(SUBMISSION_USING);
});
test("submitEmail reports a refused submission without throwing", async () => {
  // fake: EmailSubmission/set notCreated.send = { type: "forbidden", description: "Sending is not set up" }
  const r = await submitEmail(client, "a", ARGS);
  expect(r.error).toEqual({ type: "forbidden", description: "Sending is not set up" });
});
test("identityGet and identityChanges use the submission capability", async () => { /* lastUsing() == SUBMISSION_USING */ });
```

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd packages/jmap-client && mise exec -- pnpm vitest run test/write.test.ts`
  - Expected: FAIL (`emailSet is not a function` …)

- [ ] **Step 3: Implement the functions in `mail.ts` and `submission.ts` and export them from `index.ts`**

  `submitEmail` uses `client.request(calls, SUBMISSION_USING)` and reads the `EmailSubmission/set` response. An `Email/import` failure becomes `error` with the import's `SetError`.

- [ ] **Step 4: Run the package tests and typecheck**
  - Run: `cd packages/jmap-client && mise exec -- pnpm vitest run && mise exec -- pnpm typecheck`
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(jmap-client): Email/set, Email/import, identities and submission`

---

### Task 2: Mailflare + Mailpit test fixture

**Files:**
- Create: `packages/test-support/src/mailflare.ts`
- Modify: `packages/test-support/src/index.ts`
- Test: `tests/thunderbird/mailflare-fixture.test.ts` (no Thunderbird needed; lives here so `mise run check` never builds Mailflare)

**Interfaces:**
- Produces:
  ```ts
  export const MAILFLARE_COMMIT = "5330fa4fff72cb0f38564822ff873e8ab854dee8";
  export const MAILPIT_IMAGE = "docker.io/axllent/mailpit:v1.33.1";
  export interface MailflareInstance {
    baseUrl: string; sessionUrl: string;                 // http://127.0.0.1:<port>/jmap/session
    username: string; apiKey: string;                    // Basic auth: username + API key (Mailflare's JMAP accepts API keys only)
    addresses: string[];                                 // e.g. ["me@example.test", "hello@example.test"]
    deliver(o: { from: string; to: string; subject: string; body: string; messageId?: string }): Promise<void>; // over SMTP
    captured(): Promise<{ from: string; to: string[]; bcc: string[]; subject: string; raw: string; text: string }[]>; // Mailpit
    setSending(enabled: boolean): Promise<void>;         // domain sending_provider "cloudflare" | "none"
    stop(): Promise<void>;
  }
  export function startMailflare(o?: { localParts?: string[] }): Promise<MailflareInstance>; // default ["me", "hello"]
  ```
- How to build it (proven steps: `docs/spikes/2026-11-17-phase-2/README.md` §4 and `mailflare-up.sh`):
  - **Image:** build `localhost/mailflare-test:<short commit>` once from a shallow clone in `.cache/mailflare/src` at `MAILFLARE_COMMIT`; reuse it if it exists.
  - **Containers:** run Mailpit and Mailflare on a private podman network with random free host ports. Set `SMTP_URL=smtp://<mailpit>:1025`, `SMTP_INBOUND_PORT=2525` and `APP_URL=http://127.0.0.1:<port>`.
  - **First-time setup:** register the account on domain `example.test` with `skipDns: true`.
  - **Second address:** create one mailbox per extra local part through Mailflare's mailbox API. See `src/app/api/mailboxes/route.ts` in the clone for its request format (*builder reads it*).
  - **Domain state:** set `domains.status='active'` and `sending_provider='cloudflare'` in `/data/mailflare.sqlite` (test-only shortcut).
  - **API key:** create one with scope `["jmap"]` covering every mailbox. Send `Sec-Fetch-Site: same-origin` with the request.
  - **`deliver()`:** sends from a domain without SPF/DMARC (`sender.test`); `example.org` mail is filed as spam.
  - **`captured()`:** Mailpit prepends one `Bcc:` line for envelope-only recipients. `raw` must have that line removed, so tests can check what recipients really received.

- [ ] **Step 1: Write the failing test**

```ts
test("a fresh Mailflare has two identities, takes SMTP mail into the Inbox, and sends into Mailpit", async () => {
  const mf = await startMailflare();
  try {
    const { client, accountId } = await connectWith(mf);          // JmapClient with Basic(username, apiKey)
    const ids = await identityGet(client, accountId);
    expect(ids.list.map(i => i.email).sort()).toEqual(["hello@example.test", "me@example.test"]);
    await mf.deliver({ from: "out@sender.test", to: "me@example.test", subject: "Fixture in", body: "Čestitke" });
    const inbox = (await mailboxGet(client, accountId)).list.find(m => m.role == "inbox" && m.parentId?.length);
    // the Inbox under me@ holds "Fixture in"
    expect(await subjectsIn(client, accountId, inbox!.id)).toContain("Fixture in");
    // a raw draft submitted from me@ arrives in Mailpit to To and Bcc, without a Bcc header in raw
    await sendRaw(client, accountId, mf, { to: "to@dest.test", bcc: "hidden@dest.test", subject: "Fixture out" });
    const [msg] = (await mf.captured()).filter(m => m.subject == "Fixture out");
    expect(msg.to).toEqual(["to@dest.test"]);
    expect(msg.bcc).toEqual(["hidden@dest.test"]);
    expect(msg.raw).not.toMatch(/^Bcc:/im);
  } finally { await mf.stop(); }
}, 900_000);
```

`connectWith`, `subjectsIn` and `sendRaw` are small helpers in the test file. `sendRaw` uses Task 1's `submitEmail`.

- [ ] **Step 2: Run it to verify it fails**
  - Run: `cd tests/thunderbird && mise exec -- pnpm vitest run mailflare-fixture.test.ts`
  - Expected: FAIL (`startMailflare is not exported`)

- [ ] **Step 3: Implement `startMailflare`**

  Reuse `stalwart.ts`'s podman helpers and port picking.

- [ ] **Step 4: Run it to verify it passes**
  - Same command. Expected: PASS. The first run builds the image, which takes minutes.

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs patch`
  - `test: local Mailflare + Mailpit fixture`

---

### Task 3: Preparing and submitting a message (mail-sync)

**Files:**
- Create: `packages/mail-sync/src/outgoing.ts`
- Modify: `packages/mail-sync/src/index.ts`
- Test: `packages/mail-sync/test/outgoing.test.ts` (pure + fake fetch)

**Interfaces:**
- Consumes: Task 1 `submitEmail`, `JmapClient.uploadBlob`.
- Produces:
  ```ts
  export class RedirectNotSupportedError extends Error {}
  export function isRedirect(raw: Uint8Array): boolean;          // a Resent-From / Resent-To header in the header block
  export function prepareForSubmission(raw: Uint8Array, bcc: string[]): Uint8Array; // adds "Bcc: a, b" before the blank line when bcc is non-empty; bytes otherwise unchanged
  export function sendDraft(client: JmapClient, accountId: string, o: {
    raw: Uint8Array; bcc: string[]; to: string[]; identity: { id: string; email: string };
    draftsMailboxId: string; sentMailboxId: string;
  }): Promise<{ submissionId: string }>;   // throws RedirectNotSupportedError, JmapNetworkError, or SubmissionRefusedError(error: SetError)
  export class SubmissionRefusedError extends Error { constructor(readonly error: SetError) }
  ```
  `sendDraft` steps:
  1. Refuse a redirect.
  2. Run `prepareForSubmission`.
  3. `uploadBlob(… "message/rfc822")`.
  4. `submitEmail` with envelope `{ mailFrom: identity.email, rcptTo: [...to, ...bcc] }` (deduplicated, case-insensitive).

- [ ] **Step 1: Write the failing tests**

```ts
test("prepareForSubmission adds one Bcc header and leaves the body untouched", () => {
  const out = text(prepareForSubmission(bytes("From: a@x\r\nTo: b@y\r\n\r\nbody Bcc: x\r\n"), ["h1@y", "h2@y"]));
  expect(out).toBe("From: a@x\r\nTo: b@y\r\nBcc: h1@y, h2@y\r\n\r\nbody Bcc: x\r\n");
});
test("prepareForSubmission without Bcc returns the bytes unchanged", () => { /* toEqual input */ });
test("isRedirect sees Resent- headers only in the header block", () => {
  expect(isRedirect(bytes("Resent-From: a@x\r\nFrom: b@y\r\n\r\nx"))).toBe(true);
  expect(isRedirect(bytes("From: b@y\r\n\r\nResent-From: a@x"))).toBe(false);
});
test("sendDraft refuses a redirect before uploading anything", async () => {
  await expect(sendDraft(client, "a", { ...ARGS, raw: bytes("Resent-To: c@z\r\n\r\nx") })).rejects.toBeInstanceOf(RedirectNotSupportedError);
  expect(fetchCalls()).toEqual([]);
});
test("sendDraft submits Thunderbird's exact recipients, Bcc included, once", async () => {
  await sendDraft(client, "a", { ...ARGS, to: ["To@Y.test"], bcc: ["to@y.test", "h@y.test"] });
  expect(submission().envelope.rcptTo).toEqual([{ email: "To@Y.test" }, { email: "h@y.test" }]);
  expect(countCalls("EmailSubmission/set")).toBe(1);
});
test("a refused submission throws SubmissionRefusedError with the server's description", async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd packages/mail-sync && mise exec -- pnpm vitest run test/outgoing.test.ts`
  - Expected: FAIL

- [ ] **Step 3: Implement `outgoing.ts`**

  Header-block detection stops at the first `\r\n\r\n` (or `\n\n`).

- [ ] **Step 4: Run all mail-sync tests and typecheck**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(mail-sync): prepare and submit outgoing messages`

---

### Task 4: `jmap` outgoing server, identities, and the fallback guard

**Files:**
- Create: `apps/thunderbird-addon/experiment/modules/OutgoingServer.sys.mjs`
- Create: `apps/thunderbird-addon/experiment/modules/Identities.sys.mjs`
- Modify:
  - `Registration.sys.mjs` (factory for `@mozilla.org/messenger/outgoing/server;1?type=jmap`, new CID);
  - `AccountRegistry.sys.mjs`: `createAccount`, `startup`, `shutdown` and sync, as described below;
  - `Scenarios.sys.mjs` and `tests/thunderbird/harness/types.ts`.
- Test: `tests/thunderbird/outgoing.test.ts`

**Interfaces:**
- Consumes: Task 1 `identityGet`, `identityChanges`; `JmapClient`; the Phase 1 runtime (`runtimeFor(server)`).
- Produces:
  ```js
  // OutgoingServer.sys.mjs
  export class JmapOutgoingServer { /* nsIMsgOutgoingServer; type "jmap"; supports both `server.key = k` (153/158)
     and `initialize(key, newServer)` (160); stores mail.smtpserver.<key>.jmap_incoming = <incoming server key> */ }
  export function createOutgoingServer(incoming /* nsIMsgIncomingServer */): string; // returns outgoing key
  export function ensureOutgoingServers(): void;  // startup: un-park + every JMAP identity resolves to its jmap server, recreate same key if not
  export function parkOutgoingServers(): void;    // shutdown: type "smtp", hostname "jmap-parked.invalid", port 1
  // Identities.sys.mjs
  export async function syncIdentities(incoming, client, accountId): Promise<void>;
  ```
- Identities:
  - one Thunderbird identity per JMAP identity, keyed by the identity pref `jmap_identity_id`;
  - `email` and `fullName` from the server;
  - `smtpServerKey` = the account's jmap outgoing server;
  - `doFcc = false`;
  - `draftFolder` / `fccFolder` = URIs of the `drafts` / `sent` mailboxes under the identity's mailbox. On Mailflare that's the mailbox whose id is the identity id's prefix before `~`; otherwise the account's top-level role mailboxes.
  - Identities without `jmap_identity_id` are left alone. A JMAP identity that disappears is removed from the account unless it is the account's last identity.
- Called from:
  - `createAccount` (after the server is created);
  - every sync, when `Identity/changes` reports changes. Mailflare's `cannotCalculateChanges` means: re-run `identityGet` and compare.
- `startup()` calls `ensureOutgoingServers()` after `registerComponents()`; `shutdown()` calls `parkOutgoingServers()`.
- `sendMailMessage` exists but reports failure with the text `Sending through JMAP is not ready yet.` (replaced in Task 5).

- [ ] **Step 1: Write the failing tests** (Mailflare fixture; scenarios `create-account`, `inspect`, new `outgoing-state`)

```ts
test("a Mailflare account with two addresses gets two identities sending through its jmap server", async () => {
  const r = await runScenario<OutgoingState>({ version, profile, scenario: "outgoing-state", args: {} });
  expect(r.identities.map(i => i.email).sort()).toEqual(["hello@example.test", "me@example.test"]);
  for (const i of r.identities) {
    expect(i).toMatchObject({ outgoingType: "jmap", doFcc: false });
    expect(i.draftFolder).toMatch(new RegExp(`/${i.email.split("@")[0]}.*/Drafts$`)); // its own tree
  }
});
test("after a restart every JMAP identity still resolves to the jmap server", /* outgoing-state again */);
test("a stale outgoing list is repaired at startup: the jmap server is recreated under the same key", async () => {
  // scenario "drop-outgoing": removes the key from mail.smtpservers' cached view by restarting with the type pref
  // set to an unregistered type "jmap-missing"; next start must show outgoingType "jmap" and the same key.
});
test("after the add-on shuts down, its outgoing server is parked so nothing can fall back to another account", async () => {
  // after any scenario run (the add-on shut down at quit), read prefs.js of the profile:
  // mail.smtpserver.<jmap key>.type == "smtp", .hostname == "jmap-parked.invalid", .port == 1
  // (no "jmap"-typed server is left for 153/158 to choke on when the add-on is absent);
  // the next run's "outgoing-state" shows outgoingType "jmap" again, same key.
});
```

- [ ] **Step 2: Run them to verify they fail**
  - Run: `mise run build:test && cd tests/thunderbird && mise exec -- pnpm vitest run outgoing.test.ts -t "Thunderbird 160"`
  - Expected: FAIL

- [ ] **Step 3: Implement**

  Work in this order: `OutgoingServer.sys.mjs`, then `Identities.sys.mjs`, then the registry and registration wiring, then the scenarios. For the "not installed" test, the harness needs `createProfile`/restart with the xpi removed, as `harness.test.ts` does.

- [ ] **Step 4: Run them on all versions, then the whole Thunderbird suite**
  - Run: `cd tests/thunderbird && mise exec -- pnpm vitest run outgoing.test.ts`, then `mise run tb:test` in the background.
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(addon): jmap outgoing server and JMAP identities`

---

### Task 5: Sending through JMAP

**Files:**
- Modify:
  - `OutgoingServer.sys.mjs` (`sendMailMessage`);
  - `AccountRegistry.sys.mjs` (expose the account runtime to the outgoing server through `jmap_incoming`);
  - `Scenarios.sys.mjs` (scenario `send`, using `nsIMsgSend.sendMessageFile` as in `docs/spikes/2026-11-17-phase-2/spike-scenarios.diff`).
- Test: `tests/thunderbird/send.test.ts`

**Interfaces:**
- Consumes: Task 3 `sendDraft`, `RedirectNotSupportedError`, `SubmissionRefusedError`; Task 4 identities (`jmap_identity_id`, `draftFolder`, `fccFolder` → `jmapMailboxId`).
- Produces `sendMailMessage(file, recipients, bccRecipients, identity, sender, password, statusListener, requestDSN, messageId, listener)`:
  1. read the file;
  2. call `listener.onSendStart(request)`;
  3. `sendDraft(...)`;
  4. finish with `listener.onSendStop(serverURI, status, null, errorMessage)`.

  `errorMessage` texts (fixed):
  - Redirect: `Redirect isn't available for JMAP accounts.`
  - Refused: `The server did not send this message: <description>. If a copy appears in Sent, it was not delivered.`
  - Network error before the submission request was sent: `Couldn't reach the mail server. The message was not sent.`
  - Network error after it was sent: `The connection was lost while sending. The message may have been sent; check Sent before sending it again.`

  Never retry automatically. After success, request a sync so the server's Sent copy arrives.

- [ ] **Step 1: Write the failing tests** (Mailflare fixture, plus the second SMTP account set as default to catch any fallback)

```ts
test("sending from each address delivers to To and Bcc, with no Bcc header, and one Sent copy each", async () => {
  for (const from of ["me@example.test", "hello@example.test"]) {
    const r = await runScenario<SendResult>({ version, profile, scenario: "send",
      args: { from, to: "to@dest.test", bcc: "hidden@dest.test", subject: `Hi from ${from}` } });
    expect(r.status).toBe(0);
  }
  const caught = await mf.captured();
  for (const from of ["me@example.test", "hello@example.test"]) {
    const m = caught.find(c => c.subject == `Hi from ${from}`)!;
    expect(m).toMatchObject({ from, to: ["to@dest.test"], bcc: ["hidden@dest.test"] });
    expect(m.raw).not.toMatch(/^Bcc:/im);
  }
  const after = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: {} });
  // one Sent copy per address, in that address's own Sent folder; Drafts empty
});
test("Redirect is refused and nothing is captured", /* raw with Resent-To; status != 0; errorMessage exact */);
test("a send the server refuses reports it plainly", async () => {
  await mf.setSending(false);
  const r = await runScenario<SendResult>({ /* send */ });
  expect(r.status).not.toBe(0);
  expect(r.errorMessage).toMatch(/^The server did not send this message: Sending is not set up/);
  expect(r.errorMessage).toContain("If a copy appears in Sent, it was not delivered.");
  await mf.setSending(true);
});
test("Send Later puts the message in the Outbox, and sending the Outbox goes through JMAP", /* nsMsgQueueForLater, then
  MailServices outbox send (nsIMsgSendLater.sendUnsentMessages); captured once in Mailpit */);
test("sending with the server stopped fails clearly and nothing reaches the fallback SMTP server", async () => {
  // stop Mailflare; send; status != 0; errorMessage "Couldn't reach the mail server. The message was not sent."
  // fallback SMTP account's server was never contacted (scenario records outgoingServer used)
});
```

- [ ] **Step 2: Run them to verify they fail**
  - Run: `mise run build:test && cd tests/thunderbird && mise exec -- pnpm vitest run send.test.ts -t "Thunderbird 160"`
  - Expected: FAIL (`Sending through JMAP is not ready yet.`)

- [ ] **Step 3: Implement `sendMailMessage`**

- [ ] **Step 4: Run `send.test.ts` on all versions, then `mise run tb:test` in the background**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(addon): send mail through JMAP`

---

### Task 6: Server keywords, the local-only rule, and engine hooks

**Files:**
- Modify:
  - `packages/mail-sync/src/mapping.ts`;
  - `packages/mail-sync/src/engine.ts`;
  - `packages/mail-sync/src/store.ts` (doc of `upsertMessage`);
  - `apps/thunderbird-addon/experiment/modules/TbMailStore.sys.mjs`.
- Test: `packages/mail-sync/test/mapping.test.ts`, `packages/mail-sync/test/engine.int.test.ts`, `tests/thunderbird/sync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function flagsToKeywords(flags: LocalFlags): string[];  // lower-case: $seen, $flagged, $answered, $forwarded, $draft, $junk|$notjunk, tags
  export function keywordPatch(serverKeywords: string[], desired: string[], localOnly: string[]): Record<string, true | null>;
  // keys "keywords/<k>"; only differences; never touches $-keywords absent from `desired`'s vocabulary
  // (i.e. server-only $ keywords the add-on hides stay); skips `localOnly`.
  export function mergeServerFlags(server: LocalFlags, serverKeywords: string[], previousServerKeywords: string[] | null, local: LocalFlags): LocalFlags;
  // server is the truth for everything the server reports or once reported; a local tag/answered/forwarded/junk
  // the server never had (absent from previousServerKeywords) is kept.
  ```
  `SyncEngine` changes:
  - constructor option `isPending?: (emailId: string) => boolean`. A delta sync does not touch local copies of a pending email: no upsert and no removal.
  - new method `refreshEmails(ids: string[]): Promise<void>`: `Email/get` (header properties) and apply each email as a delta update would, creating, updating or removing local copies to match its `mailboxIds`.

  `TbMailStore` changes:
  - stores `jmapServerKeywords` (space-separated, lower-case) on every header it writes;
  - `_updateFlags` applies `mergeServerFlags`;
  - new `serverKeywordsOf(hdr): string[]` and `localOnlyOf(hdr): string[]`; `localOnlyOf` reads the `jmapLocalKeywords` property.

- [ ] **Step 1: Write the failing tests**

```ts
test("keywordPatch sends only differences and never removes hidden $ keywords", () => {
  expect(keywordPatch(["$seen", "$hasnoattachment", "work"], ["$flagged", "work"], []))
    .toEqual({ "keywords/$seen": null, "keywords/$flagged": true });
});
test("keywordPatch skips keywords known to be local-only", () => {
  expect(keywordPatch(["$seen"], ["$seen", "work"], ["work"])).toEqual({});
});
test("mergeServerFlags keeps a tag the server never had and drops one the server removed", () => {
  const local = { ...NONE, tags: ["mine", "gone"] };
  const merged = mergeServerFlags({ ...NONE, tags: [] }, [], ["gone"], local);
  expect(merged.tags).toEqual(["mine"]);
});
test("a pending email is left alone by a delta sync, and refreshEmails applies the server state", async () => { /* FakeStore + Stalwart */ });
```

Thunderbird test, added to `sync.test.ts` (`server changes…` test): after the delta, `jmapServerKeywords` of "Tagged work" is `"$seen $junk work"`. The report gains `serverKeywords: string[]`.

- [ ] **Step 2: Run them to verify they fail** (mail-sync vitest; `sync.test.ts` on 160)

- [ ] **Step 3: Implement the mapping functions, engine changes and store changes**

- [ ] **Step 4: Run `mise run check` and `sync.test.ts` on all versions**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(mail-sync): server keywords and local-only tags`

---

### Task 7: The outbound queue (`Outbox`)

**Files:**
- Create: `packages/mail-sync/src/outbox.ts`
- Modify: `packages/mail-sync/src/index.ts`
- Test: `packages/mail-sync/test/outbox.test.ts` (fake client), `packages/mail-sync/test/outbox.int.test.ts` (Stalwart)

**Interfaces:**
- Consumes: Task 1 `emailSet`, `emailImport`.
- Produces:
  ```ts
  export type OutboxOp =
    | { kind: "keywords"; emailId: string; patch: Record<string, true | null> }
    | { kind: "move"; emailId: string; fromMailboxId: string; toMailboxId: string }
    | { kind: "removeMailbox"; emailId: string; mailboxId: string }
    | { kind: "destroy"; emailId: string }
    | { kind: "importDraft"; mailboxId: string; localKey: number; keywords: string[] };
  export interface OutboxStorage { load(): Promise<OutboxOp[]>; save(ops: OutboxOp[]): Promise<void> }
  export interface OutboxHooks {
    readDraft(op: Extract<OutboxOp, { kind: "importDraft" }>): Promise<Uint8Array | null>; // null: draft gone, drop op
    onApplied(op: OutboxOp, imported?: ImportedEmail): Promise<void>;
    onRefused(op: OutboxOp, error: SetError): Promise<void>;
  }
  export class Outbox {
    constructor(o: { client: JmapClient; accountId: string; storage: OutboxStorage; hooks: OutboxHooks; batchSize?: number; log?: LogFn });
    load(): Promise<void>;
    enqueue(op: OutboxOp): Promise<void>;     // persists before returning
    pendingEmailIds(): Set<string>;
    get size(): number;
    flush(): Promise<{ applied: number; refused: number }>; // throws JmapNetworkError and keeps the queue
  }
  ```
- Coalescing:
  - successive keyword ops for one email merge per key, last one wins. A key returning to a value the server already has is still sent (the server confirms; simple and correct);
  - a `destroy` drops earlier ops for that email;
  - `move` ops chain (A→B then B→C becomes A→C).
- Batching: `Email/set` with at most `batchSize ?? session maxObjectsInSet ?? 50` updates per call.
- `importDraft` is sent alone, via `emailImport`.
- Ops leave the queue only after their result is known.
- `move` patches are `mailboxIds/<from>: null, mailboxIds/<to>: true`.

- [ ] **Step 1: Write the failing tests**

```ts
test("read → unread → read before a flush sends one patch ending read", async () => {
  await ob.enqueue(kw("e1", { "keywords/$seen": true }));
  await ob.enqueue(kw("e1", { "keywords/$seen": null }));
  await ob.enqueue(kw("e1", { "keywords/$seen": true }));
  await ob.flush();
  expect(setCalls()).toEqual([{ update: { e1: { "keywords/$seen": true } } }]);
});
test("30 updates with batchSize 10 go out as three Email/set calls", /* … */);
test("a network failure keeps every op, and a restart with the same storage still has them", async () => {
  fetchFails(); await expect(ob.flush()).rejects.toBeInstanceOf(JmapNetworkError);
  const again = new Outbox({ ...OPTS, storage }); await again.load(); expect(again.size).toBe(3);
});
test("a refused op is dropped and reported; the others are applied", async () => {
  // fake: notUpdated e2 { type: "invalidProperties", description: "A message belongs to exactly one mailbox" }
  await ob.flush();
  expect(refused()).toEqual([["e2", "A message belongs to exactly one mailbox"]]);
  expect(ob.size).toBe(0);
});
test("destroy after keyword changes sends only the destroy", /* … */);
test("on Stalwart, queued keyword and move ops change the server", /* outbox.int.test.ts */);
```

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement `outbox.ts`**

- [ ] **Step 4: Run `mise run check`**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(mail-sync): persisted outbound queue`

---

### Task 8: Capturing local changes (read, flag, tags, junk)

**Files:**
- Create:
  - `apps/thunderbird-addon/experiment/modules/ChangeWatcher.sys.mjs`;
  - `apps/thunderbird-addon/experiment/modules/Notify.sys.mjs`.
- Modify:
  - `AccountRegistry.sys.mjs`: runtime `outbox` with storage `jmap-outbox.json` in the server's local directory; engine gets `isPending: id => outbox.pendingEmailIds().has(id)`; flush scheduling, below;
  - `TbMailStore.sys.mjs`: `localOnly` maintenance in `onApplied` for keyword ops (re-read the email with `refreshEmails`; keywords added by the patch but absent on the server are appended to `jmapLocalKeywords`);
  - `Scenarios.sys.mjs`.
- Test: `tests/thunderbird/writeback.test.ts`

**Interfaces:**
- Consumes: Task 6 (`flagsToKeywords`, `keywordPatch`, `serverKeywordsOf`, `localOnlyOf`, `refreshEmails`); Task 7 (`Outbox`).
- Produces:
  ```js
  export function startWatching(): void; export function stopWatching(): void; // ChangeWatcher
  export function notify(server, text): void; // Notify: MailServices.mailSession.alertUser(`${server.prettyName}: ${text}`, null)
  ```
  ```ts
  // packages/test-support: StalwartInstance gains
  restart(): Promise<void>; // stop and start the same container, keeping its data and port
  ```
- What the watcher reacts to:
  - `onFolderPropertyFlagChanged` for headers in jmap folders, properties `Status`, `Flagged`, `Keywords`. It reads the header's local state as `LocalFlags`: Read, Marked, Replied, Forwarded flags, the `keywords` property as tags, and `junkscore` "100"/"0" as junk true/false. It then computes `keywordPatch(serverKeywordsOf(hdr), flagsToKeywords(flags), localOnlyOf(hdr))` and enqueues a non-empty patch;
  - `onFolderEvent(folder, "JunkStatusChanged")`: the same diff over that folder's headers.
- Registry flush scheduling:
  - 1 s after an enqueue, debounced;
  - at the start of every sync, before `engine.sync()`;
  - after a network failure: retry 30 s → 5 min, doubling.
- A refused op runs `refreshEmails([emailId])`, then `notify(server, \`The server refused a change to “${subject}”: ${description}. It now shows as it is on the server.\`)`.

- [ ] **Step 1: Write the failing tests** (Stalwart and Mailflare `describe.each`; scenarios `change` with args `{ path: "view-toggle-read" | "thread-read" | "folder-flag" | "add-tag" | "view-junk" | "select-auto-read" | "extension-tag", folderPath, subject }` and `outbox-state`)

```ts
test.each(PATHS)("%s reaches the server", async path => {
  await runScenario({ version, profile, scenario: "change", args: { path, folderPath: ["Inbox"], subject: "W1" } });
  expect(await serverKeywords(client, accountId, ids.w1)).toEqual(expect.arrayContaining(EXPECTED[path]));
});
test("a change made by another client reaches Thunderbird and is not sent back", async () => {
  await setKeywords(client, accountId, ids.w2, ["$seen", "$flagged"]);
  const r = await runScenario<OutboxState>({ version, profile, scenario: "outbox-state", args: { sync: true } });
  expect(r.queued).toBe(0); expect(r.setCallsSinceStart).toBe(0);
});
test("on Mailflare a tag stays after the next sync (local-only); on Stalwart a tag removed elsewhere disappears", /* … */);
test("changes made with the server stopped are sent after a restart once it is back", async () => {
  await stopServer(); await runScenario({ /* change: add-tag + view-toggle-read */ });
  await startServerAgainSamePort(); await runScenario({ scenario: "outbox-state", args: { sync: true } });
  // server shows both changes; queued == 0
});
test("marking 30 messages read with batch size 10 sends three Email/set calls", /* pref extensions.thunderbird-jmap.outboxBatchSize = 10 */);
```

For the Stalwart restart, use `StalwartInstance.restart()` (above). For Mailflare, use `stop` plus a new `startMailflare` on the same data volume; the builder adds `MailflareInstance.restart()` the same way.

- [ ] **Step 2: Run them to verify they fail** (`writeback.test.ts` on 160)

- [ ] **Step 3: Implement the watcher, notification, registry wiring and store hook**

- [ ] **Step 4: Run `writeback.test.ts` on all versions, then `mise run tb:test` in the background**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(addon): send read, flag, tag and junk changes to the server`

---

### Task 9: Moving and deleting (including Empty Trash and automatic deletions)

**Files:**
- Modify:
  - `MsgFolder.sys.mjs` (`copyMessages` for moves within the account, `deleteMessages`, `emptyTrash`);
  - `TbMailStore.sys.mjs` (`moveLocalCopy`, `removeLocalCopy`, `trashMailboxId()`);
  - `Scenarios.sys.mjs`.
- Test: `tests/thunderbird/move-delete.test.ts`

**Interfaces:**
- Consumes: Task 7 ops `move`, `removeMailbox`, `destroy`; Task 8 refusal handling.
- Produces:
  ```js
  // TbMailStore
  async moveLocalCopy(fromMailboxId, toMailboxId, emailId): Promise<void> // header + stored body move; body re-downloads later if not stored
  async removeLocalCopy(mailboxId, emailId): Promise<void>
  trashMailboxId(): string | null
  ```
- Folder overrides:
  - **`copyMessages(src, msgs, isMove=true, …)`** with both folders in the same jmap account: `moveLocalCopy`, then enqueue `move`, then `listener.OnStopCopy(NS_OK)` and `NotifyFolderEvent` as Thunderbird expects.
  - **Copies (`isMove=false`), and moves to or from other accounts:** fail with `NS_ERROR_NOT_IMPLEMENTED` and a `notify` text: `Copying messages isn't available for JMAP accounts yet.`
  - **`deleteMessages(msgs, …, deleteStorage, …)`:**
    - from a folder that is not Trash, with no `deleteStorage`: if the email has another local non-Trash copy, `removeLocalCopy` + `removeMailbox`; otherwise move it to Trash, as above;
    - from Trash, or with `deleteStorage`: `removeLocalCopy` + `destroy`.
  - **`emptyTrash`:** destroy every email in the Trash mailbox.
- Automatic deletions (retention, junk purge, Empty Trash on exit, a filter's Delete action) all arrive through `deleteMessages`/`emptyTrash` and are forwarded (spec §5.4).

- [ ] **Step 1: Write the failing tests** (Stalwart and Mailflare)

```ts
test("moving a message to another folder moves it on the server", /* copy service isMove; serverMailboxes(id) == [alpha] */);
test("Delete moves to Trash; Delete in Trash and Shift+Delete destroy", /* view deleteMsg / deleteNoTrash commands */);
test("deleting one copy of an email in two mailboxes removes only that mailbox (Stalwart)", async () => {
  // email in Inbox+Alpha; delete in Inbox → server mailboxIds == { alpha }; not in Trash
});
test("Empty Trash and a retention policy delete on the server", /* emptyTrash(); folder.retentionSettings + applyRetentionSettings() */);
test("on Mailflare a move between the two address trees is undone and reported", async () => {
  const r = await runScenario<NoticeResult>({ scenario: "move", args: { from: ["me <me@example.test>", "Inbox"], to: ["hello <hello@example.test>", "Archive"], subject: "M1" } });
  // after flush: message back in its Inbox; r.notices[0] matches
  // /^me@example.test: The server refused a change to “M1”: Messages cannot move between accounts' mailboxes\. It now shows as it is on the server\.$/
});
test("copying a message is refused with a clear notice and changes nothing", /* … */);
```

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement the overrides and store methods**

- [ ] **Step 4: Run `move-delete.test.ts` on all versions, then `mise run tb:test` in the background**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(addon): move and delete messages on the server`

---

### Task 10: Drafts

**Files:**
- Modify:
  - `MsgFolder.sys.mjs` (`copyFileMessage`);
  - `TbMailStore.sys.mjs` (`storeLocalMessage(mailboxId, file, keywords): Promise<number>`, `readRawByKey(mailboxId, key): Promise<Uint8Array | null>`, `bindEmail(mailboxId, key, email: ImportedEmail): void`);
  - `AccountRegistry.sys.mjs` (Outbox hooks `readDraft` / `onApplied` for `importDraft`);
  - `Scenarios.sys.mjs` (scenario `save-draft`: `nsIMsgSend.sendMessageFile(… nsMsgSaveAsDraft …)`; scenario `save-template`).
- Test: `tests/thunderbird/drafts.test.ts`

**Interfaces:**
- Consumes: Task 7 `importDraft`; Task 9 delete path; Task 4 identity `draftFolder`.
- `copyFileMessage(file, msgToReplace, isDraftOrTemplate, …)` into a Drafts or Templates folder:
  1. store the message locally (`storeLocalMessage`) with `$draft`/`$seen`;
  2. enqueue `importDraft`;
  3. if `msgToReplace` is set, delete it through the Task 9 path (destroy).

  When the server refuses an import (Mailflare Templates: "New messages can only be created in a Drafts mailbox"), the local copy is removed and the user gets the refusal notice from Task 8.

- [ ] **Step 1: Write the failing tests** (Stalwart and Mailflare)

```ts
test("saving a draft puts it in the identity's Drafts on the server", /* server Drafts has subject; local header has jmapId */);
test("saving the draft again replaces it: one draft on the server", /* … */);
test("on Mailflare saving a template is refused with a notice and leaves nothing behind", /* … */);
test("a draft saved while the server is stopped reaches the server after a restart", /* … */);
```

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run `drafts.test.ts` on all versions, then `mise run tb:test` in the background**
  - Expected: all pass

- [ ] **Step 5: Commit**
  - `node scripts/bump-version.mjs minor`
  - `feat(addon): drafts on the server`

---

### Task 11: Documentation and the full run

**Files:**
- Modify:
  - `README.md` (what works now; Mailflare notes: API key as password, Templates, Redirect);
  - main design §12 (Phase 2 done).
- Test: whole suite

- [ ] **Step 1: Update `README.md` and the main design's phase list**

- [ ] **Step 2: Run `mise run check` and `mise run tb:test`**
  - Expected: all green on 153.7.0esr, 158.0 and 160.0; zero aborts in the log.

- [ ] **Step 3: Commit**
  - `node scripts/bump-version.mjs patch`
  - `docs: Phase 2 in README and design`
