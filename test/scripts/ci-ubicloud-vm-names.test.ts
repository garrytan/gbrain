// ci-ubicloud-vm-names.test.ts — VM names that carry an expiry
// (ubirun-<owner>-<epoch>-x<expiry>-<suffix>) next to the older names, for
// scripts/ubicloud/ubi-runner.sh and scripts/ci-ubicloud.ts.
//
// Protects: `up`/`run --ttl-hours H` name their VM with an expiry H hours
// after creation (no --ttl-hours: no expiry, never reaped), the flag is
// validated and cannot be combined with -n, and every existing parser
// (list --mine, usage, gc, down) reads old and new names alike: gc ages a VM
// by its creation epoch, never its expiry.
// Fails when: a new-format name is not owner-tagged for list --mine or usage,
// gc sweeps by the expiry or another owner's VM, or the flag is ignored.
// Network: none (in-process mock Ubicloud API).

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockUbicloud, waitForEvent, type MockUbicloud, type MockUbicloudOptions } from "../helpers/mock-ubicloud-api.ts";

const RUNNER = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/ubi-runner.sh");
const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 5 * 3600;

let dir = "";
let mock: MockUbicloud | null = null;
afterEach(() => {
  mock?.stop();
  mock = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function serve(opts: MockUbicloudOptions = {}): MockUbicloud {
  mock = startMockUbicloud(opts);
  return mock;
}

function spawnRunner(args: string[], extra: Record<string, string> = {}) {
  dir ||= mkdtempSync(join(tmpdir(), "ubi-vm-names-"));
  return Bun.spawn(["bash", RUNNER, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      UBICLOUD_API_KEY: "test-token",
      UBICLOUD_API_URL: mock?.url ?? "http://127.0.0.1:9",
      UBI_RUNNER_STATE: join(dir, "state"),
      UBI_POLL_SECONDS: "0.2",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function run(args: string[], extra: Record<string, string> = {}) {
  const proc = spawnRunner(args, extra);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("--ttl-hours", () => {
  for (const verb of ["up", "run"] as const) {
    it(`${verb} --ttl-hours 3 names the VM with an expiry three hours after creation`, async () => {
      const api = serve();
      const proc = spawnRunner(verb === "up" ? ["up", "--ttl-hours", "3"] : ["run", "--ttl-hours", "3", "--", "true"], { UBI_OWNER: "gbra135" });
      const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
      proc.kill("SIGTERM");
      await proc.exited;
      const m = /^ubirun-gbra135-(\d{10})-x(\d{10})-[0-9a-f]{8}$/.exec(name);
      expect(m).not.toBeNull();
      expect(Number(m![2]) - Number(m![1])).toBe(3 * 3600);
      expect(Math.abs(Number(m![1]) - NOW)).toBeLessThan(120);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(api.vms.size).toBe(0);
    });
  }

  it("without --ttl-hours the name carries no expiry", async () => {
    const api = serve();
    const proc = spawnRunner(["up"], { UBI_OWNER: "gbra135" });
    const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
    proc.kill("SIGTERM");
    await proc.exited;
    expect(name).toMatch(/^ubirun-gbra135-\d{10}-[0-9a-f]{8}$/);
  });

  it("refuses a bad value and the combination with -n before any create", async () => {
    const api = serve();
    for (const bad of ["0", "1.5", "abc", "9000"]) {
      const r = await run(["up", "--ttl-hours", bad], { UBI_OWNER: "t1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--ttl-hours must be a whole number of hours from 1 to 8760");
    }
    const both = await run(["up", "-n", "ubirun-t1-1790000000-aaaaaaaa", "--ttl-hours", "2"], { UBI_OWNER: "t1" });
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("cannot be combined with -n");
    const runBoth = await run(["run", "--ttl-hours", "2", "-n", "ubirun-t1-1790000000-aaaaaaaa", "--", "true"], { UBI_OWNER: "t1" });
    expect(runBoth.code).toBe(1);
    expect(runBoth.stderr).toContain("cannot be combined with -n");
    expect(api.events).toEqual([]);
  });
});

describe("parsers read old and new names", () => {
  const seed = [
    { name: `ubirun-t1-${OLD}-x${NOW + 3600}-ci01abcd`, size: "standard-16" },
    { name: `ubirun-t1-${NOW}-x${OLD}-ci02abcd`, size: "standard-8" },
    { name: `ubirun-t1-${OLD}-aaaaaaaa`, size: "standard-4" },
    { name: `ubirun-other-${OLD}-x${OLD + 3600}-ci01ffff`, size: "standard-16" },
    { name: `ubirun-${OLD}-dddddddd`, size: "standard-2" },
    { name: "prod-db", size: "standard-2" },
  ];

  it("list --mine and usage tag new-format names with their owner", async () => {
    serve({ seed });
    const mine = await run(["list", "--mine"], { UBI_OWNER: "t1" });
    expect(mine.stdout.trim().split("\n").map((l) => l.split(/\s+/)[1])).toEqual(seed.slice(0, 3).map((s) => s.name));
    const usage = (await run(["usage"], { UBI_OWNER: "t1" })).stdout;
    expect(usage).toMatch(/^t1\s+3\s+28\s+\(you\)$/m);
    expect(usage).toMatch(/^other\s+1\s+16$/m);
    expect(usage).toMatch(/^\(untagged\)\s+1\s+2$/m);
    expect(usage).toMatch(/^\(other\)\s+1\s+2$/m);
  });

  it("gc ages by creation epoch: it sweeps the caller's old VMs of both formats, not a young VM whose expiry passed", async () => {
    const api = serve({ seed });
    const gc = await run(["gc", "1"], { UBI_OWNER: "t1" });
    expect(gc.code).toBe(0);
    expect(api.events.filter((e) => e.startsWith("destroy ")).sort()).toEqual([`destroy ${seed[0]!.name}`, `destroy ${seed[2]!.name}`].sort());
    expect([...api.vms.keys()].sort()).toEqual([seed[1]!.name, seed[3]!.name, seed[4]!.name, seed[5]!.name].sort());
  });

  it("down destroys a new-format name", async () => {
    const api = serve({ seed });
    const down = await run(["down", seed[3]!.name], { UBI_OWNER: "t1" });
    expect(down.code).toBe(0);
    expect(api.events).toEqual([`destroy ${seed[3]!.name}`, `removed ${seed[3]!.name}`]);
  });
});
