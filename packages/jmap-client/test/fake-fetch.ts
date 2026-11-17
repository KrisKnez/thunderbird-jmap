/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export interface Recorded {
  url: string;
  init?: RequestInit;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** A fetch double that records requests and answers from a handler. */
export function fakeFetch(handler: Handler) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

export function json(body: unknown, init: { status?: number; url?: string } = {}): Response {
  const res = new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
  if (init.url) {
    Object.defineProperty(res, "url", { value: init.url });
  }
  return res;
}

/** A session object shaped like Stalwart 1.1.1's (relative URLs). */
export const STALWART_LIKE_SESSION = {
  capabilities: {
    "urn:ietf:params:jmap:core": { maxObjectsInGet: 500, maxCallsInRequest: 16 },
    "urn:ietf:params:jmap:mail": {},
  },
  accounts: { d333333: { name: "admin", isPersonal: true, isReadOnly: false } },
  primaryAccounts: { "urn:ietf:params:jmap:mail": "d333333" },
  username: "admin",
  apiUrl: "/jmap/",
  downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  uploadUrl: "/jmap/upload/{accountId}/",
  eventSourceUrl: "/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
  state: "36d96819",
};
