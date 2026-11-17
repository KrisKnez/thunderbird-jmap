/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JmapAuthError, JmapError } from "./errors.js";
import { checkedFetch } from "./http.js";
import type { FetchLike } from "./types.js";

export interface Session {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean; isReadOnly: boolean }>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
  maxObjectsInGet: number;
  maxCallsInRequest: number;
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolve a session URL or URL template (which may be relative, as Stalwart
 * returns them) against the session URL, without percent-encoding the
 * template's {placeholders}.
 */
export function resolveUrlTemplate(template: string, sessionUrl: string): string {
  if (HAS_SCHEME.test(template)) {
    return template;
  }
  const base = new URL(sessionUrl);
  if (template.startsWith("//")) {
    return base.protocol + template;
  }
  if (template.startsWith("/")) {
    return base.origin + template;
  }
  const dir = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
  return base.origin + dir + template;
}

/**
 * Find the JMAP session URL. A URL is fetched as given; an email address or
 * bare domain starts at https://<domain>/.well-known/jmap. No credentials are
 * sent: browsers drop Authorization on cross-origin redirects, so the
 * redirect target (even one answering 401) is the session URL, and the
 * caller validates credentials there.
 */
export async function discoverSessionUrl(input: string, opts: { fetch: FetchLike }): Promise<string> {
  const trimmed = input.trim();
  const start = HAS_SCHEME.test(trimmed)
    ? trimmed
    : `https://${trimmed.slice(trimmed.lastIndexOf("@") + 1)}/.well-known/jmap`;
  try {
    const res = await checkedFetch(opts.fetch, start, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return res.url || start;
  } catch (e) {
    if (e instanceof JmapAuthError && e.url) {
      return e.url;
    }
    throw e;
  }
}

const CORE = "urn:ietf:params:jmap:core";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol == "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve a server-supplied URL and require https, so credentials never
 * travel in cleartext. Plain http is accepted only between loopback hosts
 * (a local test server).
 */
function secureUrl(template: string, sessionUrl: string, field: string): string {
  const resolved = resolveUrlTemplate(String(template), sessionUrl);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(resolved)?.[1]?.toLowerCase();
  const loopbackHttp =
    isLoopbackHttp(sessionUrl) && isLoopbackHttp(resolved.replace(/\{[^}]*\}/g, "x"));
  if (scheme != "https" && !loopbackHttp) {
    throw new JmapError(`The server's ${field} is not an https:// address: ${resolved}`);
  }
  return resolved;
}

/** Turn a raw session object into a Session with absolute, https URLs. */
export function parseSession(raw: any, sessionUrl: string): Session {
  const core = (raw?.capabilities?.[CORE] ?? {}) as Record<string, unknown>;
  return {
    apiUrl: secureUrl(raw.apiUrl, sessionUrl, "apiUrl"),
    downloadUrl: secureUrl(raw.downloadUrl, sessionUrl, "downloadUrl"),
    uploadUrl: secureUrl(raw.uploadUrl, sessionUrl, "uploadUrl"),
    eventSourceUrl: secureUrl(raw.eventSourceUrl, sessionUrl, "eventSourceUrl"),
    state: raw.state,
    username: raw.username,
    accounts: raw.accounts ?? {},
    primaryAccounts: raw.primaryAccounts ?? {},
    capabilities: raw.capabilities ?? {},
    maxObjectsInGet: typeof core.maxObjectsInGet == "number" ? core.maxObjectsInGet : 500,
    maxCallsInRequest: typeof core.maxCallsInRequest == "number" ? core.maxCallsInRequest : 16,
  };
}
