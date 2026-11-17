// SCRATCH — Phase 2 experiment, not committed.
import { test, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { startStalwart, connect, createMailbox, importEmail, mailboxIdByRole } from "@thunderbird-jmap/test-support";
import { createProfile, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";

test("change-path spike", async () => {
  const version = process.env.SPIKE_TB ?? "160.0";
  const s = await startStalwart();
  try {
    const { client, accountId } = await connect(s);
    const inbox = await mailboxIdByRole(client, accountId, "inbox");
    await createMailbox(client, accountId, "Alpha");
    for (const n of [1, 2, 3, 4]) await importEmail(client, accountId, { mailboxIds: [inbox], subject: `P${n}`, body: `p${n}` });
    const profile = await createProfile({ xpi: TEST_XPI });
    const created = await runScenario({ version, profile, scenario: "create-account", args: { email: "admin@example.com", sessionUrl: s.sessionUrl, username: s.username, secret: s.password, authKind: "basic" } });
    const r = await runScenario({ version, profile, scenario: "spike-paths", args: {}, timeoutMs: 180_000 });
    writeFileSync(process.env.SPIKE_OUT!, JSON.stringify({ created: (created as any).ok, r }, null, 2));
  } finally {
    await s.stop();
  }
  expect(true).toBe(true);
}, 600_000);
