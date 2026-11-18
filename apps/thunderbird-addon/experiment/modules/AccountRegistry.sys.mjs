/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Account lifecycle for the jmap account type: startup (component
// registration, reactivation), account creation, and one runtime (client,
// sync engine, store) per server with serialized syncs.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import { MailUtils } from "resource:///modules/MailUtils.sys.mjs";
import {
  CORE_VERSION,
  JmapClient,
  JmapError,
  SyncEngine,
  discoverSession,
  JmapNetworkError,
  RedirectNotSupportedError,
  SubmissionRefusedError,
  SubmissionUncertainError,
  sendDraft,
  Outbox,
} from "./core.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { startWatching, stopWatching } from "./ChangeWatcher.sys.mjs";
import { notify } from "./Notify.sys.mjs";
import { log } from "./Log.sys.mjs";
import { registerComponents, unregisterComponents } from "./Registration.sys.mjs";
import { TbMailStore, mailboxIdOf } from "./TbMailStore.sys.mjs";
import { TYPE } from "./IncomingServer.sys.mjs";
import {
  createOutgoingServer,
  deleteOutgoingServersFor,
  ensureOutgoingServers,
  parkOutgoingServers,
  setSendHandler,
} from "./OutgoingServer.sys.mjs";
import { syncIdentities } from "./Identities.sys.mjs";

export const coreVersion = CORE_VERSION;

const REALM = "JMAP";
const KEEP_UNAVAILABLE_SECONDS = 315360000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const LoginInfo = Components.Constructor(
  "@mozilla.org/login-manager/loginInfo;1",
  Ci.nsILoginInfo,
  "init"
);

const fetchImpl = (url, init) => fetch(url, init);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { DNS: "resource:///modules/DNS.sys.mjs" });

/** SRV records through Thunderbird's DNS module; none if the lookup fails. */
async function resolveSrv(name) {
  try {
    const records = await lazy.DNS.srv(name);
    return records.map(r => ({ priority: r.prio, weight: r.weight, host: r.host, port: r.port }));
  } catch (e) {
    log.info(`no SRV records for ${name}: ${e}`);
    return [];
  }
}

/**
 * Discovery found the session through a DNS record pointing outside the
 * email's domain. The message is the session URL; the setup page shows it
 * and the user confirms by submitting it as the session URL.
 */
class ConfirmServerError extends Error {
  constructor(url) {
    super(url);
    this.name = "ConfirmServer";
  }
}
const BODY_PREF = "extensions.thunderbird-jmap.backgroundBodyDownload";
/** Largest Email/set batch; 0 = the server's maxObjectsInSet. */
const BATCH_PREF = "extensions.thunderbird-jmap.outboxBatchSize";
const FLUSH_DELAY_MS = 1000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 300_000;
/** Server pref: the "check for mail at startup" default was applied once. */
const STARTUP_DEFAULT_APPLIED = "jmap_startup_check_default_applied";

let resolveReady;
const ready = new Promise(resolve => (resolveReady = resolve));

/** Resolves once startup (registration + reactivation) is done. */
export function whenReady() {
  return ready;
}

function jmapServers() {
  return MailServices.accounts.allServers.filter(server => server.type == TYPE);
}

/**
 * server key → where that server's login is saved. Removing an account
 * clears the server's prefs, so this is recorded beforehand.
 */
const savedLogins = new Map();

function rememberLogin(server) {
  const sessionUrl = server.getStringValue("jmap_session_url");
  if (sessionUrl) {
    savedLogins.set(server.key, { origin: loginOrigin(sessionUrl), username: server.username });
  }
}

/** When a jmap account is removed, forget its saved login and its runtime. */
const serverRemovedObserver = {
  observe(subject, topic, data) {
    let key = data;
    try {
      key = subject.QueryInterface(Ci.nsIMsgIncomingServer).key || data;
    } catch (e) {
      // Not a server: use the key passed along.
    }
    runtimes.delete(key);
    try {
      deleteOutgoingServersFor(key);
    } catch (e) {
      log.warn(`could not remove the outgoing server of ${key}`, e);
    }
    const saved = savedLogins.get(key);
    if (!saved) {
      return;
    }
    savedLogins.delete(key);
    findLogin(saved.origin, saved.username)
      .then(login => login && Services.logins.removeLoginAsync(login))
      .catch(e => log.warn(`could not forget the login of ${key}`, e));
  },
};

/** The text Thunderbird shows when a send fails (fixed copy, see the Phase 2 plan). */
function sendErrorText(e) {
  if (e instanceof RedirectNotSupportedError) {
    return "Redirect isn't available for JMAP accounts.";
  }
  if (e instanceof SubmissionRefusedError) {
    const reason = String(e.error.description ?? e.error.type).replace(/\.\s*$/, "");
    return `The server did not send this message: ${reason}. If a copy appears in Sent, it was not delivered.`;
  }
  if (e instanceof SubmissionUncertainError) {
    return "The connection was lost while sending. The message may have been sent; check Sent before sending it again.";
  }
  if (e instanceof JmapNetworkError) {
    return "Couldn't reach the mail server. The message was not sent.";
  }
  return `The message was not sent: ${e?.message ?? e}`;
}

/** Send a composed message from a JMAP identity (called by the jmap outgoing server). */
async function sendFromIdentity(incoming, { file, to, bcc, identity }) {
  const folder = uri => (uri ? MailUtils.getExistingFolder(uri) : null);
  const drafts = folder(identity.draftsFolderURI);
  const sent = folder(identity.fccFolderURI);
  const draftsMailboxId = drafts ? mailboxIdOf(drafts) : "";
  const sentMailboxId = sent ? mailboxIdOf(sent) : "";
  const identityId = identity.getCharAttribute("jmap_identity_id");
  if (!identityId || !draftsMailboxId || !sentMailboxId) {
    throw new Error("This identity has no Drafts or Sent folder on the server.");
  }
  const runtime = runtimeFor(incoming);
  try {
    const raw = await IOUtils.read(file.path);
    await sendDraft(await runtime.getClient(), incoming.getStringValue("jmap_account_id"), {
      raw,
      to,
      bcc,
      identity: { id: identityId, email: identity.email },
      draftsMailboxId,
      sentMailboxId,
    });
  } catch (e) {
    log.warn(`sending from ${identity.email} failed`, e);
    throw new Error(sendErrorText(e));
  }
  // Bring the server's Sent copy down.
  syncServer(incoming, "sent").catch(() => {});
}

/** Called by the Experiment's onStartup. */
export function startup() {
  try {
    registerComponents();
    setSendHandler(sendFromIdentity);
    startWatching(queueChange);
    Services.obs.addObserver(serverRemovedObserver, "message-server-removed");
    // Accounts load before add-ons; ours were parked as unavailable.
    MailServices.accounts.reactivateAccounts();
    try {
      ensureOutgoingServers();
    } catch (e) {
      log.error("could not set up the outgoing servers", e);
    }
    for (const server of jmapServers()) {
      // Core only clears this when the type loads at startup, which never
      // happens for an add-on type.
      Services.prefs.clearUserPref(`mail.server.${server.key}.timeFoundUnavailable`);
      rememberLogin(server);
      // Rebuild the folder tree now: C++ callers (descendants, lookups) read
      // the child list directly and never reach the JS subFolders getter.
      try {
        void server.rootFolder.subFolders;
      } catch (e) {
        log.error(`folder discovery for ${server.key} failed`, e);
      }
      // "Check for new messages at startup" is on by default (applied once
      // to accounts created before it was; core stores "off" by clearing
      // the pref, so only a marker tells "never set" from "turned off").
      // Core's own startup check runs before this type is registered, so it
      // never reaches our servers: sync them here.
      if (!server.getBoolValue(STARTUP_DEFAULT_APPLIED)) {
        server.loginAtStartUp = true;
        server.setBoolValue(STARTUP_DEFAULT_APPLIED, true);
      }
      if (server.loginAtStartUp) {
        syncServer(server, "startup").catch(() => {});
      } else {
        // Changes queued before the last quit still go out.
        runtimeFor(server)
          .getOutbox()
          .then(outbox => outbox.size && scheduleFlush(server, 5000))
          .catch(() => {});
      }
    }
  } catch (e) {
    log.error("startup failed", e);
  } finally {
    resolveReady();
  }
}

/**
 * Called by the Experiment's onShutdown when Thunderbird quits: the
 * outgoing servers are parked so that, until the add-on runs again, a JMAP
 * identity cannot send through another account's server.
 */
export function appShutdown() {
  try {
    parkOutgoingServers();
  } catch (e) {
    log.error("could not park the outgoing servers", e);
  }
}

/** Called by the Experiment's onShutdown when the add-on is disabled/updated. */
export function shutdown() {
  try {
    parkOutgoingServers();
  } catch (e) {
    log.error("could not park the outgoing servers", e);
  }
  Services.obs.removeObserver(serverRemovedObserver, "message-server-removed");
  stopWatching();
  for (const runtime of runtimes.values()) {
    clearTimeout(runtime.flushTimer);
  }
  unregisterComponents();
  runtimes.clear();
}

// --- runtimes -------------------------------------------------------------

/** @type {Map<string, object>} server key → runtime */
const runtimes = new Map();

function loginOrigin(sessionUrl) {
  return new URL(sessionUrl).origin;
}

async function findLogin(origin, username) {
  const logins = await Services.logins.searchLoginsAsync({ origin, httpRealm: REALM });
  return logins.find(l => l.username == username) ?? null;
}

async function credentialsFor(server) {
  const sessionUrl = server.getStringValue("jmap_session_url");
  const login = await findLogin(loginOrigin(sessionUrl), server.username);
  const secret = login?.password ?? "";
  return server.getStringValue("jmap_auth_kind") == "bearer"
    ? { kind: "bearer", token: secret }
    : { kind: "basic", username: server.username, password: secret };
}

/**
 * The runtime for a jmap server: { store, lastSyncError, getClient(),
 * getEngine() }. The client and engine are created on first use (the login
 * manager is async), so folder discovery at startup never touches it.
 */
export function runtimeFor(server) {
  let runtime = runtimes.get(server.key);
  if (!runtime) {
    let clientPromise = null;
    let enginePromise = null;
    let outboxPromise = null;
    runtime = {
      store: new TbMailStore(server),
      lastSyncError: null,
      running: null,
      followUp: null,
      bodies: null,
      getClient() {
        clientPromise ??= credentialsFor(server).then(
          credentials =>
            new JmapClient({
              sessionUrl: server.getStringValue("jmap_session_url"),
              credentials,
              fetch: fetchImpl,
            })
        );
        return clientPromise;
      },
      /** Local changes waiting for the server (persisted in the account's directory). */
      outbox: null,
      stats: { applied: 0, refused: 0 },
      flushTimer: null,
      retryDelay: 0,
      afterFlush: null,
      getOutbox() {
        outboxPromise ??= this.getClient().then(async client => {
          const outbox = new Outbox({
            client,
            accountId: server.getStringValue("jmap_account_id"),
            storage: outboxStorage(server),
            hooks: outboxHooks(server, this),
            batchSize: Services.prefs.getIntPref(BATCH_PREF, 0) || undefined,
            log: (level, message) => log[level](message),
            later: fn => setTimeout(fn, 0),
          });
          await outbox.load();
          this.outbox = outbox;
          return outbox;
        });
        return outboxPromise;
      },
      getEngine() {
        enginePromise ??= Promise.all([this.getClient(), this.getOutbox()]).then(
          ([client, outbox]) =>
            new SyncEngine({
              client,
              store: this.store,
              accountId: server.getStringValue("jmap_account_id"),
              log: (level, message) => log[level](message),
              isPending: id => outbox.pendingEmailIds().has(id),
            })
        );
        return enginePromise;
      },
    };
    runtimes.set(server.key, runtime);
  }
  return runtime;
}

/**
 * Sync a server. Runs are serialized per account; calls made while a run is
 * in flight share one follow-up run.
 */
/** The account's outbound queue file: jmap-outbox.json in its local directory. */
function outboxStorage(server) {
  const path = () => {
    const file = server.localPath.clone();
    file.append("jmap-outbox.json");
    return file.path;
  };
  return {
    async load() {
      try {
        return await IOUtils.readJSON(path());
      } catch (e) {
        if (e.name != "NotFoundError") {
          log.warn(`unreadable outbox for ${server.key}; starting empty`, e);
        }
        return [];
      }
    },
    async save(ops) {
      await IOUtils.writeJSON(path(), ops, { tmpPath: path() + ".tmp" });
    },
  };
}

const unescapePointer = s => s.replace(/~1/g, "/").replace(/~0/g, "~");

/** Outbox results are collected during a flush and handled after it (see flushQueue). */
function outboxHooks(server, runtime) {
  return {
    async readDraft(op) {
      // null when the local draft is gone (saved again, or deleted): drop it.
      return runtime.store.readRawByKey(op.mailboxId, op.localKey);
    },
    async onApplied(op, imported) {
      runtime.stats.applied++;
      if (op.kind == "importDraft" && imported) {
        runtime.store.bindEmail(op.mailboxId, op.localKey, imported, op.keywords);
        runtime.store.flushTouched();
      }
      if (op.kind == "keywords" && runtime.afterFlush) {
        const added = Object.entries(op.patch)
          .filter(([, value]) => value === true)
          .map(([path]) => unescapePointer(path.slice("keywords/".length)));
        const list = runtime.afterFlush.applied.get(op.emailId) ?? [];
        runtime.afterFlush.applied.set(op.emailId, [...list, ...added]);
      }
    },
    async onRefused(op, error) {
      runtime.stats.refused++;
      let subject = "";
      if (op.kind == "importDraft") {
        // The server will not take it; the draft stays in Thunderbird, so
        // nothing the user wrote is lost.
        subject = runtime.store.subjectOfKey(op.mailboxId, op.localKey);
      } else if (op.emailId) {
        subject = runtime.store.subjectOf(op.emailId);
      }
      runtime.afterFlush?.refused.push({ op, error, subject });
    },
  };
}

/**
 * Send queued local changes. Afterwards, re-read the affected emails: a
 * refused change is undone (the server's state comes back, and the user is
 * told), and keywords the server silently ignored become local-only.
 */
async function flushQueue(server) {
  const runtime = runtimeFor(server);
  const outbox = await runtime.getOutbox();
  if (!outbox.size) {
    return;
  }
  runtime.afterFlush = { applied: new Map(), refused: [] };
  try {
    await outbox.flush();
  } finally {
    const { applied, refused } = runtime.afterFlush;
    runtime.afterFlush = null;
    const ids = [...new Set([...applied.keys(), ...refused.map(r => r.op.emailId).filter(Boolean)])];
    if (ids.length) {
      try {
        await (await runtime.getEngine()).refreshEmails(ids);
        for (const [emailId, added] of applied) {
          runtime.store.noteLocalOnly(emailId, added);
        }
      } catch (e) {
        log.warn(`could not re-read changed emails of ${server.key}`, e);
      }
      runtime.store.flushTouched();
    }
    for (const { op, error, subject } of refused) {
      const reason = String(error.description ?? error.type).replace(/\.\s*$/, "");
      notify(
        server,
        op.kind == "importDraft"
          ? `The server refused to save “${subject}”: ${reason}. It is kept in this folder in Thunderbird only.`
          : `The server refused a change to “${subject}”: ${reason}. It now shows as it is on the server.`
      );
    }
  }
}

/** Sync soon (which sends queued changes first); later calls push it back. */
function scheduleFlush(server, delay = FLUSH_DELAY_MS) {
  const runtime = runtimeFor(server);
  clearTimeout(runtime.flushTimer);
  runtime.flushTimer = setTimeout(() => {
    runtime.flushTimer = null;
    syncServer(server, "local changes").catch(() => {});
  }, delay);
}

/** Queue a local change for the server (change watcher, folder moves and deletes). */
export function queueChange(server, op) {
  const runtime = runtimeFor(server);
  runtime
    .getOutbox()
    .then(outbox => outbox.enqueue(op))
    .then(
      // A change that matches the server leaves nothing to send.
      changed => changed && scheduleFlush(server),
      e => log.warn(`could not queue a change for ${server.key}`, e)
    );
}

export function syncServer(server, reason) {
  const runtime = runtimeFor(server);
  const run = () => {
    log.debug(`sync ${server.key} (${reason})`);
    runtime.running = (async () => {
      try {
        // Local changes go to the server first; the sync then confirms them.
        await flushQueue(server);
        const result = await (await runtime.getEngine()).sync();
        runtime.lastSyncError = null;
        runtime.retryDelay = 0;
        try {
          await syncIdentities(server, await runtime.getClient(), server.getStringValue("jmap_account_id"));
        } catch (e) {
          log.warn(`identity sync of ${server.key} failed`, e);
        }
        if (Services.prefs.getBoolPref(BODY_PREF, true)) {
          downloadBodies(server).catch(() => {});
        }
        return result;
      } catch (e) {
        runtime.lastSyncError = e;
        log.warn(`sync of ${server.key} failed`, e);
        if (runtime.outbox?.size) {
          runtime.retryDelay = Math.min(Math.max(RETRY_MIN_MS, runtime.retryDelay * 2), RETRY_MAX_MS);
          scheduleFlush(server, runtime.retryDelay);
        }
        throw e;
      } finally {
        runtime.running = null;
      }
    })();
    return runtime.running;
  };
  if (runtime.running) {
    runtime.followUp ??= runtime.running
      .catch(() => {})
      .then(() => {
        runtime.followUp = null;
        return run();
      });
    return runtime.followUp;
  }
  return run();
}

/**
 * Download every missing message body in the background. One download job
 * per account at a time; a call while one runs returns that job.
 */
export function downloadBodies(server) {
  const runtime = runtimeFor(server);
  runtime.bodies ??= (async () => {
    try {
      const engine = await runtime.getEngine();
      while ((await engine.downloadPendingBodies()) > 0) {
        runtime.store.flushTouched();
      }
    } catch (e) {
      log.warn(`body download for ${server.key} failed`, e);
    } finally {
      runtime.store.flushTouched();
      runtime.bodies = null;
    }
  })();
  return runtime.bodies;
}

/** Resolves when no sync or body download is running for the server. */
export async function whenIdle(server) {
  const runtime = runtimeFor(server);
  while (runtime.running || runtime.followUp || runtime.bodies) {
    await Promise.allSettled([runtime.running, runtime.followUp, runtime.bodies]);
  }
}

// --- account creation -----------------------------------------------------

function requireText(value, name) {
  if (typeof value != "string" || !value.trim()) {
    throw new JmapError(`${name} is required`);
  }
  return value.trim();
}

/**
 * Create a jmap account. Credentials are validated against the server first;
 * nothing is created unless they work, and a failure while creating removes
 * whatever was created.
 *
 * @param {{email: string, sessionUrl?: string, username?: string, secret: string,
 *          authKind: "basic"|"bearer"}} details
 * @returns {Promise<{accountKey: string}>}
 */
export async function createAccount(details) {
  const email = requireText(details.email, "Email");
  const secret = requireText(details.secret, "Password or token");
  const username = details.username?.trim() || email;
  const authKind = details.authKind == "bearer" ? "bearer" : "basic";
  const credentials =
    authKind == "bearer"
      ? { kind: "bearer", token: secret }
      : { kind: "basic", username, password: secret };

  let sessionUrl = details.sessionUrl?.trim();
  if (!sessionUrl) {
    const found = await discoverSession(email, { fetch: fetchImpl, resolveSrv });
    if (found.needsConfirmation) {
      // DNS is not authenticated (RFC 8620 §8.3): no credentials go to a
      // server outside the email's domain until the user has seen it.
      throw new ConfirmServerError(found.url);
    }
    sessionUrl = found.url;
  }
  const url = new URL(sessionUrl);
  if (url.protocol != "https:" && !(url.protocol == "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new JmapError("Use an https:// address.");
  }

  // Core's own duplicate check compares ports, which are only set after
  // creation; two servers with one URI would share folders and break both.
  if (MailServices.accounts.findServer(username, url.hostname, TYPE)) {
    throw new JmapError("This account is already set up.");
  }

  const client = new JmapClient({ sessionUrl, credentials, fetch: fetchImpl });
  await client.getSession();
  const accountId = await client.primaryMailAccountId();

  let server = null;
  let account = null;
  let login = null;
  try {
    server = MailServices.accounts.createIncomingServer(username, url.hostname, TYPE);
    server.port = url.port ? Number(url.port) : url.protocol == "https:" ? 443 : 80;
    server.prettyName = email;
    server.setStringValue("jmap_session_url", sessionUrl);
    server.setStringValue("jmap_account_id", accountId);
    server.setStringValue("jmap_auth_kind", authKind);
    server.setIntValue("secondsToLeaveUnavailable", KEEP_UNAVAILABLE_SECONDS);
    server.loginAtStartUp = true;
    server.setBoolValue(STARTUP_DEFAULT_APPLIED, true);

    const outgoingKey = createOutgoingServer(server);
    const identity = MailServices.accounts.createIdentity();
    identity.email = email;
    identity.smtpServerKey = outgoingKey;
    identity.doFcc = false;
    account = MailServices.accounts.createAccount();
    account.addIdentity(identity);
    account.incomingServer = server;

    const origin = loginOrigin(sessionUrl);
    const existing = await findLogin(origin, username);
    login = new LoginInfo(origin, null, REALM, username, secret, "", "");
    if (existing) {
      await Services.logins.modifyLoginAsync(existing, login);
    } else {
      await Services.logins.addLoginAsync(login);
    }
    Services.prefs.savePrefFile(null);
  } catch (e) {
    log.error("account creation failed; rolling back", e);
    if (server) {
      try {
        deleteOutgoingServersFor(server.key);
      } catch (e2) {
        log.warn("could not remove the outgoing server", e2);
      }
    }
    if (account) {
      MailServices.accounts.removeAccount(account, true);
    } else if (server) {
      MailServices.accounts.removeIncomingServer(server, true);
    }
    if (login) {
      await Services.logins.removeLoginAsync(login).catch(() => {});
    }
    throw e;
  }

  rememberLogin(server);
  syncServer(server, "account created").catch(() => {});
  return { accountKey: account.key };
}

/** @returns {Array<{accountKey: string, email: string, sessionUrl: string}>} */
export function listAccounts() {
  return jmapServers().map(server => {
    const account = MailServices.accounts.findAccountForServer(server);
    return {
      accountKey: account?.key ?? "",
      email: account?.defaultIdentity?.email ?? server.prettyName,
      sessionUrl: server.getStringValue("jmap_session_url"),
    };
  });
}
