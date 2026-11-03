// ci-ubicloud-vm-names.test.ts — VM names in gstack's runner grammar
// (ubirun-<owner>-<epoch>-<suffix>-t<H>) next to the older -x<expiry> and
// TTL-less names, for scripts/ubicloud/ubi-runner.sh and scripts/ci-ubicloud.ts.
//
// Protects: `up`/`run --ttl-hours H` name their VM with a -t<H> TTL, and
// without it with UBI_TTL_HOURS (gstack's default, 3), so no generated name is
// TTL-less; the flag is validated (1 to 999), with -n NAME it appends -t<H>,
// and a ubirun- NAME without a TTL is refused before any create (#8050);
// every parser (list --mine, usage, gc, down) reads all three formats alike:
// gc ages a VM by its creation epoch, never its expiry.
// Fails when: a new-format name is not owner-tagged for list --mine or usage,
// gc sweeps by the expiry or another owner's VM, the flag is ignored, or a
// hand-named ubirun- VM reaches the API without a TTL.
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
    it(`${verb} --ttl-hours 3 names the VM with a three-hour TTL in gstack's grammar`, async () => {
      const api = serve();
      const proc = spawnRunner(verb === "up" ? ["up", "--ttl-hours", "3"] : ["run", "--ttl-hours", "3", "--", "true"], { UBI_OWNER: "gbra135" });
      const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
      proc.kill("SIGTERM");
      await proc.exited;
      const m = /^ubirun-gbra135-(\d{10})-[0-9a-f]{8}-t3$/.exec(name);
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m![1]) - NOW)).toBeLessThan(120);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(api.vms.size).toBe(0);
    });
  }

  it("without --ttl-hours the name carries UBI_TTL_HOURS: gstack's 3 by default, 999 at most", async () => {
    for (const [extra, ttl] of [[{}, "t3"], [{ UBI_TTL_HOURS: "999" }, "t999"]] as const) {
      const api = serve({ rejectCreates: true });
      const r = await run(["up"], { UBI_OWNER: "gbra135", ...extra });
      expect(r.code).toBe(1);
      const name = api.events[0]!.split(" ")[1]!;
      expect(name).toMatch(new RegExp(`^ubirun-gbra135-\\d{10}-[0-9a-f]{8}-${ttl}$`));
      expect(name.length).toBeLessThanOrEqual(63);
      mock!.stop();
    }
  });

  it("refuses a bad value before any create", async () => {
    const api = serve();
    for (const bad of ["0", "1.5", "abc", "1000", "024"]) {
      for (const args of [["up", "--ttl-hours", bad], ["run", "--ttl-hours", bad, "--", "true"]]) {
        const r = await run(args, { UBI_OWNER: "t1" });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("--ttl-hours must be a whole number of hours from 1 to 999");
      }
    }
    expect(api.events).toEqual([]);
  });

  // #8050 item 1: a hand-named ubirun- VM used to bypass the TTL.
  it("-n NAME with --ttl-hours appends -t<H>; a ubirun- NAME without a TTL is refused before any create; other names pass", async () => {
    const api = serve({ rejectCreates: true });
    for (const args of [["up", "-n", "ubirun-t1-1790000000-aaaaaaaa", "--ttl-hours", "2"], ["run", "--ttl-hours", "2", "-n", "ubirun-t1-1790000000-bbbbbbbb", "--", "true"]]) {
      expect((await run(args, { UBI_OWNER: "t1" })).code).toBe(1);
    }
    expect(api.events.filter((e) => e.startsWith("create-start "))).toEqual(["create-start ubirun-t1-1790000000-aaaaaaaa-t2", "create-start ubirun-t1-1790000000-bbbbbbbb-t2"]);
    api.events.length = 0;
    for (const args of [["up", "-n", "ubirun-t1-1790000000-cccccccc"], ["run", "-n", "ubirun-t1-1790000000-dddddddd", "--", "true"], ["up", "-n", "ubirun-t1-1790000000-eeeeeeee-t0"]]) {
      const r = await run(args, { UBI_OWNER: "t1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("has no -t<hours> TTL, so no reaper could destroy it if this run dies; add --ttl-hours H");
    }
    const twice = await run(["up", "-n", "ubirun-t1-1790000000-ffffffff-t5", "--ttl-hours", "2"], { UBI_OWNER: "t1" });
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("already ends in a TTL");
    expect(api.events).toEqual([]);
    expect((await run(["up", "-n", "ubirun-t1-1790000000-abababab-t5"], { UBI_OWNER: "t1" })).code).toBe(1);
    expect((await run(["up", "-n", "bench-db-1"], { UBI_OWNER: "t1" })).code).toBe(1);
    expect(api.events.filter((e) => e.startsWith("create-start "))).toEqual(["create-start ubirun-t1-1790000000-abababab-t5", "create-start bench-db-1"]);
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
    { name: `ubirun-t1-${OLD}-eeeeeeee-t3`, size: "standard-2" },
    { name: `ubirun-other-${NOW}-ffffffff-t999`, size: "standard-4" },
  ];

  it("list --mine and usage tag -t<H> and -x<expiry> names with their owner", async () => {
    serve({ seed });
    const mine = await run(["list", "--mine"], { UBI_OWNER: "t1" });
    expect(mine.stdout.trim().split("\n").map((l) => l.split(/\s+/)[1])).toEqual([0, 1, 2, 6].map((i) => seed[i]!.name));
    const usage = (await run(["usage"], { UBI_OWNER: "t1" })).stdout;
    expect(usage).toMatch(/^t1\s+4\s+30\s+\(you\)$/m);
    expect(usage).toMatch(/^other\s+2\s+20$/m);
    expect(usage).toMatch(/^\(untagged\)\s+1\s+2$/m);
    expect(usage).toMatch(/^\(other\)\s+1\s+2$/m);
  });

  it("gc ages by creation epoch: it sweeps the caller's old VMs of every format, not a young VM whose expiry passed", async () => {
    const api = serve({ seed });
    const gc = await run(["gc", "1"], { UBI_OWNER: "t1" });
    expect(gc.code).toBe(0);
    expect(api.events.filter((e) => e.startsWith("destroy ")).sort()).toEqual([0, 2, 6].map((i) => `destroy ${seed[i]!.name}`).sort());
    expect([...api.vms.keys()].sort()).toEqual([1, 3, 4, 5, 7].map((i) => seed[i]!.name).sort());
  });

  it("down destroys a new-format name", async () => {
    const api = serve({ seed });
    const down = await run(["down", seed[3]!.name], { UBI_OWNER: "t1" });
    expect(down.code).toBe(0);
    expect(api.events).toEqual([`destroy ${seed[3]!.name}`, `removed ${seed[3]!.name}`]);
  });
});
