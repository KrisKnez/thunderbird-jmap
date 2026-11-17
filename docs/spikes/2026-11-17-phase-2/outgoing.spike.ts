// SCRATCH — Phase 2 experiment, not committed.
import { test, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { startStalwart } from "@thunderbird-jmap/test-support";
import { createProfile, TEST_XPI } from "./harness/thunderbird.js";
import { runScenario } from "./harness/scenario.js";

const OUT = process.env.SPIKE_OUT!;
const version = process.env.SPIKE_TB ?? "160.0";

test("outgoing server spike", async () => {
  const s = await startStalwart();
  const results: Record<string, unknown> = { version };
  try {
    const profile = await createProfile({ xpi: TEST_XPI });
    const run = async (scenario: string, args: unknown = {}) =>
      (results[`${Object.keys(results).length}-${scenario}`] = await runScenario({ version, profile, scenario, args }));
    await run("create-account", { email: "admin@example.com", sessionUrl: s.sessionUrl, username: s.username, secret: s.password, authKind: "basic" });
    await run("spike-out-setup");
    await run("spike-out-send");
    await run("spike-out-check");
    await run("spike-out-check", { recreate: true });
    await run("spike-out-send");
  } finally {
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    await s.stop();
  }
  expect(true).toBe(true);
}, 600_000);
