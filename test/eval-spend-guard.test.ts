/**
 * scripts/eval-spend-guard.sh — subprocess pins with a temp ledger.
 *
 * Hermetic: the wrapped "paid command" is a shell one-liner that writes a
 * marker file (proving it ran) and optionally an actual-cost file. Env is
 * passed to spawn/spawnSync, never mutated on process.env.
 *
 * Every launch writes TWO ledger rows sharing a run_id: a `running`
 * reservation (cost = estimate) BEFORE the command starts and a `done`
 * reconciliation after it exits. `doneRows()` is the recorded outcome;
 * `ledgerRows()` is the raw file.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/eval-spend-guard.sh');

// A chmod-444 file is still appendable under CAP_DAC_OVERRIDE (root, some
// sandboxes); the unwritable-ledger pin needs the kernel to honor the bits.
function permissionsEnforced(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-spend-guard-probe-'));
  try {
    const f = join(d, 'ro');
    writeFileSync(f, '');
    chmodSync(f, 0o444);
    try {
      appendFileSync(f, 'x');
      return false;
    } catch {
      return true;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const PERMS_ENFORCED = permissionsEnforced();

// Same idea for READ bits: a chmod-000 file is still readable under
// CAP_DAC_OVERRIDE; the unreadable-ledger pin needs the kernel to honor it.
function readPermissionsEnforced(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-spend-guard-probe-'));
  try {
    const f = join(d, 'noread');
    writeFileSync(f, '{"cost_usd":1}\n');
    chmodSync(f, 0o000);
    try {
      readFileSync(f);
      return false;
    } catch {
      return true;
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const READ_PERMS_ENFORCED = readPermissionsEnforced();

let dir: string;
let ledger: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-spend-guard-'));
  ledger = join(dir, 'receipts', 'spend.jsonl');
  // The guard requires the ledger to EXIST (a missing ledger is not a $0
  // ledger). Every test starts from an empty, present ledger; the missing-
  // ledger behaviour has its own tests below, which remove it first.
  mkdirSync(join(dir, 'receipts'), { recursive: true });
  writeFileSync(ledger, '');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function guardEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    TMPDIR: dir,
    GBRAIN_EVAL_SPEND_LEDGER: ledger,
    ...extraEnv,
  };
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf-8', env: guardEnv(extraEnv) });
}

/** Async launch for the in-flight / signal pins. */
function start(args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawn('bash', [SCRIPT, ...args], { cwd: ROOT, env: guardEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, stderr: () => stderr };
}

async function waitFor(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function ledgerRows(): Array<Record<string, unknown>> {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
const doneRows = () => ledgerRows().filter((r) => r.status === 'done');
const runningRows = () => ledgerRows().filter((r) => r.status === 'running');

describe('eval-spend-guard.sh', () => {
  test('under cap: runs the command; reservation row then reconciliation row share a run_id', () => {
    const marker = join(dir, 'ran.txt');
    const r = run(['75', '3', '--', 'sh', '-c', `echo ok > "${marker}"`]);
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(r.stderr).toContain('launching');
    expect(r.stderr).toContain('reserved $3.000000');
    expect(r.stderr).toContain('recorded cost $3.000000 (exit 0); ledger now $3.000000');
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    const [reserved, done] = rows;
    expect(reserved.status).toBe('running');
    expect(reserved.estimate_usd).toBe(3);
    expect(reserved.cost_usd).toBe(3);
    expect(reserved.exit_code).toBeNull();
    expect(typeof reserved.run_id).toBe('string');
    expect(String(reserved.run_id).length).toBeGreaterThan(8);
    expect(done.status).toBe('done');
    expect(done.run_id).toBe(reserved.run_id);
    expect(done.estimate_usd).toBe(3);
    expect(done.cost_usd).toBe(3);
    expect(done.exit_code).toBe(0);
    for (const row of rows) {
      expect(String(row.command)).toContain('echo ok');
      expect(String(row.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  test('over cap: refuses with exit 3, never runs the command, appends nothing', () => {
    // seed the ledger at $73.50 across two rows (one with an exponent form)
    writeFileSync(
      ledger,
      '{"ts":"2026-09-04T00:00:00Z","estimate_usd":70,"cost_usd":70.25,"exit_code":0,"command":"x"}\n' +
        '{"ts":"2026-09-04T00:00:01Z","estimate_usd":3,"cost_usd":3.25e0,"exit_code":0,"command":"y"}\n',
    );
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '2', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain('REFUSED');
    expect(r.stderr).toContain('75.5');
    expect(ledgerRows().length).toBe(2);
  });

  test('exactly at cap is allowed (ledger + estimate == cap)', () => {
    writeFileSync(ledger, '{"cost_usd":72}\n');
    const r = run(['75', '3', '--', 'true']);
    expect(r.status).toBe(0);
    expect(ledgerRows().length).toBe(3);
  });

  test('actual-cost file written by the command overrides the estimate (bare number)', () => {
    const costFile = join(dir, 'actual.txt');
    const r = run(['75', '3', '--', 'sh', '-c', `printf '1.2345\\n' > "$GBRAIN_EVAL_ACTUAL_COST_FILE"`], {
      GBRAIN_EVAL_ACTUAL_COST_FILE: costFile,
    });
    expect(r.status).toBe(0);
    const [done] = doneRows();
    expect(done.estimate_usd).toBe(3);
    expect(done.cost_usd).toBe(1.2345);
    expect(runningRows()[0].cost_usd).toBe(3); // the reservation keeps the estimate
  });

  test('actual-cost file as JSON {cost_usd} is honored; unset env gets a scratch path exported to the child', () => {
    const r = run([
      '75',
      '3',
      '--',
      'sh',
      '-c',
      `test -n "$GBRAIN_EVAL_ACTUAL_COST_FILE" && printf '{"cost_usd": 0.5, "note":"x"}' > "$GBRAIN_EVAL_ACTUAL_COST_FILE"`,
    ]);
    expect(r.status).toBe(0);
    expect(doneRows()[0].cost_usd).toBe(0.5);
  });

  test('command failure: exit code propagates and is recorded', () => {
    const r = run(['75', '1', '--', 'sh', '-c', 'exit 7']);
    expect(r.status).toBe(7);
    expect(doneRows()[0].exit_code).toBe(7);
  });

  test('command text with quotes and backslashes yields valid JSON', () => {
    const r = run(['75', '1', '--', 'sh', '-c', 'echo "a \\"b\\" \\\\ c"']);
    expect(r.status).toBe(0);
    const rows = ledgerRows(); // JSON.parse would have thrown on a bad line
    expect(rows.length).toBe(2);
    expect(String(rows[0].command)).toContain('echo');
  });

  test('usage errors exit 2 (missing --, non-numeric cap)', () => {
    expect(run(['75', '1', 'true']).status).toBe(2);
    expect(run(['abc', '1', '--', 'true']).status).toBe(2);
    expect(run(['75', 'x', '--', 'true']).status).toBe(2);
    expect(ledgerRows().length).toBe(0);
  });

  test('ledger rows accumulate across runs and drive the next decision', () => {
    expect(run(['10', '6', '--', 'true']).status).toBe(0);
    expect(run(['10', '3', '--', 'true']).status).toBe(0);
    const r = run(['10', '2', '--', 'true']); // 9 + 2 > 10
    expect(r.status).toBe(3);
    expect(ledgerRows().length).toBe(4);
  });

  // ── reservation / reconciliation (fail closed in TIME) ──────────────────

  test('the reservation is on the ledger while the command runs, blocks a concurrent guard, and is superseded by the reconciliation', async () => {
    const g = start(['10', '6', '--', 'sh', '-c', 'sleep 2; printf 2 > "$GBRAIN_EVAL_ACTUAL_COST_FILE"']);
    await waitFor(() => runningRows().length === 1, 'the reservation row');
    const [reserved] = ledgerRows();
    expect(ledgerRows().length).toBe(1);
    expect(reserved.status).toBe('running');
    expect(reserved.cost_usd).toBe(6);
    expect(reserved.exit_code).toBeNull();

    // A concurrent guard sees $6 in flight: 6 + 5 > 10 → refused, nothing run.
    const marker = join(dir, 'should-not-exist.txt');
    const c = run(['10', '5', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(c.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(c.stderr).toContain('ledger $6.000000 + estimate $5.000000');
    expect(c.stderr).toContain('1 in-flight reservation(s)');

    const { code } = await g.exit;
    expect(code).toBe(0);
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows[1].status).toBe('done');
    expect(rows[1].run_id).toBe(reserved.run_id);
    expect(rows[1].cost_usd).toBe(2);
    expect(rows[1].exit_code).toBe(0);
    expect(g.stderr()).toContain('ledger now $2.000000');

    // Reconciled total is $2 (NOT 6 + 2): 2 + 8 == 10 is allowed.
    const n = run(['10', '8', '--', 'true']);
    expect(n.status).toBe(0);
    expect(n.stderr).toContain('ledger $2.000000 (2 row(s))');
    expect(n.stderr).not.toContain('in-flight');
  });

  test('a SIGTERMed guard stops the command and reconciles at the estimate (exit 143)', async () => {
    const g = start(['10', '4', '--', 'sleep', '30']);
    // Deterministic: the `reserved $` line is printed AFTER the reservation
    // row lands and the traps are armed, so the signal can never race the
    // guard's own setup (the pre-fix flake: traps were installed after the
    // append, and a TERM in that window left the reservation unreconciled).
    await waitFor(() => g.stderr().includes('reserved $4.000000'), "the 'reserved $' line");
    expect(runningRows().length).toBe(1);
    const t0 = Date.now();
    g.child.kill('SIGTERM');
    const { code } = await g.exit;
    expect(code).toBe(143);
    expect(Date.now() - t0).toBeLessThan(10_000); // the child was killed, not waited out
    expect(g.stderr()).toContain('interrupted (signal 15)');
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows[1].status).toBe('done');
    expect(rows[1].run_id).toBe(rows[0].run_id);
    expect(rows[1].cost_usd).toBe(4); // the estimate
    expect(rows[1].exit_code).toBe(143);
    // …and that spend drives the next decision: 4 + 7 > 10.
    expect(run(['10', '7', '--', 'true']).status).toBe(3);
    expect(run(['10', '6', '--', 'true']).status).toBe(0);
  });

  test('a SIGKILLed guard leaves its reservation counted at the estimate for the next guard', async () => {
    const g = start(['10', '4', '--', 'sleep', '3']);
    await waitFor(() => runningRows().length === 1, 'the reservation row');
    g.child.kill('SIGKILL');
    const { signal } = await g.exit;
    expect(signal).toBe('SIGKILL');
    expect(ledgerRows().length).toBe(1); // no reconciliation could be written
    const r = run(['10', '7', '--', 'true']); // 4 (in flight forever) + 7 > 10
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('1 in-flight reservation(s)');
    const ok = run(['10', '6', '--', 'true']);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain('1 in-flight reservation(s) counted at their estimate');
  });

  test('a command that ignores SIGTERM is SIGKILLed after the grace period; the guard still reconciles (exit 143)', async () => {
    // The child traps TERM and would sleep on forever; with the grace knob at
    // 1 s the guard escalates to KILL instead of waiting unbounded.
    const g = start(['10', '4', '--', 'bash', '-c', 'trap "" TERM; sleep 30'], { GBRAIN_EVAL_SPEND_GUARD_KILL_GRACE_SECONDS: '1' });
    await waitFor(() => g.stderr().includes('reserved $4.000000'), "the 'reserved $' line");
    // Let the child install its trap before we signal.
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    g.child.kill('SIGTERM');
    const { code } = await g.exit;
    const elapsed = Date.now() - t0;
    expect(code).toBe(143);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(8_000); // not the child's 30 s
    expect(g.stderr()).toContain('did not exit within 1s of SIGTERM — sending SIGKILL');
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows[1].status).toBe('done');
    expect(rows[1].cost_usd).toBe(4);
    expect(rows[1].exit_code).toBe(143);
  }, 15_000);

  test.skipIf(!READ_PERMS_ENFORCED)('an existing but unreadable ledger refuses the launch (exit 3) instead of auditing as $0', () => {
    // gawk exits 0 with an all-zero END line on a file it cannot open — pre-fix
    // that read as "$0 spent" and the launch proceeded against an empty audit.
    writeFileSync(ledger, '{"cost_usd":70}\n');
    chmodSync(ledger, 0o000);
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain('cannot audit ledger');
    expect(r.stderr).toContain('not readable');
    expect(r.stderr).toContain('command NOT run');
    expect(r.stderr).not.toContain('launching');
    chmodSync(ledger, 0o644);
    expect(ledgerRows().length).toBe(1); // nothing appended
  });

  test('an audit awk cannot vouch for (non-zero exit, or a malformed audit line) refuses the launch — never a $0 read', () => {
    // Perms-independent twin of the unreadable-ledger pin: a PATH shim replaces
    // awk ONLY for the ledger-audit call (every other awk use — norm6, the cap
    // arithmetic — delegates to the real binary).
    const realAwk = spawnSync('bash', ['-c', 'command -v awk'], { encoding: 'utf-8' }).stdout.trim();
    expect(realAwk.length).toBeGreaterThan(0);
    const shimDir = join(dir, 'shim');
    mkdirSync(shimDir);
    const shim = (body: string) => {
      writeFileSync(
        join(shimDir, 'awk'),
        `#!/bin/bash\nfor a in "$@"; do case "$a" in *spend.jsonl) ${body} ;; esac; done\nexec "${realAwk}" "$@"\n`,
      );
      chmodSync(join(shimDir, 'awk'), 0o755);
    };
    writeFileSync(ledger, '{"cost_usd":70}\n');
    const marker = join(dir, 'should-not-exist.txt');
    const env = { PATH: `${shimDir}:${process.env.PATH ?? '/usr/bin:/bin'}` };

    // awk dies mid-audit (e.g. an I/O error): refused, nothing appended.
    shim('exit 2');
    const r1 = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`], env);
    expect(r1.status).toBe(3);
    expect(r1.stderr).toContain('cannot audit ledger');
    expect(r1.stderr).toContain('awk exited 2');
    expect(existsSync(marker)).toBe(false);

    // awk exits 0 but prints an EMPTY line (the gawk unreadable-file shape).
    shim('echo ""; exit 0');
    const r2 = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`], env);
    expect(r2.status).toBe(3);
    expect(r2.stderr).toContain('audit line is malformed');
    expect(r2.stderr).not.toContain('launching');

    // …or a non-numeric total.
    shim('echo "1 1 NaN 0"; exit 0');
    const r3 = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`], env);
    expect(r3.status).toBe(3);
    expect(r3.stderr).toContain('audit line is malformed');
    expect(existsSync(marker)).toBe(false);
    expect(ledgerRows().length).toBe(1); // untouched throughout

    // Control: the real awk through the same PATH still launches (70 + 1 <= 75).
    rmSync(join(shimDir, 'awk'));
    const ok = run(['75', '1', '--', 'true'], env);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain('ledger $70.000000 (1 row(s))');
  });

  test('command text with tabs, CR and other control characters is escaped into valid JSON (no GNU-sed \\t dependency)', () => {
    const r = run(['75', '1', '--', 'sh', '-c', 'true # tab\there cr\rhere bell\u0001here']);
    expect(r.status).toBe(0);
    const raw = readFileSync(ledger, 'utf-8');
    expect(raw).toContain('tab\\there');
    expect(raw).toContain('cr\\rhere');
    expect(raw).toContain('bell\\u0001here');
    // No raw control byte reached the file …
    expect(/[\u0000-\u001f]/.test(raw.replace(/\n/g, ''))).toBe(false);
    // … and JSON.parse round-trips the exact command text.
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    for (const row of rows) expect(String(row.command)).toBe('sh -c true # tab\there cr\rhere bell\u0001here');
  });

  test('audit: legacy rows are final, an orphan reservation counts, a reconciled reservation does not, a run_id-less running row is final', () => {
    writeFileSync(
      ledger,
      '{"cost_usd":3}\n' + // legacy row (no run_id/status)
        '{"run_id":"dead-guard","status":"running","estimate_usd":4,"cost_usd":4,"exit_code":null}\n' +
        '{"run_id":"b","status":"running","estimate_usd":9,"cost_usd":9,"exit_code":null}\n' +
        '{"run_id":"b","status":"done","estimate_usd":9,"cost_usd":1,"exit_code":0}\n' +
        '{"status":"running","cost_usd":0.5}\n', // can never be reconciled → final
    );
    // 3 + 4 + 1 + 0.5 = 8.5; the $9 reservation for run b is superseded.
    const r = run(['10', '1.5', '--', 'true']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ledger $8.500000 (5 row(s))');
    expect(r.stderr).toContain('1 in-flight reservation(s)');
    expect(run(['10', '1', '--', 'true']).status).toBe(3); // 10 + 1 > 10
  });

  test.skipIf(!PERMS_ENFORCED)('an unwritable ledger refuses the launch (exit 3): a run that is not on the books cannot be capped', () => {
    writeFileSync(ledger, '{"cost_usd":1}\n');
    chmodSync(ledger, 0o444);
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain('cannot append the reservation row');
    expect(r.stderr).toContain('command NOT run');
    expect(ledgerRows().length).toBe(1); // unchanged
  });

  // ── fail-closed ledger integrity ─────────────────────────────────────────

  test('a truncated ledger line refuses to launch (exit 3) naming the line, and never runs the command', () => {
    writeFileSync(
      ledger,
      '{"ts":"2026-09-04T00:00:00Z","estimate_usd":3,"cost_usd":3.25,"exit_code":0,"command":"x"}\n' +
        '{"ts":"2026-09-04T00:00:01Z","estimate_usd":70,"cost_usd":70\n', // killed mid-write: no closing brace
    );
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain('unparseable line(s)');
    expect(r.stderr).toContain('line numbers: 2');
    // nothing appended
    expect(readFileSync(ledger, 'utf-8').split('\n').filter((l) => l.length > 0).length).toBe(2);
  });

  test('a string-typed cost_usd is unparseable, not silently $0 (exit 3, no launch)', () => {
    // Pre-fix this row was dropped by the grep and the ledger read as $3.25 —
    // fail OPEN. The 70 in the string row is exactly the spend that would blow the cap.
    writeFileSync(ledger, '{"cost_usd":3.25}\n{"cost_usd":"70"}\n{"cost_usd":1}\n');
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(r.stderr).toContain('line numbers: 2');
  });

  test('a signed / negative ledger cost is unparseable too (a negative row would drive the total backwards)', () => {
    writeFileSync(ledger, '{"cost_usd":-70}\n{"cost_usd":+1}\n{"cost_usd":2}\n');
    const r = run(['75', '1', '--', 'true']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('2 unparseable line(s) out of 3');
    expect(r.stderr).toContain('line numbers: 1,2');
  });

  test('blank lines are tolerated; a valid ledger with whitespace and exponent forms sums exactly', () => {
    writeFileSync(ledger, '\n{"cost_usd": 1.5 , "x":1}\n\n{ "cost_usd":2.5e0}\n   \n');
    const r = run(['5', '1', '--', 'true']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('ledger $4.000000 (2 row(s))');
    expect(run(['5', '1', '--', 'true']).status).toBe(3); // 5 + 1 > 5
  });

  // ── unsigned-only amounts + %.6f normalization ──────────────────────────

  test('signed or malformed estimate / cap is a usage error (exit 2), nothing launches, nothing is written', () => {
    const marker = join(dir, 'should-not-exist.txt');
    for (const [cap, est] of [
      ['75', '-1'],
      ['75', '+1'],
      ['-75', '1'],
      ['75', '1e'],
      ['75', 'e5'],
      ['75', '1.2.3'],
      ['75', 'NaN'],
      ['75', 'inf'],
    ]) {
      const r = run([cap, est, '--', 'sh', '-c', `echo no > "${marker}"`]);
      expect(r.status, `${cap} ${est}`).toBe(2);
      expect(r.stderr, `${cap} ${est}`).toContain('not an unsigned number');
    }
    expect(existsSync(marker)).toBe(false);
    expect(ledgerRows().length).toBe(0);
  });

  test("estimate forms '1.', '.5' and '2e-1' are accepted and written as valid JSON numbers", () => {
    expect(run(['75', '1.', '--', 'true']).status).toBe(0);
    expect(run(['75', '.5', '--', 'true']).status).toBe(0);
    expect(run(['75', '2e-1', '--', 'true']).status).toBe(0);
    const rows = doneRows(); // JSON.parse would throw on `1.` or `.5`
    expect(rows.map((r) => r.estimate_usd)).toEqual([1, 0.5, 0.2]);
    expect(rows.map((r) => r.cost_usd)).toEqual([1, 0.5, 0.2]);
    const raw = readFileSync(ledger, 'utf-8');
    expect(raw).toContain('"estimate_usd":1.000000,"cost_usd":1.000000');
    expect(raw).toContain('"estimate_usd":0.500000,"cost_usd":0.500000');
    // …and the next decision sums them (1.7) correctly.
    const r = run(['2', '0.5', '--', 'true']); // 1.7 + 0.5 > 2
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('ledger $1.700000');
  });

  test("a cost file of '1.' / '.5' is normalized before it is written", () => {
    const costFile = join(dir, 'actual.txt');
    const r = run(['75', '3', '--', 'sh', '-c', `printf '.5' > "$GBRAIN_EVAL_ACTUAL_COST_FILE"`], {
      GBRAIN_EVAL_ACTUAL_COST_FILE: costFile,
    });
    expect(r.status).toBe(0);
    expect(readFileSync(ledger, 'utf-8')).toContain('"cost_usd":0.500000');
    expect(doneRows()[0].cost_usd).toBe(0.5);
  });

  test('a negative, signed, zero, or string-typed actual cost falls back to the estimate', () => {
    const cases: Array<[string, string]> = [
      ['-2', 'unreadable'], // signed bare number: rejected by is_number, not parsed as -2
      ['+2', 'unreadable'],
      ['0', 'non-positive'],
      ['{"cost_usd":"2"}', 'unreadable'],
      ['{"cost_usd":-0.5}', 'unreadable'],
      ['{"cost_usd":0}', 'non-positive'],
      ['garbage', 'unreadable'],
    ];
    for (const [payload, note] of cases) {
      writeFileSync(ledger, '');
      const costFile = join(dir, 'actual.txt');
      const r = run(['75', '3', '--', 'sh', '-c', `printf '%s' '${payload}' > "$GBRAIN_EVAL_ACTUAL_COST_FILE"`], {
        GBRAIN_EVAL_ACTUAL_COST_FILE: costFile,
      });
      expect(r.status, payload).toBe(0);
      expect(r.stderr, payload).toContain(note);
      expect(r.stderr, payload).toContain('estimate');
      const rows = doneRows();
      expect(rows.length, payload).toBe(1);
      expect(rows[0].cost_usd, payload).toBe(3); // the estimate, never a negative or zero row
      rmSync(costFile, { force: true });
    }
  });

  // ── ledger existence ─────────────────────────────────────────────────────

  test('a missing ledger refuses to launch (exit 3) and prints the resolved path', () => {
    rmSync(ledger, { force: true });
    const marker = join(dir, 'should-not-exist.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo no > "${marker}"`]);
    expect(r.status).toBe(3);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(ledger)).toBe(false); // NOT silently created
    expect(r.stderr).toContain('ledger does not exist');
    expect(r.stderr).toContain(ledger);
    expect(r.stderr).toContain('GBRAIN_EVAL_SPEND_LEDGER_INIT=1');
  });

  test('the default ledger path (no env override) is also required to exist', () => {
    rmSync(ledger, { force: true });
    const r = spawnSync('bash', [SCRIPT, '75', '1', '--', 'true'], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TMPDIR: dir },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain(join(dir, 'gbrain-lme-receipts', 'spend.jsonl'));
  });

  test('GBRAIN_EVAL_SPEND_LEDGER_INIT=1 creates the ledger with a loud NEW LEDGER line, then launches', () => {
    rmSync(join(dir, 'receipts'), { recursive: true, force: true });
    const marker = join(dir, 'ran.txt');
    const r = run(['75', '1', '--', 'sh', '-c', `echo ok > "${marker}"`], { GBRAIN_EVAL_SPEND_LEDGER_INIT: '1' });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(r.stderr).toContain('NEW LEDGER');
    expect(r.stderr).toContain(ledger);
    expect(ledgerRows().length).toBe(2);
    // A second run with INIT still set does NOT re-announce (the file exists now).
    const r2 = run(['75', '1', '--', 'true'], { GBRAIN_EVAL_SPEND_LEDGER_INIT: '1' });
    expect(r2.status).toBe(0);
    expect(r2.stderr).not.toContain('NEW LEDGER');
    expect(ledgerRows().length).toBe(4);
  });
});
