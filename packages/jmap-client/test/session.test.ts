/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, test, expect } from "vitest";
import {
  resolveUrlTemplate,
  authorizationHeader,
  discoverSessionUrl,
  JmapClient,
} from "../src/index.js";
import { fakeFetch, json, STALWART_LIKE_SESSION } from "./fake-fetch.js";

describe("resolveUrlTemplate", () => {
  test("origin-relative template keeps its {placeholders}", () => {
    expect(
      resolveUrlTemplate(
        "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
        "http://127.0.0.1:18080/jmap/session"
      )
    ).toBe("http://127.0.0.1:18080/jmap/download/{accountId}/{blobId}/{name}?accept={type}");
  });
  test("absolute template is unchanged", () => {
    expect(resolveUrlTemplate("https://a.example/x/{blobId}", "https://h/jmap/session")).toBe(
      "https://a.example/x/{blobId}"
    );
  });
  test("path-relative template resolves against the session directory", () => {
    expect(resolveUrlTemplate("api/", "https://h/jmap/session")).toBe("https://h/jmap/api/");
  });
});

describe("authorizationHeader", () => {
  test("basic encodes UTF-8 credentials", () => {
    expect(authorizationHeader({ kind: "basic", username: "ü", password: "p" })).toBe(
      "Basic w7w6cA=="
    );
  });
  test("bearer passes the token", () => {
    expect(authorizationHeader({ kind: "bearer", token: "t" })).toBe("Bearer t");
  });
});

describe("discoverSessionUrl", () => {
  test("an email address starts at https://<domain>/.well-known/jmap and returns the final URL", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(STALWART_LIKE_SESSION, { url: "https://mail.example.org/jmap/session" })
    );
    const url = await discoverSessionUrl("me@example.org", {
      fetch,
      credentials: { kind: "bearer", token: "t" },
    });
    expect(calls[0].url).toBe("https://example.org/.well-known/jmap");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer t");
    expect(url).toBe("https://mail.example.org/jmap/session");
  });
  test("a URL is used as given", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(STALWART_LIKE_SESSION, { url: "http://127.0.0.1:18080/jmap/session" })
    );
    await discoverSessionUrl("http://127.0.0.1:18080/.well-known/jmap", {
      fetch,
      credentials: { kind: "bearer", token: "t" },
    });
    expect(calls[0].url).toBe("http://127.0.0.1:18080/.well-known/jmap");
  });
});

describe("JmapClient.getSession", () => {
  test("resolves the four URLs, reads core limits, and caches", async () => {
    const { fetch, calls } = fakeFetch(() => json(STALWART_LIKE_SESSION));
    const client = new JmapClient({
      sessionUrl: "http://127.0.0.1:18080/jmap/session",
      credentials: { kind: "basic", username: "admin", password: "pw" },
      fetch,
    });
    const s = await client.getSession();
    expect(s.apiUrl).toBe("http://127.0.0.1:18080/jmap/");
    expect(s.downloadUrl).toBe(
      "http://127.0.0.1:18080/jmap/download/{accountId}/{blobId}/{name}?accept={type}"
    );
    expect(s.uploadUrl).toBe("http://127.0.0.1:18080/jmap/upload/{accountId}/");
    expect(s.eventSourceUrl).toBe(
      "http://127.0.0.1:18080/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}"
    );
    expect(s.maxObjectsInGet).toBe(500);
    expect(s.maxCallsInRequest).toBe(16);
    await client.getSession();
    expect(calls).toHaveLength(1);
    expect(await client.primaryMailAccountId()).toBe("d333333");
  });
});
