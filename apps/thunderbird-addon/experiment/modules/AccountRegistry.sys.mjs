/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Account lifecycle for the jmap account type: startup (component
// registration, reactivation), account creation, and one runtime (client,
// sync engine, store) per server with serialized syncs.

import { MailServices } from "resource:///modules/MailServices.sys.mjs";
import {
  CORE_VERSION,
  JmapClient,
  JmapError,
  SyncEngine,
  discoverSessionUrl,
} from "./core.sys.mjs";
import { log } from "./Log.sys.mjs";
import { registerComponents, unregisterComponents } from "./Registration.sys.mjs";
import { TbMailStore } from "./TbMailStore.sys.mjs";
import { TYPE } from "./IncomingServer.sys.mjs";

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
const BODY_PREF = "extensions.thunderbird-jmap.backgroundBodyDownload";

let resolveReady;
const ready = new Promise(resolve => (resolveReady = resolve));

/** Resolves once startup (registration + reactivation) is done. */
export function whenReady() {
  return ready;
}

function jmapServers() {
  return MailServices.accounts.allServers.filter(server => server.type == TYPE);
}

/** Called by the Experiment's onStartup. */
export function startup() {
  try {
    registerComponents();
    // Accounts load before add-ons; ours were parked as unavailable.
    MailServices.accounts.reactivateAccounts();
    for (const server of jmapServers()) {
      // Core only clears this when the type loads at startup, which never
      // happens for an add-on type.
      Services.prefs.clearUserPref(`mail.server.${server.key}.timeFoundUnavailable`);
      // Rebuild the folder tree now: C++ callers (descendants, lookups) read
      // the child list directly and never reach the JS subFolders getter.
      try {
        void server.rootFolder.subFolders;
      } catch (e) {
        log.error(`folder discovery for ${server.key} failed`, e);
      }
    }
  } catch (e) {
    log.error("startup failed", e);
  } finally {
    resolveReady();
  }
}

/** Called by the Experiment's onShutdown when the add-on is disabled/updated. */
export function shutdown() {
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
      getEngine() {
        enginePromise ??= this.getClient().then(
          client =>
            new SyncEngine({
              client,
              store: this.store,
              accountId: server.getStringValue("jmap_account_id"),
              log: (level, message) => log[level](message),
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
export function syncServer(server, reason) {
  const runtime = runtimeFor(server);
  const run = () => {
    log.debug(`sync ${server.key} (${reason})`);
    runtime.running = (async () => {
      try {
        const result = await (await runtime.getEngine()).sync();
        runtime.lastSyncError = null;
        if (Services.prefs.getBoolPref(BODY_PREF, true)) {
          downloadBodies(server).catch(() => {});
        }
        return result;
      } catch (e) {
        runtime.lastSyncError = e;
        log.warn(`sync of ${server.key} failed`, e);
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

  const sessionUrl =
    details.sessionUrl?.trim() ||
    (await discoverSessionUrl(email, { fetch: fetchImpl, credentials }));
  const url = new URL(sessionUrl);
  if (url.protocol != "https:" && !(url.protocol == "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new JmapError("Use an https:// address.");
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

    const identity = MailServices.accounts.createIdentity();
    identity.email = email;
    account = MailServices.accounts.createAccount();
    account.addIdentity(identity);
    account.incomingServer = server;

    const origin = loginOrigin(sessionUrl);
    const existing = await findLogin(origin, username);
    login = new LoginInfo(origin, null, REALM, username, secret, "", "");
    if (existing) {
      Services.logins.modifyLogin(existing, login);
    } else {
      await Services.logins.addLoginAsync(login);
    }
    Services.prefs.savePrefFile(null);
  } catch (e) {
    log.error("account creation failed; rolling back", e);
    if (account) {
      MailServices.accounts.removeAccount(account, true);
    } else if (server) {
      MailServices.accounts.removeIncomingServer(server, true);
    }
    if (login) {
      try {
        Services.logins.removeLogin(login);
      } catch {}
    }
    throw e;
  }

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
