/**
 * Swap readiness for a brain written from many machines (lane L5, docs/designs/rust-engine/multi-user-server.md "M3").
 *
 * Authoring gate (docs/TESTING.md): (1) protects the one place `gbrain engine swap --to rust --plan` may stop refusing
 * `multiple_writer_hosts`: the multi-user switch (GBRAIN_RUST_MULTIUSER=1) is on AND the destination, read from the
 * destination itself, is a served multi-user Rust brain serving this brain. (2) Fails when the refusal lifts with the
 * switch off, with missing, embedded (not served), single-user or wrong-brain evidence, when the destination is read
 * from the current engine instead of the destination, or when anything differs with the switch off (JSON bytes and
 * plan hash). (3) The public command is driven here; readiness and plan units are covered in
 * engine-swap-readiness.test.ts and engine-swap-cli.test.ts. This proves eligibility only: moving a two-host brain
 * through shadow mode and back is a separate acceptance item that waits for the server (lane L3). (4) Seam: the
 * injected destination probe stands in for the server until it exists; the switch is set with withEnv.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import type { SwapDestinationProbe } from '../src/core/engine-swap/destination.ts';
import type { ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { withEnv } from './helpers/with-env.ts';

const NOW = new Date('2026-12-01T00:00:00Z');
const SWITCH = 'GBRAIN_RUST_MULTIUSER';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-swap-multi-'));
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

/** A status document that passes every criterion, with writers on `hosts` machines. */
function status(hosts: number | null): ShadowStatus {
  return {
    epoch_id: 'e1', epoch_started_at: '2026-11-10T00:00:00Z',
    follower: { state: 'following', lag_ms: 0, lag_ms_p99_24h: 900, lag_ms_p99_epoch: 1200, queue_depth: 0, applied_rows: 5000, coverage_watermark: { valid: true, through: 'x', invalidated_reason: null } },
    reconcile: { state: 'idle', consecutive_clean_full_passes: 3 },
    write_comparisons: { state: 'on', sample_rate: 1, comparable: 1500, unexplained_difference: 0, uncomparable: 2, capability_missing: 0 },
    fingerprints: { checked_rows: 900, mismatches: 0, probe: { state: 'pass', checked_at: '2026-11-30T00:00:00Z', server_version: '16', collation: 'C' } },
    allocators: { verified: true, checked_at: '2026-11-30T00:00:00Z' },
    seed: { seed_id: 's', finished_at: '2026-11-10T01:00:00Z', unseeded_gap_rows_total: 0 },
    reads: { ops: [{ op: 'search', successful: 8000, minimum: 1000 }, { op: 'get_page', successful: 4000, minimum: 1000 }], capability_missing_7d: 0, rust_error_unresolved_7d: 0, diverged_unexplained_7d: 0 },
    search: { trigram_exact_disagreements: 0, keyword_title: { ranker: 'ts_rank', exact_disagreements: 0 }, vector_recall_at_10: 0.99, primary_recall_at_10: 0.985 },
    privacy_diverged: 0,
    bench: { pairs: 150, rust_no_worse: true, filtered_vector_margin_met: true, losses: [] },
    child: { panics: 0, faults: 0 },
    drills: { backup_restore_passed: true, eval_gates_e1_e3: true },
    eligibility: { writer_hosts_7d: hosts, unknown_writer_paths: 0, team_brain: false, preview_target: true },
  };
}

/** The stand-in for a served multi-user Rust destination that serves the `host` brain. */
const served: SwapDestinationProbe = async () => ({ engine: 'rust', brain_id: 'host', served: true, multiuser: true });
const probeOf = (over: Partial<Awaited<ReturnType<SwapDestinationProbe>> & object>): SwapDestinationProbe => async () => ({ engine: 'rust', brain_id: 'host', served: true, multiuser: true, ...over });

async function run(extra: Partial<EngineSwapCliDeps> & { hosts?: number | null } = {}) {
  let stdout = '';
  let error = '';
  const { hosts = 2, ...deps } = extra;
  const code = await runEngineSwap(['--to', 'rust', '--plan', '--json'], {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    readShadowStatus: async () => status(hosts), now: NOW,
    home, dataDir: home, resolveBrain: () => 'host', cliBrain: null,
    out: t => { stdout += t; },
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    ...deps,
  });
  return { code, stdout, error, plan: stdout ? JSON.parse(stdout) : null };
}
const elig = (plan: { criteria: Array<{ n: number; state: string; detail: string }> }) => plan.criteria.find(c => c.n === 11)!;

describe('engine swap --plan with writers on two hosts', () => {
  test('a served multi-user Rust destination with the switch on lifts the multiple_writer_hosts refusal', async () => {
    await withEnv({ [SWITCH]: '1' }, async () => {
      const r = await run({ resolveDestination: served });
      expect(r.code).toBe(0);
      expect(elig(r.plan).state).toBe('pass');
      expect(r.plan.reason).not.toBe('multiple_writer_hosts');
      // Every other criterion passes in this document, so the plan is READY; any other failing row would still refuse.
      expect(r.plan.verdict).toBe('READY');
      expect(r.plan.reason).toBeNull();
    });
  });

  test('the other eligibility checks still apply with a served multi-user destination', async () => {
    await withEnv({ [SWITCH]: '1' }, async () => {
      const unknownPaths = await run({ resolveDestination: served, readShadowStatus: async () => { const d = status(2); d.eligibility!.unknown_writer_paths = 3; return d; } });
      expect(unknownPaths.plan.reason).toBe('writer_coverage_unknown');
      const team = await run({ resolveDestination: served, readShadowStatus: async () => { const d = status(2); d.eligibility!.team_brain = true; return d; } });
      expect(team.plan.reason).toBe('team_brain');
      const preview = await run({ resolveDestination: served, readShadowStatus: async () => { const d = status(2); d.eligibility!.preview_target = false; return d; } });
      expect(elig(preview.plan).state).toBe('fail');
      expect(preview.plan.verdict).toBe('NOT READY');
      const none = await run({ resolveDestination: served, hosts: null });
      expect(none.plan.reason).toBe('writer_coverage_unknown');
      const other = await run({ resolveDestination: served, readShadowStatus: async () => { const d = status(2); d.child!.panics = 1; return d; } });
      expect(other.plan.verdict).toBe('NOT READY');
      expect(other.plan.reason).not.toBe('multiple_writer_hosts');
    });
  });

  const refusing: Array<[string, boolean, SwapDestinationProbe | undefined]> = [
    ['no destination (no probe: nothing reports served yet)', true, undefined],
    ['a probe that finds nothing', true, async () => null],
    ['a probe that throws', true, async () => { throw new Error('unreachable'); }],
    ['an embedded destination (served false)', true, probeOf({ served: false })],
    ['a single-user destination (multiuser false)', true, probeOf({ multiuser: false })],
    ['a destination that is not Rust', true, probeOf({ engine: 'postgres' })],
    ['a destination serving a different brain', true, probeOf({ brain_id: 'someone-else' })],
    ['a destination that does not say which brain it serves', true, probeOf({ brain_id: null })],
    ['the switch off with a served multi-user destination', false, served],
  ];
  for (const [name, on, probe] of refusing) {
    test(`still refuses multiple_writer_hosts: ${name}`, async () => {
      await withEnv({ [SWITCH]: on ? '1' : undefined }, async () => {
        const r = await run({ resolveDestination: probe });
        expect(r.code).toBe(0);
        expect(r.plan.reason).toBe('multiple_writer_hosts');
        expect(elig(r.plan).state).toBe('fail');
        expect(r.plan.verdict).toBe('NOT READY');
      });
    });
  }

  test('only the exact value 1 turns the switch on', async () => {
    await withEnv({ [SWITCH]: 'true' }, async () => {
      expect((await run({ resolveDestination: served })).plan.reason).toBe('multiple_writer_hosts');
    });
  });

  test('the injected environment decides the switch like the process environment does', async () => {
    const on = await run({ resolveDestination: served, env: { HOME: home, [SWITCH]: '1' } });
    expect(on.plan.reason).toBeNull();
    const off = await run({ resolveDestination: served, env: { HOME: home } });
    expect(off.plan.reason).toBe('multiple_writer_hosts');
  });

  test('the destination is asked for, never the engine the brain runs on today', async () => {
    const asked: string[] = [];
    await withEnv({ [SWITCH]: '1' }, async () => {
      // A source engine that claims to be a served multi-user Rust engine changes nothing: only the destination counts.
      const claimsServed = Object.assign(Object.create(engine), {
        disconnect: async () => undefined, kind: 'rust', multiuser: true, capabilities: () => ['served'],
      }) as BrainEngine;
      const r = await run({ openEngine: async () => claimsServed });
      expect(r.plan.reason).toBe('multiple_writer_hosts');
      await run({ resolveDestination: async id => { asked.push(id); return null; } });
    });
    expect(asked).toEqual(['host']);
  });
});

describe('with the switch off nothing changes', () => {
  test('the destination is not even asked for', async () => {
    let asked = 0;
    await withEnv({ [SWITCH]: undefined }, async () => {
      await run({ resolveDestination: async () => { asked++; return null; } });
    });
    expect(asked).toBe(0);
  });

  test('plan JSON and plan hash are byte-identical with and without a destination, in both modes of hosts', async () => {
    await withEnv({ [SWITCH]: undefined }, async () => {
      for (const hosts of [1, 2, null]) {
        const base = await run({ hosts });
        const withProbe = await run({ hosts, resolveDestination: served });
        expect(withProbe.stdout).toBe(base.stdout);
        expect(withProbe.plan.plan_hash).toBe(base.plan.plan_hash);
        expect('destination' in base.plan).toBe(false);
      }
    });
  });

  test('with the switch on, a single-host plan keeps its exact JSON and hash; the destination stays out of the JSON', async () => {
    const off = await withEnv({ [SWITCH]: undefined }, () => run({ hosts: 1 }));
    await withEnv({ [SWITCH]: '1' }, async () => {
      const noEvidence = await run({ hosts: 1 });
      expect(noEvidence.stdout).toBe(off.stdout);
      const withDest = await run({ hosts: 1, resolveDestination: served });
      expect('destination' in withDest.plan).toBe(false);
      expect(Object.keys(withDest.plan)).toEqual(Object.keys(off.plan));
    });
  });

  test('the plan hash binds the destination identity and mode when the switch is on', async () => {
    await withEnv({ [SWITCH]: '1' }, async () => {
      const a = await run({ resolveDestination: served });
      const b = await run({ resolveDestination: served });
      expect(b.plan.plan_hash).toBe(a.plan.plan_hash);
      // Same verdict, but a destination that serves another brain (refusing) or runs single-user cannot share the hash.
      const wrongBrain = await run({ resolveDestination: probeOf({ brain_id: 'someone-else' }) });
      const singleUser = await run({ resolveDestination: probeOf({ multiuser: false }) });
      expect(new Set([a.plan.plan_hash, wrongBrain.plan.plan_hash, singleUser.plan.plan_hash]).size).toBe(3);
    });
  });
});
