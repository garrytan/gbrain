#!/usr/bin/env bun
/**
 * scripts/ci-ubicloud.ts — the ci:local gate fanned out across ephemeral
 * Ubicloud VMs.
 *
 *   bun run ci:ubicloud                 # gitleaks + verify + serial + slow + unit + ALL E2E
 *   bun run ci:ubicloud:diff            # doc-only diff: doc checks + gitleaks; any other diff: the full gate
 *
 * Options:
 *   --vms N            VMs to provision in parallel (default 4: 64 vCPUs of the
 *                      project quota that pull-request CI shares)
 *   --size SIZE        Ubicloud size (default standard-16)
 *   --slots N          concurrent work slots per VM (default: half of --size's vCPUs)
 *   --location LOC     Ubicloud location (default eu-central-h1)
 *   --lanes a,b        subset of gitleaks,verify,serial,slow,unit,e2e (default all)
 *   --diff             doc-only diffs run only the doc checks and gitleaks (ci:local --diff)
 *   --record-weights   write measured durations to scripts/ubicloud/weights.json
 *   --keep             leave the VMs running (destroy with ubi-runner.sh down NAME)
 *
 * Needs UBICLOUD_API_KEY (or UBICLOUD_API_TOKEN) plus bash, curl, python3,
 * ssh, ssh-keygen and tar locally. The checkout (tracked + untracked-unignored
 * files + .git) is packed once and streamed to every VM, so uncommitted edits
 * are tested.
 *
 * Each VM runs scripts/ubicloud/setup-ci-vm.sh (bun, test prerequisites, one
 * pgvector server + PgBouncer per slot, PGLite snapshots). The first VM to
 * finish setup runs the machine-level items in order (gitleaks, verify, the
 * serial lane's machine-exclusive files) and then joins the pool. Every other
 * test file is an item in one global heaviest-first queue that idle slots pull
 * from (scripts/ubicloud/schedule.ts); items run through the same wrappers
 * ci:local uses (scripts/ubicloud/ci-item.sh). Durations of every run are
 * merged into .context/ci-ubicloud/weights.json, which weights the next run.
 *
 * VMs are named ubirun-<owner>-<epoch>-ciNN<hex> (owner: UBI_OWNER or the
 * runner's per-machine id). Each name is appended to <run>/vms.txt before its
 * create request is sent. On exit, including SIGINT, SIGTERM, SIGHUP (a
 * dropped terminal, a cancelled background operation) and SIGQUIT, in-flight
 * `up` calls are allowed to finish (they destroy their own VM), then every
 * recorded name is destroyed and polled until it is confirmed gone.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildItems,
  parseItemLog,
  readWeightTable,
  sortQueue,
  takeBatch,
  weightKey,
  type Item,
  type ItemResult,
  type Lane,
  type WeightTable,
} from "./ubicloud/schedule.ts";

const ROOT = resolve(import.meta.dir, "..");
const RUNNER = join(ROOT, "scripts/ubicloud/ubi-runner.sh");
const REMOTE_DIR = "work/gbrain";
const COMMITTED_WEIGHTS = join(ROOT, "scripts/ubicloud/weights.json");
const LOCAL_WEIGHTS = join(ROOT, ".context/ci-ubicloud/weights.json");
const ALL_LANES = ["gitleaks", "verify", "serial", "slow", "unit", "e2e"] as const;
const BATCH_TIMEOUT_MS = 20 * 60 * 1000;
// Items this heavy are the run's long poles: spread them one per VM so two of
// them never compete for the same VM's CPUs.
const HEAVY_MS = 60_000;
// VMs still in setup count toward heavy spreading for this long after the
// first VM is ready, so the first VM does not claim every long pole.
const HEAVY_SETUP_GRACE_MS = 45_000;

interface Opts {
  vms: number;
  size: string;
  slots: number;
  location: string;
  lanes: Set<string>;
  diff: boolean;
  recordWeights: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    vms: 4,
    size: "standard-16",
    slots: 0,
    location: "eu-central-h1",
    lanes: new Set(ALL_LANES),
    diff: false,
    recordWeights: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) usage(`${arg} needs a value`);
      return v!;
    };
    if (arg === "--vms") opts.vms = Number(value());
    else if (arg === "--size") opts.size = value();
    else if (arg === "--slots") opts.slots = Number(value());
    else if (arg === "--location") opts.location = value();
    else if (arg === "--lanes") opts.lanes = new Set(value().split(","));
    else if (arg === "--diff") opts.diff = true;
    else if (arg === "--record-weights") opts.recordWeights = true;
    else if (arg === "--keep") opts.keep = true;
    else usage(`unknown argument ${arg}`);
  }
  for (const lane of opts.lanes) if (!(ALL_LANES as readonly string[]).includes(lane)) usage(`unknown lane ${lane}`);
  if (!Number.isInteger(opts.vms) || opts.vms < 1) usage("--vms must be a positive integer");
  // One slot per two vCPUs: the whole corpus still fits inside the longest
  // single file's runtime at the default fleet size, and the headroom keeps
  // timing-sensitive files (and that longest file) from starving for CPU.
  if (!opts.slots) opts.slots = Math.max(1, Math.round(Number(/(\d+)$/.exec(opts.size)?.[1] ?? 16) / 2));
  if (!Number.isInteger(opts.slots) || opts.slots < 1) usage("--slots must be a positive integer");
  return opts;
}

function usage(message: string): never {
  console.error(`ci-ubicloud: ${message}`);
  console.error("usage: bun run scripts/ci-ubicloud.ts [--vms N] [--size SIZE] [--slots N] [--location LOC] [--lanes a,b] [--diff] [--record-weights] [--keep]");
  process.exit(2);
}

const t0 = Date.now();
const clock = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const log = (message: string) => console.log(`[ci-ubicloud ${clock()}] ${message}`);

function sh(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
const lines = (text: string) => text.split(/\s+/).map((l) => l.trim()).filter(Boolean);

const children = new Map<ReturnType<typeof spawn>, string>();

/** Run the runner script; stdout goes to `out` (a path) or is returned. */
function runner(args: string[], opts: { out?: string; input?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [RUNNER, ...args], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    children.set(child, args[0]!);
    let stdout = "";
    let stderr = "";
    const sink = opts.out ? createWriteStream(opts.out) : null;
    child.stdout!.on("data", (chunk) => (sink ? sink.write(chunk) : (stdout += chunk)));
    child.stderr!.on("data", (chunk) => (sink ? sink.write(chunk) : (stderr += chunk)));
    if (opts.input) {
      createReadStream(opts.input).pipe(child.stdin!);
    } else {
      child.stdin!.end();
    }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      const finish = () => resolvePromise({ code: code ?? 1, stdout: sink ? "" : stdout + (code ? stderr : "") });
      if (sink) sink.end(finish);
      else finish();
    });
  });
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface Vm {
  name: string;
  state: "provisioning" | "setup" | "ready" | "failed" | "destroyed";
  requested: boolean;
  infraErrors: number;
  setupMs?: number;
  busySlots: number;
  heavy: number;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.UBICLOUD_API_KEY && !process.env.UBICLOUD_API_TOKEN) {
    console.error("ci-ubicloud: UBICLOUD_API_KEY (or UBICLOUD_API_TOKEN) is not set");
    process.exit(2);
  }
  const sha = sh("git", ["rev-parse", "HEAD"]).trim();
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${sha.slice(0, 8)}`;
  const runDir = join(ROOT, ".context/ci-ubicloud", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  mkdirSync(join(runDir, "failures"), { recursive: true });

  // ── Inventory: the same discovery the ci:local wrappers use ───────────────
  const e2eFiles = lines(sh("bash", ["scripts/run-e2e.sh", "--dry-run-list"]));
  if (opts.diff) {
    const classification = spawnSync("bun", ["run", "scripts/select-e2e.ts", "--classify-only"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim();
    if (classification === "DOC_ONLY") {
      log("--diff: doc-only diff — running the doc checks locally, then gitleaks (ci:local doc-only fast-path)");
      if (spawnSync("bash", ["scripts/ci-doc-checks.sh"], { cwd: ROOT, stdio: "inherit" }).status !== 0) process.exit(1);
      opts.lanes = new Set(["gitleaks"]);
      opts.vms = 1;
    } else {
      log(`--diff: E2E narrowing is retired; running the full E2E corpus (see docs/TESTING.md#e2e-selection). Classification: ${classification || "unknown"}`);
    }
  }
  const exclusive = lines(sh("bash", ["scripts/run-serial-tests.sh", "--dry-run-list-exclusive"]));
  const serialPool = lines(sh("bash", ["scripts/run-serial-tests.sh", "--dry-run-list"])).filter((f) => !exclusive.includes(f));
  const inventory: Record<Lane, string[]> = {
    unit: lines(sh("bash", ["scripts/run-unit-shard.sh", "--dry-run-list"])),
    serial: serialPool,
    slow: lines(sh("bash", ["scripts/run-slow-tests.sh", "--dry-run-list"])),
    e2e: e2eFiles,
  };

  const tables: WeightTable[] = [
    readWeightTable(LOCAL_WEIGHTS),
    readWeightTable(COMMITTED_WEIGHTS),
    readWeightTable(join(ROOT, "scripts/e2e-weights.json"), 1, "e2e:"),
    readWeightTable(join(ROOT, "scripts/serial-weights.json"), 1000, "serial:"),
    readWeightTable(join(ROOT, "scripts/test-weights.json"), 1, "unit:"),
    readWeightTable(join(ROOT, "scripts/test-weights.json"), 1, "slow:"),
  ];
  const queue: Item[] = [];
  for (const lane of ["unit", "serial", "slow", "e2e"] as Lane[]) {
    if (opts.lanes.has(lane)) queue.push(...buildItems(lane, inventory[lane], tables));
  }
  sortQueue(queue);
  const control: { lane: string; files: string[] }[] = [];
  if (opts.lanes.has("gitleaks")) control.push({ lane: "gitleaks", files: [] });
  if (opts.lanes.has("verify")) control.push({ lane: "verify", files: [] });
  if (opts.lanes.has("serial") && exclusive.length) control.push({ lane: "serial", files: exclusive });
  const totalItems = queue.length + control.reduce((n, c) => n + Math.max(c.files.length, 1), 0);
  const estimate = queue.reduce((s, i) => s + i.weight, 0) / 1000;
  log(`${totalItems} items (${Object.entries(inventory).filter(([l]) => opts.lanes.has(l)).map(([l, f]) => `${l} ${f.length}`).join(", ")}, control ${control.map((c) => c.lane).join("+") || "none"}); ~${Math.round(estimate)}s of weighted work`);
  log(`provisioning ${opts.vms} × ${opts.size} in ${opts.location}, ${opts.slots} slots each; logs in ${runDir}`);

  // ── Checkout tarball, packed once ────────────────────────────────────────
  const tarball = join(tmpdir(), `gbrain-ci-ubicloud-${process.pid}.tgz`);
  const packed = await runner(["pack", ROOT], { out: tarball });
  if (packed.code !== 0) throw new Error("packing the checkout failed");

  const bunVersion = process.env.GBRAIN_CI_BUN_TAG
    ?? /oven\/bun:\$\{GBRAIN_CI_BUN_TAG:-([^}]+)\}/.exec(readFileSync(join(ROOT, "docker-compose.ci.yml"), "utf8"))?.[1]
    ?? "1.4.2";

  // ── Teardown on every exit path ──────────────────────────────────────────
  const owner = sh("bash", [RUNNER, "owner"]).trim();
  const ledger = join(runDir, "vms.txt");
  const vms: Vm[] = Array.from({ length: opts.vms }, (_, i) => ({
    name: `ubirun-${owner}-${Math.floor(Date.now() / 1000)}-ci${String(i + 1).padStart(2, "0")}${Math.random().toString(16).slice(2, 6)}`,
    state: "provisioning",
    requested: false,
    infraErrors: 0,
    busySlots: 0,
    heavy: 0,
  }));
  // Memoized: the signal handler and main's finally must await the same
  // teardown, or main exits while its `down` calls are still running.
  let tornDown: Promise<void> | null = null;
  const teardown = () => (tornDown ??= destroyAll());
  const destroyAll = async () => {
    // An `up` gets SIGTERM, records its create answer and destroys its own VM;
    // waiting for it means no create request is in flight when `down` runs.
    const ups = [...children].filter(([, sub]) => sub === "up").map(([child]) => child);
    for (const [child, sub] of children) child.kill(sub === "up" ? "SIGTERM" : "SIGKILL");
    await Promise.all(ups.map((child) => new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done(null) : child.once("exit", done)))));
    rmSync(tarball, { force: true });
    const live = vms.filter((vm) => vm.requested && vm.state !== "destroyed");
    if (opts.keep) {
      log(`--keep: leaving ${live.map((vm) => vm.name).join(" ")} running; destroy with: scripts/ubicloud/ubi-runner.sh down NAME`);
      return;
    }
    log(`destroying ${live.length} VM(s): ${live.map((vm) => vm.name).join(" ")}`);
    await Promise.all(live.map(async (vm) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if ((await runner(["down", vm.name, "-l", opts.location])).code === 0) {
          vm.state = "destroyed";
          return;
        }
      }
      console.error(`ci-ubicloud: WARNING could not confirm ${vm.name} is gone; run: scripts/ubicloud/ubi-runner.sh down ${vm.name} -l ${opts.location}`);
    }));
    const left = live.filter((vm) => vm.state !== "destroyed").length;
    log(left ? `teardown left ${left} VM(s) unconfirmed (names in ${ledger})` : `teardown confirmed ${live.length} VM(s) gone`);
  };
  let interrupted = false;
  // After SIGHUP the terminal may be gone: a failed log write must not abort teardown.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(signal, () => {
      if (interrupted) return;
      interrupted = true;
      log(`${signal}: tearing down`);
      teardown().finally(() => process.exit(130));
    });
  }

  // ── Scheduling state ─────────────────────────────────────────────────────
  const results = new Map<string, ItemResult & { vm: string; slot: number }>();
  let inFlight = 0;
  let controlDone = control.length === 0;
  let controlClaimed = false;
  let batchSeq = 0;
  const totalSlots = () => vms.filter((vm) => vm.state === "ready").length * opts.slots;
  let firstReadyAt = 0;
  const skipHeavy = (vm: Vm) => (item: Item) => {
    if (item.weight < HEAVY_MS) return false;
    const inGrace = Date.now() - firstReadyAt < HEAVY_SETUP_GRACE_MS;
    const peers = vms.filter((v) => v.state === "ready" || (inGrace && (v.state === "setup" || v.state === "provisioning")));
    return vm.heavy > Math.min(...peers.map((v) => v.heavy));
  };

  const record = (vm: Vm, slot: number, result: ItemResult) => {
    results.set(weightKey(result.lane as Lane, result.file), { ...result, vm: vm.name, slot });
    if (result.rc !== 0) {
      const path = join(runDir, "failures", `${result.lane}__${result.file.replace(/[\\/]/g, "__")}.log`);
      writeFileSync(path, result.output + "\n");
      log(`FAIL ${result.lane} ${result.file} (rc=${result.rc}, ${Math.round(result.ms / 1000)}s) → ${path}`);
    }
  };

  const runBatch = async (vm: Vm, slot: number, lane: string, files: string[]) => {
    const logPath = join(runDir, "logs", `${String(++batchSeq).padStart(5, "0")}-${vm.name.slice(-8)}-s${slot}-${lane}.log`);
    const cmd = `cd ${REMOTE_DIR} && SLOT=${slot} bash scripts/ubicloud/ci-item.sh ${lane} ${files.map(quote).join(" ")}`;
    const r = await runner(["ssh", vm.name, cmd], { out: logPath, timeoutMs: BATCH_TIMEOUT_MS });
    return { code: r.code, parsed: parseItemLog(readFileSync(logPath, "utf8")), logPath };
  };

  const slotWorker = async (vm: Vm, slot: number) => {
    while (!interrupted && vm.state === "ready") {
      const batch = takeBatch(queue, { slots: Math.max(totalSlots(), 1), skip: skipHeavy(vm) });
      if (batch.length === 0) {
        if (inFlight === 0) return;
        await Bun.sleep(1000);
        continue;
      }
      inFlight++;
      vm.busySlots++;
      const heavy = batch.filter((i) => i.weight >= HEAVY_MS).length;
      vm.heavy += heavy;
      const lane = batch[0]!.lane;
      const { code, parsed, logPath } = await runBatch(vm, slot, lane, batch.map((i) => i.file));
      vm.heavy -= heavy;
      vm.busySlots--;
      const done = new Set(parsed.map((r) => r.file));
      for (const result of parsed) record(vm, slot, result);
      const lost = batch.filter((item) => !done.has(item.file));
      if (lost.length) {
        vm.infraErrors++;
        log(`batch on ${vm.name} slot ${slot} ended (exit ${code}) with ${lost.length} unfinished item(s); log ${logPath}`);
        for (const item of lost) {
          item.attempts++;
          if (item.attempts < 2) queue.push(item);
          else record(vm, slot, { lane: item.lane, file: item.file, rc: 255, ms: 0, output: `no result after ${item.attempts} attempts; last batch log: ${logPath}` });
        }
        sortQueue(queue);
        if (vm.infraErrors >= 3) {
          log(`retiring ${vm.name} after ${vm.infraErrors} infrastructure errors`);
          vm.state = "failed";
        }
      }
      inFlight--;
    }
  };

  const runControl = async (vm: Vm) => {
    for (const step of control) {
      log(`control on ${vm.name}: ${step.lane}${step.files.length ? ` (${step.files.length} exclusive files, sequential)` : ""}`);
      const { parsed, logPath } = await runBatch(vm, 1, step.lane, step.files);
      const done = new Set(parsed.map((r) => r.file));
      for (const result of parsed) record(vm, 1, result);
      for (const file of step.files.length ? step.files : ["-"]) {
        if (!done.has(file)) record(vm, 1, { lane: step.lane, file, rc: 255, ms: 0, output: `no result; batch log: ${logPath}` });
      }
    }
    controlDone = true;
  };

  const vmLifecycle = async (vm: Vm, index: number) => {
    const started = Date.now();
    const setupLog = join(runDir, "logs", `setup-${vm.name}.log`);
    if (tornDown) return;
    vm.requested = true;
    appendFileSync(ledger, `${vm.name} ${opts.location}\n`);
    const up = await runner(["up", "-n", vm.name, "-s", opts.size, "-l", opts.location], { out: setupLog });
    if (tornDown) return;
    if (up.code !== 0) {
      vm.state = "failed";
      const setupText = readFileSync(setupLog, "utf8").trim();
      const quota = setupText.indexOf("ubi-runner: quota refused");
      if (quota >= 0) log(`VM ${index + 1} refused by the Ubicloud vCPU quota; the run continues on the VMs that started:\n${setupText.slice(quota)}`);
      else log(`VM ${index + 1} failed to provision (see ${setupLog}): ${setupText.split("\n").slice(-2).join(" | ")}`);
      return;
    }
    vm.state = "setup";
    const unpack = await runner(["unpack", vm.name, REMOTE_DIR], { input: tarball });
    const env = `SLOTS=${opts.slots} BUN_VERSION=${quote(bunVersion)} GITLEAKS=${opts.lanes.has("gitleaks") ? 1 : 0}`;
    const setup = unpack.code === 0
      ? await runner(["ssh", vm.name, `cd ${REMOTE_DIR} && ${env} bash scripts/ubicloud/setup-ci-vm.sh`], { out: `${setupLog}.bootstrap`, timeoutMs: 15 * 60 * 1000 })
      : unpack;
    if (setup.code !== 0) {
      vm.state = "failed";
      log(`VM ${vm.name} setup failed (see ${setupLog}.bootstrap)`);
      return;
    }
    vm.setupMs = Date.now() - started;
    vm.state = "ready";
    firstReadyAt ||= Date.now();
    log(`${vm.name} ready in ${Math.round(vm.setupMs / 1000)}s`);
    if (!controlClaimed && control.length) {
      controlClaimed = true;
      await runControl(vm);
    }
    await Promise.all(Array.from({ length: opts.slots }, (_, slot) => slotWorker(vm, slot + 1)));
  };

  const progress = setInterval(() => {
    const failed = [...results.values()].filter((r) => r.rc !== 0).length;
    const ready = vms.filter((vm) => vm.state === "ready").length;
    const busy = vms.reduce((n, vm) => n + vm.busySlots, 0);
    log(`${results.size}/${totalItems} done, ${failed} failed | queue ${queue.length} | VMs ready ${ready}/${opts.vms} | busy slots ${busy}`);
  }, 15000);

  let exitCode = 0;
  try {
    await Promise.all(vms.map((vm, i) => vmLifecycle(vm, i)));
    if (control.length && !controlDone) throw new Error("no VM became ready to run gitleaks/verify/exclusive items");
    if (queue.length) throw new Error(`${queue.length} items never ran: every VM failed`);
  } catch (error) {
    console.error(`ci-ubicloud: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    clearInterval(progress);
    await teardown();
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const all = [...results.values()];
  const failures = all.filter((r) => r.rc !== 0);
  const byLane = new Map<string, { pass: number; fail: number; ms: number }>();
  for (const r of all) {
    const entry = byLane.get(r.lane) ?? { pass: 0, fail: 0, ms: 0 };
    if (r.rc === 0) entry.pass++;
    else entry.fail++;
    entry.ms += r.ms;
    byLane.set(r.lane, entry);
  }
  const wallMs = Date.now() - t0;
  const computeMs = all.reduce((s, r) => s + r.ms, 0);
  console.log("");
  console.log("=== ci-ubicloud summary ===");
  for (const [lane, e] of byLane) console.log(`  ${lane.padEnd(8)} ${e.pass} passed, ${e.fail} failed, ${Math.round(e.ms / 1000)}s compute`);
  const ready = vms.filter((vm) => vm.setupMs !== undefined);
  console.log(`  VMs: ${ready.length}/${opts.vms} ready${ready.length ? `, setup ${Math.round(Math.min(...ready.map((v) => v.setupMs!)) / 1000)}-${Math.round(Math.max(...ready.map((v) => v.setupMs!)) / 1000)}s` : ""}`);
  console.log(`  wall ${Math.round(wallMs / 1000)}s, ${Math.round(computeMs / 1000)}s of test compute`);
  console.log("  slowest items:");
  for (const r of [...all].sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`    ${Math.round(r.ms / 1000)}s ${r.lane} ${r.file}`);

  const timings: Record<string, number> = {};
  for (const r of all) if (r.rc === 0 && r.file !== "-") timings[weightKey(r.lane as Lane, r.file)] = r.ms;
  const merged = { ...Object.fromEntries(readWeightTable(LOCAL_WEIGHTS)), ...timings };
  mkdirSync(dirname(LOCAL_WEIGHTS), { recursive: true });
  writeFileSync(LOCAL_WEIGHTS, JSON.stringify(sortedObject(merged), null, 2) + "\n");
  if (opts.recordWeights) {
    const committed = { ...Object.fromEntries(readWeightTable(COMMITTED_WEIGHTS)), ...timings };
    const current = new Set(Object.entries(inventory).flatMap(([lane, files]) => files.map((f) => weightKey(lane as Lane, f))));
    const pruned = Object.fromEntries(Object.entries(committed).filter(([key]) => current.has(key)));
    writeFileSync(COMMITTED_WEIGHTS, JSON.stringify(sortedObject(pruned), null, 2) + "\n");
    log(`recorded ${Object.keys(timings).length} durations into scripts/ubicloud/weights.json`);
  }
  writeFileSync(join(runDir, "summary.json"), JSON.stringify({
    sha, runId, wallMs, computeMs, opts: { ...opts, lanes: [...opts.lanes] },
    vms: vms.map(({ name, state, setupMs, infraErrors }) => ({ name, state, setupMs, infraErrors })),
    lanes: Object.fromEntries(byLane), failures: failures.map(({ lane, file, rc, ms, vm }) => ({ lane, file, rc, ms, vm })),
  }, null, 2) + "\n");

  if (failures.length) {
    console.log("");
    console.log(`${failures.length} failing item(s):`);
    for (const f of failures) console.log(`  - ${f.lane} ${f.file} (rc=${f.rc})`);
    for (const f of failures.slice(0, 5)) {
      console.log(`\n--- ${f.lane} ${f.file} (last 30 lines) ---`);
      console.log(f.output.split("\n").slice(-30).join("\n"));
    }
    console.log(`\nFull per-item logs: ${join(runDir, "failures")}`);
    exitCode = 1;
  }
  const expected = totalItems;
  if (exitCode === 0 && results.size !== expected) {
    console.error(`ci-ubicloud: ${results.size} results for ${expected} items`);
    exitCode = 1;
  }
  console.log(exitCode === 0 ? `\n[ci-ubicloud] All checks passed in ${clock()}.` : `\n[ci-ubicloud] FAILED after ${clock()}.`);
  process.exit(exitCode);
}

function sortedObject(obj: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
