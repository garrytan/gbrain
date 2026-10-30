// ci-ubicloud-teardown.slow.test.ts — SIGTERM or SIGHUP (a dropped terminal,
// a cancelled background operation) to scripts/ci-ubicloud.ts while
// its VMs are still provisioning (one created, two creates in flight) against
// a mock Ubicloud API. Every name is recorded before its create, and teardown
// returns only after each VM that came to exist is destroyed and gone. Every
// gate VM name carries its expiry, two hours after creation by default
// (scripts/ubicloud/reap-expired.ts reaps a VM teardown never reached).
//
// The orchestrator packs its whole checkout (.git and untracked files
// included) before it provisions anything, so it runs from a fixture repo
// holding only scripts/ and docker-compose.ci.yml. Run from the real
// checkout, the time to the first create grew with the operator's checkout:
// a 4.6 GB one never reached it within 120 s.

import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeGitFixture } from "../helpers/git-fixture.ts";
import { startMockUbicloud, waitForEvent, type MockUbicloud } from "../helpers/mock-ubicloud-api.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
let dir = "";
let mock: MockUbicloud | null = null;
let proc: ReturnType<typeof Bun.spawn> | null = null;

afterEach(() => {
  proc?.kill("SIGKILL");
  proc = null;
  mock?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("ci:ubicloud teardown", () => {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) it(`${signal} mid-provision destroys every VM it asked for, including creates still in flight`, async () => {
    dir = mkdtempSync(join(tmpdir(), "ci-ubicloud-teardown-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    await makeGitFixture(repo);
    cpSync(join(ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
    cpSync(join(ROOT, "docker-compose.ci.yml"), join(repo, "docker-compose.ci.yml"));
    const api = (mock = startMockUbicloud({ createDelayMs: (name) => (/-ci01/.test(name) ? 0 : 4000) }));
    const child = (proc = Bun.spawn(["bun", "run", "scripts/ci-ubicloud.ts", "--vms", "3", "--lanes", "gitleaks"], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        UBICLOUD_API_KEY: "test-token",
        UBICLOUD_API_URL: api.url,
        UBI_RUNNER_STATE: join(dir, "state"),
        UBI_OWNER: "probe",
        UBI_POLL_SECONDS: "0.2",
      },
      stdout: "pipe",
      stderr: "pipe",
    }));
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    // An orchestrator that exits before provisioning fails here with its output, not after a blind timeout.
    const exitedEarly = child.exited.then(async (code) => {
      throw new Error(`ci-ubicloud exited ${code} before the probe signal\n${await stdout}\n${await stderr}`);
    });
    await Promise.race([waitForEvent(api, /^created \S+-ci01/, 120_000), exitedEarly]);
    // ci02 and ci03 are spawned together but their creates reach the API in either order, so wait for both.
    for (const vm of [/^create-start \S+-ci02/, /^create-start \S+-ci03/]) await Promise.race([waitForEvent(api, vm, 10_000), exitedEarly]);
    exitedEarly.catch(() => {});
    expect(api.events.some((e) => /^created \S+-ci0[23]/.test(e))).toBe(false);
    child.kill(signal);
    expect(await child.exited).toBe(130);
    const out = await stdout;
    const runDir = /logs in (\S+)/.exec(out)?.[1] ?? "";
    expect(runDir.startsWith(repo)).toBe(true);

    const requested = readFileSync(join(runDir, "vms.txt"), "utf8").trim().split("\n").map((l) => l.split(" ")[0]!);
    expect(requested).toHaveLength(3);
    for (const name of requested) {
      const tagged = /^ubirun-probe-(\d{10})-x(\d{10})-ci0[123][0-9a-f]{4}$/.exec(name);
      expect(tagged).not.toBeNull();
      expect(Number(tagged![2]) - Number(tagged![1])).toBe(2 * 3600);
      expect(api.events).toContain(`created ${name}`);
      expect(api.events).toContain(`removed ${name}`);
    }
    expect(api.vms.size).toBe(0);
    expect(out).toContain("teardown confirmed 3 VM(s) gone");
    expect(await stderr).not.toContain("WARNING");
  }, 180_000);
});

// A SIGTERM while batches run (a cancelled gate) kills those batches. They
// are the teardown's doing, so the run reports an interrupt: no VM is
// retired for "infrastructure errors" and nothing claims every VM failed.
// scripts/ubicloud/ubi-runner.sh is replaced in the fixture by a stub whose
// batches block until killed.
const STUB_RUNNER = [
  "#!/usr/bin/env bash",
  "sub=$1; shift",
  "case \"$sub\" in",
  "  owner) echo probe;;",
  "  pack) tar -C \"$1\" -cf - scripts 2>/dev/null;;",
  "  unpack) cat >/dev/null;;",
  "  down) sleep 2;;",
  "  ssh) name=$1; shift; case \"$*\" in *ci-item.sh*) echo \"$name\" >> \"$UBI_RUNNER_STATE/batches\"; exec sleep 60;; *\"bash -s\"*) cat >/dev/null;; esac;;",
  "esac",
  "exit 0",
].join("\n");

describe("ci:ubicloud interrupt", () => {
  it("SIGTERM while batches run reports an interrupt, not VM infrastructure errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "ci-ubicloud-interrupt-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    await makeGitFixture(repo);
    cpSync(join(ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
    cpSync(join(ROOT, "docker-compose.ci.yml"), join(repo, "docker-compose.ci.yml"));
    writeFileSync(join(repo, "scripts/ubicloud/ubi-runner.sh"), STUB_RUNNER, { mode: 0o755 });
    mkdirSync(join(repo, "test"));
    for (let i = 0; i < 12; i++) writeFileSync(join(repo, "test", `t${i}.test.ts`), "import { test } from 'bun:test';\ntest('x', () => {});\n");
    const state = join(dir, "state");
    mkdirSync(state);
    const child = (proc = Bun.spawn(["bun", "run", "scripts/ci-ubicloud.ts", "--vms", "1", "--lanes", "unit"], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, UBICLOUD_API_KEY: "test-token", UBI_RUNNER_STATE: state, UBI_OWNER: "probe" },
      stdout: "pipe",
      stderr: "pipe",
    }));
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    for (let i = 0; i < 300 && !existsSync(join(state, "batches")); i++) await Bun.sleep(100);
    expect(existsSync(join(state, "batches"))).toBe(true);
    await Bun.sleep(500);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(130);
    const out = await stdout;
    const err = await stderr;
    expect(out).toContain("SIGTERM: tearing down");
    expect(out).not.toContain("infrastructure errors");
    expect(err).not.toContain("every VM failed");
    expect(err).toMatch(/interrupted: \d+ item\(s\) did not run/);
  }, 120_000);
});
