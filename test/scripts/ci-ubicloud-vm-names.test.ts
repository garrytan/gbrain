// ci-ubicloud-vm-names.test.ts — VM names that carry a TTL
// (ubirun-<owner>-<epoch>-<suffix>-t<hours>, gstack's scheme) next to the
// legacy expiring form (ubirun-<owner>-<epoch>-x<expiry>-<suffix>) and the
// older names, for scripts/ubicloud/ubi-runner.sh and scripts/ci-ubicloud.ts.
//
// Protects: generated names end in -t<hours> (--ttl-hours H, else
// UBI_TTL_HOURS, default 4; 0 omits it), the flag is validated and cannot be
// combined with -n, every parser (list --mine, usage, gc, down) reads all
// formats alike (gc ages a VM by its creation epoch, never its TTL), and
// `reap` (run first by every `up` unless UBI_REAP=0) destroys exactly the VMs
// of any owner whose TTL, in either form, ended over ten minutes ago.
// Fails when: a name is not owner-tagged for list --mine or usage, gc sweeps
// by the TTL or another owner's VM, reap touches an unexpired, TTL-less,
// untagged or foreign VM, or the flag is ignored.
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

async function createdName(args: string[], extra: Record<string, string> = {}): Promise<string> {
  const api = serve();
  const proc = spawnRunner(args, { UBI_OWNER: "gbra135", ...extra });
  const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
  proc.kill("SIGTERM");
  await proc.exited;
  expect(api.vms.size).toBe(0);
  mock!.stop();
  mock = null;
  return name;
}

describe("--ttl-hours and UBI_TTL_HOURS", () => {
  for (const verb of ["up", "run"] as const) {
    it(`${verb} --ttl-hours 3 names the VM with a three-hour TTL`, async () => {
      const name = await createdName(verb === "up" ? ["up", "--ttl-hours", "3"] : ["run", "--ttl-hours", "3", "--", "true"]);
      const m = /^ubirun-gbra135-(\d{10})-[0-9a-f]{8}-t3$/.exec(name);
      expect(m).not.toBeNull();
      expect(Math.abs(Number(m![1]) - NOW)).toBeLessThan(120);
      expect(`ubirun-abcdefghijkl-${NOW}-ffffffff-t999`.length).toBeLessThan(50);
    });
  }

  it("without --ttl-hours the name carries UBI_TTL_HOURS (default 4; 0 omits it)", async () => {
    expect(await createdName(["up"])).toMatch(/^ubirun-gbra135-\d{10}-[0-9a-f]{8}-t4$/);
    expect(await createdName(["up"], { UBI_TTL_HOURS: "7" })).toMatch(/^ubirun-gbra135-\d{10}-[0-9a-f]{8}-t7$/);
    expect(await createdName(["up"], { UBI_TTL_HOURS: "0" })).toMatch(/^ubirun-gbra135-\d{10}-[0-9a-f]{8}$/);
    expect(await createdName(["up", "--ttl-hours", "2"], { UBI_TTL_HOURS: "0" })).toMatch(/-t2$/);
  });

  it("refuses a bad value and the combination with -n before any create", async () => {
    const api = serve();
    for (const bad of ["0", "1.5", "abc", "1000", "08"]) {
      const r = await run(["up", "--ttl-hours", bad], { UBI_OWNER: "t1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--ttl-hours must be a whole number of hours from 1 to 999");
    }
    for (const bad of ["08", "1000", "abc"]) {
      const r = await run(["owner"], { UBI_TTL_HOURS: bad });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("UBI_TTL_HOURS must be a whole number of hours from 0 to 999");
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

describe("parsers read every format", () => {
  const seed = [
    { name: `ubirun-t1-${OLD}-x${NOW + 3600}-ci01abcd`, size: "standard-16" },
    { name: `ubirun-t1-${NOW}-x${OLD}-ci02abcd`, size: "standard-8" },
    { name: `ubirun-t1-${OLD}-aaaaaaaa`, size: "standard-4" },
    { name: `ubirun-other-${OLD}-x${OLD + 3600}-ci01ffff`, size: "standard-16" },
    { name: `ubirun-${OLD}-dddddddd`, size: "standard-2" },
    { name: "prod-db", size: "standard-2" },
    { name: `ubirun-t1-${OLD}-ci03abcd-t9`, size: "standard-2" },
    { name: `ubirun-other-${OLD}-eeeeeeee-t1`, size: "standard-8" },
  ];

  it("list --mine and usage tag every format with its owner", async () => {
    serve({ seed });
    const mine = await run(["list", "--mine"], { UBI_OWNER: "t1" });
    expect(mine.stdout.trim().split("\n").map((l) => l.split(/\s+/)[1])).toEqual([...seed.slice(0, 3), seed[6]!].map((s) => s.name));
    const usage = (await run(["usage"], { UBI_OWNER: "t1" })).stdout;
    expect(usage).toMatch(/^t1\s+4\s+30\s+\(you\)$/m);
    expect(usage).toMatch(/^other\s+2\s+24$/m);
    expect(usage).toMatch(/^\(untagged\)\s+1\s+2$/m);
    expect(usage).toMatch(/^\(other\)\s+1\s+2$/m);
  });

  it("gc ages by creation epoch: it sweeps the caller's old VMs of every format, not a young VM whose expiry passed", async () => {
    const api = serve({ seed });
    const gc = await run(["gc", "1"], { UBI_OWNER: "t1" });
    expect(gc.code).toBe(0);
    expect(api.events.filter((e) => e.startsWith("destroy ")).sort()).toEqual([seed[0]!, seed[2]!, seed[6]!].map((s) => `destroy ${s.name}`).sort());
    expect([...api.vms.keys()].sort()).toEqual([seed[1]!, seed[3]!, seed[4]!, seed[5]!, seed[7]!].map((s) => s.name).sort());
  });

  it("reap destroys every owner's VMs whose TTL (either form) ended over ten minutes ago, and nothing else (an expiry before creation is no TTL)", async () => {
    const fresh = [
      { name: `ubirun-t1-${NOW - 3600 - 300}-aaaa0001-t1`, size: "standard-2" },
      { name: `ubirun-t1-${NOW - 3600 - 900}-aaaa0002-t1`, size: "standard-2" },
      { name: `ubirun-t1-${OLD}-x${NOW - 300}-aaaa0003`, size: "standard-2" },
      { name: `ubirun-t1-${OLD}-aaaa0004-t0`, size: "standard-2" },
      { name: `ubirun-t1-${OLD}-aaaa0005-t01`, size: "standard-2" },
    ];
    const api = serve({ seed: [...seed, ...fresh] });
    const reap = await run(["reap"], { UBI_OWNER: "t1" });
    expect(reap.code).toBe(0);
    const reaped = [seed[3]!, seed[7]!, fresh[1]!].map((s) => s.name);
    expect(api.events.filter((e) => e.startsWith("destroy ")).sort()).toEqual(reaped.map((n) => `destroy ${n}`).sort());
    expect(reap.stderr).toMatch(new RegExp(`reaping expired eu-central-h1/${seed[7]!.name} \\(owner other; its TTL ended \\d+ min ago\\)`));
    expect([...api.vms.keys()].sort()).toEqual([...seed, ...fresh].map((s) => s.name).filter((n) => !reaped.includes(n)).sort());
    expect((await run(["reap"], { UBI_OWNER: "t1" })).stderr).toContain("reap: no expired VMs");
  });

  it("up reaps first; UBI_REAP=0 skips it", async () => {
    const expired = `ubirun-other-${OLD}-eeeeeeee-t1`;
    for (const [extra, reaps] of [[{ UBI_REAP: "0" }, false], [{}, true]] as const) {
      const api = serve({ seed: [{ name: expired }] });
      const proc = spawnRunner(["up"], { UBI_OWNER: "t1", ...extra });
      const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
      proc.kill("SIGTERM");
      await proc.exited;
      const destroys = api.events.filter((e) => e.startsWith("destroy "));
      expect(destroys).toEqual(reaps ? [`destroy ${expired}`, `destroy ${name}`] : [`destroy ${name}`]);
      mock!.stop();
      mock = null;
    }
  });

  it("down destroys a new-format name", async () => {
    const api = serve({ seed });
    const down = await run(["down", seed[3]!.name], { UBI_OWNER: "t1" });
    expect(down.code).toBe(0);
    expect(api.events).toEqual([`destroy ${seed[3]!.name}`, `removed ${seed[3]!.name}`]);
  });
});
