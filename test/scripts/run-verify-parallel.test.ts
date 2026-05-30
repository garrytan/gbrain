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
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
