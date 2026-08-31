/**
 * bootstrapDoctorChecks (doctor.ts) — the agent-bootstrap check group
 * [B2/B3/B4/ENG-4/C1 + one-live-serve].
 *
 * Covers the six checks (bootstrap_hooks_heartbeat, bootstrap_push_health,
 * bootstrap_serve_lock, bootstrap_hook_schema_pairing, bootstrap_runbook_skew,
 * bootstrap_last_verify), the no-bootstrap-state → zero-checks gate, and the
 * fail-soft catches (torn/corrupt state files degrade to warn or silence,
 * never a throw).
 *
 * Isolation: every test builds a fresh tmp GBRAIN_HOME parent and runs the
 * probe inside `withEnv({ GBRAIN_HOME: parent })` — no direct process.env
 * mutation, no PGLite engine (checks accept `engine: null`; the one
 * engine-shaped check gets a stub with just `getConfig`).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { bootstrapDoctorChecks, type Check } from '../src/commands/doctor.ts';
import { writeHarnessReceipt } from '../src/core/bootstrap/format.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { VERSION } from '../src/version.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const T = 30_000; // explicit per-test timeout — bun ignores bunfig.toml's key

// ── fixtures ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh GBRAIN_HOME parent + the effective home dir (`<parent>/.gbrain`). */
function makeHome(): { parent: string; home: string } {
  const parent = mkdtempSync(join(tmpdir(), 'gb-bdc-'));
  tmpDirs.push(parent);
  const home = join(parent, '.gbrain');
  mkdirSync(home, { recursive: true });
  return { parent, home };
}

interface HeartbeatLine {
  outcome: 'ok' | 'degraded' | 'error';
}

/** Write `<home>/integrations/hooks/heartbeat.jsonl` (rawLines appended verbatim). */
function writeHeartbeat(home: string, entries: HeartbeatLine[], rawLines: string[] = []): void {
  const dir = join(home, 'integrations', 'hooks');
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({ ts: new Date().toISOString(), event: 'session-start', outcome: e.outcome, duration_ms: 1 }),
  );
  writeFileSync(join(dir, 'heartbeat.jsonl'), [...lines, ...rawLines].join('\n') + '\n');
}

function writePushStatus(home: string, body: string): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(join(home, 'bootstrap', 'push-status.json'), body);
}

/** A valid v1 install receipt pointing at `ws` (or a receipt-shaped blob). */
function writeReceipt(home: string, ws: string): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(
    join(home, 'bootstrap', 'receipt.json'),
    JSON.stringify({
      receipt_version: 1,
      workspace_dir: ws,
      source_id: 'workspace',
      agent_name: 'Testy',
      created_at: new Date().toISOString(),
      created_by: 'test',
      brain_created_by_bootstrap: false,
      created_paths: [],
      registrations: [],
    }),
  );
}

function writeVerifyRun(home: string, name: string, body: string): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(join(home, 'bootstrap', name), body);
}

/** A workspace dir; `dirty: true` makes it a git repo with an untracked file. */
function makeWorkspace(opts: { dirty?: boolean } = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'gb-bdc-ws-'));
  tmpDirs.push(ws);
  if (opts.dirty) {
    execFileSync('git', ['init', '-q', ws], { stdio: 'ignore' });
    writeFileSync(join(ws, 'unpushed-note.md'), 'recent agent memory\n');
  }
  return ws;
}

function run(parent: string, engine: BrainEngine | null = null): Promise<Check[]> {
  return withEnv({ GBRAIN_HOME: parent }, () => bootstrapDoctorChecks(engine));
}

function byName(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

const STALE_TS = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 3 days ago

// ── the gate ────────────────────────────────────────────────────────────────

describe('no-bootstrap-state gate', () => {
  test('a home with no receipt, no push-status, no heartbeat → zero checks', async () => {
    const { parent } = makeHome();
    expect(await run(parent)).toEqual([]);
  }, T);

  test('unresolvable home (relative GBRAIN_HOME) → zero checks, no throw', async () => {
    const checks = await withEnv({ GBRAIN_HOME: 'relative/not-absolute' }, () =>
      bootstrapDoctorChecks(null),
    );
    expect(checks).toEqual([]);
  }, T);

  test('a corrupt receipt ALONE does not open the gate (readReceipt fail-soft → null)', async () => {
    const { parent, home } = makeHome();
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'receipt.json'), 'not json{{{');
    expect(await run(parent)).toEqual([]);
  }, T);

  test('a heartbeat file alone opens the gate', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const checks = await run(parent);
    expect(byName(checks, 'bootstrap_hooks_heartbeat')?.status).toBe('ok');
  }, T);

  test('a harness receipt ALONE opens the gate (#4043 — harness-only boxes get checks)', async () => {
    const { parent, home } = makeHome();
    writeHarnessReceipt(home, harnessReceiptFixture([]));
    const checks = await run(parent);
    expect(checks.length).toBeGreaterThan(0);
    expect(byName(checks, 'bootstrap_harness_health')).toBeDefined();
  }, T);
});

// ── 0. harness registration health (#4043) ─────────────────────────────────

function harnessReceiptFixture(
  targets: Array<{ state: 'pending' | 'confirmed' | 'failed' }>,
  extra: Record<string, unknown> = {},
): never {
  return {
    harness_receipt_version: 1,
    created_at: new Date().toISOString(),
    created_by: `gbrain@${VERSION}`,
    // an unroutable TEST-NET address so the /health probe fails fast + offline
    url: 'http://192.0.2.1:9/mcp',
    source_id: 'default',
    token: { name: 'bootstrap-harness', id: '33333333-3333-3333-3333-333333333333', minted: true },
    targets: targets.map((t) => ({ host: 'claude-code', kind: 'mcp', scope: 'user', name: 'gbrain', ...t })),
    ...extra,
  } as never;
}

describe('bootstrap_harness_health (#4043)', () => {
  test('failed/pending targets → fail with the converge instruction', async () => {
    const { parent, home } = makeHome();
    writeHarnessReceipt(home, harnessReceiptFixture([{ state: 'failed' }, { state: 'pending' }]));
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toMatch(/1 failed \/ 1 pending/);
  }, T);

  test('host:opencode receipt flows through host-generic filtering — failed target still fails', async () => {
    const { parent, home } = makeHome();
    const receipt = harnessReceiptFixture([{ state: 'failed' }, { state: 'confirmed' }]) as Record<string, unknown>;
    for (const t of receipt.targets as Array<Record<string, unknown>>) t.host = 'opencode';
    writeHarnessReceipt(home, receipt as never);
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toMatch(/1 failed/);
  }, T);

  test('unconverged rotation (previous_id) → fail naming the revoke command', async () => {
    const { parent, home } = makeHome();
    const receipt = harnessReceiptFixture([{ state: 'confirmed' }]) as Record<string, unknown>;
    (receipt.token as Record<string, unknown>).previous_ids = ['44444444-4444-4444-4444-444444444444'];
    writeHarnessReceipt(home, receipt as never);
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toMatch(/never revoked/);
  }, T);

  test('healthy receipt + unreachable serve → WARN (normal transient), never fail', async () => {
    const { parent, home } = makeHome();
    writeHarnessReceipt(home, harnessReceiptFixture([{ state: 'confirmed' }]));
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/serve is unreachable|not answering/);
  }, T);

  test('half-removed receipt (zero targets, minted token still live) → FAIL, never a vacuous green (red-team)', async () => {
    const { parent, home } = makeHome();
    writeHarnessReceipt(home, harnessReceiptFixture([]));
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toMatch(/removal pending/);
    expect(c?.message).toContain('33333333-3333-3333-3333-333333333333');
  }, T);

  test('unreadable harness receipt → warn, never a throw (fail-soft umbrella)', async () => {
    const { parent, home } = makeHome();
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'harness.json'), 'not json{{{');
    const checks = await run(parent);
    const c = byName(checks, 'bootstrap_harness_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/unreadable/);
  }, T);
});

// ── 1. hook heartbeat failure rate [B3] ─────────────────────────────────────

describe('bootstrap_hooks_heartbeat thresholds', () => {
  const mix = (errors: number, ok: number): HeartbeatLine[] => [
    ...Array.from({ length: errors }, () => ({ outcome: 'error' as const })),
    ...Array.from({ length: ok }, () => ({ outcome: 'ok' as const })),
  ];

  test('>0.5 hard-failure rate → fail, message carries the ratio', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, mix(6, 4));
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    expect(c?.status).toBe('fail');
    expect(c?.message).toContain('6/10');
  }, T);

  test('>0.2 and ≤0.5 → warn (hooks fail open)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, mix(3, 7));
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('3/10');
  }, T);

  test('a mostly-degraded window names the TOP reason in the healthy message (standing misconfig made visible)', async () => {
    const { parent, home } = makeHome();
    const line = (reason: string) =>
      JSON.stringify({ ts: new Date().toISOString(), event: 'session-end', outcome: 'degraded', reason, duration_ms: 1 });
    writeHeartbeat(home, [], [
      ...Array.from({ length: 8 }, () => line('scan_unavailable')),
      ...Array.from({ length: 2 }, () => line('push_unavailable')),
    ]);
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    expect(c?.status).toBe('ok'); // degraded is a designed fallback, never a failure
    expect(c?.message).toContain('10/10 degraded (top: scan_unavailable x8)');
  }, T);

  test('exactly 0.2 → ok (threshold is strictly greater-than)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, mix(2, 8));
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    expect(c?.status).toBe('ok');
  }, T);

  test('degraded entries are DESIGNED fallbacks — never counted as failures', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, Array.from({ length: 10 }, () => ({ outcome: 'degraded' as const })));
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain('0/10');
  }, T);

  test('torn heartbeat lines are skipped, valid ones still counted — no throw', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }, { outcome: 'error' }], ['{"half', 'garbage!!!', '{']);
    const c = byName(await run(parent), 'bootstrap_hooks_heartbeat');
    // 1 error / 2 valid = 0.5 → warn (not fail; torn lines don't inflate the denominator)
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('1/2');
  }, T);

  test('an ALL-torn heartbeat file opens the gate but emits no heartbeat check — no throw', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [], ['not json', '{{{{']);
    const checks = await run(parent);
    expect(byName(checks, 'bootstrap_hooks_heartbeat')).toBeUndefined();
  }, T);
});

// ── 2. push staleness [B4] ──────────────────────────────────────────────────

describe('bootstrap_push_health', () => {
  test('fresh successful push → ok', async () => {
    const { parent, home } = makeHome();
    writePushStatus(home, JSON.stringify({ ts: new Date().toISOString(), ok: true }));
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain('last push ok');
  }, T);

  test('last push FAILED → warn naming the reason (regardless of age)', async () => {
    const { parent, home } = makeHome();
    writePushStatus(home, JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'push_failed' }));
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('FAILED');
    expect(c?.message).toContain('push_failed');
  }, T);

  test('>48h stale + CLEAN tree → warn only (likely just idle)', async () => {
    const { parent, home } = makeHome();
    // No receipt → ws is null → dirty stays false: the stale-only branch.
    writePushStatus(home, JSON.stringify({ ts: STALE_TS, ok: true }));
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('>48h');
    expect(c?.message).toContain('idle');
  }, T);

  test('>48h stale + DIRTY workspace tree → fail [B4]', async () => {
    const { parent, home } = makeHome();
    const ws = makeWorkspace({ dirty: true });
    writeReceipt(home, ws);
    writePushStatus(home, JSON.stringify({ ts: STALE_TS, ok: true }));
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toContain('DIRTY');
    expect(c?.message).toContain(ws);
  }, T);

  test('unparseable ts → not stale (NaN guard) → ok', async () => {
    const { parent, home } = makeHome();
    writePushStatus(home, JSON.stringify({ ts: 'not-a-date', ok: true }));
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('ok');
  }, T);

  test('a corrupt push-status.json degrades to warn — never a throw', async () => {
    const { parent, home } = makeHome();
    writePushStatus(home, 'torn{{{not-json');
    const c = byName(await run(parent), 'bootstrap_push_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('unreadable');
  }, T);
});

// ── 3. one-live-serve / lock collision note ────────────────────────────────

describe('bootstrap_serve_lock', () => {
  function writeLock(home: string, lock: Record<string, unknown>): void {
    const lockDir = join(home, 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), JSON.stringify(lock));
  }

  test('live serve holder → ok (hook IPC available), names the pid', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]); // open the gate
    writeLock(home, { pid: process.pid, subcommand: 'serve' });
    const c = byName(await run(parent), 'bootstrap_serve_lock');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain(String(process.pid));
    expect(c?.message).toContain('live serve');
  }, T);

  test('live NON-serve holder → warn (hook IPC blocked)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    writeLock(home, { pid: process.pid, subcommand: 'sync' });
    const c = byName(await run(parent), 'bootstrap_serve_lock');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('non-serve');
  }, T);

  test('dead holder / no lock → no check (stale lock dir is inert)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const deadPid = spawnSync('true', { stdio: 'ignore' }).pid!; // exited + reaped → ESRCH
    writeLock(home, { pid: deadPid, subcommand: 'serve' });
    expect(byName(await run(parent), 'bootstrap_serve_lock')).toBeUndefined();
  }, T);

  test('a corrupt lock file probes to null — no check, no throw', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const lockDir = join(home, 'brain.pglite', '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'lock'), 'not json{{{');
    expect(byName(await run(parent), 'bootstrap_serve_lock')).toBeUndefined();
  }, T);
});

// ── 4. hooks-in-use + unmigrated brain pairing [ENG-4] ─────────────────────

describe('bootstrap_hook_schema_pairing', () => {
  const stubEngine = (getConfig: (key: string) => Promise<string | null>): BrainEngine =>
    ({ getConfig } as unknown as BrainEngine);

  test('hooks seen + stale schema → warn naming apply-migrations', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]); // hooksSeen = true
    const engine = stubEngine(async () => '1'); // v1 < LATEST_VERSION
    const c = byName(await run(parent, engine), 'bootstrap_hook_schema_pairing');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain(`v${LATEST_VERSION}`);
    expect(c?.message).toContain('apply-migrations');
  }, T);

  test('hooks seen + current schema → no pairing check', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const engine = stubEngine(async () => String(LATEST_VERSION));
    expect(byName(await run(parent, engine), 'bootstrap_hook_schema_pairing')).toBeUndefined();
  }, T);

  test('null engine → no pairing check (heartbeat check still emitted)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const checks = await run(parent, null);
    expect(byName(checks, 'bootstrap_hook_schema_pairing')).toBeUndefined();
    expect(byName(checks, 'bootstrap_hooks_heartbeat')).toBeDefined();
  }, T);

  test('getConfig throwing is swallowed — no pairing check, no throw', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const engine = stubEngine(async () => {
      throw new Error('schema_version unreadable');
    });
    expect(byName(await run(parent, engine), 'bootstrap_hook_schema_pairing')).toBeUndefined();
  }, T);
});

// ── 5. runbook skew [C1] ────────────────────────────────────────────────────

describe('bootstrap_runbook_skew', () => {
  test('stamp != binary version → warn carrying both', async () => {
    const { parent, home } = makeHome();
    const ws = makeWorkspace();
    writeReceipt(home, ws);
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), '<!-- gbrain-runbook-stamp: 0.0.1 -->\n# runbook\n');
    const c = byName(await run(parent), 'bootstrap_runbook_skew');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('0.0.1');
    expect(c?.message).toContain(VERSION);
  }, T);

  test('matching stamp → no check; absent runbook → no check', async () => {
    const { parent, home } = makeHome();
    const ws = makeWorkspace();
    writeReceipt(home, ws);
    expect(byName(await run(parent), 'bootstrap_runbook_skew')).toBeUndefined();
    writeFileSync(join(ws, 'BOOTSTRAP_FOR_AGENTS.md'), `<!-- gbrain-runbook-stamp: ${VERSION} -->\n`);
    expect(byName(await run(parent), 'bootstrap_runbook_skew')).toBeUndefined();
  }, T);
});

// ── 6. last verify freshness [B2 read side] ─────────────────────────────────

describe('bootstrap_last_verify', () => {
  test('last verify FAILED → warn naming the failed check ids', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]); // verify snapshots alone don't open the gate
    writeVerifyRun(
      home,
      'verify-2026-01-01T00-00-00-000Z.json',
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ok: false, checks: [{ id: 'roundtrip', ok: false }] }),
    );
    const c = byName(await run(parent), 'bootstrap_last_verify');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('FAILED');
    expect(c?.message).toContain('roundtrip');
  }, T);

  test('passed >14 days ago → warn (workspace rot self-check nag)', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    const oldTs = new Date(Date.now() - 20 * 86_400_000).toISOString();
    writeVerifyRun(
      home,
      'verify-2026-01-02T00-00-00-000Z.json',
      JSON.stringify({ ts: oldTs, ok: true, checks: [] }),
    );
    const c = byName(await run(parent), 'bootstrap_last_verify');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('d ago');
  }, T);

  test('recent pass → ok; the NEWEST run (by filename) wins over an older failure', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]);
    writeVerifyRun(
      home,
      'verify-2026-01-01T00-00-00-000Z.json',
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', ok: false, checks: [{ id: 'roundtrip', ok: false }] }),
    );
    const freshTs = new Date().toISOString();
    writeVerifyRun(
      home,
      'verify-2026-06-01T00-00-00-000Z.json',
      JSON.stringify({ ts: freshTs, ok: true, checks: [] }),
    );
    const c = byName(await run(parent), 'bootstrap_last_verify');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain(freshTs);
  }, T);

  test('an unreadable snapshot is skipped; corrupt-only → no check, no throw', async () => {
    const { parent, home } = makeHome();
    writeHeartbeat(home, [{ outcome: 'ok' }]); // keep the gate open
    writeVerifyRun(home, 'verify-2026-01-01T00-00-00-000Z.json', 'torn{{{');
    expect(byName(await run(parent), 'bootstrap_last_verify')).toBeUndefined();
  }, T);
});

// ── everything torn at once — the fail-soft umbrella ────────────────────────

// ── bootstrap_durability_job [B7/D7] ────────────────────────────────────────
//
// Presence-only checks certify dead jobs as healthy, so the doctor probes
// consent + liveness. These pin the two branch families a unit test can hold
// deterministically: the non-local environment (no scheduler EXPECTED — ok)
// and the consented-but-missing job (warn naming `gbrain sources harden`).

describe('bootstrap_durability_job [B7/D7]', () => {
  /** Env keys that would flip detectExecutionEnvironment away from local. */
  const NEUTRAL_ENV = {
    CLAUDE_CODE_REMOTE: undefined,
    CLAUDE_CODE_REMOTE_SESSION_ID: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    https_proxy: undefined,
    HTTPS_PROXY: undefined,
    RENDER: undefined,
    RAILWAY_ENVIRONMENT: undefined,
    FLY_APP_NAME: undefined,
  } as const;

  function writeConsent(ws: string, value: 'yes' | 'no'): void {
    mkdirSync(join(ws, 'state'), { recursive: true });
    writeFileSync(
      join(ws, 'state', 'interview.json'),
      JSON.stringify({ version: 1, answers: { PERSIST_CRON: { value, set_at: new Date().toISOString() } } }),
    );
  }

  test('cloud sandbox: no scheduler is EXPECTED → ok naming the environment, never a warn', async () => {
    const { parent, home } = makeHome();
    const ws = makeWorkspace();
    writeReceipt(home, ws);
    writeConsent(ws, 'yes'); // even with consent, a cloud sandbox has no scheduler to check
    const checks = await withEnv(
      { GBRAIN_HOME: parent, CLAUDE_CODE_REMOTE: 'true' },
      () => bootstrapDoctorChecks(null),
    );
    const c = byName(checks, 'bootstrap_durability_job');
    expect(c?.status).toBe('ok');
    expect(c?.message).toContain('no scheduler in this environment');
    expect(c?.message).toContain('cloud-sandbox');
  }, T);

  test('local + PERSIST_CRON=yes but NO scheduled job on disk → warn naming `gbrain sources harden`', async () => {
    const { parent, home } = makeHome();
    const ws = makeWorkspace();
    writeReceipt(home, ws);
    writeConsent(ws, 'yes');
    // HOME redirected: the launchd-plist / pull-log probes must never read the
    // real machine's LaunchAgents (a developer's own gbrain install would flip
    // the verdict). Fresh empty HOME → durabilityJobStatus kind 'none'.
    const fakeHome = mkdtempSync(join(tmpdir(), 'gb-bdc-fakehome-'));
    tmpDirs.push(fakeHome);
    const checks = await withEnv(
      { ...NEUTRAL_ENV, GBRAIN_HOME: parent, HOME: fakeHome },
      () => bootstrapDoctorChecks(null),
    );
    const c = byName(checks, 'bootstrap_durability_job');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('PERSIST_CRON=yes');
    expect(c?.message).toContain('gbrain sources harden workspace');
  }, T);
});

describe('fail-soft umbrella', () => {
  test('corrupt receipt + torn heartbeat + corrupt push-status + torn verify → warns, never throws', async () => {
    const { parent, home } = makeHome();
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'receipt.json'), '{"receipt_version":'); // torn
    writeHeartbeat(home, [], ['{"half', 'garbage']);
    writePushStatus(home, 'also not json');
    writeVerifyRun(home, 'verify-2026-01-01T00-00-00-000Z.json', '{{{{');
    const checks = await run(parent);
    // The only surviving signal is the push-status warn; nothing throws.
    expect(byName(checks, 'bootstrap_push_health')?.status).toBe('warn');
    expect(checks.every((c) => c.name.startsWith('bootstrap_'))).toBe(true);
    expect(checks.some((c) => c.status === 'fail')).toBe(false);
  }, T);
});
