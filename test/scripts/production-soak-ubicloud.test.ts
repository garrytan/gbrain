// production-soak-ubicloud.test.ts — scripts/bench/production-soak/ubicloud.sh
// start's VM TTL (#8050 item 3).
//
// Protects: the soak VMs' TTL covers the soak: by default --hours (rounded up)
// plus 12, and a --ttl-hours under --hours + 4 is refused before any VM is
// created, since the operator reaper and gstack's reap destroy a VM about ten
// minutes past its TTL.
// Fails when: the TTL stops following --hours (the old fixed 15 lost a 20 h
// soak at about 15 h) or a too-short TTL reaches the API.
// Network: none (in-process mock Ubicloud API that refuses every create).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockUbicloud, type MockUbicloud } from "../helpers/mock-ubicloud-api.ts";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts/bench/production-soak/ubicloud.sh");
let dir = "";
let mock: MockUbicloud | null = null;
afterEach(() => {
  mock?.stop();
  mock = null;
  rmSync(dir, { recursive: true, force: true });
});

// Async: the mock API is served from this process, so a blocking spawn would starve it.
async function start(args: string[]) {
  dir ||= mkdtempSync(join(tmpdir(), "soak-ubicloud-"));
  const proc = Bun.spawn(["bash", SCRIPT, "start", "--rtts", "65", "--out", join(dir, "out"), ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, UBI_OWNER: "t1", UBICLOUD_API_KEY: "test-token", UBICLOUD_API_URL: mock!.url, UBI_RUNNER_STATE: join(dir, "state") },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr, names: mock!.events.filter((e) => e.startsWith("create-start ")).map((e) => e.split(" ")[1]!) };
}

describe("production soak TTL", () => {
  it("defaults the VM TTL to --hours rounded up plus 12", async () => {
    for (const [hours, ttl] of [["20", "t32"], ["3", "t15"], ["2.5", "t15"]] as const) {
      mock = startMockUbicloud({ rejectCreates: true });
      const r = await start(["--hours", hours]);
      expect(r.code).not.toBe(0);
      expect(r.names).toHaveLength(1);
      expect(r.names[0]).toMatch(new RegExp(`^ubirun-t1-\\d{10}-[0-9a-f]{8}-${ttl}$`));
      mock.stop();
    }
  }, 60_000);

  it("refuses a TTL under --hours + 4, or a bad --hours, before any VM is created", async () => {
    mock = startMockUbicloud({ rejectCreates: true });
    const short = await start(["--hours", "20", "--ttl-hours", "15"]);
    expect(short.code).toBe(2);
    expect(short.stderr).toContain("--ttl-hours 15 is under --hours 20 + 4: the reapers would destroy the VMs mid-soak; give at least 24");
    expect((await start(["--hours", "abc"])).stderr).toContain("--hours must be a number of hours");
    expect((await start(["--hours", "3", "--ttl-hours", "1000"])).stderr).toContain("--ttl-hours must be a whole number from 1 to 999");
    expect(mock.events).toEqual([]);
    const ok = await start(["--hours", "20", "--ttl-hours", "24"]);
    expect(ok.names[0]).toMatch(/-t24$/);
  }, 60_000);
});
