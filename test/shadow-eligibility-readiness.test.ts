/**
 * Readiness criterion 11 reads the eligibility producer (src/shadow/eligibility.ts -> src/core/engine-swap/readiness.ts).
 *
 * Protects: one observed writer host with no unknown writer path, a personal brain and a preview target pass
 * criterion 11; two hosts refuse `multiple_writer_hosts`; evidence of an unseen writer refuses
 * `writer_coverage_unknown`; with no engine passed in, or a SELECT that throws, the writer fields are absent and
 * criterion 11 is `missing` (NOT READY), never a pass. Regression it catches: a producer field name that drifts from
 * the ShadowStatus interface, or an omission that reads as zero hosts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { buildEligibilityStatus } from '../src/shadow/eligibility.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { WriterObserver } from '../src/shadow/writer-observations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { readConfiguredShadowStatus } from '../src/shadow/status-document.ts';
import { shadowBrainKey, shadowDirFor, writeShadowState, SHADOW_STATE_VERSION } from '../src/shadow/state.ts';
import type { ShadowState } from '../src/shadow/state.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdirSync } from 'node:fs';

let primary: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-elig-readiness-'));
});

afterAll(async () => {
  await primary.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(primary);
  await primary.executeRaw('DELETE FROM engine_writer_observations');
});

async function observe(host: string, app: string): Promise<void> {
  const o = new WriterObserver({ primary, dir, identity: () => ({ hostId: host, applicationName: app, processKind: 'cli', gbrainVersion: 'test' }) });
  o.note();
  while (o.inFlight) await o.inFlight;
  o.stop();
}

async function criterion11(input: { engine?: BrainEngine; unknown?: number; brain?: string; target?: string | null; dir?: string }) {
  const out = await buildEligibilityStatus({
    dir: input.dir ?? dir, state: null, engine: input.engine, source: { name: 'test', unknownPaths: () => input.unknown ?? 0 },
    brainId: () => input.brain ?? 'host', addonTarget: () => (input.target === undefined ? 'linux-x64-glibc' : input.target),
  });
  const verdict = evaluateReadiness({ eligibility: out.eligibility } as ShadowStatus);
  return { out, verdict, row: verdict.criteria.find(c => c.n === 11)! };
}

describe('criterion 11 from the eligibility producer', () => {
  test('one host, no unknown path, a personal brain on a preview target passes', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { row } = await criterion11({ engine: primary });
    expect(row.state).toBe('pass');
  });

  test('two writer hosts refuse multiple_writer_hosts', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    await observe('22222222-2222-4222-8222-222222222222', 'gbrain sync:2:bbbbbbbb');
    const { row, verdict } = await criterion11({ engine: primary });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('multiple_writer_hosts');
  });

  test('evidence of an unseen writer refuses writer_coverage_unknown', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { row, verdict } = await criterion11({ engine: primary, unknown: 1 });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('no engine passed in: the writer fields are absent and criterion 11 is missing, NOT READY', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { out, row, verdict } = await criterion11({});
    expect('writer_hosts_7d' in out.eligibility).toBe(false);
    expect(row.state).toBe('missing');
    expect(verdict.verdict).toBe('NOT READY');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('a SELECT that throws: the same missing row, never a pass', async () => {
    const failing = { executeRaw: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } } as unknown as BrainEngine;
    const { row, verdict } = await criterion11({ engine: failing });
    expect(row.state).toBe('missing');
    expect(verdict.verdict).toBe('NOT READY');
  });

  test('no observed writer is missing evidence, not one host', async () => {
    const { row } = await criterion11({ engine: primary });
    expect(row.state).toBe('missing');
  });

  test('a mounted team brain refuses team_brain; a musl host is not a preview target', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    expect((await criterion11({ engine: primary, brain: 'team-a' })).verdict.reason).toBe('team_brain');
    expect((await criterion11({ engine: primary, target: 'linux-x64-musl' })).row.state).toBe('fail');
  });
});

describe('criterion 11 fails closed on a stop or a restart it cannot see inside', () => {
  const DAY = 86_400_000;
  const HOST = '11111111-1111-4111-8111-111111111111';
  const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
  const state = (extra: Partial<ShadowState> = {}): ShadowState => ({
    version: SHADOW_STATE_VERSION, enabled: true, started_at: iso(2 * DAY), sample_rate: 1, queue_bound: 8, plan_hash: 'h', brain: 'b', primary_engine: 'pglite',
    writer_evidence_since: iso(30 * DAY), writer_evidence_seed: 'seed-1', ...extra,
  });

  async function criterion11(input: { engine: BrainEngine; state: ShadowState }) {
    const out = await buildEligibilityStatus({
      dir, state: input.state, engine: input.engine, source: { name: 'test', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc',
    });
    const verdict = evaluateReadiness({ eligibility: out.eligibility } as ShadowStatus);
    return { out, verdict, row: verdict.criteria.find(c => c.n === 11)! };
  }

  test('a clean epoch with one observed host passes (the control)', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    expect((await criterion11({ engine: primary, state: state() })).row.state).toBe('pass');
  });

  test('an enabled restart that continued the epoch refuses writer_coverage_unknown, whatever the evidence tables say', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    const { row, verdict, out } = await criterion11({ engine: primary, state: state({ writer_coverage_restarted_at: iso(60 * 60_000) }) });
    expect(out.eligibility.unknown_writer_paths).toBe(1);
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('a long stop and a restart: the stop time is older than the window, the restart is not, and the restart still refuses', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    const { row, verdict } = await criterion11({ engine: primary, state: state({ writer_coverage_stopped_at: iso(9 * DAY), writer_coverage_restarted_at: iso(60_000) }) });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('a stopped shadow refuses for as long as it is stopped, even with no gap row anywhere (a failed stop-gap insert cannot read as clean)', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    const { row, verdict } = await criterion11({ engine: primary, state: state({ enabled: false, stopped_at: iso(10 * DAY), writer_coverage_stopped_at: iso(10 * DAY) }) });
    expect(row.state).toBe('fail');
    expect(verdict.reason).toBe('writer_coverage_unknown');
  });

  test('the blanket lasts one window: a restart older than the window no longer counts, and an unreadable time always does', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    expect((await criterion11({ engine: primary, state: state({ writer_coverage_restarted_at: iso(9 * DAY) }) })).row.state).toBe('pass');
    expect((await criterion11({ engine: primary, state: state({ writer_coverage_restarted_at: 'yesterday' }) })).row.state).toBe('fail');
  });
});

describe('criterion 11 does not trust a state file that disagrees with the open engine', () => {
  const stateOf = (extra: Record<string, unknown>): ShadowState => ({
    version: SHADOW_STATE_VERSION, enabled: true, started_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), sample_rate: 1, queue_bound: 8, plan_hash: 'h', brain: 'b', ...extra,
  }) as ShadowState;
  const read = async (state: ShadowState) => {
    const out = await buildEligibilityStatus({ dir, state, engine: primary, source: { name: 'test', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    const verdict = evaluateReadiness({ eligibility: out.eligibility } as ShadowStatus);
    return { out, row: verdict.criteria.find(c => c.n === 11)! };
  };

  test('a state naming the same kind as the engine passes; a missing, unreadable or different primary_engine counts and refuses', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    expect((await read(stateOf({ primary_engine: 'pglite' }))).row.state).toBe('pass');
    for (const bad of [{}, { primary_engine: 7 }, { primary_engine: 'postgres' }, { primary_engine: null }]) {
      const { out, row } = await read(stateOf(bad));
      expect([JSON.stringify(bad), out.eligibility.unknown_writer_paths]).toEqual([JSON.stringify(bad), 1]);
      expect(row.state).toBe('fail');
    }
  });
});

describe('criterion 11 needs a state it can prove', () => {
  const base = { version: SHADOW_STATE_VERSION, enabled: true, started_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), sample_rate: 1, queue_bound: 8, plan_hash: 'h', brain: 'b' };
  const read = async (state: unknown, stateRequired = false) => {
    const out = await buildEligibilityStatus({ dir, state: state as ShadowState | null, stateRequired, engine: primary, source: { name: 'test', unknownPaths: () => 0 }, brainId: () => 'host', addonTarget: () => 'linux-x64-glibc' });
    const verdict = evaluateReadiness({ eligibility: out.eligibility } as ShadowStatus);
    return { out, row: verdict.criteria.find(c => c.n === 11)! };
  };

  test('a primary_engine that is not exactly the open engine\'s kind counts, whatever the hook requirement says', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    for (const bad of ['rust', '', 'postgre', 'PGLITE', ' pglite']) {
      const { out, row } = await read({ ...base, primary_engine: bad });
      expect([bad, out.eligibility.unknown_writer_paths]).toEqual([bad, 1]);
      expect(row.state).toBe('fail');
    }
  });

  test('a state that is not provably enabled counts: enabled missing, mistyped or false', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    for (const enabled of [undefined, 'true', 1, null, false]) {
      const state = { ...base, primary_engine: 'pglite', ...(enabled === undefined ? {} : { enabled }) };
      if (enabled === undefined) delete (state as { enabled?: unknown }).enabled;
      const { out, row } = await read(state);
      expect([String(enabled), out.eligibility.unknown_writer_paths]).toEqual([String(enabled), 1]);
      expect(row.state).toBe('fail');
    }
  });

  test('the status document asks for a state: with an engine in hand and no readable state it counts, never a clean pass', async () => {
    await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
    const { out, row } = await read(null, true);
    expect(out.eligibility.unknown_writer_paths).toBe(1);
    expect(row.state).toBe('fail');
    expect((await read(null, false)).out.eligibility.unknown_writer_paths).toBe(0);
  });
});

describe('the status document the swap reads', () => {
  test('with the primary passed in it carries the writer fields; without it they are absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-elig-doc-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
        const sdir = shadowDirFor(shadowBrainKey(config)!);
        mkdirSync(sdir, { recursive: true });
        writeShadowState(sdir, { version: SHADOW_STATE_VERSION, enabled: true, started_at: new Date(Date.now() - 86_400_000).toISOString(), sample_rate: 1, queue_bound: 8, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' });
        await observe('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:aaaaaaaa');
        const withEngine = await readConfiguredShadowStatus(() => config, new Date(), primary);
        expect(withEngine?.eligibility).toMatchObject({ writer_hosts_7d: 1, unknown_writer_paths: 0, team_brain: false });
        const without = await readConfiguredShadowStatus(() => config, new Date());
        expect(without && 'writer_hosts_7d' in without.eligibility).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('criterion 11 counts writers of an older build (write_protocol)', () => {
  const HOST = '11111111-1111-4111-8111-111111111111';
  const epochDir = (startedAtMs: number): string => {
    const d = mkdtempSync(join(tmpdir(), 'gbrain-elig-protocol-'));
    ensureEpoch(d, { seed_id: 's', rust_addon_sha256: 'a', comparator_version: 4, adapter_version: 'x', capability_set_hash: null, readiness_policy_hash: 'p' }, startedAtMs);
    return d;
  };
  const insertRow = (app: string, protocol: number | null, lastSeen: string): Promise<unknown> =>
    primary.executeRaw(`INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version, write_protocol, last_seen) VALUES ($1, $2, 'cli', 'old', $3, $4::timestamptz)`, [HOST, app, protocol, lastSeen]);

  test('M1: a row with no write_protocol seen in the epoch is an unknown writer path: criterion 11 fails, and the producer names it', async () => {
    const d = epochDir(Date.now() - 3_600_000);
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    await insertRow('gbrain cli:2:old00000', null, new Date().toISOString());
    const { out, row, verdict } = await criterion11({ engine: primary, dir: d });
    expect(out.eligibility).toMatchObject({ legacy_write_writers: 1, unknown_writer_paths: 1 });
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('older build');
    expect(verdict.reason).toBe('writer_coverage_unknown');
    rmSync(d, { recursive: true, force: true });
  });

  test('M1: a row with a lower write_protocol is the same, and a row of this build (write_protocol 2) passes', async () => {
    const d = epochDir(Date.now() - 3_600_000);
    await observe(HOST, 'gbrain cli:1:aaaaaaaa'); // written by this build: protocol 2
    expect((await primary.executeRaw<{ write_protocol: number }>('SELECT write_protocol FROM engine_writer_observations'))[0]!.write_protocol).toBe(2);
    expect((await criterion11({ engine: primary, dir: d })).row.state).toBe('pass');
    await insertRow('gbrain cli:3:lower000', 1, new Date().toISOString());
    const { out, row } = await criterion11({ engine: primary, dir: d });
    expect(out.eligibility.legacy_write_writers).toBe(1);
    expect(row.state).toBe('fail');
    rmSync(d, { recursive: true, force: true });
  });

  test('M1: an older writer last seen before the epoch started (less the 10 minute refresh slack) is ignored; one inside the slack counts', async () => {
    const started = Date.now() - 3_600_000; const d = epochDir(started);
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    await insertRow('gbrain cli:4:before00', null, new Date(started - 11 * 60_000).toISOString());
    expect((await criterion11({ engine: primary, dir: d })).row.state).toBe('pass');
    await insertRow('gbrain cli:5:slack000', null, new Date(started - 5 * 60_000).toISOString());
    expect((await criterion11({ engine: primary, dir: d })).out.eligibility.legacy_write_writers).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  test('M1: the epoch window has no 7-day clamp: a legacy writer seen early in a 15-day epoch still fails criterion 11, however many days ago it wrote', async () => {
    const day = 86_400_000; const started = Date.now() - 15 * day; const d = epochDir(started);
    await observe(HOST, 'gbrain cli:1:modern000'); // this build, seen now: supplies the one host
    await insertRow('gbrain cli:2:legacy000', null, new Date(started + day).toISOString()); // an older build, last seen 14 days ago, inside the epoch
    const { out, row } = await criterion11({ engine: primary, dir: d });
    expect(out.eligibility.legacy_write_writers).toBe(1); // was 0: the rolling 7-day window cut it off and criterion 11 could pass
    expect(row.state).toBe('fail');
    await insertRow('gbrain cli:3:before000', null, new Date(started - 11 * 60_000).toISOString()); // still ignored: before the epoch began, less the slack
    expect((await criterion11({ engine: primary, dir: d })).out.eligibility.legacy_write_writers).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  test('M1: with no epoch on disk the window start bounds it; and where the migration has not run (no write_protocol column) the read fails and criterion 11 is missing, never a pass', async () => {
    await observe(HOST, 'gbrain cli:1:aaaaaaaa');
    await insertRow('gbrain cli:6:oldnoepo', null, new Date().toISOString());
    expect((await criterion11({ engine: primary })).out.eligibility.legacy_write_writers).toBe(1);
    await primary.executeRaw('ALTER TABLE engine_writer_observations DROP COLUMN write_protocol');
    try {
      const { out, row } = await criterion11({ engine: primary });
      expect(out.eligibility_evidence).toMatchObject({ state: 'read_failed' });
      expect(row.state).toBe('missing');
    } finally { await primary.executeRaw('ALTER TABLE engine_writer_observations ADD COLUMN IF NOT EXISTS write_protocol INTEGER'); }
  });
});
