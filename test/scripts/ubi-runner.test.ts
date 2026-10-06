// ubi-runner.test.ts — scripts/ubicloud/ubi-runner.sh against a mock Ubicloud
// API: owner-tagged VM names, the stale sweep (off unless UBI_GC_HOURS is set,
// and never another owner's VMs), list --mine / usage, and teardown that waits
// out in-flight creates when `up` gets SIGTERM or SIGKILL mid-provision.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockUbicloud, waitForEvent, type MockUbicloud, type MockUbicloudOptions } from "../helpers/mock-ubicloud-api.ts";

const RUNNER = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/ubi-runner.sh");
const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 5 * 3600;

let dir = "";
let mock: MockUbicloud | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ubi-runner-test-"));
});
afterEach(() => {
  mock?.stop();
  mock = null;
  rmSync(dir, { recursive: true, force: true });
});

function serve(opts: MockUbicloudOptions = {}): MockUbicloud {
  mock = startMockUbicloud(opts);
  return mock;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    UBICLOUD_API_KEY: "test-token",
    UBICLOUD_API_URL: mock?.url ?? "http://127.0.0.1:9",
    UBI_RUNNER_STATE: join(dir, "state"),
    UBI_POLL_SECONDS: "0.2",
    ...extra,
  };
}

function spawnRunner(args: string[], extra: Record<string, string> = {}) {
  return Bun.spawn(["bash", RUNNER, ...args], { env: env(extra), stdout: "pipe", stderr: "pipe" });
}

async function run(args: string[], extra: Record<string, string> = {}) {
  const proc = spawnRunner(args, extra);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("owner tag", () => {
  it("sanitizes UBI_OWNER to at most 12 lowercase letters and digits, starting with a letter", async () => {
    expect((await run(["owner"], { UBI_OWNER: "GBRA-41 lane!" })).stdout.trim()).toBe("gbra41lane");
    expect((await run(["owner"], { UBI_OWNER: "12345" })).stdout.trim()).toBe("u12345");
    expect((await run(["owner"], { UBI_OWNER: "abcdefghijklmnopq" })).stdout.trim()).toBe("abcdefghijkl");
    expect((await run(["owner"], { UBI_OWNER: "--" })).code).toBe(1);
  });

  it("defaults to a stable per-machine id", async () => {
    const first = (await run(["owner"])).stdout.trim();
    expect(first).toMatch(/^m[0-9a-f]{8}$/);
    expect((await run(["owner"])).stdout.trim()).toBe(first);
  });
});

describe("teardown waits for in-flight creates", () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const) {
    it(`${signal} during the create request: the create finishes, then the VM is destroyed and confirmed gone`, async () => {
      const api = serve({ createDelayMs: () => 1500 });
      const proc = spawnRunner(["up"], { UBI_OWNER: "t1" });
      const started = await waitForEvent(api, /^create-start /);
      const name = started.split(" ")[1]!;
      expect(name).toMatch(/^ubirun-t1-\d{10}-[0-9a-f]{8}$/);
      proc.kill(signal);
      expect(await proc.exited).toBe(130);
      expect(api.events).toEqual([`create-start ${name}`, `created ${name}`, `destroy ${name}`, `removed ${name}`]);
      expect(api.vms.size).toBe(0);
    });
  }

  it("a second signal during teardown does not cut it short", async () => {
    const api = serve({ destroyDelayMs: 1500 });
    const proc = spawnRunner(["up"], { UBI_OWNER: "t1" });
    const name = (await waitForEvent(api, /^created /)).split(" ")[1]!;
    proc.kill("SIGTERM");
    await waitForEvent(api, /^destroy /);
    proc.kill("SIGHUP");
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
    expect(api.events.slice(-2)).toEqual([`destroy ${name}`, `removed ${name}`]);
    expect(api.vms.size).toBe(0);
  });

  it("SIGTERM while the VM is still provisioning destroys it before exiting", async () => {
    const api = serve();
    const proc = spawnRunner(["up"], { UBI_OWNER: "t1" });
    const name = (await waitForEvent(api, /^created /)).split(" ")[1]!;
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(130);
    expect(api.events.slice(-2)).toEqual([`destroy ${name}`, `removed ${name}`]);
    expect(api.vms.size).toBe(0);
  });

  // Bash 5.2 runs a pending signal trap inside the parse of the next $(...),
  // where the trap fails to parse and the shell exits 2 without running it.
  // BASH_ENV turns on xtrace with a PS4 whose first $(...) sends the runner
  // SIGTERM, so the second is always parsed with that trap pending.
  for (const args of [["up"], ["run", "--", "true"]]) {
    it(`${args[0]}: a SIGTERM that lands while bash parses a $(...) still destroys the VM and exits 130`, async () => {
      const api = serve();
      const bashEnv = join(dir, "bash-env");
      writeFileSync(bashEnv, `PS4='$([ "$BASH_SUBSHELL" = 1 ] && [ -e "$PROBE_DIR/go" ] && mkdir "$PROBE_DIR/fired" 2>/dev/null && kill -TERM $$)$(:)+ '\nset -x\n`);
      const proc = spawnRunner(args, { UBI_OWNER: "t1", BASH_ENV: bashEnv, PROBE_DIR: dir });
      const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const name = (await waitForEvent(api, /^created /)).split(" ")[1]!;
      writeFileSync(join(dir, "go"), "");
      expect(await proc.exited).toBe(130);
      await output;
      expect(existsSync(join(dir, "fired"))).toBe(true);
      expect(api.events.slice(-2)).toEqual([`destroy ${name}`, `removed ${name}`]);
      expect(api.vms.size).toBe(0);
    });
  }

  it("after SIGKILL mid-create, down waits for the create to land and destroys the VM", async () => {
    const api = serve({ createDelayMs: () => 1500 });
    const proc = spawnRunner(["up"], { UBI_OWNER: "t1" });
    const name = (await waitForEvent(api, /^create-start /)).split(" ")[1]!;
    proc.kill("SIGKILL");
    await proc.exited;
    expect(api.vms.size).toBe(0);
    const down = await run(["down", name], { UBI_CREATE_GRACE: "20" });
    expect(down.code).toBe(0);
    expect(api.events).toEqual([`create-start ${name}`, `created ${name}`, `destroy ${name}`, `removed ${name}`]);
    expect(api.vms.size).toBe(0);
  });

  it("a quota refusal reports usage by owner and needs no grace wait; down of an unknown name reports it gone", async () => {
    const api = serve({ rejectCreates: true, seed: [{ name: `ubirun-lane2-${NOW}-aaaaaaaa` }, { name: `ubirun-lane2-${NOW}-bbbbbbbb` }] });
    const t0 = Date.now();
    const up = await run(["up"], { UBI_OWNER: "t1", UBI_CREATE_GRACE: "60" });
    expect(up.code).toBe(1);
    expect(up.stderr).toMatch(/quota refused eu-central-h1\/ubirun-t1-\S+ \(standard-16\): it needs 16 vCPUs and the project already uses 252 of 256/);
    expect(up.stderr).toMatch(/^lane2\s+2\s+32$/m);
    expect(up.stderr).toContain("create failed: vCPU quota exhausted");
    expect(Date.now() - t0).toBeLessThan(15_000);
    const down = await run(["down", `ubirun-t1-${NOW}-deadbeef`, "-l", "eu-central-h1"]);
    expect(down.code).toBe(0);
    expect(down.stderr).toContain("never existed or already destroyed");
    expect(api.vms.size).toBe(2);
    expect(api.events.some((e) => e.startsWith("destroy "))).toBe(false);
  });
});

describe("stale sweep and ownership", () => {
  const seed = [
    { name: `ubirun-t1-${OLD}-aaaaaaaa`, size: "standard-16" },
    { name: `ubirun-t1-${NOW}-bbbbbbbb`, size: "standard-8" },
    { name: `ubirun-other-${OLD}-cccccccc`, size: "standard-16" },
    { name: `ubirun-${OLD}-dddddddd`, size: "standard-4" },
    { name: "prod-db", size: "standard-2" },
  ];

  it("up never sweeps when UBI_GC_HOURS is unset", async () => {
    const api = serve({ seed });
    const proc = spawnRunner(["up"], { UBI_OWNER: "t1" });
    const name = (await waitForEvent(api, /^created /)).split(" ")[1]!;
    proc.kill("SIGTERM");
    await proc.exited;
    expect(api.events.filter((e) => e.startsWith("destroy "))).toEqual([`destroy ${name}`]);
    expect(api.vms.size).toBe(seed.length);
  });

  it("with UBI_GC_HOURS set, up sweeps only the caller's own stale VMs", async () => {
    const api = serve({ seed });
    const proc = spawnRunner(["up"], { UBI_OWNER: "t1", UBI_GC_HOURS: "1" });
    const name = (await waitForEvent(api, /^created /)).split(" ")[1]!;
    proc.kill("SIGTERM");
    await proc.exited;
    expect(api.events.filter((e) => e.startsWith("destroy "))).toEqual([`destroy ubirun-t1-${OLD}-aaaaaaaa`, `destroy ${name}`]);
    expect([...api.vms.keys()].sort()).toEqual(seed.slice(1).map((s) => s.name).sort());
  });

  it("gc HOURS destroys only the caller's VMs older than HOURS and requires HOURS", async () => {
    const api = serve({ seed });
    expect((await run(["gc"], { UBI_OWNER: "t1" })).code).toBe(1);
    const gc = await run(["gc", "1"], { UBI_OWNER: "t1" });
    expect(gc.code).toBe(0);
    expect(api.events).toEqual([`destroy ubirun-t1-${OLD}-aaaaaaaa`, `removed ubirun-t1-${OLD}-aaaaaaaa`]);
  });

  it("list --mine shows only the caller's VMs; usage sums vCPUs by owner", async () => {
    serve({ seed });
    const mine = await run(["list", "--mine"], { UBI_OWNER: "t1" });
    expect(mine.stdout.trim().split("\n").map((l) => l.split(/\s+/)[1])).toEqual([`ubirun-t1-${OLD}-aaaaaaaa`, `ubirun-t1-${NOW}-bbbbbbbb`]);
    const usage = (await run(["usage"], { UBI_OWNER: "t1" })).stdout;
    expect(usage).toMatch(/^t1\s+2\s+24\s+\(you\)$/m);
    expect(usage).toMatch(/^other\s+1\s+16$/m);
    expect(usage).toMatch(/^\(untagged\)\s+1\s+4$/m);
    expect(usage).toMatch(/^\(other\)\s+1\s+2$/m);
    expect(usage).toMatch(/^total\s+5\s+46$/m);
  });
});
