/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, test, expect } from "vitest";
import {
  resolveUrlTemplate,
  authorizationHeader,
  discoverSessionUrl,
  discoverSession,
  JmapClient,
  JmapHttpError,
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
    const url = await discoverSessionUrl("me@example.org", { fetch });
    expect(calls[0].url).toBe("https://example.org/.well-known/jmap");
    expect(url).toBe("https://mail.example.org/jmap/session");
  });
  test("sends no credentials, so a cross-host redirect cannot be mistaken for a bad password", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ type: "unauthorized" }, { status: 401, url: "https://api.example.net/jmap/session" })
    );
    const url = await discoverSessionUrl("me@example.org", { fetch });
    expect(new Headers(calls[0].init?.headers).has("Authorization")).toBe(false);
    expect(url).toBe("https://api.example.net/jmap/session");
  });
  test("a missing well-known endpoint is an HTTP error", async () => {
    const { fetch } = fakeFetch(() => new Response("no", { status: 404 }));
    await expect(discoverSessionUrl("me@example.org", { fetch })).rejects.toBeInstanceOf(JmapHttpError);
  });
  test("a URL is used as given", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(STALWART_LIKE_SESSION, { url: "http://127.0.0.1:18080/jmap/session" })
    );
    await discoverSessionUrl("http://127.0.0.1:18080/.well-known/jmap", { fetch });
    expect(calls[0].url).toBe("http://127.0.0.1:18080/.well-known/jmap");
  });
});

describe("discoverSession", () => {
  type Srv = { priority: number; weight: number; host: string; port: number };
  const resolver = (records: Srv[] | Error) => {
    const asked: string[] = [];
    const resolveSrv = async (name: string) => {
      asked.push(name);
      if (records instanceof Error) {
        throw records;
      }
      return records;
    };
    return { resolveSrv, asked };
  };
  const notFound = () => new Response("", { status: 404 });
  const unauthorized = (url: string) => json({ error: "Unauthorized" }, { status: 401, url });

  test("the domain's own /.well-known/jmap is tried first and needs no confirmation", async () => {
    const { fetch } = fakeFetch(() => json(STALWART_LIKE_SESSION, { url: "https://mail.example.net/jmap/session" }));
    const { resolveSrv, asked } = resolver([{ priority: 0, weight: 1, host: "other.example.com", port: 443 }]);
    const found = await discoverSession("me@example.org", { fetch, resolveSrv });
    expect(found).toEqual({ url: "https://mail.example.net/jmap/session", via: "well-known", needsConfirmation: false });
    expect(asked).toEqual([]);
  });

  test("without a /.well-known/jmap on the domain, its _jmap._tcp SRV record is used", async () => {
    const { fetch, calls } = fakeFetch(url =>
      url == "https://jmap.example.net/.well-known/jmap"
        ? unauthorized("https://jmap.example.net/jmap/session")
        : notFound()
    );
    const { resolveSrv, asked } = resolver([{ priority: 0, weight: 1, host: "jmap.example.net", port: 443 }]);
    const found = await discoverSession("Me@Example.org", { fetch, resolveSrv });
    expect(asked).toEqual(["_jmap._tcp.example.org"]);
    expect(calls.map(c => c.url)).toEqual([
      "https://example.org/.well-known/jmap",
      "https://jmap.example.net/.well-known/jmap",
    ]);
    // DNS is not authenticated: a server outside the user's domain is confirmed first.
    expect(found).toEqual({ url: "https://jmap.example.net/jmap/session", via: "srv", needsConfirmation: true });
  });

  test("an SRV target inside the email's domain needs no confirmation, and its port is kept", async () => {
    const { fetch, calls } = fakeFetch(url =>
      url.startsWith("https://mail.example.org:8443/") ? json(STALWART_LIKE_SESSION, { url }) : notFound()
    );
    const { resolveSrv } = resolver([{ priority: 0, weight: 1, host: "mail.example.org.", port: 8443 }]);
    const found = await discoverSession("me@example.org", { fetch, resolveSrv });
    expect(calls[1].url).toBe("https://mail.example.org:8443/.well-known/jmap");
    expect(found).toEqual({
      url: "https://mail.example.org:8443/.well-known/jmap",
      via: "srv",
      needsConfirmation: false,
    });
  });

  test("SRV targets are tried by priority, skipping '.' and unreachable hosts", async () => {
    const { fetch, calls } = fakeFetch(url => {
      if (url.startsWith("https://a.example.net/")) {
        throw new TypeError("connection refused");
      }
      return url.startsWith("https://b.example.net/") ? unauthorized("https://b.example.net/jmap/session") : notFound();
    });
    const { resolveSrv } = resolver([
      { priority: 10, weight: 1, host: "b.example.net", port: 443 },
      { priority: 0, weight: 1, host: ".", port: 0 },
      { priority: 5, weight: 1, host: "a.example.net", port: 443 },
    ]);
    const found = await discoverSession("me@example.org", { fetch, resolveSrv });
    expect(calls.map(c => new URL(c.url).host)).toEqual(["example.org", "a.example.net", "b.example.net"]);
    expect(found.url).toBe("https://b.example.net/jmap/session");
  });

  test("SRV targets that are not plain host names are skipped, so they cannot pass as in-domain", async () => {
    const { fetch, calls } = fakeFetch(url =>
      url.startsWith("https://example.org/") ? notFound() : json(STALWART_LIKE_SESSION, { url })
    );
    const tricky = [
      "evil.example.com/x.example.org",
      "evil.example.com#.example.org",
      "evil.example.com?.example.org",
      "u@evil.example.com",
      "evil.example.com:1.example.org",
      "ev il.example.org",
    ];
    const { resolveSrv } = resolver(tricky.map((host, i) => ({ priority: i, weight: 1, host, port: 443 })));
    await expect(discoverSession("me@example.org", { fetch, resolveSrv })).rejects.toBeInstanceOf(JmapHttpError);
    expect(calls.map(c => c.url)).toEqual(["https://example.org/.well-known/jmap"]);
  });

  test("with no SRV records, or a failing DNS lookup, the domain's error is reported", async () => {
    for (const records of [[], new Error("SERVFAIL")]) {
      const { fetch } = fakeFetch(() => notFound());
      const { resolveSrv } = resolver(records);
      await expect(discoverSession("me@example.org", { fetch, resolveSrv })).rejects.toBeInstanceOf(JmapHttpError);
    }
  });

  test("a URL is used as given, without a DNS lookup", async () => {
    const { fetch } = fakeFetch(url => json(STALWART_LIKE_SESSION, { url }));
    const { resolveSrv, asked } = resolver([]);
    const found = await discoverSession("https://jmap.example.net/jmap/session", { fetch, resolveSrv });
    expect(found).toEqual({ url: "https://jmap.example.net/jmap/session", via: "url", needsConfirmation: false });
    expect(asked).toEqual([]);
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

describe("JmapClient.getSession URL safety", () => {
  const sessionWith = (overrides: Record<string, string>) =>
    fakeFetch(() => json({ ...STALWART_LIKE_SESSION, ...overrides })).fetch;

  test("rejects a plain-http API URL from an https session", async () => {
    const client = new JmapClient({
      sessionUrl: "https://mail.example.org/jmap/session",
      credentials: { kind: "basic", username: "u", password: "p" },
      fetch: sessionWith({ apiUrl: "http://mail.example.org/jmap/" }),
    });
    await expect(client.getSession()).rejects.toThrow(/https/);
  });

  test("rejects non-http schemes", async () => {
    const client = new JmapClient({
      sessionUrl: "https://mail.example.org/jmap/session",
      credentials: { kind: "basic", username: "u", password: "p" },
      fetch: sessionWith({ downloadUrl: "file:///etc/{blobId}" }),
    });
    await expect(client.getSession()).rejects.toThrow(/https/);
  });

  test("allows http only between loopback hosts", async () => {
    const ok = new JmapClient({
      sessionUrl: "http://127.0.0.1:18080/jmap/session",
      credentials: { kind: "basic", username: "u", password: "p" },
      fetch: sessionWith({}),
    });
    await expect(ok.getSession()).resolves.toMatchObject({ apiUrl: "http://127.0.0.1:18080/jmap/" });
    const leaky = new JmapClient({
      sessionUrl: "http://127.0.0.1:18080/jmap/session",
      credentials: { kind: "basic", username: "u", password: "p" },
      fetch: sessionWith({ apiUrl: "http://evil.example/jmap/" }),
    });
    await expect(leaky.getSession()).rejects.toThrow(/https/);
  });
});
