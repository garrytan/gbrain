/**
 * `gbrain engine swap --to rust --yes --expect <hash>` (PR S5b): every refusal comes before the first write.
 *
 * Authoring gate (docs/TESTING.md): (1) protects a brain whose swap must not start: nothing is fenced, recorded or
 * switched when the plan changed, readiness is NOT READY, the brain has folder rules or remote callers the Rust engine
 * cannot serve yet, an override still selects the old engine, another process holds the brain, the addon is missing,
 * or the caller did not approve. (2) Fails when any of these reaches the first write or gives an untyped error, or when
 * the readiness policy stops moving the plan hash. (3) The run itself is in test/engine-swap-run.serial.test.ts. (4) Seams:
 * the shadow status, the lock check and the addon check are injected; the brain is a real PGLite engine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { opError } from '../src/core/ops/contract.ts';
import { runEngineSwap, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import { brainRefFor, READINESS_POLICY, type ReadinessPolicy } from '../src/core/engine-swap/policy.ts';
import { readinessReadyFor } from './helpers/swap-ready-status.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
const READY_AT = new Date('2026-12-01T00:00:00Z');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-swap-refusals-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM access_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
  await engine.executeRaw('DELETE FROM access_rules');
});

async function run(args: string[], extra: Partial<EngineSwapCliDeps> = {}) {
  let stdout = '';
  let error = '';
  const code = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => runEngineSwap(args, {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    env: { HOME: home }, home, dataDir: home, resolveBrain: () => 'host', cliBrain: null, now: READY_AT,
    readShadowStatus: async () => readinessReadyFor(),
    out: t => { stdout += t; }, err: () => undefined,
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    run: { brainInUse: () => false, addonCheck: async () => null, ...extra.run },
    ...extra,
  }));
  return { code, stdout, error, json: () => JSON.parse(error) };
}

async function planHash(extra: Partial<EngineSwapCliDeps> = {}): Promise<string> {
  return JSON.parse((await run(['--to', 'rust', '--plan', '--json'], extra)).stdout).plan_hash;
}

/** Nothing was written: no run record, no fence row. */
async function nothingWritten(): Promise<void> {
  expect(existsSync(join(home, '.gbrain', 'engine-swap'))).toBe(false);
  const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_graduation');
  expect(row!.n).toBe(0);
}

describe('engine swap run refusals (before any write)', () => {
  test('no approval gives confirmation_required (exit 3) with the plan hash', async () => {
    const hash = await planHash();
    const r = await run(['--to', 'rust', '--json']);
    expect(r.code).toBe(3);
    expect(r.json().code).toBe('confirmation_required');
    expect(r.json().message).toContain(hash);
    expect(r.json().fix.argv).toEqual(['gbrain', 'engine', 'swap', '--to', 'rust', '--yes', '--expect', hash]);
    await nothingWritten();
  });

  test('a changed plan gives preview_changed', async () => {
    const r = await run(['--to', 'rust', '--yes', '--expect', '0000000000000000', '--json']);
    expect(r.json().code).toBe('preview_changed');
    await nothingWritten();
  });

  test('NOT READY refuses with the readiness reason and points to the report, never an override', async () => {
    const notReady = { readShadowStatus: async () => null };
    const r = await run(['--to', 'rust', '--yes', '--expect', await planHash(notReady), '--json'], notReady);
    expect(r.json().code).toBe('engine_swap_refused');
    expect(r.json().reason).toBe('no_shadow');
    await nothingWritten();
    const lagging = { readShadowStatus: async () => ({ ...readinessReadyFor(), reconcile: { consecutive_clean_full_passes: 1 } }) };
    const r2 = await run(['--to', 'rust', '--yes', '--expect', await planHash(lagging), '--json'], lagging);
    expect(r2.json().reason).toBe('not_ready');
    expect(r2.json().fix.argv).toEqual(['gbrain', 'engine', 'shadow', 'report', '--json']);
    await nothingWritten();
  });

  // A Rust build that does not serve access_control (this trunk's does: the next case): the gate this case pins.
  const NO_ACCESS = { rustServes: new Set<string>() as never };

  test('folder rules refuse with folder_rules_unserved', async () => {
    await engine.executeRaw(`INSERT INTO access_policy_state (source_id) VALUES ('default') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES ('default', 'r1', 'team/', ARRAY['alice-example'], 1)`);
    const r = await run(['--to', 'rust', '--yes', '--expect', await planHash(NO_ACCESS), '--json'], NO_ACCESS);
    expect(r.json().code).toBe('engine_swap_refused');
    expect(r.json().reason).toBe('folder_rules_unserved');
    expect(r.json().message).toContain('1 access rule row(s)');
    await nothingWritten();
  });

  test('folder rules stop blocking once the Rust engine serves access_control (the access-serves-rust member table)', async () => {
    await engine.executeRaw(`INSERT INTO access_policy_state (source_id) VALUES ('default') ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES ('default', 'r1', 'team/', ARRAY['alice-example'], 1)`);
    const blocked = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], NO_ACCESS)).stdout);
    expect(blocked.blockers.map((b: { reason: string }) => b.reason)).toEqual(['folder_rules_unserved']);
    const served = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { rustServes: new Set(['access_control']) as never })).stdout);
    expect(served.blockers).toEqual([]);
    expect(served.plan_hash).not.toBe(blocked.plan_hash);
  });

  test('an access token, an OAuth client or remote MCP refuses with remote_access_unserved', async () => {
    await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash) VALUES ('laptop', 'hash-not-a-secret')`);
    const r = await run(['--to', 'rust', '--yes', '--expect', await planHash(), '--json']);
    expect(r.json().reason).toBe('remote_access_unserved');
    expect(r.json().message).toContain('1 active access token(s)');
    expect(r.error).not.toContain('hash-not-a-secret');
    await nothingWritten();
  });

  test('an engine-selecting variable refuses with route_override and names it, never its value', async () => {
    const env = { env: { HOME: home, DATABASE_URL: 'postgresql://db.example/x?app=VALUECANARY' } };
    const r = await run(['--to', 'rust', '--yes', '--expect', await planHash(env), '--json'], env);
    expect(r.json().reason).toBe('route_override');
    expect(r.json().message).toContain('variable DATABASE_URL');
    expect(r.error).not.toContain('VALUECANARY');
    await nothingWritten();
  });

  test('another process holding the brain refuses with brain_in_use before the brain is opened', async () => {
    let opened = false;
    const r = await run(['--to', 'rust', '--yes', '--expect', 'x', '--json'], { run: { brainInUse: () => true }, openEngine: async () => { opened = true; throw new Error('opened'); } });
    expect(r.json().reason).toBe('brain_in_use');
    expect(opened).toBe(false);
    await nothingWritten();
  });

  test('a missing addon refuses with its own code', async () => {
    const r = await run(['--to', 'rust', '--yes', '--expect', await planHash(), '--json'], {
      run: { addonCheck: async () => opError('rust_engine_addon_missing', 'No Rust engine addon is installed.', 'Install it.', { reason: 'not_installed' }) },
    });
    expect(r.json().code).toBe('rust_engine_addon_missing');
    await nothingWritten();
  });

  test('--resume with no recorded run is a usage error, and --status says nothing is recorded', async () => {
    expect((await run(['--to', 'rust', '--resume', '--json'])).json().code).toBe('invalid_params');
    const s = await run(['--status', '--json']);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout)).toEqual({ schema_version: 1, run: null });
    await nothingWritten();
  });
});

describe('the readiness policy (criterion 1 minimum shadow duration)', () => {
  /** The approved policy without its dated override: the base rules these cases check (the override has its own cases). */
  const BASE: ReadinessPolicy = { ...READINESS_POLICY, overrides: [] };
  const young = { readShadowStatus: async () => ({ ...readinessReadyFor(), epoch_started_at: '2026-11-25T00:00:00Z' }) };
  const plan = async (policy: ReadinessPolicy) => JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { ...young, policy })).stdout);

  test('14 days by default: a 6-day epoch fails criterion 1', async () => {
    const p = await plan(BASE);
    expect(p.policy.text).toContain('minimum shadow duration 14 days');
    expect(p.criteria[0].state).toBe('fail');
    expect(p.criteria[0].detail).toContain('of 14 days');
  });

  test('a shorter approved duration or not_required changes the verdict and the plan hash', async () => {
    const base = await plan(BASE);
    const five = await plan({ ...BASE, shadow_min: { kind: 'days', days: 5, expires: '2026-12-15' }, approved_by: 'test' });
    expect(five.criteria[0].state).toBe('pass');
    expect(five.verdict).toBe('READY');
    expect(five.policy.hash).not.toBe(base.policy.hash);
    expect(five.plan_hash).not.toBe(base.plan_hash);
    const none = await plan({ ...BASE, shadow_min: { kind: 'not_required' }, approved_by: 'test' });
    expect(none.criteria[0].state).toBe('pass');
    expect(none.policy.text).toContain('not required');
  });

  test('the shipped dated override names its ruling and expiry, and applies to every opt-in brain', async () => {
    const p = await plan(READINESS_POLICY);
    expect(p.policy.override).toMatchObject({ id: 'c1-opt-in-short-shadow', applies: true, why: null });
    expect(p.policy.text).toContain('"Do it" (Slack channel C0CJDTJG5PE');
    expect(p.policy.text).toContain('2026-11-25 at 3:20 PM PST');
    expect(p.policy.text).toContain(READINESS_POLICY.overrides![0]!.expires);
    expect(p.policy.brain_ref).toBe(brainRefFor((await engine.readPersistenceBrainId())!));
  });

  test('bound to this brain, the dated override sets the duration, and the plan hash changes', async () => {
    const shipped = READINESS_POLICY.overrides![0]!;
    const bound: ReadinessPolicy = { ...READINESS_POLICY, overrides: [{ ...shipped, applies_to: 'brain', brain_ref: brainRefFor((await engine.readPersistenceBrainId())!), shadow_min: { kind: 'days', days: 0 } }] };
    const before = await plan(READINESS_POLICY);
    const after = await plan(bound);
    expect(after.policy.override).toMatchObject({ applies: true, why: null });
    expect(after.policy.text).toContain('this brain only');
    expect(after.criteria[0].state).toBe('pass');
    expect(after.plan_hash).not.toBe(before.plan_hash);
  });

  test('an expired value falls back to 14 days', async () => {
    const p = await plan({ ...BASE, shadow_min: { kind: 'not_required', expires: '2026-11-30' }, approved_by: 'test' });
    expect(p.policy.text).toContain('expired; 14 days applies');
    expect(p.criteria[0].state).toBe('fail');
  });

  test('no policy waives caught-up following: a lagging follower fails criterion 1 even when duration is not required', async () => {
    const lag = { readShadowStatus: async () => ({ ...readinessReadyFor(), follower: { ...readinessReadyFor().follower, queue_depth: 4 } }) };
    const p = JSON.parse((await run(['--to', 'rust', '--plan', '--json'], { ...lag, policy: { ...READINESS_POLICY, shadow_min: { kind: 'not_required' }, approved_by: 'test' } })).stdout);
    expect(p.criteria[0].state).toBe('fail');
    expect(p.reason).toBe('follower_behind');
  });
});
