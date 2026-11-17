/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Sending through JMAP, end to end on a local Mailflare (sends land in
// Mailpit). The profile also has an SMTP-only account whose (unreachable)
// server is the default, so any fallback to another account would show.
//
// Successful sends go through Thunderbird's own sending code. Failures are
// driven through the identity's outgoing server directly (as Thunderbird's
// sender calls it): Thunderbird shows a send failure in a modal alert, which
// a headless run cannot dismiss.

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import { startMailflare, type MailflareInstance } from "@thunderbird-jmap/test-support";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

interface SendResult {
  status: number;
}
interface DirectResult {
  serverType: string;
  exitCode: number;
  errorMessage: string | null;
}

const ME = "me@example.test";
const HELLO = "hello@example.test";

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let mf: MailflareInstance;
  let profile: string;

  beforeAll(async () => {
    mf = await startMailflare();
    profile = await createProfile({ xpi: TEST_XPI });
    const created = await runScenario<Inspection>({
      version,
      profile,
      scenario: "create-account",
      args: { email: ME, sessionUrl: mf.sessionUrl, username: mf.username, secret: mf.apiKey, authKind: "basic" },
    });
    expect(created.ok, created.error).toBe(true);
    const smtp = await runScenario({ version, profile, scenario: "add-smtp-account", args: {} });
    expect(smtp.ok, smtp.error).toBe(true);
  }, 900_000);

  afterAll(async () => {
    await mf?.stop();
  });

  const send = (args: Record<string, unknown>) => runScenario<SendResult>({ version, profile, scenario: "send", args });
  const direct = (args: Record<string, unknown>) => runScenario<DirectResult>({ version, profile, scenario: "send-direct", args });
  const sentFolderSubjects = (r: Inspection, address: string) =>
    Object.entries(r.accounts[0].messages)
      .filter(([path]) => path.startsWith(`${address.split("@")[0]} <${address}>/Sent`))
      .flatMap(([, list]) => list.map(m => m.subject));
  const draftSubjects = (r: Inspection) =>
    Object.entries(r.accounts[0].messages)
      .filter(([path]) => path.endsWith("/Drafts"))
      .flatMap(([, list]) => list.map(m => m.subject));

  test("sending from each address delivers to To and Bcc, with no Bcc header, and one Sent copy each", async () => {
    for (const from of [ME, HELLO]) {
      const r = await send({ from, to: "to@dest.test", bcc: "hidden@dest.test", subject: `Hi from ${from}` });
      expect(r.ok, r.error).toBe(true);
      expect(r.status).toBe(0);
    }
    const caught = await mf.captured();
    for (const from of [ME, HELLO]) {
      const m = caught.filter(c => c.subject == `Hi from ${from}`);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ from, to: ["to@dest.test"], bcc: ["hidden@dest.test"] });
      expect(m[0].raw).not.toMatch(/^Bcc:/im);
    }
    const after = await runScenario<Inspection>({ version, profile, scenario: "inspect", args: {} });
    expect(after.ok, after.error).toBe(true);
    expect(sentFolderSubjects(after, ME)).toEqual([`Hi from ${ME}`]);
    expect(sentFolderSubjects(after, HELLO)).toEqual([`Hi from ${HELLO}`]);
    expect(draftSubjects(after)).toEqual([]);
  });

  test("Send Later puts the message in the Outbox, and sending it from there goes through JMAP", async () => {
    const queued = await send({ from: ME, to: "later@dest.test", subject: "Sent later", mode: "later" });
    expect(queued.ok, queued.error).toBe(true);
    expect((await mf.captured()).filter(c => c.subject == "Sent later")).toEqual([]);
    const flushed = await runScenario<{ status: number }>({ version, profile, scenario: "send-unsent", args: { from: ME } });
    expect(flushed.ok, flushed.error).toBe(true);
    expect(flushed.status).toBe(0);
    expect((await mf.captured()).filter(c => c.subject == "Sent later")).toHaveLength(1);
  });

  test("Redirect is refused and nothing is sent", async () => {
    const r = await direct({ from: ME, to: "to@dest.test", subject: "Redirected", resent: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.serverType).toBe("jmap");
    expect(r.exitCode).not.toBe(0);
    expect(r.errorMessage).toBe("Redirect isn't available for JMAP accounts.");
    expect((await mf.captured()).filter(c => c.subject == "Redirected")).toEqual([]);
  });

  test("a send the server refuses reports it plainly", async () => {
    await mf.setSending(false);
    try {
      const r = await direct({ from: ME, to: "to@dest.test", subject: "Refused" });
      expect(r.ok, r.error).toBe(true);
      expect(r.exitCode).not.toBe(0);
      expect(r.errorMessage).toMatch(/^The server did not send this message: Sending is not set up/);
      expect(r.errorMessage).toMatch(/If a copy appears in Sent, it was not delivered\.$/);
      expect((await mf.captured()).filter(c => c.subject == "Refused")).toEqual([]);
    } finally {
      await mf.setSending(true);
    }
  });

  test("sending with the server unreachable fails clearly, through the jmap server, not the fallback", async () => {
    await mf.stop(); // last test: the server is gone for good
    const r = await direct({ from: ME, to: "to@dest.test", subject: "Offline" });
    expect(r.ok, r.error).toBe(true);
    expect(r.serverType).toBe("jmap");
    expect(r.exitCode).not.toBe(0);
    expect(r.errorMessage).toBe("Couldn't reach the mail server. The message was not sent.");
  });
});
