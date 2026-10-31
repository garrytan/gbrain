// ubi-runner-run.test.ts — scripts/ubicloud/ubi-runner.sh's run, verify,
// reap, leftover line, watchdog and quota preflight against the in-process mock
// Ubicloud API (VMs show as running) and a fake ssh on PATH. No network, no VM.
// Ported from gstack's test/ubicloud-runner.test.ts (synced at gstack 5532345a)
// onto gbrain's mock API.
//
// Protects: up, run and verify refuse without UBI_OWNER before any API call;
// gbrain's up reaps nothing unless UBI_REAP=1 and says so in one line; reap
// destroys expired TTL VMs of any owner and only the caller's own TTL-less
// ubirun-<owner>-* VMs past UBI_LEGACY_HOURS; run ends with the UBICLOUD:
// left= line (also in UBI_LEFT_FILE), and a VM it cannot confirm gone fails a
// passing command; a silent or overlong remote command is killed with exit
// 124, its last output and its remote session ended; --pass/--env and a
// committed .gstack/ubicloud.json never forward UBICLOUD_*, and the config's
// setup and pull destinations stay inside --src; a known vCPU ceiling refuses
// before any create request.
// Fails when: any of those reaches the API or the VM when it should not, a
// leaked VM reads as left=0, or a timeout passes silently.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockUbicloud, type MockUbicloud, type MockUbicloudOptions } from "../helpers/mock-ubicloud-api.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const RUNNER = join(ROOT, "scripts/ubicloud/ubi-runner.sh");
const NOW = Math.floor(Date.now() / 1000);

let dir = "";
let mock: MockUbicloud | null = null;

// The fake ssh logs every remote command (its last argument) to ssh.log and
// plays the part the command asks for. command-mode / setup-mode files under
// the fixture root script the command and setup phases.
const FAKE_SSH = [
  "#!/usr/bin/env bash",
  "root=${UBI_FAKE_ROOT:?}",
  "cmd=${*: -1}",
  "printf '%s\\n' \"$cmd\" >> \"$root/ssh.log\"",
  "case \"$cmd\" in",
  "  -O|exit|true) exit 0 ;;",
  "  *pkill*) echo \"$cmd\" >> \"$root/cancel.log\" ;;",
  "  *captured*) cat > \"$root/captured\" ;;",
  "  *\"cat > ~/.ubirun-env\"*) cat > \"$root/ubirun-env\" ;;",
  "  *\"cat > ~/.ubirun-setup.sh\"*) cat > \"$root/ubirun-setup.sh\" ;;",
  "  *\"tar -xzf -\"*) cat > /dev/null ;;",
  "  *\"tar -czf -\"*) base=${cmd##* }; tar -czf - -C \"$root/remote-fs\" \"$base\" ;;",
  "  *\"ls -d -- \"*) g=${cmd#*ls -d -- }; g=${g%% *}; ls -d -- \"$root/remote-fs/\"$g >/dev/null 2>&1 ;;",
  "  *\"bash -l ~/.ubirun-setup.sh\"*) echo \"setup start\"; if [ -f \"$root/setup-mode\" ]; then bash -c \"$(cat \"$root/setup-mode\")\"; fi; echo \"setup done\" ;;",
  "  *\"bash -lc \"*) if [ -f \"$root/command-mode\" ]; then bash -c \"$(cat \"$root/command-mode\")\"; else echo \"ran: $cmd\"; fi ;;",
  "  *) : ;;",
  "esac",
].join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ubi-runner-run-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/ssh"), FAKE_SSH);
  chmodSync(join(dir, "bin/ssh"), 0o755);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/file.txt"), "x\n");
});
afterEach(() => {
  mock?.stop();
  mock = null;
  rmSync(dir, { recursive: true, force: true });
});

function serve(opts: MockUbicloudOptions = {}): MockUbicloud {
  mock?.stop();
  mock = startMockUbicloud({ running: true, destroyDelayMs: 50, ...opts });
  return mock;
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: dir,
    UBI_FAKE_ROOT: dir,
    UBICLOUD_API_KEY: "test-token",
    UBICLOUD_API_URL: mock?.url ?? "http://127.0.0.1:9",
    UBI_RUNNER_STATE: join(dir, "state"),
    UBI_POLL_SECONDS: "0.2",
    UBI_OWNER: "t1",
    UBI_HEARTBEAT: "0",
    ...extra,
  };
}

async function run(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn(["bash", RUNNER, ...args], { env: env(extra), stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : "");
const creates = () => (mock?.events ?? []).filter((e) => e.startsWith("create-start "));
const destroyed = () => (mock?.events ?? []).filter((e) => e.startsWith("destroy ")).map((e) => e.slice("destroy ".length)).sort();
const RUN_VM = /ubirun-t1-\d{10}-[0-9a-f]{8}-t3/.source;

// A VM this machine already created (state dir with its env), for ssh NAME COMMAND.
function knownVm(name = "vm-a") {
  mkdirSync(join(dir, "state", name), { recursive: true });
  writeFileSync(join(dir, "state", name, "env"), `NAME=${name}\nLOCATION=eu-central-h1\nSIZE=standard-16\nIP=192.0.2.1\nCREATED=yes\nCREATE_AT=0\nCREATE_PID=1\n`);
  writeFileSync(join(dir, "state", name, "key"), "");
}

function repo(cfg: unknown): string {
  const src = join(dir, "repo");
  mkdirSync(join(src, ".gstack"), { recursive: true });
  mkdirSync(join(src, "scripts"), { recursive: true });
  writeFileSync(join(src, "scripts/boot.sh"), "echo boot\n");
  writeFileSync(join(src, ".gstack/ubicloud.json"), JSON.stringify(cfg));
  return src;
}

describe("owner and reap", () => {
  it("up, run and verify refuse without UBI_OWNER before any API call; list, usage, reap and down still work without it", async () => {
    const api = serve({ seed: [{ name: "vm-a" }] });
    const src = repo({ command: "make verify" });
    for (const args of [["up"], ["run", "--", "true"], ["verify", "--src", src]]) {
      const r = await run(args, { UBI_OWNER: "" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("UBI_OWNER is not set: every VM must carry its owner; export UBI_OWNER=<your thread or session code>");
      expect(r.stderr).toContain("(UBI_OWNER_REQUIRED)");
    }
    expect(api.events).toEqual([]);
    for (const args of [["list"], ["usage"], ["reap"]]) expect((await run(args, { UBI_OWNER: "" })).code).toBe(0);
    expect((await run(["down", "vm-a"], { UBI_OWNER: "" })).code).toBe(0);
  }, 60_000);

  // GBRA-108: gbrain still holds TTL-less VMs older than gstack's 4 h legacy
  // bound, so gbrain's up reaps nothing until UBI_REAP=1, and says so.
  it("gbrain's up reaps nothing by default and says so in one line; UBI_REAP=1 reaps expired TTL VMs of any owner first", async () => {
    const seed = [{ name: "ubirun-other-1000000000-bbbb-t1" }, { name: "ubirun-t1-1000000000-aaaa" }, { name: `ubirun-peer-${NOW}-cccc-t3` }];
    serve({ rejectCreates: true, seed });
    const def = await run(["up"]);
    expect(def.code).toBe(1);
    expect(def.stderr.match(/reap skipped: gbrain defaults UBI_REAP=0 until its TTL-less VMs older than 4h are gone \(UBI_REAP=1 reaps; reap-expired\.ts still destroys expired TTL VMs\)/g)).toHaveLength(1);
    expect(def.stderr).not.toContain("reaping");
    expect(destroyed()).toEqual([]);
    const off = await run(["up"], { UBI_REAP: "0" });
    expect(off.stderr).not.toContain("reap skipped");
    expect(destroyed()).toEqual([]);
    expect(creates()).toHaveLength(2);
    const on = await run(["up"], { UBI_REAP: "1" });
    expect(on.code).toBe(1);
    expect(on.stderr).toMatch(/reaping expired eu-central-h1\/ubirun-other-1000000000-bbbb-t1 \(owner other; its TTL ended \d+ min ago\)/);
    expect(on.stderr).toMatch(/reaping TTL-less eu-central-h1\/ubirun-t1-1000000000-aaaa \(owner t1; \d+h old, legacy sweep at 4h\)/);
    expect(on.stderr).not.toContain("reap skipped");
    expect(destroyed()).toEqual(["ubirun-other-1000000000-bbbb-t1", "ubirun-t1-1000000000-aaaa"]);
  }, 60_000);

  it("reap destroys expired TTLs (and older -x expiries) and this owner's old TTL-less names, never unexpired, recent, another owner's TTL-less, untagged or foreign ones", async () => {
    const seed = [
      "ubirun-other-1000000000-bbbb-t1",
      "ubirun-t1-9999999999-dddd-t1",
      "ubirun-t1-1000000000-aaaa",
      "ubirun-1000000000-cccc",
      `ubirun-t1-${NOW - 3 * 3600}-eeee`,
      "ubirun-gbra240-1000000000-gggg",
      "team-db-1000000000-ffff",
      `ubirun-other-${NOW - 5 * 3600}-x${NOW - 3 * 3600}-hhhh`,
    ].map((name) => ({ name }));
    const api = serve({ seed });
    const reap = await run(["reap"]);
    expect(reap.code).toBe(0);
    expect(destroyed()).toEqual(["ubirun-other-1000000000-bbbb-t1", "ubirun-t1-1000000000-aaaa", seed[7]!.name].sort());
    expect((await run(["reap"])).stderr).toContain("reap: no expired VMs");
    const lowered = await run(["reap"], { UBI_LEGACY_HOURS: "2" });
    expect(lowered.code).toBe(0);
    expect(lowered.stderr).toMatch(/reaping TTL-less eu-central-h1\/ubirun-t1-\d{10}-eeee \(owner t1; 3h old, legacy sweep at 2h\)/);
    const ownerless = await run(["reap"], { UBI_OWNER: "", UBI_LEGACY_HOURS: "1" });
    expect(ownerless.code).toBe(0);
    expect(ownerless.stderr).not.toContain("reaping TTL-less");
    expect([...api.vms.keys()].sort()).toEqual(["team-db-1000000000-ffff", "ubirun-1000000000-cccc", "ubirun-gbra240-1000000000-gggg", "ubirun-t1-9999999999-dddd-t1"]);
  }, 60_000);

  it("reap reports a failed list and a failed destroy; bad UBI_TTL_HOURS refuses creates and bad UBI_LEGACY_HOURS refuses reap, never read-only commands", async () => {
    const api = serve({ seed: [{ name: "ubirun-other-1000000000-bbbb-t1" }] });
    api.faults.destroy = true;
    const destroyFails = await run(["reap"]);
    expect(destroyFails.code).toBe(1);
    expect(destroyFails.stderr).toContain("failed to reap eu-central-h1/ubirun-other-1000000000-bbbb-t1");
    expect(destroyFails.stderr).toContain("reap: 1 of 1 expired VMs could not be destroyed");
    api.faults.list = true;
    const listFails = await run(["reap"]);
    expect(listFails.code).toBe(1);
    expect(listFails.stderr).toContain("reap: could not list the project's VMs; nothing destroyed");
    for (const ttl of ["0", "08", "1000", "abc"]) {
      const r = await run(["up"], { UBI_TTL_HOURS: ttl });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("UBI_TTL_HOURS must be a whole number of hours from 1 to 999");
    }
    expect((await run(["owner"], { UBI_TTL_HOURS: "0", UBI_LEGACY_HOURS: "0" })).code).toBe(0);
    for (const legacy of ["0", "04", "x"]) {
      const r = await run(["reap"], { UBI_LEGACY_HOURS: legacy });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("UBI_LEGACY_HOURS must be a whole number of hours from 1 to 9999");
    }
    expect(creates()).toEqual([]);
  }, 60_000);
});

describe("run leftover line", () => {
  it("ends with UBICLOUD: left=0 for its own VM, also in UBI_LEFT_FILE; a same-owner sibling is information only; --keep reports left=1 kept=1", async () => {
    const api = serve({ seed: [{ name: "ubirun-t1-9999999999-sib1-t3" }] });
    const leftFile = join(dir, "left");
    const r = await run(["run", "--src", join(dir, "src"), "--", "true"], { UBI_LEFT_FILE: leftFile });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`UBICLOUD: left=0 owner=t1 vm=${RUN_VM} others=1\\n`));
    expect(read("left")).toMatch(new RegExp(`^UBICLOUD: left=0 owner=t1 vm=${RUN_VM} others=1\\n$`));
    // scripts/pregate-remote-gate.sh parses the file with this expression.
    const parser = readFileSync(join(ROOT, "scripts/pregate-remote-gate.sh"), "utf8").match(/left=\$\(sed -n '([^']+)'/)![1]!;
    expect(Bun.spawnSync(["sed", "-n", parser, leftFile], { timeout: 30_000 }).stdout.toString()).toBe("0\n");
    expect([...api.vms.keys()]).toEqual(["ubirun-t1-9999999999-sib1-t3"]);
    const kept = await run(["run", "--src", join(dir, "src"), "--keep", "--", "true"]);
    expect(kept.code).toBe(0);
    expect(kept.stderr).toMatch(new RegExp(`UBICLOUD: left=1 owner=t1 vm=${RUN_VM} kept=1\\n`));
    expect(kept.stderr).not.toContain("left=0");
    expect(api.vms.size).toBe(2);
  }, 60_000);

  it("a passing command whose teardown fails exits 1 with left=1 and the down command; a failing one keeps its status; an unreadable list is left=unknown", async () => {
    const api = serve();
    api.faults.destroy = true;
    const leaked = await run(["run", "--src", join(dir, "src"), "--", "true"], { UBI_DOWN_TIMEOUT: "3" });
    expect(leaked.code).toBe(1);
    expect(leaked.stderr).toMatch(new RegExp(`UBICLOUD: left=1 owner=t1 vm=(${RUN_VM}) others=0\\n[^]*VM cleanup not confirmed for \\1 \\(left=1\\); destroy it with: \\S+ down \\1`));
    writeFileSync(join(dir, "command-mode"), "exit 7");
    const failedLeak = await run(["run", "--src", join(dir, "src"), "--", "false"], { UBI_DOWN_TIMEOUT: "3" });
    expect(failedLeak.code).toBe(7);
    expect(failedLeak.stderr).toMatch(new RegExp(`UBICLOUD: left=1 owner=t1 vm=${RUN_VM} others=1\\n`));
    api.faults.destroy = false;
    rmSync(join(dir, "command-mode"));
    api.faults.list = true;
    const blind = await run(["run", "--src", join(dir, "src"), "--", "true"]);
    expect(blind.code).toBe(1);
    expect(blind.stderr).toMatch(new RegExp(`UBICLOUD: left=unknown owner=t1 vm=${RUN_VM} others=unknown\\n`));
  }, 90_000);
});

describe("watchdog", () => {
  it("kills a silent ssh command with exit 124, its last output and its remote session; the heartbeat reports progress", async () => {
    knownVm();
    writeFileSync(join(dir, "command-mode"), 'echo "line one"; echo "warn one" >&2; sleep 20');
    const hung = await run(["ssh", "vm-a", "make test"], { UBI_IDLE_TIMEOUT: "2" });
    expect(hung.code).toBe(124);
    expect(hung.stdout).toBe("line one\n");
    expect(hung.stderr).toContain("warn one");
    expect(hung.stderr).toMatch(/watchdog: ssh printed nothing for \d+s \(UBI_IDLE_TIMEOUT=2\); killing it\. Last output:/);
    expect(hung.stderr.lastIndexOf("line one")).toBeGreaterThan(hung.stderr.indexOf("Last output:"));
    expect(read("cancel.log")).toMatch(/sid=\$\(cat ~\/\.ubirun-ssh-\d+\.sid .*pkill -TERM -s/);
    expect(read("ssh.log")).toMatch(/setsid -w bash -c 'printf %s \$\$ >~\/\.ubirun-ssh-\d+\.sid; bash -lc make\\ test'/);
    const kept = readdirSync(join(dir, "state/vm-a")).filter((f) => f.endsWith(".log"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^ssh-\d+\.log$/);
    expect(read(`state/vm-a/${kept[0]}`)).toContain("line one");

    writeFileSync(join(dir, "command-mode"), 'for i in 1 2 3 4 5 6; do echo "tick $i"; sleep 0.5; done');
    const beating = await run(["ssh", "vm-a", "true"], { UBI_IDLE_TIMEOUT: "0", UBI_HEARTBEAT: "1" });
    expect(beating.code).toBe(0);
    expect(beating.stdout).toContain("tick 6");
    expect(beating.stderr).toMatch(/heartbeat: ssh \d+s elapsed, last output \d+s ago/);
    expect(readdirSync(join(dir, "state/vm-a")).filter((f) => f.endsWith(".log"))).toEqual(kept);
  }, 60_000);

  it("times each command on its own clock: a silent command dies while another on the same VM keeps printing", async () => {
    knownVm();
    // The chatty command prints until the test says the silent one has returned, so the order is fixed, not raced on timing.
    writeFileSync(join(dir, "command-mode"), 'if [ -f "$UBI_FAKE_ROOT/chatty" ]; then rm -f "$UBI_FAKE_ROOT/chatty"; i=0; while [ ! -f "$UBI_FAKE_ROOT/silent-done" ] && [ $i -lt 100 ]; do i=$((i + 1)); echo "chat $i"; sleep 0.5; done; echo "chat end"; else sleep 12; fi');
    writeFileSync(join(dir, "chatty"), "");
    let chattyDone = false;
    const chatty = run(["ssh", "vm-a", "chatty"], { UBI_IDLE_TIMEOUT: "3" }).then((r) => ((chattyDone = true), r));
    while (existsSync(join(dir, "chatty"))) await Bun.sleep(50);
    const silent = await run(["ssh", "vm-a", "silent"], { UBI_IDLE_TIMEOUT: "3" });
    expect(silent.code).toBe(124);
    expect(chattyDone).toBe(false);
    writeFileSync(join(dir, "silent-done"), "");
    const c = await chatty;
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("chat end");
  }, 60_000);

  it("ssh NAME COMMAND hands the caller's stdin to the remote command", async () => {
    knownVm();
    const r = await run(["ssh", "vm-a", "cat > captured"], {}, "payload line\n");
    expect(r.code).toBe(0);
    expect(read("captured")).toBe("payload line\n");
  }, 30_000);
});

describe("run", () => {
  it("a hung setup is killed by the watchdog with exit 124, never reaches the command, and the VM is destroyed", async () => {
    const api = serve();
    writeFileSync(join(dir, "setup-mode"), "sleep 20");
    writeFileSync(join(dir, "setup.sh"), "echo hi\n");
    const r = await run(["run", "--src", join(dir, "src"), "--setup", join(dir, "setup.sh"), "--", "make test"], { UBI_IDLE_TIMEOUT: "2" });
    expect(r.code).toBe(124);
    expect(r.stderr).toMatch(/watchdog: setup printed nothing for \d+s \(UBI_IDLE_TIMEOUT=2\)/);
    expect(r.stderr).toContain("setup failed (exit 124)");
    expect(read("ssh.log")).not.toContain("bash -lc");
    expect(read("cancel.log")).toMatch(/cat ~\/\.ubirun-setup-\d+\.sid/);
    expect(r.stderr).toMatch(new RegExp(`destroyed eu-central-h1/${RUN_VM}`));
    expect(api.vms.size).toBe(0);
  }, 60_000);

  it("UBI_RUN_TIMEOUT kills a command that keeps printing, with exit 124 and its reason", async () => {
    const api = serve();
    writeFileSync(join(dir, "command-mode"), 'for i in $(seq 1 20); do echo "tick $i"; sleep 0.5; done');
    const r = await run(["run", "--src", join(dir, "src"), "--", "make test"], { UBI_RUN_TIMEOUT: "2" });
    expect(r.code).toBe(124);
    expect(r.stderr).toMatch(/watchdog: command ran \d+s \(UBI_RUN_TIMEOUT=2\); killing it/);
    expect(r.stderr).toContain("command exited 124 after");
    expect(api.vms.size).toBe(0);
  }, 60_000);

  it("--pass and --env forward named variables only; UBICLOUD_* and non-names are refused before any API call", async () => {
    serve();
    const ok = await run(["run", "--src", join(dir, "src"), "--pass", "UBI_TEST_TOKEN", "--env", "CI=1", "--", "make test"], { UBI_TEST_TOKEN: "sekret value" });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("command exited 0 after");
    const envFile = read("ubirun-env");
    expect(envFile).toContain("export UBI_TEST_TOKEN=sekret\\ value");
    expect(envFile).toContain("export CI=1");
    expect(envFile).not.toContain("UBICLOUD");
    expect(ok.stdout + ok.stderr).not.toContain("sekret");
    const before = creates().length;
    for (const [flag, value, why] of [
      ["--pass", "UBICLOUD_API_KEY", /never forwards its own Ubicloud credentials/],
      ["--pass", "UBICLOUD_API_TOKEN", /never forwards its own Ubicloud credentials/],
      ["--env", "UBICLOUD_API_KEY=x", /never forwards its own Ubicloud credentials/],
      ["--pass", "X;Y", /not a variable name/],
      ["--env", "A B=1", /not a variable name/],
      ["--env", "NOVALUE", /give NAME=VALUE/],
    ] as const) {
      const r = await run(["run", "--src", join(dir, "src"), flag, value, "--", "true"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(why);
    }
    expect(creates().length).toBe(before);
  }, 90_000);

  it("up and run accept only the storage sizes Ubicloud offers, before any API call; UBI_ALLOWED_STORAGE widens the list", async () => {
    serve();
    for (const args of [["up", "-S", "100"], ["run", "--storage", "1000", "--", "true"], ["up", "-S", ""]]) {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("(allowed: 320 640; set UBI_ALLOWED_STORAGE when Ubicloud adds sizes)");
    }
    for (const [size, extra] of [["320", {}], ["1280", { UBI_ALLOWED_STORAGE: "320 640 1280" }]] as const) {
      expect((await run(["run", "-S", size, "--bogus"], extra)).stderr).toContain("run: unknown option --bogus");
    }
    expect(creates()).toEqual([]);
  }, 60_000);

  it("up records the VM in the scratch file before its create request and down forgets it", async () => {
    serve();
    const up = await run(["up"]);
    expect(up.code).toBe(0);
    const name = up.stdout.trim();
    expect(read("state/vms.tsv")).toMatch(new RegExp(`^${name}\\teu-central-h1\\tt1\\t\\S+\\t\\d+\\n$`));
    expect((await run(["records"])).stdout).toContain(name);
    expect((await run(["down", name])).code).toBe(0);
    expect(read("state/vms.tsv")).toBe("");
  }, 60_000);
});

describe("verify", () => {
  it("runs only a committed .gstack/ubicloud.json, with its setup resolved against --src, refusing before any API call", async () => {
    serve();
    const src = join(dir, "repo");
    mkdirSync(join(src, ".gstack"), { recursive: true });
    const missing = await run(["verify", "--src", src]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`verify: no ${src}/.gstack/ubicloud.json; commit one`);
    writeFileSync(join(src, ".gstack/ubicloud.json"), JSON.stringify({ setup: "scripts/boot.sh" }));
    expect((await run(["verify", "--src", src])).stderr).toContain("names no command and none was given after --");
    writeFileSync(join(src, ".gstack/ubicloud.json"), JSON.stringify({ setup: "scripts/boot.sh", command: "make verify" }));
    expect((await run(["verify", "--src", src])).stderr).toContain(`setup script not found: ${src}/scripts/boot.sh`);
    writeFileSync(join(src, ".gstack/ubicloud.json"), "{");
    expect((await run(["verify", "--src", src])).stderr).toContain("is not valid JSON");
    expect(creates()).toEqual([]);
  }, 60_000);

  it("forwards a configured pass name only when the command line grants it, and never UBICLOUD_*", async () => {
    serve();
    const src = repo({ setup: "scripts/boot.sh", command: "make verify", pass: ["UBI_TEST_TOKEN"] });
    const refused = await run(["verify", "--src", src], { UBI_TEST_TOKEN: "x" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("asks to forward local UBI_TEST_TOKEN; grant each on this command line with --pass NAME, or every name it lists with --trust-config");
    expect(creates()).toEqual([]);
    const granted = await run(["verify", "--src", src, "--pass", "UBI_TEST_TOKEN"], { UBI_TEST_TOKEN: "granted value" });
    expect(granted.code).toBe(0);
    expect(read("ubirun-env")).toContain("export UBI_TEST_TOKEN=granted\\ value");
    expect(read("ubirun-setup.sh")).toBe("echo boot\n");
    expect(read("ssh.log")).toContain("bash -lc make\\ verify");
    const trusted = await run(["verify", "--src", src, "--trust-config"], { UBI_TEST_TOKEN: "trusted value" });
    expect(trusted.code).toBe(0);
    expect(read("ubirun-env")).toContain("export UBI_TEST_TOKEN=trusted\\ value");
    writeFileSync(join(src, ".gstack/ubicloud.json"), JSON.stringify({ command: "make verify", pass: ["UBICLOUD_API_KEY"] }));
    const n = creates().length;
    const key = await run(["verify", "--src", src, "--trust-config"]);
    expect(key.code).toBe(1);
    expect(key.stderr).toContain("never forwards its own Ubicloud credentials");
    expect(creates().length).toBe(n);
  }, 90_000);

  it("keeps the setup script and pull destinations inside --src: absolute, ~ and .. paths are refused before any API call", async () => {
    serve();
    const src = repo({});
    writeFileSync(join(dir, "outside.sh"), "echo outside\n");
    const cases: Array<[unknown, RegExp]> = [
      [{ setup: join(dir, "outside.sh"), command: "x" }, /setup '[^']*outside\.sh' must be a relative path inside the checkout/],
      [{ setup: "../outside.sh", command: "x" }, /must be a relative path inside the checkout/],
      [{ setup: "scripts/../../outside.sh", command: "x" }, /must be a relative path inside the checkout/],
      [{ setup: "~/outside.sh", command: "x" }, /must be a relative path inside the checkout/],
      [{ command: "x", pull: ["logs:/etc/cron.d"] }, /pull destination '\/etc\/cron\.d' must be a relative path inside the checkout/],
      [{ command: "x", pull: ["logs:../stolen"] }, /pull destination '\.\.\/stolen' must be a relative path inside the checkout/],
      [{ command: "x", pull: ["no-colon"] }, /pull entry 'no-colon' must be REMOTE_GLOB:LOCAL_DIR/],
    ];
    for (const [cfg, want] of cases) {
      writeFileSync(join(src, ".gstack/ubicloud.json"), JSON.stringify(cfg));
      const r = await run(["verify", "--src", src]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(want);
    }
    expect(creates()).toEqual([]);
  }, 90_000);

  it("rechecks every pull destination at pull time: a symlink an earlier pull planted cannot redirect a later pull outside --src", async () => {
    const api = serve();
    const src = repo({ command: "make verify", pull: ["escape:.", "artifacts:escape/new/sub"] });
    const victim = join(dir, "victim");
    mkdirSync(victim);
    mkdirSync(join(dir, "remote-fs/artifacts"), { recursive: true });
    writeFileSync(join(dir, "remote-fs/artifacts/authorized_keys"), "ssh-ed25519 AAAA attacker\n");
    symlinkSync(victim, join(dir, "remote-fs/escape"));
    const r = await run(["verify", "--src", src]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/pull refused: .*\/repo\/escape\/new\/sub resolves outside .*\/repo/);
    expect(lstatSync(join(src, "escape")).isSymbolicLink()).toBe(true);
    expect(readdirSync(victim)).toEqual([]);
    expect(api.vms.size).toBe(0);
  }, 60_000);

  it("a pull whose remote glob matches nothing is reported and skipped, not a failure", async () => {
    serve();
    knownVm();
    const r = await run(["pull", "vm-a", "heavy-logs", join(dir, "out")]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("pull: nothing matches heavy-logs");
    expect(read("ssh.log")).not.toContain("tar -czf - heavy-logs");
  }, 60_000);

  it("the committed .gstack/ubicloud.json is accepted: its setup is inside the checkout and it forwards nothing", async () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, ".gstack/ubicloud.json"), "utf8")) as { setup: string; command: string; pass?: string[]; env?: string[] };
    expect(existsSync(join(ROOT, cfg.setup))).toBe(true);
    expect(cfg.pass ?? []).toEqual([]);
    expect((cfg.env ?? []).filter((e) => e.startsWith("UBICLOUD_"))).toEqual([]);
    serve({ rejectCreates: true });
    const r = await run(["verify", "--src", ROOT]);
    expect(r.stderr).toContain(`verify: ${ROOT}/.gstack/ubicloud.json`);
    expect(r.stderr).toContain("quota refused");
    expect(creates()).toHaveLength(1);
  }, 60_000);
});

describe("quota preflight", () => {
  it("a refusal caches the maximum; the cache drives the preflight for a day, then is dropped; UBI_QUOTA_WAIT waits before refusing", async () => {
    serve({ rejectCreates: true });
    const refused = await run(["up"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("create failed: vCPU quota exhausted");
    expect(read("state/quota-max").trim()).toBe("256");

    serve({ seed: [{ name: "ubirun-peer-9999999999-cccc" }] });
    writeFileSync(join(dir, "state/quota-max"), "31\n");
    const cached = await run(["up"]);
    expect(cached.code).toBe(1);
    expect(cached.stderr).toMatch(new RegExp(`quota preflight refused eu-central-h1/${RUN_VM} \\(standard-16\\): it needs 16 vCPUs and the project's VMs already use 16 of 31 \\(ceiling from the last refusal, cached in .*quota-max;`));
    expect(cached.stderr).toContain("create refused before any request: vCPU quota exhausted");
    const t0 = Date.now();
    const waited = await run(["up"], { UBI_QUOTA_WAIT: "3" });
    expect(waited.code).toBe(1);
    expect(waited.stderr).toMatch(/quota: 16 of 31 vCPUs in use and 16 needed; waiting up to 3s more for room/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3000); // gstack-timing-ok: UBI_QUOTA_WAIT is a wall-clock wait; a lower bound cannot flake
    const fromEnv = await run(["up"], { UBI_QUOTA_VCPUS: "24" });
    expect(fromEnv.stderr).toMatch(/already use 16 of 24 \(ceiling from UBI_QUOTA_VCPUS;/);
    expect(creates()).toEqual([]);

    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(join(dir, "state/quota-max"), old, old);
    const stale = await run(["up"]);
    expect(stale.code).toBe(0);
    expect(stale.stderr).not.toContain("quota preflight refused");
    expect(existsSync(join(dir, "state/quota-max"))).toBe(false);
    const name = stale.stdout.trim();
    expect(name).toMatch(new RegExp(`^${RUN_VM}$`));
    expect((await run(["down", name])).code).toBe(0);
  }, 90_000);
});
