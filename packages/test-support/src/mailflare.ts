/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A local Mailflare (hieunc229/mailflare, AGPL-3.0) with Mailpit as its
// outbound relay, for tests. Mailflare is built from a pinned commit fetched
// at test time and is never copied into this repository. Test sends land in
// Mailpit and are never delivered. Steps proven in docs/spikes/2026-11-17-phase-2/.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort } from "./stalwart.js";

const run = promisify(execFile);

export const MAILFLARE_COMMIT = "5330fa4fff72cb0f38564822ff873e8ab854dee8";
export const MAILPIT_IMAGE = "docker.io/axllent/mailpit:v1.33.1";
const MAILFLARE_REPO = "https://github.com/hieunc229/mailflare.git";
const IMAGE = `localhost/mailflare-test:${MAILFLARE_COMMIT.slice(0, 7)}`;
const DOMAIN = "example.test";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = join(REPO_ROOT, ".cache/mailflare/src");

export interface CapturedMessage {
  from: string;
  to: string[];
  bcc: string[];
  subject: string;
  /** The message as recipients got it (Mailpit's own leading Bcc: line removed). */
  raw: string;
  text: string;
}

export interface MailflareInstance {
  baseUrl: string;
  sessionUrl: string;
  /** Basic-auth user; Mailflare's JMAP only checks the password part (the API key). */
  username: string;
  apiKey: string;
  /** Same as apiKey, so `connect()` works as for Stalwart. */
  password: string;
  addresses: string[];
  deliver(o: { from: string; to: string; subject: string; body: string; messageId?: string }): Promise<void>;
  captured(): Promise<CapturedMessage[]>;
  setSending(enabled: boolean): Promise<void>;
  /** Stop the server, keeping its data (volume) and ports. */
  down(): Promise<void>;
  /** Start it again after down(). */
  up(): Promise<void>;
  stop(): Promise<void>;
}

async function podman(...args: string[]): Promise<string> {
  const { stdout } = await run("podman", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Clone the pinned commit (shallow) and build the image once. */
async function ensureImage(): Promise<void> {
  if (await podman("image", "exists", IMAGE).then(() => true, () => false)) {
    return;
  }
  const pinned = join(SOURCE, "..", "PINNED");
  if (!existsSync(join(SOURCE, ".git")) || !existsSync(pinned) || readFileSync(pinned, "utf8").trim() != MAILFLARE_COMMIT) {
    mkdirSync(SOURCE, { recursive: true });
    await run("git", ["-C", SOURCE, "init", "-q"]);
    await run("git", ["-C", SOURCE, "fetch", "-q", "--depth", "1", MAILFLARE_REPO, MAILFLARE_COMMIT]);
    await run("git", ["-C", SOURCE, "checkout", "-q", "FETCH_HEAD"]);
    writeFileSync(pinned, MAILFLARE_COMMIT + "\n");
  }
  await run("podman", ["build", "-t", IMAGE, SOURCE], { maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 });
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`${url} not ready after ${timeoutMs} ms`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

export async function startMailflare(o: { localParts?: string[] } = {}): Promise<MailflareInstance> {
  const localParts = o.localParts ?? ["me", "hello"];
  await ensureImage();
  const id = randomBytes(4).toString("hex");
  const network = `tbjmap-mf-${id}`;
  const mailpit = `tbjmap-mailpit-${id}`;
  const mailflare = `tbjmap-mailflare-${id}`;
  const [httpPort, smtpPort, mailpitPort] = [await freePort(), await freePort(), await freePort()];
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const mailpitUrl = `http://127.0.0.1:${mailpitPort}`;

  const stop = async () => {
    await podman("rm", "-f", mailflare, mailpit).catch(() => "");
    await podman("network", "rm", "-f", network).catch(() => "");
  };
  const sql = (statement: string) =>
    podman(
      "exec", "-w", "/app", mailflare, "node", "-e",
      `const D=require("better-sqlite3"); new D("/data/mailflare.sqlite").prepare(${JSON.stringify(statement)}).run()`
    );

  try {
    await podman("network", "create", network);
    await podman("run", "-d", "--name", mailpit, "--network", network, "-p", `127.0.0.1:${mailpitPort}:8025`, MAILPIT_IMAGE);
    await podman(
      "run", "-d", "--name", mailflare, "--network", network,
      "-p", `127.0.0.1:${httpPort}:3000`, "-p", `127.0.0.1:${smtpPort}:2525`,
      "-e", `SMTP_URL=smtp://${mailpit}:1025`, "-e", `APP_URL=${baseUrl}`,
      "-e", "SMTP_INBOUND_PORT=2525", "-e", `MAIL_HOSTNAME=${DOMAIN}`,
      IMAGE
    );
    await waitFor(`${baseUrl}/api/setup/status`, 120_000);
    await waitFor(`${mailpitUrl}/api/v1/messages`, 60_000);

    const password = randomBytes(12).toString("hex") + "A1!";
    const post = async (path: string, body: unknown, cookie = "") => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Mailflare ${path}: ${res.status} ${JSON.stringify(data)}`);
      }
      return { res, data };
    };
    await post("/api/setup/prepare", {});
    await post("/api/auth/register", {
      domain: DOMAIN,
      username: localParts[0],
      password,
      skipDns: true,
      enableSending: true,
      usePasskey: false,
      resetEmail: "reset@sender.test",
    });
    const login = await post("/api/auth/login", { email: `${localParts[0]}@${DOMAIN}`, password });
    const cookie = login.res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const get = async (path: string) => (await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } })).json() as Promise<any>;

    const domains: any = await get("/api/domains");
    const domainId = (domains.domains ?? domains).find((d: any) => d.hostname == DOMAIN).id;
    for (const localPart of localParts.slice(1)) {
      await post("/api/mailboxes", { domainId, localPart, displayName: localPart }, cookie);
    }
    // Test-only: a manual domain stays "pending" without DNS, which refuses
    // inbound mail and sending. Self-hosted "cloudflare" sends via SMTP_URL.
    await sql("update domains set status='active', sending_provider='cloudflare'");

    const mailboxes: any = await get("/api/mailboxes");
    const mailboxIds = (mailboxes.mailboxes ?? mailboxes).map((m: any) => m.id);
    const key = await post("/api/api-keys", { name: "thunderbird-test", scopes: ["jmap"], mailboxIds }, cookie);
    const apiKey = String(key.data.key);
    const username = `${localParts[0]}@${DOMAIN}`;

    /** Resolves once an email with this Message-ID is visible over JMAP. */
    const waitForMessageId = async (messageId: string) => {
      const auth = { Authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString("base64")}` };
      const session: any = await (await fetch(`${baseUrl}/jmap/session`, { headers: auth })).json();
      const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
      const deadline = Date.now() + 30_000;
      for (;;) {
        const res: any = await (
          await fetch(session.apiUrl, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify({
              using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
              methodCalls: [
                ["Email/query", { accountId, limit: 500 }, "q"],
                ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["messageId"] }, "g"],
              ],
            }),
          })
        ).json();
        const list = res.methodResponses?.[1]?.[1]?.list ?? [];
        if (list.some((e: any) => (e.messageId ?? []).includes(messageId))) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`Mailflare did not file <${messageId}> within 30 s`);
        }
        await new Promise(r => setTimeout(r, 250));
      }
    };

    const deliver: MailflareInstance["deliver"] = async m => {
      const messageId = m.messageId ?? `${randomBytes(8).toString("hex")}@sender.test`;
      const raw =
        `From: ${m.from}\r\nTo: ${m.to}\r\nSubject: ${m.subject}\r\nDate: ${new Date().toUTCString()}\r\n` +
        `Message-ID: <${messageId}>\r\n` +
        `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${m.body}\r\n`;
      await smtpSend(smtpPort, m.from, m.to, raw);
      await waitForMessageId(messageId);
    };

    const captured = async (): Promise<CapturedMessage[]> => {
      const list: any = await (await fetch(`${mailpitUrl}/api/v1/messages?limit=500`)).json();
      const out: CapturedMessage[] = [];
      for (const m of list.messages ?? []) {
        const raw = (await (await fetch(`${mailpitUrl}/api/v1/message/${m.ID}/raw`)).text()).replace(/^Bcc:[^\r\n]*\r?\n/, "");
        const full: any = await (await fetch(`${mailpitUrl}/api/v1/message/${m.ID}`)).json();
        out.push({
          from: m.From?.Address ?? "",
          to: (m.To ?? []).map((a: any) => a.Address),
          bcc: (m.Bcc ?? []).map((a: any) => a.Address),
          subject: m.Subject ?? "",
          raw,
          text: full.Text ?? "",
        });
      }
      return out;
    };

    return {
      baseUrl,
      sessionUrl: `${baseUrl}/jmap/session`,
      username,
      apiKey,
      password: apiKey,
      addresses: localParts.map(p => `${p}@${DOMAIN}`),
      deliver,
      captured,
      setSending: async enabled => {
        await sql(`update domains set sending_provider='${enabled ? "cloudflare" : "none"}'`);
      },
      down: async () => {
        await podman("stop", "-t", "2", mailflare);
      },
      up: async () => {
        await podman("start", mailflare);
        await waitFor(`${baseUrl}/api/setup/status`, 120_000);
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Minimal SMTP client: deliver one message to the local Mailflare listener. */
async function smtpSend(port: number, from: string, to: string, raw: string): Promise<void> {
  const { createConnection } = await import("node:net");
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let buffer = "";
  const waiters: ((line: string) => void)[] = [];
  socket.on("data", chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      // Multi-line replies ("250-…") end with a line whose 4th char is a space.
      if (line.length < 4 || line[3] == " ") {
        waiters.shift()?.(line);
      }
    }
  });
  const reply = () => new Promise<string>(resolve => waiters.push(resolve));
  const expect = async (code: string, send?: string) => {
    if (send !== undefined) {
      socket.write(send);
    }
    const line = await reply();
    if (!line.startsWith(code)) {
      socket.destroy();
      throw new Error(`SMTP: expected ${code}, got "${line}"`);
    }
  };
  await expect("220");
  await expect("250", "EHLO sender.test\r\n");
  await expect("250", `MAIL FROM:<${from}>\r\n`);
  await expect("250", `RCPT TO:<${to}>\r\n`);
  await expect("354", "DATA\r\n");
  const body = raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  await expect("250", `${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
  socket.end("QUIT\r\n");
}
