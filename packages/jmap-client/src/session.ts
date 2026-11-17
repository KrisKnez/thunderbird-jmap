/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authorizationHeader, type Credentials } from "./credentials.js";
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
 * bare domain starts at https://<domain>/.well-known/jmap. Redirects are
 * followed and the final URL is returned.
 */
export async function discoverSessionUrl(
  input: string,
  opts: { fetch: FetchLike; credentials: Credentials }
): Promise<string> {
  const trimmed = input.trim();
  const start = HAS_SCHEME.test(trimmed)
    ? trimmed
    : `https://${trimmed.slice(trimmed.lastIndexOf("@") + 1)}/.well-known/jmap`;
  const res = await checkedFetch(opts.fetch, start, {
    method: "GET",
    headers: { Authorization: authorizationHeader(opts.credentials), Accept: "application/json" },
  });
  return res.url || start;
}

const CORE = "urn:ietf:params:jmap:core";

/** Turn a raw session object into a Session with absolute URLs. */
export function parseSession(raw: any, sessionUrl: string): Session {
  const core = (raw?.capabilities?.[CORE] ?? {}) as Record<string, unknown>;
  return {
    apiUrl: resolveUrlTemplate(raw.apiUrl, sessionUrl),
    downloadUrl: resolveUrlTemplate(raw.downloadUrl, sessionUrl),
    uploadUrl: resolveUrlTemplate(raw.uploadUrl, sessionUrl),
    eventSourceUrl: resolveUrlTemplate(raw.eventSourceUrl, sessionUrl),
    state: raw.state,
    username: raw.username,
    accounts: raw.accounts ?? {},
    primaryAccounts: raw.primaryAccounts ?? {},
    capabilities: raw.capabilities ?? {},
    maxObjectsInGet: typeof core.maxObjectsInGet == "number" ? core.maxObjectsInGet : 500,
    maxCallsInRequest: typeof core.maxCallsInRequest == "number" ? core.maxCallsInRequest : 16,
  };
}
