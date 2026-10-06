// run-verify-parallel.test.ts — pin the dispatcher's contract.
//
// We can't easily fake the 20-check list inside the script (it's a static
// array), but we CAN verify:
//   1. --dry-list emits one line per check
//   2. Unknown args exit 2
//   3. The fast-path measurement claim — running it on a clean tree
//      completes faster than the sequential `&&`-chain would have
//   4. A made-up failing check propagates exit 1 with the named check
//      in the failure report (covered by overriding the CHECKS array
//      via a sibling temp script)
//
// (3) is a soft regression guard, not a hard timing assertion (CI runners
// vary). (4) is the load-bearing test: failure surfaces with name + log.

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/run-verify-parallel.sh";

describe("run-verify-parallel.sh — CLI contract", () => {
  it("--dry-list emits one line per check, exit 0", () => {
    const r = spawnSync("bash", [SCRIPT, "--dry-list"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    // The exact count is allowed to grow; assert > 10 and that every line
    // looks like a script name (no whitespace, no quotes).
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      expect(l).toMatch(/^[a-z][a-z0-9:_-]+$/);
    }
  });

  it("includes the load-bearing privacy + jsonb + typecheck checks", () => {
    const r = spawnSync("bash", [SCRIPT, "--dry-list"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const set = new Set(r.stdout.trim().split("\n"));
    expect(set.has("check:privacy")).toBe(true);
    expect(set.has("check:jsonb")).toBe(true);
    expect(set.has("typecheck")).toBe(true);
    expect(set.has("check:operations-filter-bypass")).toBe(true);
  });

  it("unknown arg exits 2 with usage error", () => {
    const r = spawnSync("bash", [SCRIPT, "--bogus"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown arg");
    expect(r.stderr).toContain("usage:");
  });
});

describe("guard registration ⇒ execution coverage", () => {
  // guard-self-test.sh enforces that every scripts/check-* guard is
  // REGISTERED in guards-manifest.tsv, but nothing enforced that a
  // registered guard actually EXECUTES anywhere — five guards sat
  // registered-but-dead until the v0.45.x test/eval/CI pass. This closes
  // the loop: every manifest guard must be reachable from verify's CHECKS
  // (via a package.json script that invokes its file), or be explicitly
  // exempted HERE with the reason it runs elsewhere / deliberately not.
  const EXECUTION_EXEMPT: Record<string, string> = {
    "check-bun-test-timeout.sh":
      "runs directly as a test.yml verify-job step (not via CHECKS — avoids a package.json edit)",
    "check-admin-embedded.sh":
      "duplicates check:admin-build's vite+tsc build; embed freshness covered there",
    "check-bash32.sh":
      "needs Docker or a native bash 3.2: runs as a test.yml verify-job step (bash:3.2 image) and in macos-validation.yml (/bin/bash), never in verify",
    "check-test-discriminates.sh":
      "manual per-PR discrimination helper (#3665): reverts named source files and re-runs bun test to prove the test fails without the fix — cannot know which hunk is 'the fix' on an arbitrary diff, so deliberately not in verify/CI (manifest row says the same)",
  };

  it("every manifest guard is executed by verify or explicitly exempt", () => {
    const manifestLines = readFileSync("scripts/guards-manifest.tsv", "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    const guards = manifestLines.map((l) => l.split("\t")[0]!).filter(Boolean);
    expect(guards.length).toBeGreaterThan(30);

    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const dry = spawnSync("bash", [SCRIPT, "--dry-list"], { encoding: "utf8" });
    expect(dry.status).toBe(0);
    const executed = new Set(dry.stdout.trim().split("\n"));

    const missing: string[] = [];
    for (const g of guards) {
      if (EXECUTION_EXEMPT[g]) continue;
      const invokingKeys = Object.entries(pkg.scripts)
        .filter(([, cmd]) => cmd.includes(`scripts/${g}`))
        .map(([key]) => key);
      const covered = invokingKeys.some((k) => executed.has(k));
      if (!covered) missing.push(g);
    }
    expect(missing).toEqual([]);
  });
});

describe("run-verify-parallel.sh — failure surfacing (synthetic dispatcher)", () => {
  // We can't inject a fake check into the real script without touching the
  // CHECKS array. Instead, we write a SMALLER synthetic dispatcher that
  // shares the same shape (background jobs, exit-file aggregation, log
  // tail on failure) and assert the surfacing contract on it. This proves
  // the design, leaving the real script tested via CLI contract above.
  //
  // Each "check" is written as its own executable file so bash array
  // expansion doesn't try to word-split shell strings (the natural
  // failure mode of expressing checks as bash command strings is that
  // spaces and quotes don't survive `"${CHECKS[@]}"`).

  function writeSynth(checkBodies: { name: string; body: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "verify-synth-"));
    const checkPaths: string[] = [];
    for (const c of checkBodies) {
      const p = `${dir}/${c.name}.sh`;
      writeFileSync(p, `#!/usr/bin/env bash\n${c.body}\n`, { mode: 0o755 });
      checkPaths.push(p);
    }
    const dispatcher = `${dir}/dispatch.sh`;
    // CHECKS is an array of absolute paths to executable scripts.
    const arrLit = checkPaths.map((p) => `"${p}"`).join(" ");
    writeFileSync(
      dispatcher,
      `#!/usr/bin/env bash
set -uo pipefail
LOG_DIR=$(mktemp -d /tmp/verify-synth-log-XXXXXX)
trap 'rm -rf "$LOG_DIR"' EXIT
CHECKS=(${arrLit})
PIDS=()
NAMES=()
for c in "\${CHECKS[@]}"; do
  base=$(basename "$c" .sh)
  NAMES+=("$base")
  (
    "$c" > "$LOG_DIR/$base.log" 2>&1
    echo $? > "$LOG_DIR/$base.exit"
  ) &
  PIDS+=($!)
done
for p in "\${PIDS[@]}"; do wait "$p" 2>/dev/null || true; done
FAIL=0
FAILED_NAMES=""
for i in "\${!NAMES[@]}"; do
  n="\${NAMES[$i]}"
  rc=$(cat "$LOG_DIR/$n.exit")
  if [ "$rc" != "0" ]; then
    FAIL=$((FAIL+1))
    FAILED_NAMES="$FAILED_NAMES $n"
    echo "--- $n (rc=$rc) ---" >&2
    tail -10 "$LOG_DIR/$n.log" >&2
  fi
done
if [ "$FAIL" -gt 0 ]; then
  echo "Failed:$FAILED_NAMES" >&2
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );
    return dispatcher;
  }

  function cleanup(dispatcher: string) {
    rmSync(dispatcher.replace(/\/dispatch\.sh$/, ""), { recursive: true, force: true });
  }

  it("all-pass: exit 0, no failure block", () => {
    const d = writeSynth([
      { name: "alpha", body: "exit 0" },
      { name: "beta", body: "exit 0" },
      { name: "gamma", body: "exit 0" },
    ]);
    try {
      const r = spawnSync("bash", [d], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Failed:");
    } finally {
      cleanup(d);
    }
  });

  it("one-fails: exit 1, failure block names the check + shows log tail", () => {
    const d = writeSynth([
      { name: "alpha", body: "exit 0" },
      {
        name: "beta",
        body: 'echo "synthetic failure detail line" >&2\nexit 7',
      },
      { name: "gamma", body: "exit 0" },
    ]);
    try {
      const r = spawnSync("bash", [d], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Failed: beta");
      expect(r.stderr).toContain("synthetic failure detail line");
      expect(r.stderr).toMatch(/--- beta \(rc=7\) ---/);
    } finally {
      cleanup(d);
    }
  });

  it("two-fail: both names appear in the Failed: list", () => {
    const d = writeSynth([
      { name: "alpha", body: "exit 0" },
      { name: "beta", body: "echo err-A >&2\nexit 1" },
      { name: "gamma", body: "echo err-B >&2\nexit 2" },
    ]);
    try {
      const r = spawnSync("bash", [d], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("err-A");
      expect(r.stderr).toContain("err-B");
      expect(r.stderr).toMatch(/Failed:\s+beta\s+gamma/);
    } finally {
      cleanup(d);
    }
  });
});

describe("run-verify-parallel.sh — no-timeout-binary fallback rc capture (regression)", () => {
  // macOS ships no `timeout`; without brew coreutils (`gtimeout`) — stock
  // machines, minimal containers, restricted/sandboxed PATHs — the dispatcher
  // degrades to the bg-pid + sleep-watchdog branch.
  //
  // Regression pinned here: each check's sentinel .exit file must record the
  // exit code of the CHECK (read right after `wait $pid`), not of the
  // watchdog teardown. The watchdog subshell is killed with SIGTERM and so
  // reports 143; reading `$?` after the teardown stamped 143 into every
  // sentinel — verify reported pass=0 fail=<all> while every per-check log
  // said OK.
  //
  // Hermetic on any host: the script runs from a tempdir copy with `bun`
  // stubbed (checks complete instantly, no repo needed) and PATH set to a
  // curated symlink dir containing everything the script calls EXCEPT
  // gtimeout/timeout — forcing the fallback branch even where coreutils is
  // installed.

  function makeFallbackHarness(timeoutSecs = "5"): { root: string; env: Record<string, string> } {
    const root = mkdtempSync(join(tmpdir(), "verify-fallback-"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "run-verify-parallel.sh"));
    // The dispatcher sources the shared runner lib — stage it too (E3).
    copyFileSync("scripts/lib/test-env.sh", join(root, "scripts", "lib", "test-env.sh"));

    const bin = join(root, "bin");
    mkdirSync(bin);
    // Everything the dispatcher and its subshells invoke, minus timeout bins.
    for (const tool of ["bash", "sh", "env", "dirname", "mktemp", "date", "sleep", "cat", "tail", "head", "rm", "mkdir", "pkill", "grep", "sed", "awk", "wc", "tr", "sort"]) {
      const p = Bun.which(tool);
      if (p) symlinkSync(p, join(bin, tool));
    }
    // `bun run <name>` stand-in: instant, prints OK, exits 7 for the check
    // named in $STUB_FAIL_CHECK (if any).
    writeFileSync(
      join(bin, "bun"),
      `#!/usr/bin/env bash
name="\${2:-}"
[ -n "\${STUB_LOG:-}" ] && echo "start $name" >> "$STUB_LOG"
if [ -n "\${STUB_SLOW_CHECK:-}" ] && [ "$name" = "\${STUB_SLOW_CHECK}" ]; then sleep 2; fi
[ -n "\${STUB_LOG:-}" ] && echo "end $name" >> "$STUB_LOG"
echo "stub check OK: $name"
if [ -n "\${STUB_SKIP_CHECK:-}" ] && [ "$name" = "\${STUB_SKIP_CHECK}" ]; then
  echo "GBRAIN_CHECK_SKIPPED: subject absent in this checkout"
fi
if [ -n "\${STUB_FAIL_CHECK:-}" ] && [ "$name" = "\${STUB_FAIL_CHECK}" ]; then
  echo "stub check failing: $name" >&2
  exit 7
fi
exit 0
`,
      { mode: 0o755 },
    );

    return {
      root,
      env: {
        PATH: bin,
        HOME: process.env.HOME ?? root,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        GBRAIN_VERIFY_TIMEOUT: timeoutSecs,
        GBRAIN_VERIFY_LOG_DIR: join(root, "logs"),
      },
    };
  }

  it("all checks passing → exit 0, every sentinel records 0 (not the watchdog's 143)", () => {
    const { root, env } = makeFallbackHarness();
    try {
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], { encoding: "utf8", env });
      expect(r.stderr).toMatch(/pass=\d+ fail=0/);
      expect(r.status).toBe(0);
      const exits = readdirSync(join(root, "logs")).filter((f) => f.endsWith(".exit"));
      expect(exits.length).toBeGreaterThan(10);
      for (const f of exits) {
        expect(readFileSync(join(root, "logs", f), "utf8").trim()).toBe("0");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records every check's real outcome: a self-skip is a skip (not a pass) in outcomes.tsv and the receipt", () => {
    const { root, env } = makeFallbackHarness();
    try {
      const receipts = join(root, "receipts");
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], {
        encoding: "utf8",
        env: { ...env, STUB_SKIP_CHECK: "check:grok-pin", STUB_FAIL_CHECK: "check:jsonb", GBRAIN_TEST_RECEIPT_DIR: receipts },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/fail=1 skip=1\b/);
      expect(r.stderr).toContain("check:grok-pin: subject absent in this checkout");
      const outcomes = readFileSync(join(root, "logs", "outcomes.tsv"), "utf8");
      expect(outcomes).toContain("check:grok-pin\tskip\t0\tsubject absent in this checkout");
      expect(outcomes).toContain("check:jsonb\tfail\t7\t");
      expect(outcomes).toContain("check:privacy\tpass\t0\t");
      const junit = readFileSync(join(receipts, "verify--all--primary.junit.xml"), "utf8");
      expect(junit).toContain('<testcase name="check:grok-pin" classname="verify" file="verify"><skipped message="subject absent in this checkout" /></testcase>');
      expect(junit).toContain('<testcase name="check:jsonb" classname="verify" file="verify"><failure message="fail rc=7" /></testcase>');
      expect(readFileSync(join(receipts, "verify--all--primary.receipt"), "utf8")).toContain("exit=1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps its default temp log directory when a check fails and names it", () => {
    const { root, env } = makeFallbackHarness();
    const { GBRAIN_VERIFY_LOG_DIR: _unused, ...defaults } = env;
    try {
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], {
        encoding: "utf8",
        env: { ...defaults, STUB_FAIL_CHECK: "check:jsonb" },
      });
      expect(r.status).toBe(1);
      const kept = /per-check logs kept in (\S+)/.exec(r.stderr)?.[1];
      expect(kept).toBeDefined();
      expect(readFileSync(join(kept!, "check_jsonb.log"), "utf8")).toContain("stub check failing: check:jsonb");
      rmSync(kept!, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a self-timed SOLO check starts only after every pool check has finished, and fails like any other", () => {
    const { root, env } = makeFallbackHarness();
    try {
      const log = join(root, "order.log");
      const dry = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh"), "--dry-list"], { encoding: "utf8", env }).stdout.trim().split("\n");
      expect(dry.at(-1)).toBe("check:guard-self-test");
      expect(dry.filter((c) => c === "check:guard-self-test")).toHaveLength(1);
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], {
        encoding: "utf8",
        env: { ...env, STUB_LOG: log, STUB_SLOW_CHECK: "typecheck", GBRAIN_VERIFY_MAX_PARALLEL: "4" },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/running \d+ checks: \d+ in the pool, then 1 solo/);
      const checks = new Set(dry);
      const lines = readFileSync(log, "utf8").trim().split("\n").filter((l) => checks.has(l.replace(/^(start|end) /, "")));
      const soloStart = lines.indexOf("start check:guard-self-test");
      expect(soloStart).toBeGreaterThan(-1);
      const poolEnds = lines.filter((l) => l.startsWith("end ") && l !== "end check:guard-self-test");
      expect(poolEnds).toHaveLength(dry.length - 1);
      expect(lines.slice(soloStart).filter((l) => l !== "end check:guard-self-test")).toEqual(["start check:guard-self-test"]);
      expect(lines.indexOf("end typecheck")).toBeLessThan(soloStart);
      const failing = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], {
        encoding: "utf8",
        env: { ...env, STUB_FAIL_CHECK: "check:guard-self-test" },
      });
      expect(failing.status).toBe(1);
      expect(failing.stderr).toContain("--- check:guard-self-test (rc=7)");
      expect(readFileSync(join(root, "logs", "outcomes.tsv"), "utf8")).toMatch(/^check:guard-self-test\tfail\t7\t\S+\t\d+$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("typecheck runs on every platform: only the macOS 26 workflow raises the per-check cap, Linux keeps 120 s (#6056)", () => {
    const workflows = readdirSync(".github/workflows").filter((f) => /\.ya?ml$/.test(f));
    const read = (f: string) => readFileSync(join(".github/workflows", f), "utf8");
    expect(workflows.filter((f) => read(f).includes("GBRAIN_VERIFY_TIMEOUT"))).toEqual(["macos-validation.yml"]);
    const mac = read("macos-validation.yml");
    expect(mac).toMatch(/^\s+runs-on: macos-26$/m);
    expect(mac).toMatch(/^\s+GBRAIN_VERIFY_TIMEOUT: '240'$/m);
    for (const f of workflows) expect(read(f)).not.toContain("TYPECHECK_COVERED_BY");
    expect(readFileSync(SCRIPT, "utf8")).not.toContain("TYPECHECK_COVERED_BY");
    expect(readFileSync(SCRIPT, "utf8")).toContain('TIMEOUT="${GBRAIN_VERIFY_TIMEOUT:-120}"');
    const testYml = read("test.yml");
    const verifyJob = testYml.slice(testYml.indexOf("\n  verify:\n"), testYml.indexOf("\n  verify:\n") + 4000);
    expect(verifyJob).toContain("- run: bun run verify");
    expect(verifyJob).toMatch(/runs-on: ubicloud-standard-\d+-ubuntu/);
    const dry = spawnSync("bash", [SCRIPT, "--dry-list"], { encoding: "utf8" }).stdout.split("\n");
    expect(dry).toContain("typecheck");
    const pkgScripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const [name, cmd] of Object.entries(pkgScripts)) expect(`${name}: ${cmd}`).not.toContain("GBRAIN_VERIFY_TIMEOUT");
  });

  it("one check failing → exit 1, sentinel records the check's own rc (7), not 143", () => {
    const { root, env } = makeFallbackHarness();
    try {
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], {
        encoding: "utf8",
        env: { ...env, STUB_FAIL_CHECK: "check:jsonb" },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--- check:jsonb (rc=7)");
      expect(r.stderr).toContain("stub check failing: check:jsonb");
      expect(r.stderr).toMatch(/fail=1\b/);
      expect(readFileSync(join(root, "logs", "check_jsonb.exit"), "utf8").trim()).toBe("7");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the watchdog never outlives its check: no orphaned sleep holds the caller's pipes", () => {
    const timeoutSecs = "47";
    const { root, env } = makeFallbackHarness(timeoutSecs);
    const watchdogSleeps = () => spawnSync("pgrep", ["-f", `^sleep ${timeoutSecs}$`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    try {
      const started = performance.now();
      const r = spawnSync("bash", [join(root, "scripts", "run-verify-parallel.sh")], { encoding: "utf8", env });
      expect(r.status).toBe(0);
      expect(performance.now() - started).toBeLessThan(Number(timeoutSecs) * 1000 / 2);
      if (Bun.which("pgrep")) expect(watchdogSleeps()).toEqual([]);
    } finally {
      for (const pid of watchdogSleeps()) try { process.kill(Number(pid)); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
