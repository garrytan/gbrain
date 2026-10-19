// ubicloud-reap-expired.test.ts — scripts/ubicloud/reap-expired.ts, the
// operator-side leak guard for ci:ubicloud VMs.
//
// Protects: only VMs in the expiring name format
// (ubirun-<owner>-<epoch>-x<expiry>-<suffix>) whose expiry plus the grace has
// passed are ever selected; legacy untagged names, owner-tagged names without
// an expiry and names ubi-runner did not make are never selected, whoever
// owns them. Dry run is the default and destroys nothing; --apply destroys
// through ubi-runner.sh down; more expired VMs than --max refuse the whole run.
// Fails when: a selection rule loosens, the dry run sends a destroy, the plan
// or owner notice stops naming owner, age, expiry and action, or the gate's
// name helper makes a name the reaper cannot read back.
// Network: none. The end-to-end cases use the in-process mock Ubicloud API.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expiringVmName, ownerNotices, parseVmName, planReap, renderPlan } from "../../scripts/ubicloud/reap-expired.ts";
import { startMockUbicloud, type MockUbicloud } from "../helpers/mock-ubicloud-api.ts";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts/ubicloud/reap-expired.ts");
const NOW = 1_792_000_000;
const H = 3600;
const LOC = "eu-central-h1";

const expired = `ubirun-gbra135-${NOW - 5 * H}-x${NOW - 3 * H}-ci01a1b2`;
const inGrace = `ubirun-gbra130-${NOW - 3 * H}-x${NOW - 5 * 60}-ci02c3d4`;
const live = `ubirun-gbra130-${NOW - 600}-x${NOW + 2 * H}-9f8e7d6c`;
const noExpiry = `ubirun-gbra9-${NOW - 50 * H}-aaaaaaaa`;
const legacy = `ubirun-${NOW - 300 * H}-e9af21ce`;
const backwards = `ubirun-gbra7-${NOW - 2 * H}-x${NOW - 3 * H}-bbbbbbbb`;
const FIXTURE = [expired, inGrace, live, noExpiry, legacy, backwards, "prod-db", `ubirun-x${NOW - 9 * H}-x${NOW - 8 * H}`].map((name) => ({ location: LOC, name }));

describe("parseVmName", () => {
  it("reads the expiring format, owner-tagged names without expiry, legacy names and foreign names", () => {
    expect(parseVmName(expired)).toEqual({ kind: "expiring", owner: "gbra135", createdAt: NOW - 5 * H, expiresAt: NOW - 3 * H });
    expect(parseVmName(noExpiry)).toEqual({ kind: "no-expiry", owner: "gbra9", createdAt: NOW - 50 * H });
    expect(parseVmName(legacy)).toEqual({ kind: "legacy", createdAt: NOW - 300 * H });
    expect(parseVmName("prod-db")).toEqual({ kind: "foreign" });
    expect(parseVmName(`ubirun-x${NOW - 9 * H}-x${NOW - 8 * H}`)).toEqual({ kind: "foreign" });
    expect(parseVmName(`${expired}-extra!`)).toEqual({ kind: "foreign" });
  });

  it("the gate's name helper writes names of at most 63 characters that read back with their expiry", () => {
    const name = expiringVmName({ owner: "abcdefghijkl", createdAt: NOW, ttlHours: 2, suffix: "ci10ffff" });
    expect(name).toBe(`ubirun-abcdefghijkl-${NOW}-x${NOW + 2 * H}-ci10ffff`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(parseVmName(name)).toEqual({ kind: "expiring", owner: "abcdefghijkl", createdAt: NOW, expiresAt: NOW + 2 * H });
    expect(expiringVmName({ owner: "t1", createdAt: NOW, ttlHours: 0, suffix: "ci01abcd" })).toBe(`ubirun-t1-${NOW}-ci01abcd`);
    expect(() => expiringVmName({ owner: "t1", createdAt: NOW, ttlHours: 1.5, suffix: "ci01abcd" })).toThrow();
    expect(() => expiringVmName({ owner: "T-1", createdAt: NOW, ttlHours: 1, suffix: "ci01abcd" })).toThrow();
  });
});

describe("planReap", () => {
  it("selects only expiring names past expiry plus grace, and never legacy, untagged-expiry or foreign names", () => {
    const plan = planReap(FIXTURE, { now: NOW, graceSeconds: 15 * 60 });
    const action = Object.fromEntries(plan.map((row) => [row.name, row.action]));
    expect(action).toEqual({
      [expired]: "destroy",
      [inGrace]: "keep",
      [live]: "keep",
      [noExpiry]: "skip",
      [legacy]: "skip",
      [backwards]: "skip",
      "prod-db": "skip",
      [`ubirun-x${NOW - 9 * H}-x${NOW - 8 * H}`]: "skip",
    });
    expect(plan.find((row) => row.name === backwards)?.reason).toContain("expiry before creation");
    expect(plan.filter((row) => row.action === "destroy").map((row) => row.name)).toEqual([expired]);
    expect(planReap(FIXTURE, { now: NOW, graceSeconds: 0 }).filter((row) => row.action === "destroy").map((row) => row.name).sort()).toEqual([expired, inGrace].sort());
  });

  it("the plan names owner, age, expiry and action per VM; the notice groups expired VMs by owner with the thread code", () => {
    const plan = planReap(FIXTURE, { now: NOW, graceSeconds: 15 * 60 });
    const text = renderPlan(plan, { now: NOW, apply: false, graceSeconds: 15 * 60 });
    expect(text).toContain("dry run");
    expect(text).toMatch(new RegExp(`gbra135\\s+would destroy\\s+5h00m\\s+expired 3h00m ago\\s+${LOC}/${expired}`));
    expect(text).toMatch(new RegExp(`gbra130\\s+keep\\s+0h10m\\s+expires in 2h00m\\s+${LOC}/${live}`));
    expect(text).toMatch(new RegExp(`gbra9\\s+skip: no expiry\\s+50h00m\\s+-\\s+${LOC}/${noExpiry}`));
    expect(text).toMatch(new RegExp(`\\(untagged\\)\\s+skip: legacy name\\s+300h00m`));
    expect(text).toContain("2 VM(s) not named by ubi-runner: skipped");
    expect(text).not.toContain("prod-db");
    const notice = ownerNotices(plan, { now: NOW, apply: false });
    expect(notice).toContain("owner gbra135 (thread GBRA-135): 1 expired VM(s)");
    expect(notice).toContain(`${LOC}/${expired} expired 3h00m ago`);
    expect(notice).toContain("Dry run: nothing was destroyed");
    expect(notice).not.toContain("gbra130");
    expect(ownerNotices(planReap([{ location: LOC, name: live }], { now: NOW, graceSeconds: 0 }), { now: NOW, apply: false })).toContain("no expired VMs");
  });
});

describe("reap-expired CLI against the mock Ubicloud API", () => {
  let mock: MockUbicloud | null = null;
  let dir = "";
  afterEach(() => {
    mock?.stop();
    mock = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function cli(args: string[]) {
    dir ||= mkdtempSync(join(tmpdir(), "reap-expired-"));
    const proc = Bun.spawn(["bun", SCRIPT, ...args, "--now", String(NOW)], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, UBICLOUD_API_TOKEN: "test-token", UBICLOUD_API_URL: mock!.url, UBI_RUNNER_STATE: join(dir, "state"), UBI_POLL_SECONDS: "0.2" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  it("dry run by default: prints the plan and notice and sends no destroy", async () => {
    mock = startMockUbicloud({ seed: FIXTURE });
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`would destroy`);
    expect(r.stdout).toContain("=== owner notices ===");
    expect(mock.events.filter((e) => e.startsWith("destroy "))).toEqual([]);
    expect(mock.vms.size).toBe(FIXTURE.length);
  });

  it("--apply destroys only the expired VM through ubi-runner.sh down", async () => {
    mock = startMockUbicloud({ seed: FIXTURE });
    const r = await cli(["--apply"]);
    expect({ code: r.code, stderr: r.stderr.includes("FAILED") }).toEqual({ code: 0, stderr: false });
    expect(mock.events).toEqual([`destroy ${expired}`, `removed ${expired}`]);
    expect(r.stdout).toMatch(new RegExp(`gbra135\\s+destroyed\\s+5h00m`));
    expect(r.stdout).toContain("Destroyed by the operator reaper");
    expect([...mock.vms.keys()].sort()).toEqual(FIXTURE.map((v) => v.name).filter((n) => n !== expired).sort());
  });

  it("more expired VMs than --max refuses the whole run with exit 3 and destroys nothing", async () => {
    mock = startMockUbicloud({ seed: FIXTURE });
    const r = await cli(["--apply", "--grace-minutes", "0", "--max", "1"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("2 expired VMs exceed --max 1");
    expect(mock.events.filter((e) => e.startsWith("destroy "))).toEqual([]);
  });
});
