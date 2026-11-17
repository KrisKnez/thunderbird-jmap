/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The jmap outgoing server, JMAP identities, and the guard that keeps a JMAP
// identity's mail from ever going through another account's SMTP server.

import { describe, beforeAll, afterAll, test, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMailflare, type MailflareInstance } from "@thunderbird-jmap/test-support";
import { createProfile, TB_VERSIONS, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";
import type { Inspection } from "./harness/types.js";

interface IdentityState {
  email: string;
  jmapIdentityId: string;
  outgoingKey: string;
  outgoingType: string | null;
  outgoingHost: string | null;
  doFcc: boolean;
  draftFolderPath: string[] | null;
  fccFolderPath: string[] | null;
}
interface OutgoingState {
  identities: IdentityState[];
  identityCount: number;
  accountOutgoingKey: string;
}

/** Prefs Thunderbird saved for this profile (prefs.js), as name → value. */
async function savedPrefs(profile: string): Promise<Record<string, string | number | boolean>> {
  const text = await readFile(join(profile, "prefs.js"), "utf8");
  const prefs: Record<string, string | number | boolean> = {};
  for (const m of text.matchAll(/^user_pref\("([^"]+)", (.*)\);$/gm)) {
    prefs[m[1]] = JSON.parse(m[2]);
  }
  return prefs;
}

/** Run with an extra user.js pref (applied at startup), then remove it again. */
async function withUserPref<T>(profile: string, name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const file = join(profile, "user.js");
  const original = await readFile(file, "utf8");
  await writeFile(file, `${original}user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`);
  try {
    return await fn();
  } finally {
    await writeFile(file, original);
  }
}

describe.each(TB_VERSIONS)("Thunderbird %s", version => {
  let mf: MailflareInstance;
  let profile: string;
  let first: OutgoingState;

  beforeAll(async () => {
    mf = await startMailflare();
    profile = await createProfile({ xpi: TEST_XPI });
    const created = await runScenario<Inspection>({
      version,
      profile,
      scenario: "create-account",
      args: { email: "me@example.test", sessionUrl: mf.sessionUrl, username: mf.username, secret: mf.apiKey, authKind: "basic" },
    });
    expect(created.ok, created.error).toBe(true);
  }, 900_000);

  afterAll(async () => {
    await mf?.stop();
  });

  const state = async () => {
    const r = await runScenario<OutgoingState>({ version, profile, scenario: "outgoing-state", args: {} });
    expect(r.ok, r.error).toBe(true);
    return r;
  };

  test("a Mailflare account with two addresses gets two identities sending through its jmap server", async () => {
    first = await state();
    expect(first.identities.map(i => i.email).sort()).toEqual(["hello@example.test", "me@example.test"]);
    expect(first.identityCount).toBe(2);
    for (const i of first.identities) {
      expect(i).toMatchObject({ outgoingKey: first.accountOutgoingKey, outgoingType: "jmap", doFcc: false });
      expect(i.jmapIdentityId).toMatch(/~/);
      expect(i.draftFolderPath).toEqual([expect.stringContaining(`<${i.email}>`), "Drafts"]);
      expect(i.fccFolderPath).toEqual([expect.stringContaining(`<${i.email}>`), "Sent"]);
    }
  });

  test("after a restart every JMAP identity still resolves to the jmap server", async () => {
    const again = await state();
    expect(again.identities).toEqual(first.identities);
  });

  test("after the add-on shuts down, its outgoing server is parked so nothing can fall back to another account", async () => {
    const prefs = await savedPrefs(profile);
    const key = first.accountOutgoingKey;
    expect(prefs[`mail.smtpserver.${key}.type`]).toBe("smtp");
    expect(prefs[`mail.smtpserver.${key}.hostname`]).toBe("jmap-parked.invalid");
    expect(prefs[`mail.smtpserver.${key}.port`]).toBe(1);
  });

  test("a stale outgoing list is repaired at startup: the jmap server comes back under the same key", async () => {
    const key = first.accountOutgoingKey;
    // As after a crash with an unknown type in the list: 160 drops the
    // server from its cached list, 153/158 fail to load the list at all.
    const repaired = await withUserPref(profile, `mail.smtpserver.${key}.type`, "jmap-missing", state);
    expect(repaired.identities).toEqual(first.identities);
  });

  test("an account from before Phase 2 gets an outgoing server, and its identity is adopted, not duplicated", async () => {
    const older = await runScenario({ version, profile, scenario: "as-phase-1-account", args: {} });
    expect(older.ok, older.error).toBe(true);
    const upgraded = await state();
    expect(upgraded.identityCount).toBe(2);
    expect(upgraded.identities.map(i => [i.email, i.outgoingType, i.doFcc]).sort()).toEqual([
      ["hello@example.test", "jmap", false],
      ["me@example.test", "jmap", false],
    ]);
  });
});
