/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test, expect } from "vitest";
import {
  JmapClient,
  JmapAuthError,
  JmapMethodError,
  JmapNetworkError,
  JmapRequestError,
} from "../src/index.js";
import { fakeFetch, json, STALWART_LIKE_SESSION } from "./fake-fetch.js";

const SESSION_URL = "http://127.0.0.1:18080/jmap/session";

/** Session requests get the session; API POSTs get `api(body)`. */
function clientWith(api: (body: any) => Response | Promise<Response>) {
  const { fetch, calls } = fakeFetch((url, init) =>
    url == SESSION_URL ? json(STALWART_LIKE_SESSION) : api(JSON.parse(String(init?.body)))
  );
  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    credentials: { kind: "basic", username: "admin", password: "pw" },
    fetch,
  });
  return { client, calls };
}

test("request posts calls with the default capabilities to the resolved apiUrl", async () => {
  const { client, calls } = clientWith(body =>
    json({ methodResponses: [["Mailbox/get", { list: [] }, body.methodCalls[0][2]]] })
  );
  const responses = await client.request([["Mailbox/get", { accountId: "d333333" }, "a"]]);
  expect(responses).toEqual([["Mailbox/get", { list: [] }, "a"]]);
  const post = calls[1];
  expect(post.url).toBe("http://127.0.0.1:18080/jmap/");
  expect(post.init?.method).toBe("POST");
  expect(JSON.parse(String(post.init?.body)).using).toEqual([
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
  ]);
});

test("call returns the single method result", async () => {
  const { client } = clientWith(() =>
    json({ methodResponses: [["Mailbox/get", { state: "s1", list: [] }, "0"]] })
  );
  await expect(client.call("Mailbox/get", { accountId: "d333333" })).resolves.toEqual({
    state: "s1",
    list: [],
  });
});

test("call throws JmapMethodError for an error response", async () => {
  const { client } = clientWith(() =>
    json({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "0"]] })
  );
  const err: any = await client.call("Email/changes", { sinceState: "x" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(JmapMethodError);
  expect(err.type).toBe("cannotCalculateChanges");
});

test("HTTP 401 becomes JmapAuthError", async () => {
  const { fetch } = fakeFetch(() => new Response("nope", { status: 401 }));
  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    credentials: { kind: "basic", username: "admin", password: "wrong" },
    fetch,
  });
  await expect(client.getSession()).rejects.toBeInstanceOf(JmapAuthError);
});

test("a problem-details 400 becomes JmapRequestError with its type", async () => {
  const { client } = clientWith(() =>
    json({ type: "urn:ietf:params:jmap:error:notRequest", status: 400 }, { status: 400 })
  );
  const err: any = await client.request([["Mailbox/get", {}, "0"]]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(JmapRequestError);
  expect(err.type).toBe("urn:ietf:params:jmap:error:notRequest");
  expect(err.status).toBe(400);
});

test("a rejected fetch becomes JmapNetworkError", async () => {
  const { fetch } = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const client = new JmapClient({
    sessionUrl: SESSION_URL,
    credentials: { kind: "bearer", token: "t" },
    fetch,
  });
  await expect(client.getSession()).rejects.toBeInstanceOf(JmapNetworkError);
});
