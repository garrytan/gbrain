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
 * through shadow mode and back is a separate acceptance item that waits for the swap run on the multi-user trunk.
 * (4) Seam: the injected destination probe drives the evidence rules; the production default, this host's configuration
 * only (destination.ts configDestination), is driven through an injected environment and `rust_server.url`; the switch is set with withEnv; the disk reading is fixed, and the byte-identical cases write to the
 * disk between their two plans (diskMoves) so a live reading fails them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap, type EngineSwapCliDeps } from '../src/commands/engine-swap.ts';
import { configDestination, type SwapDestinationProbe } from '../src/core/engine-swap/destination.ts';
import { plannedProbeTarget } from '../src/core/engine-swap/served-probe.ts';
import { readStoreBrainId, swapStoreDir } from '../src/shadow/store-identity.ts';
import type { ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { withEnv } from './helpers/with-env.ts';

const NOW = new Date('2026-12-01T00:00:00Z');
const SWITCH = 'GBRAIN_RUST_MULTIUSER';
const LISTEN = 'GBRAIN_RUST_SERVER_LISTEN';
const CERT = 'GBRAIN_RUST_SERVER_TLS_CERT';
const KEY = 'GBRAIN_RUST_SERVER_TLS_KEY';
/** The persistence brain id of the swap's Rust store (its FORMAT file), which a served destination must report. */
const STORE_ID = '0b6f1d1e-6a52-4c8e-9f0a-1c2d3e4f5a6b';

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
    write_comparisons: { state: 'on', sample_rate: 1, comparable: 1500, unexplained_difference: 0, uncomparable: 2, capability_missing: 0,
      // Criterion 5's qualifying-write window (the same 20 days as test/helpers/swap-ready-status.ts).
      qualifying_writes: { by_day: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [new Date(Date.parse('2026-12-01T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10), 100])), first_seen: '2026-11-10T00:00:00Z' } },
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

async function run(extra: Partial<EngineSwapCliDeps> & { hosts?: number | null; text?: boolean } = {}) {
  let stdout = '';
  let error = '';
  const { hosts = 2, text = false, ...deps } = extra;
  const code = await runEngineSwap(['--to', 'rust', '--plan', ...(text ? [] : ['--json'])], {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    readShadowStatus: async () => status(hosts), now: NOW,
    // A fixed disk reading: the real one moves whenever anything writes to the shared disk (diskMoves), which is not under test here.
    home, dataDir: home, freeBytes: () => 64 * 2 ** 30, resolveBrain: () => 'host', cliBrain: null,
    // This machine's own gbrain config is not under test; the case that reads the config file passes undefined.
    rustServerUrl: () => null,
    // The swap's Rust store already exists and has this brain id (store-identity.ts); the cases that read FORMAT pass undefined.
    storeBrainId: () => STORE_ID,
    out: t => { stdout += t; },
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    ...deps,
  });
  return { code, stdout, error, plan: stdout && !text ? JSON.parse(stdout) : null };
}
/**
 * Another process writing to the same disk between two plan reads, made deterministic: 32 MiB written and synced into the
 * test's home, so the file system's free space differs from the first read. Two plans compared byte for byte must not see it.
 */
let writes = 0;
function diskMoves(): void {
  const fd = openSync(join(home, `disk-moves-${writes++}.bin`), 'w');
  try { const mib = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < 32; i++) writeSync(fd, mib); fsyncSync(fd); } finally { closeSync(fd); }
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
      // No probe reads this host's configuration: it names no brain server to listen on here.
      await withEnv({ [SWITCH]: on ? '1' : undefined, [LISTEN]: undefined, GBRAIN_RUST_SERVER_URL: undefined }, async () => {
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
        diskMoves();
        const withProbe = await run({ hosts, resolveDestination: served });
        expect(withProbe.stdout).toBe(base.stdout);
        expect(withProbe.plan.plan_hash).toBe(base.plan.plan_hash);
        expect('destination' in base.plan).toBe(false);
      }
    });
  });

  test('with the switch on, a single-host plan keeps its exact JSON and hash; the destination stays out of the JSON', async () => {
    const off = await withEnv({ [SWITCH]: undefined }, () => run({ hosts: 1 }));
    diskMoves();
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

/**
 * The production default: no probe, so the plan reads this host's configuration only. The swap host is the brain server
 * (M1 as built): it serves with GBRAIN_RUST_SERVER_LISTEN and names no server of its own to connect to.
 */
describe('engine swap --plan reads the destination from this host\'s configuration only', () => {
  const at = '10.0.0.5:7443';
  // Names only: the plan never opens the TLS files (the server reads them when it starts).
  const tls = { cert: '/etc/gbrain/tls/cert.pem', key: '/etc/gbrain/tls/key.pem' };
  const serving = (over: Record<string, string | undefined> = {}) => ({ HOME: home, [SWITCH]: '1', [LISTEN]: at, [CERT]: tls.cert, [KEY]: tls.key, ...over });

  test('a host set to serve the brain lifts the refusal, and the plan says the check is config-only', async () => {
    const r = await run({ env: serving() });
    expect(r.code).toBe(0);
    expect(r.plan.verdict).toBe('READY');
    expect(r.plan.reason).toBeNull();
    expect(elig(r.plan).state).toBe('pass');
    expect(elig(r.plan).detail).toContain('accepted on config only');
    expect(elig(r.plan).detail).toContain(`on ${at}; the plan reached no server`);
    expect(elig(r.plan).detail).toContain('restores the old engine');
    const text = await run({ env: serving(), text: true });
    expect(text.stdout).toContain('accepted on config only');
  });

  const refusing: Array<[string, Record<string, string | undefined>, string | null, string]> = [
    ['a host that serves with the --rust-listen flag only (no GBRAIN_RUST_SERVER_LISTEN)', { [LISTEN]: undefined }, null,
      'set GBRAIN_RUST_SERVER_LISTEN to the address you serve on'],
    ['a listen address that is not host:port', { [LISTEN]: 'not-an-address' }, null, 'set GBRAIN_RUST_SERVER_LISTEN to the address you serve on'],
    ['a loopback listen address', { [LISTEN]: '127.0.0.1:7443' }, null, 'loopback address, which the other writer hosts cannot reach'],
    ['a non-loopback listen address with no TLS files named', { [CERT]: undefined }, null, 'needs GBRAIN_RUST_SERVER_TLS_CERT and GBRAIN_RUST_SERVER_TLS_KEY'],
    ['a non-loopback listen address with no TLS key named', { [KEY]: '' }, null, 'needs GBRAIN_RUST_SERVER_TLS_CERT and GBRAIN_RUST_SERVER_TLS_KEY'],
    ['a host whose config names rust_server.url (a client, not the server)', {}, 'https://brain.example:7443', 'names rust_server.url'],
    ['a host with GBRAIN_RUST_SERVER_URL set (a client, not the server)', { GBRAIN_RUST_SERVER_URL: 'https://brain.example:7443' }, null, 'GBRAIN_RUST_SERVER_URL is set'],
  ];
  for (const [name, over, url, why] of refusing) {
    test(`refuses multiple_writer_hosts and says why: ${name}`, async () => {
      const r = await run({ env: serving(over), rustServerUrl: () => url });
      expect(r.code).toBe(0);
      expect(r.plan.reason).toBe('multiple_writer_hosts');
      expect(r.plan.verdict).toBe('NOT READY');
      expect(elig(r.plan).state).toBe('fail');
      expect(elig(r.plan).detail).toContain('not accepted (config only)');
      expect(elig(r.plan).detail).toContain(why);
    });
  }

  test('the switch off reads nothing and keeps the plain refusal', async () => {
    let asked = 0;
    const r = await run({ env: serving({ [SWITCH]: undefined }), rustServerUrl: () => { asked++; return null; } });
    expect(asked).toBe(0);
    expect(r.plan.reason).toBe('multiple_writer_hosts');
    expect(elig(r.plan).detail).toBe('2 writer hosts in the last 7 days');
  });

  test('by default rust_server.url is read from this host\'s gbrain config file', async () => {
    const gh = mkdtempSync(join(home, 'gbrain-home-'));
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', rust_server: { url: 'https://brain.example:7443' } }));
    await withEnv({ GBRAIN_HOME: gh }, async () => {
      const r = await run({ env: serving(), rustServerUrl: undefined });
      expect(r.plan.reason).toBe('multiple_writer_hosts');
      expect(elig(r.plan).detail).toContain('names rust_server.url');
    });
  });

  test('the plan hash binds config-only evidence and the address the run will check', async () => {
    const a = await run({ env: serving() });
    const again = await run({ env: serving() });
    expect(again.plan.plan_hash).toBe(a.plan.plan_hash);
    const otherAddress = await run({ env: serving({ [LISTEN]: '10.0.0.6:7443' }) });
    await withEnv({ [SWITCH]: '1' }, async () => {
      const probed = await run({ resolveDestination: served });
      // Same verdict and criteria states: only the config-only basis and the address tell the three apart.
      expect(new Set([a.plan.plan_hash, otherAddress.plan.plan_hash, probed.plan.plan_hash]).size).toBe(3);
    });
  });

  test('a swap whose Rust store has no brain id yet refuses, and says how to fix it', async () => {
    for (const none of [() => null, () => '']) {
      const r = await run({ env: serving(), storeBrainId: none });
      expect(r.plan.reason).toBe('multiple_writer_hosts');
      expect(r.plan.verdict).toBe('NOT READY');
      expect(elig(r.plan).detail).toContain('not accepted (config only)');
      expect(elig(r.plan).detail).toContain('has no brain id yet');
      expect(elig(r.plan).detail).toContain('run the shadow for this brain until it creates its store');
    }
  });

  test('the store brain id is read only for a host that otherwise counts', async () => {
    let asked = 0;
    const storeBrainId = () => { asked++; return STORE_ID; };
    await run({ env: serving({ [SWITCH]: undefined }), storeBrainId });
    await run({ env: serving({ [LISTEN]: '127.0.0.1:7443' }), storeBrainId });
    await run({ env: serving(), rustServerUrl: () => 'https://brain.example:7443', storeBrainId });
    expect(asked).toBe(0);
    await run({ env: serving(), storeBrainId });
    expect(asked).toBe(1);
  });

  test('the plan hash binds the store brain id, so a plan read before the store changed no longer matches', async () => {
    const a = await run({ env: serving() });
    const other = await run({ env: serving(), storeBrainId: () => '9f8e7d6c-5b4a-4321-8fed-cba987654321' });
    expect(other.plan.verdict).toBe(a.plan.verdict);
    expect(other.plan.criteria).toEqual(a.plan.criteria);
    expect(other.plan.plan_hash).not.toBe(a.plan.plan_hash);
    // The plan JSON stays as it was: the id is in the evidence and the hash, not a new plan field.
    expect(other.stdout.replace(other.plan.plan_hash, '')).toBe(a.stdout.replace(a.plan.plan_hash, ''));
    expect(a.stdout).not.toContain(STORE_ID);
  });

  test('the run probes the address and the store brain id the plan bound, and nothing for evidence that does not count', () => {
    const env = serving();
    const counted = configDestination('host', { env, storeBrainId: () => STORE_ID });
    expect(counted.store_brain_id).toBe(STORE_ID);
    expect(plannedProbeTarget(counted)).toEqual({ listen: at, expectedBrainId: STORE_ID });
    expect(plannedProbeTarget(configDestination('host', { env, storeBrainId: () => null }))).toBeNull();
    expect(plannedProbeTarget(configDestination('host', { env: serving({ [LISTEN]: '127.0.0.1:7443' }), storeBrainId: () => STORE_ID }))).toBeNull();
    expect(plannedProbeTarget({ engine: 'rust', brain_id: 'host', served: true, multiuser: true, source: 'probe' })).toBeNull();
    expect(plannedProbeTarget(null)).toBeNull();
  });

  test('by default the store brain id is read from FORMAT in the configured brain\'s shadow store, which is never created', async () => {
    const gh = mkdtempSync(join(home, 'gbrain-store-'));
    mkdirSync(join(gh, '.gbrain'), { recursive: true });
    writeFileSync(join(gh, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(gh, 'brain.pglite') }));
    await withEnv({ GBRAIN_HOME: gh, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const store = swapStoreDir(loadConfig()!)!;
      expect(store.startsWith(join(gh, '.gbrain', 'shadow'))).toBe(true);
      expect(store.endsWith('/store')).toBe(true);
      // No store yet: refused, and the read created nothing.
      const missing = await run({ env: serving(), storeBrainId: undefined });
      expect(missing.plan.reason).toBe('multiple_writer_hosts');
      expect(elig(missing.plan).detail).toContain('has no brain id yet');
      expect(existsSync(join(gh, '.gbrain', 'shadow'))).toBe(false);
      // A FORMAT that names no valid brain id counts as none.
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, 'FORMAT'), '{"format_version":1}');
      expect(readStoreBrainId(store)).toBeNull();
      writeFileSync(join(store, 'FORMAT'), 'not json');
      expect(readStoreBrainId(store)).toBeNull();
      writeFileSync(join(store, 'FORMAT'), JSON.stringify({ format_version: 1, brain_id: STORE_ID }));
      const found = await run({ env: serving(), storeBrainId: undefined });
      expect(found.plan.verdict).toBe('READY');
      const injected = await run({ env: serving() });
      expect(found.plan.plan_hash).toBe(injected.plan.plan_hash);
      expect(readdirSync(store)).toEqual(['FORMAT']);
    });
  });

  test('config evidence that does not count leaves a single-host plan\'s JSON and hash as before', async () => {
    const off = await run({ hosts: 1, env: { HOME: home } });
    diskMoves();
    const refused = await run({ hosts: 1, env: serving({ [LISTEN]: undefined }) });
    expect(refused.stdout).toBe(off.stdout);
  });
});
