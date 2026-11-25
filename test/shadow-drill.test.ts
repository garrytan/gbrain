/**
 * The shadow restore drill (src/shadow/drill.ts, drill-status.ts; swap criterion 10, first half).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the recovery evidence the swap reads: a drill passes only when the
 * owner's copy was verified without a normal open, then opened once, and its scratch space is really gone. (2) Fails when
 * a refused or failed drill reads as a pass, when scratch space is deleted while the owner's copy may still be running,
 * when `scratch_deleted` is claimed rather than observed, when a pending cleanup reads as a pass, when a drill of an
 * older epoch counts, when a tampered pending record deletes a directory outside the drills directory, or when phase 2's
 * open is mixed into phase 1's evidence. (3) The owner side is pinned by test/rust-engine-store-snapshot.test.ts and the
 * real process behavior by test/shadow-drill-addon.test.ts; nothing covered the CLI half. (4) A fake owner and fake
 * verifier (no addon): the file system, the lock, the pending record and the status are real.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { addonFileSha256, probeCopy, runBackupDrill, type DrillDeps, type DrillOwner, type ProbeEngine } from '../src/shadow/drill.ts';
import { DEFAULT_HARD_EXCLUDES } from '../src/core/search/source-boost.ts';
import { ENGLISH_STOPWORDS } from '../src/shadow/english-stopwords.ts';
import { buildDrillStatus } from '../src/shadow/drill-status.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { __stopForTests } from '../src/commands/engine-shadow.ts';
import { takeDrillLockForDelete } from '../src/shadow/drill.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import type { StoreSnapshotManifest, StoreVerifyReport } from '../src/core/rust-engine/store.ts';
import type { SnapshotStatus } from '../src/core/rust-engine/store-snapshot.ts';
import { ADDON_SHA, evalUrl, gatesObject, pinFor, SEED, TARGET, TAG, writeEpoch, writeStoreFiles } from './helpers/shadow-drill-fixtures.ts';
import { withEnv } from './helpers/with-env.ts';
import { VERSION } from '../src/version.ts';

const MANIFEST: StoreSnapshotManifest = {
  version: 1, brain_id: 'b', generation: 42, engine_format_version: 5, schema_version: 1, keys: 10, bytes: 1000,
  tags: { '50': { keys: 5, sha256: 'x' }, '51': { keys: 5, sha256: 'y' } }, relations: { chunks: { rows: 3, sha256: 'z' } }, created_at_us: 1,
};
const report = (patch: Partial<StoreVerifyReport> = {}): StoreVerifyReport => ({
  verdict: 'ok', integrity: null, brain_id: 'b', generation: 42, engine_format_version: 5, format_file_version: 5, schema_version: 1, keys: 10, bytes: 1000,
  tags: MANIFEST.tags, relations: MANIFEST.relations ?? null, keyword_index: { state: 'complete', cursor: null, pages_checked: 3, ok: true }, mismatches: [], ...patch,
});
const plenty = { bavail: 1_000_000_000, bsize: 4096 };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) { try { chmodSync(join(d, 'drills'), 0o700); } catch { /* absent */ } rmSync(d, { recursive: true, force: true }); }
});
function shadow(bytes = 4096): { dir: string; epochId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-drill-'));
  dirs.push(dir);
  writeStoreFiles(dir, bytes);
  writeFileSync(join(dir, 'state.json'), '{"keep":"as is"}');
  return { dir, epochId: writeEpoch(dir).epoch_id };
}

interface Owner extends DrillOwner { snapshots: Array<{ target: string; options: Record<string, unknown> }>; closed: boolean }
function fakeOwner(over: Partial<DrillOwner> = {}): Owner {
  const owner: Owner = {
    via: 'owner_ipc', snapshots: [], closed: false,
    snapshot: async (target, options) => {
      owner.snapshots.push({ target, options: { ...options } });
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, 'records.redb'), 'copy');
      return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 900, low: 700 } } as never;
    },
    status: async opId => ({ op_id: opId, state: 'unknown' }) as SnapshotStatus,
    ownerGone: async () => false,
    close: async () => { owner.closed = true; },
    ...over,
  };
  return owner;
}
let ids = 0;
function deps(owner: DrillOwner, over: Partial<DrillDeps> = {}): DrillDeps {
  return {
    loadAddon: async () => ({ ok: true, addon: {} as never }), openOwner: async () => owner, verify: async () => report(), verifyAfter: async () => report({ generation: 43 }),
    openCopy: async () => ({ pages: 3, searchHits: 1 }), addonSha256: () => ADDON_SHA, statfs: () => plenty, id: () => `d${++ids}`, endedWaitMs: 40, endedPollMs: 5, ...over,
  };
}
const scratches = (dir: string): string[] => (existsSync(join(dir, 'drills')) ? readdirSync(join(dir, 'drills')).filter(n => n.startsWith('scratch-')) : []);
const stopped = (reason: string): Error => Object.assign(new Error('stopped'), { code: 'rust_snapshot_stopped', reason });

describe('a passing drill', () => {
  test('records the epoch, the method, the two phases and a deleted scratch; status then reads a pass', async () => {
    const { dir, epochId } = shadow(2 * 1024 * 1024);
    const owner = fakeOwner();
    const rec = await runBackupDrill(dir, deps(owner));
    expect(rec).toMatchObject({
      pass: true, reason: null, method: 'online_logical', epoch_id: epochId, seed_id: SEED.seed_id, via: 'owner_ipc', generation: 42, engine_format_version: 5,
      store_bytes: 2 * 1024 * 1024, snapshot_bytes: 1000, over_archive_cap: false, free_bytes_initial: 900, free_bytes_low_water: 700, scratch_deleted: true,
      compared: { tags: 2, relations: 1 }, mismatches: [], post_open: { generation_after: 43, keyword_state: 'complete', pages: 3, search_hits: 1 },
    });
    expect(rec.op_id).toBe(`drill-${rec.drill_id}`);
    expect(rec.duration_ms).toBeGreaterThanOrEqual(0);
    const onDisk = JSON.parse(readFileSync(join(dir, 'drills', 'backup.json'), 'utf8'));
    expect(onDisk.drill_id).toBe(rec.drill_id);
    expect(statSync(join(dir, 'drills', 'backup.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'drills', 'history.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(false);
    expect(scratches(dir)).toEqual([]);
    expect(owner.closed).toBe(true);
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: true, backup_state: 'passed' });
    expect(buildDrillStatus(dir).drills.backup_reason).toBeUndefined();
  });

  test('the shadow keeps running: its state file is untouched and the owner is asked for one copy with the plain contract arguments', async () => {
    const { dir } = shadow();
    const owner = fakeOwner();
    await runBackupDrill(dir, deps(owner));
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe('{"keep":"as is"}');
    expect(owner.snapshots).toHaveLength(1);
    // The arguments the Nov 26 owner accepts (store-snapshot.ts SnapshotStoreOptions): an op id and test seams, nothing else.
    expect(Object.keys(owner.snapshots[0]!.options)).toEqual(['opId']);
    expect(owner.snapshots[0]!.options.opId).toMatch(/^drill-[A-Za-z0-9._-]{1,100}$/);
    expect(owner.snapshots[0]!.target).toMatch(/drills\/scratch-[^/]+\/restored$/);
  });

  test('a store over the 8 GiB archive cap records the size observation and the online method, nothing more', async () => {
    const { dir } = shadow();
    truncateSync(join(dir, 'store', 'records.redb'), 9 * 1024 ** 3);
    const rec = await runBackupDrill(dir, deps(fakeOwner()));
    expect(rec).toMatchObject({ over_archive_cap: true, method: 'online_logical', pass: true });
    expect(Object.keys(rec)).not.toContain('physical_copy');
  });

  test('a drill process that holds a free store itself (no owner to join) is recorded as in_process', async () => {
    const { dir } = shadow();
    expect((await runBackupDrill(dir, deps(fakeOwner({ via: 'in_process' })))).via).toBe('in_process');
  });
});

describe('refusals before any copy', () => {
  test.each([
    ['no seed', (dir: string) => rmSync(join(dir, 'seed.json')), 'no_seed'],
    ['no epoch', (dir: string) => rmSync(join(dir, 'evidence'), { recursive: true }), 'no_epoch'],
    ['no store', (dir: string) => rmSync(join(dir, 'store'), { recursive: true }), 'no_store'],
  ])('%s', async (_name, break_, reason) => {
    const { dir } = shadow();
    break_(dir);
    const owner = fakeOwner();
    const rec = await runBackupDrill(dir, deps(owner));
    expect(rec).toMatchObject({ pass: false, reason, op_id: null });
    expect(owner.snapshots).toHaveLength(0);
    expect(existsSync(join(dir, 'drills', 'backup.json'))).toBe(false);
  });

  test('an addon that is not installed, and a disk with less than twice the store plus 2 GiB, refuse before anything is made', async () => {
    const { dir } = shadow(10 * 1024 * 1024);
    expect((await runBackupDrill(dir, deps(fakeOwner(), { loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed', message: 'm' }) }))).reason).toBe('addon_unavailable');
    const owner = fakeOwner();
    const short = { bavail: Math.floor((2 * 10 * 1024 * 1024 + 2 * 1024 ** 3 - 1) / 4096), bsize: 4096 };
    expect((await runBackupDrill(dir, deps(owner, { statfs: () => short }))).reason).toBe('disk_space');
    expect(owner.snapshots).toHaveLength(0);
    expect(existsSync(join(dir, 'drills'))).toBe(false);
  });

  test('a drill that is running refuses another; a lock left by a dead process is taken over', async () => {
    const { dir } = shadow();
    mkdirSync(join(dir, 'drills'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'drill.lock'), JSON.stringify({ pid: process.pid, at: 1 }));
    expect((await runBackupDrill(dir, deps(fakeOwner()))).reason).toBe('drill_running');
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(true);
    writeFileSync(join(dir, 'drills', 'drill.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: 1 }));
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(false);
  });
});

describe('failures are records, never passes', () => {
  test.each([
    ['a copy that differs from the manifest', async () => report({ verdict: 'mismatch', mismatches: ['tag_digest:50'] }), 'copy_mismatch', ['tag_digest:50']],
    ['a copy redb refused', async () => report({ verdict: 'integrity', integrity: 'bad page' }), 'copy_integrity', []],
    ['a keyword index that is wrong', async () => report({ keyword_index: { state: 'complete', cursor: null, pages_checked: 3, ok: false } }), 'copy_mismatch', []],
    ['a copy the verifier cannot read', async () => { throw new Error('rust_store_unreadable'); }, 'copy_unreadable', []],
  ])('%s', async (_name, verify, reason, mismatches) => {
    const { dir } = shadow();
    const rec = await runBackupDrill(dir, deps(fakeOwner(), { verify }));
    expect(rec).toMatchObject({ pass: false, reason, mismatches, scratch_deleted: true, post_open: null });
    expect(JSON.parse(readFileSync(join(dir, 'drills', 'backup.json'), 'utf8')).pass).toBe(false);
    expect(scratches(dir)).toEqual([]);
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'failed', backup_reason: `backup_drill_failed:${reason}` });
  });

  test('a copy that will not open, and a search that finds nothing on a complete index, fail phase 2 only', async () => {
    const { dir } = shadow();
    const opens = await runBackupDrill(dir, deps(fakeOwner(), { openCopy: async () => { throw new Error('boom'); } }));
    expect(opens).toMatchObject({ pass: false, reason: 'open_failed', generation: 42, compared: { tags: 2, relations: 1 } });
    const search = await runBackupDrill(dir, deps(fakeOwner(), { openCopy: async () => { throw Object.assign(new Error('none'), { drillReason: 'search_failed' }); } }));
    expect(search.reason).toBe('search_failed');
  });

  test('an incomplete keyword index is judged by its state: the open check is told not to demand a hit', async () => {
    const { dir } = shadow();
    let expectHit: boolean | undefined;
    const rec = await runBackupDrill(dir, deps(fakeOwner(), {
      verify: async () => report({ keyword_index: { state: 'incomplete', cursor: 7, pages_checked: 7, ok: true } }),
      openCopy: async (_a, _d, hit) => { expectHit = hit; return { pages: 9, searchHits: 0 }; },
      verifyAfter: async () => report({ generation: 50, keyword_index: { state: 'complete', cursor: null, pages_checked: 9, ok: true } }),
    }));
    expect(expectHit).toBe(false);
    expect(rec).toMatchObject({ pass: true, generation: 42, post_open: { keyword_state: 'complete', generation_after: 50, search_hits: 0 } });
  });

  test.each([
    ['disk_pressure', 'cancelled', 'snapshot_disk_pressure'], ['cancelled', 'cancelled', 'snapshot_cancelled'], ['age_budget', 'cancelled', 'snapshot_age_budget'], ['busy', 'unknown', 'snapshot_busy'],
  ])('an owner that stopped the copy (%s) ends the drill with its reason and scratch is deleted after the owner says it ended', async (stopReason, state, reason) => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async (target) => { mkdirSync(target, { mode: 0o700 }); throw stopped(stopReason); },
      status: async opId => ({ op_id: opId, state }) as SnapshotStatus,
    });
    const rec = await runBackupDrill(dir, deps(owner));
    expect(rec).toMatchObject({ pass: false, reason, scratch_deleted: true });
    expect(scratches(dir)).toEqual([]);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(false);
  });

  test('an owner that cannot be reached for the copy leaves it pending, and status never calls that a pass', async () => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async (target) => { mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'records.redb'), 'half'); throw new Error('connection lost'); },
      status: async opId => ({ op_id: opId, state: 'running' }) as SnapshotStatus,
    });
    const rec = await runBackupDrill(dir, deps(owner));
    expect(rec).toMatchObject({ pass: false, reason: 'snapshot_failed', scratch_deleted: false });
    // The owner may still be writing: nothing was deleted and the record that says so is on disk.
    expect(scratches(dir)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'drills', 'pending.json'), 'utf8')).op_id).toBe(rec.op_id);
    const status = buildDrillStatus(dir).drills;
    expect(status).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending', backup_reason: 'cleanup_pending' });
    expect(evaluateReadiness({ drills: { ...status, eval_gates_e1_e3: true } } as ShadowStatus).criteria.find(c => c.n === 10)!.state).toBe('fail');

    // While the owner still says running, a new drill refuses and deletes nothing.
    const again = await runBackupDrill(dir, deps(owner));
    expect(again).toMatchObject({ pass: false, reason: 'cleanup_pending', op_id: null });
    expect(scratches(dir)).toHaveLength(1);

    // Once the owner reports the copy ended (or a different owner never ran it), the next drill clears it and passes.
    const later = await runBackupDrill(dir, deps(fakeOwner()));
    expect(later.pass).toBe(true);
    expect(scratches(dir)).toEqual([]);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(false);
  });

  test('a copy whose owner is certainly gone has ended: the next drill clears its scratch', async () => {
    const { dir } = shadow();
    const dead = fakeOwner({ status: async () => { throw new Error('connect ECONNREFUSED'); }, ownerGone: async () => true });
    mkdirSync(join(dir, 'drills', 'scratch-old', 'restored'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-old', drill_id: 'old', scratch: join(dir, 'drills', 'scratch-old'), started_at: 'x' }));
    expect((await runBackupDrill(dir, deps(dead))).pass).toBe(true);
    expect(existsSync(join(dir, 'drills', 'scratch-old'))).toBe(false);
  });

  test('a pending record naming a directory outside the drills directory deletes nothing', async () => {
    const { dir } = shadow();
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-drill-outside-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'keep.txt'), 'mine');
    mkdirSync(join(dir, 'drills', 'not-scratch'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'not-scratch', 'keep.txt'), 'mine too');
    for (const scratch of [outside, join(dir, 'drills', '..', 'store'), join(dir, 'drills', 'not-scratch')]) {
      writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-old', drill_id: 'old', scratch, started_at: 'x' }));
      const rec = await runBackupDrill(dir, deps(fakeOwner()));
      expect(rec.reason).toBe('cleanup_failed');
    }
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(dir, 'store', 'records.redb'))).toBe(true);
    expect(readFileSync(join(dir, 'drills', 'not-scratch', 'keep.txt'), 'utf8')).toBe('mine too');
  });

  test('an unreadable pending record is treated as a copy that may still run', async () => {
    const { dir } = shadow();
    mkdirSync(join(dir, 'drills'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'pending.json'), 'garbage');
    expect((await runBackupDrill(dir, deps(fakeOwner()))).reason).toBe('cleanup_pending');
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(true);
  });

  test('scratch_deleted is observed, not assumed: a directory that cannot be removed is reported', async () => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        chmodSync(join(target, '..'), 0o500); // the scratch directory: its entries cannot be unlinked
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    const rec = await runBackupDrill(dir, deps(owner));
    try {
      expect(rec).toMatchObject({ pass: false, reason: 'cleanup_failed', scratch_deleted: false });
      expect(scratches(dir)).toHaveLength(1);
      expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending' });
    } finally {
      for (const name of scratches(dir)) chmodSync(join(dir, 'drills', name), 0o700);
    }
  });
});

describe('what status counts', () => {
  test('a drill that passed in an earlier epoch does not count in the current one', async () => {
    const { dir } = shadow();
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(true);
    // A new addon opens a new epoch: the earlier drill described the earlier candidate.
    ensureEpoch(dir, { seed_id: SEED.seed_id, rust_addon_sha256: 'e'.repeat(64), comparator_version: 1, adapter_version: 'abi1.catalog1', capability_set_hash: 'caps', readiness_policy_hash: 'policy' });
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'stale', backup_reason: 'backup_drill_other_epoch' });
  });

  test('no record, an unreadable record and a record of another method are not passes', () => {
    const { dir } = shadow();
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_reason: 'backup_drill_missing' });
    mkdirSync(join(dir, 'drills'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'backup.json'), '{"pass":true');
    expect(buildDrillStatus(dir).drills.backup_reason).toBe('backup_drill_unreadable');
    writeFileSync(join(dir, 'drills', 'backup.json'), JSON.stringify({ version: 1, method: 'physical_copy', epoch_id: 'x', pass: true, scratch_deleted: true }));
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_reason: 'backup_drill_unreadable' });
  });

  test('a passing record whose scratch was not deleted is not a pass', async () => {
    const { dir, epochId } = shadow();
    mkdirSync(join(dir, 'drills'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'backup.json'), JSON.stringify({ version: 1, method: 'online_logical', epoch_id: epochId, pass: true, scratch_deleted: false }));
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending' });
  });
});

describe('gbrain engine shadow drill', () => {
  // A Postgres primary at a port nothing listens on: the drill reads and writes only the shadow directory, so it must not mind.
  const CONFIG = { engine: 'postgres' as const, database_url: 'postgresql://postgres:postgres@127.0.0.1:55499/gbrain_test' };
  async function cli(args: string[], setup: (dir: string) => void, extra: Parameters<typeof runEngineShadow>[1] = {}) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-drill-home-'));
    dirs.push(home);
    const out: string[] = [];
    const err: string[] = [];
    const code = await withEnv({ GBRAIN_HOME: home }, async () => {
      const dir = shadowDirFor(shadowBrainKey(CONFIG)!);
      setup(dir);
      return runEngineShadow(args, { config: () => CONFIG, out: l => out.push(l), err: l => err.push(l), ...extra });
    });
    return { code, out: out.join('\n'), err: err.join('\n'), home };
  }
  const seeded = (dir: string): void => { writeStoreFiles(dir); writeEpoch(dir); };

  test('--backup runs the drill, prints the record, and exits 0 on a pass', async () => {
    const owner = fakeOwner();
    const run = await cli(['drill', '--backup', '--json'], seeded, { drill: deps(owner) });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).backup).toMatchObject({ pass: true, method: 'online_logical' });
    const text = await cli(['drill', '--backup'], seeded, { drill: deps(fakeOwner()) });
    expect(text.out).toContain('passed');
    expect(text.out).toContain('scratch deleted: yes');
  });

  test('a refusal is one line with the registered code, its reason and the fix, and exits 1', async () => {
    const run = await cli(['drill', '--backup'], dir => { writeStoreFiles(dir); }, { drill: deps(fakeOwner()) });
    expect(run.code).toBe(1);
    expect(run.err).toContain('shadow_drill_failed (no_seed)');
    expect(run.err).toContain('gbrain engine shadow seed');
  });

  test('--evals fetches and caches; with no flag both halves run; offline it exits 1 with the reason', async () => {
    const text = JSON.stringify(gatesObject());
    const routes: Record<string, string> = {
      [`https://github.com/garrytan/gbrain/releases/download/${TAG}/gbrain-eval-gates.pin.json`]: JSON.stringify(pinFor(text)), [evalUrl()]: text,
    };
    const fetcher = (async (url: string) => (routes[url] ? new Response(routes[url]) : new Response('', { status: 404 }))) as unknown as typeof fetch;
    const evals = await cli(['drill', '--evals', '--json'], seeded, { fetchEvals: { fetch: fetcher, hostTarget: TARGET } });
    expect(evals.code).toBe(0);
    expect(JSON.parse(evals.out).evals).toEqual({ cached: true, reason: null, passed: true });
    const both = await cli(['drill'], seeded, { drill: deps(fakeOwner()), fetchEvals: { fetch: fetcher, hostTarget: TARGET } });
    expect(both.code).toBe(0);
    expect(both.out).toContain('Eval gates E1 to E3: pass');
    const offline = await cli(['drill', '--evals'], seeded, { fetchEvals: { fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, hostTarget: TARGET } });
    expect(offline.code).toBe(1);
    expect(offline.out).toContain('eval_gates_fetch_failed');
  });

  test('an unknown flag is a usage error and the help names the subcommand', async () => {
    expect((await cli(['drill', '--nope'], seeded)).code).toBe(2);
    const help = await cli(['--help'], seeded);
    expect(help.out).toContain('gbrain engine shadow drill [--backup] [--evals] [--json]');
  });
});

describe('review round 1: the lock, the probe, persistence, the addon and the disk check', () => {
  const lockFile = (dir: string): string => join(dir, 'drills', 'drill.lock');
  const deadLock = JSON.stringify({ pid: 2 ** 22 + 12345, at: 1 });

  test('a lock that is empty or cannot be read is never taken over, and nothing is deleted', async () => {
    for (const text of ['', '{"pid":', 'null', '{"pid":"x"}']) {
      const { dir } = shadow();
      mkdirSync(join(dir, 'drills'), { recursive: true });
      writeFileSync(lockFile(dir), text);
      const owner = fakeOwner();
      expect(await runBackupDrill(dir, deps(owner))).toMatchObject({ pass: false, reason: 'drill_running', op_id: null });
      expect(readFileSync(lockFile(dir), 'utf8')).toBe(text);
      expect(owner.snapshots).toHaveLength(0);
    }
  });

  test('a dead holder is taken over only through the takeover file: while another taker holds it, the lock stays', async () => {
    const { dir } = shadow();
    mkdirSync(join(dir, 'drills'), { recursive: true });
    writeFileSync(lockFile(dir), deadLock);
    writeFileSync(join(dir, 'drills', 'drill.lock.takeover'), 'someone else');
    const owner = fakeOwner();
    expect(await runBackupDrill(dir, deps(owner))).toMatchObject({ pass: false, reason: 'drill_running' });
    expect(owner.snapshots).toHaveLength(0);
    expect(readFileSync(lockFile(dir), 'utf8')).toBe(deadLock);
    expect(readFileSync(join(dir, 'drills', 'drill.lock.takeover'), 'utf8')).toBe('someone else');
    // With no takeover in progress the same dead lock is taken, used and released, and the takeover file is gone.
    rmSync(join(dir, 'drills', 'drill.lock.takeover'));
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(existsSync(join(dir, 'drills', 'drill.lock.takeover'))).toBe(false);
  });

  test('a drill releases the lock and the pending record only while they are its own', async () => {
    const { dir } = shadow();
    const theirs = JSON.stringify({ pid: process.pid, at: 5, token: 'someone-else' });
    const otherPending = JSON.stringify({ version: 1, op_id: 'drill-other', drill_id: 'other', scratch: join(dir, 'drills', 'scratch-other'), started_at: 'x' });
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        writeFileSync(lockFile(dir), theirs);
        writeFileSync(join(dir, 'drills', 'pending.json'), otherPending);
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    await runBackupDrill(dir, deps(owner));
    expect(readFileSync(lockFile(dir), 'utf8')).toBe(theirs);
    expect(readFileSync(join(dir, 'drills', 'pending.json'), 'utf8')).toBe(otherPending);
  });

  test('a shadow deleted while the drill runs is not recreated: nothing is published and the reason is shadow_gone', async () => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        rmSync(dir, { recursive: true, force: true }); // gbrain engine shadow stop --delete
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    const rec = await runBackupDrill(dir, deps(owner));
    expect(rec).toMatchObject({ pass: false, reason: 'shadow_gone' });
    expect(existsSync(dir)).toBe(false);
  });

  test('a drill that fails while taking its lock releases the shadow and drills directory holds', async () => {
    const { dir } = shadow();
    // The lock is stamped with `now()` right after both directories are held: fail there (the same point a full disk or a
    // read-only drills directory fails), once the drills directory exists.
    const failing = (): number => { if (existsSync(join(dir, 'drills'))) throw new Error('lock admission failed'); return Date.now(); };
    const open = (): number => readdirSync('/dev/fd').length;
    const before = open();
    await expect(runBackupDrill(dir, deps(fakeOwner(), { now: failing }))).rejects.toThrow('lock admission failed');
    expect(open()).toBe(before);
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(false);
  });

  test('stop --delete refuses while a drill holds its lock and deletes nothing; once the drill ends it deletes', async () => {
    const { dir } = shadow();
    const lines: string[] = [];
    let during = -1;
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        during = await __stopForTests({ key: 'pglite-abc', dir, engine: 'pglite' }, true, l => lines.push(l));
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    expect(await runBackupDrill(dir, deps(owner))).toMatchObject({ pass: true, reason: null });
    expect(during).toBe(1);
    expect(lines.join('\n')).toMatch(/drill_running.*Nothing was stopped or deleted/);
    expect(await __stopForTests({ key: 'pglite-abc', dir, engine: 'pglite' }, true, () => {})).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test('delete reservation excludes the first backup: with no drills directory yet, stop --delete still holds the drill lock', async () => {
    const { dir } = shadow();
    expect(existsSync(join(dir, 'drills'))).toBe(false);
    const release = takeDrillLockForDelete(dir)!;
    try {
      expect((await runBackupDrill(dir, deps(fakeOwner()))).reason).toBe('drill_running');
    } finally { release(false); }
  });

  test('stop --delete keeps the drill lock until the shadow is gone, and removes the drills directory with it', async () => {
    const { dir } = shadow();
    expect(await __stopForTests({ key: 'pglite-abc', dir, engine: 'pglite' }, true, () => {})).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test('each open the drill makes is given a check that turns false once the shadow is gone (the imports before a connect are an await)', async () => {
    const { dir } = shadow();
    const seen: unknown[] = [];
    const owner = fakeOwner();
    const rec = await runBackupDrill(dir, deps(owner, {
      openOwner: async (_addon, _store, check) => { seen.push(check?.()); rmSync(dir, { recursive: true, force: true }); seen.push(check?.()); return owner; },
    }));
    expect(seen).toEqual([true, false]);
    expect(rec).toMatchObject({ pass: false, reason: 'shadow_gone' });
    expect(existsSync(dir)).toBe(false);
  });

  test('a shadow replaced by a new one while the drill runs gets no record from the old drill', async () => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(join(dir, 'drills'), { recursive: true });
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    expect(await runBackupDrill(dir, deps(owner))).toMatchObject({ pass: false, reason: 'shadow_gone' });
    expect(existsSync(join(dir, 'drills', 'backup.json'))).toBe(false);
    expect(existsSync(join(dir, 'drills', 'history.jsonl'))).toBe(false);
  });

  test('the drill must verify and open the copy with the addon the epoch started on, and the record carries its digest', async () => {
    const { dir } = shadow();
    const ok = await runBackupDrill(dir, deps(fakeOwner()));
    expect(ok).toMatchObject({ pass: true, addon_sha256: ADDON_SHA });
    expect(JSON.parse(readFileSync(join(dir, 'drills', 'backup.json'), 'utf8')).addon_sha256).toBe(ADDON_SHA);
    for (const [name, sha] of [['another addon', 'd'.repeat(64)], ['an addon file that cannot be read', null]] as const) {
      const { dir: other } = shadow();
      const owner = fakeOwner();
      const rec = await runBackupDrill(other, deps(owner, { addonSha256: () => sha }));
      expect([name, rec.reason, rec.pass, rec.addon_sha256]).toEqual([name, 'addon_mismatch', false, sha]);
      expect(owner.snapshots).toHaveLength(0);
      expect(existsSync(join(other, 'drills'))).toBe(false);
    }
    for (const addon of [null, 'unreadable']) {
      const { dir: other } = shadow();
      writeEpoch(other, { addon });
      expect((await runBackupDrill(other, deps(fakeOwner()))).reason).toBe('addon_mismatch');
    }
  });

  test('the digest is the one the shadow child records: the sha256 of the override file, else the cached build', async () => {
    const { dir } = shadow();
    const file = join(dir, 'addon.node');
    writeFileSync(file, 'addon bytes');
    const expected = new Bun.CryptoHasher('sha256').update('addon bytes').digest('hex');
    await withEnv({ GBRAIN_RUST_ENGINE_ADDON: file }, async () => { expect(addonFileSha256({ engineBuild: 'b', target: 't' })).toBe(expected); });
    await withEnv({ GBRAIN_RUST_ENGINE_ADDON: join(dir, 'missing.node') }, async () => { expect(addonFileSha256({ engineBuild: 'b', target: 't' })).toBeNull(); });
  });

  describe('a release-installed addon (master: <build>/<target>-<sha256>.node, no override)', () => {
    const bytes = 'installed addon bytes';
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    /** A temp GBRAIN_HOME holding the current version's cached manifest and, unless `file` is false, only the content-addressed file. */
    const installed = (file: boolean, manifest = true): string => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
      dirs.push(home);
      const rust = join(home, '.gbrain', 'engines', 'rust');
      mkdirSync(join(rust, 'build-1'), { recursive: true });
      if (manifest) writeFileSync(join(rust, `manifest-${VERSION}.json`), JSON.stringify({ gbrain_version: VERSION, engine_abi: 1, engine_build: 'build-1', targets: { t: { asset: 'a.node', sha256: sha, bytes: bytes.length } } }));
      if (file) writeFileSync(join(rust, 'build-1', `t-${sha}.node`), bytes);
      return home;
    };
    const noOverride = (home: string): Record<string, string | undefined> => ({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: undefined });

    test('the digest is the content-addressed file the cached manifest names, whatever engineBuild the addon reports', async () => {
      await withEnv(noOverride(installed(true)), async () => {
        expect(addonFileSha256({ engineBuild: 'build-1', target: 't' })).toBe(sha);
        expect(addonFileSha256({ engineBuild: 'not-the-manifest-build', target: 't' })).toBe(sha);
      });
    });

    test('no manifest, a manifest naming no such target, or a named file that is missing is null, never a digest', async () => {
      await withEnv(noOverride(installed(false)), async () => { expect(addonFileSha256({ target: 't' })).toBeNull(); });
      await withEnv(noOverride(installed(true, false)), async () => { expect(addonFileSha256({ target: 't' })).toBeNull(); });
      await withEnv(noOverride(installed(true)), async () => { expect(addonFileSha256({ target: 'other-target' })).toBeNull(); });
    });

    test('a drill with the real digest reader passes on the installed addon, and refuses addon_mismatch when the file cannot be read', async () => {
      const real = (extra: Partial<DrillDeps> = {}): DrillDeps => ({ ...deps(fakeOwner(), extra), addonSha256: undefined, loadAddon: async () => ({ ok: true, addon: { target: 't' } as never }) });
      const { dir } = shadow();
      writeEpoch(dir, { addon: sha });
      await withEnv(noOverride(installed(true)), async () => { expect(await runBackupDrill(dir, real())).toMatchObject({ pass: true, addon_sha256: sha }); });
      const { dir: other } = shadow();
      writeEpoch(other, { addon: sha });
      await withEnv(noOverride(installed(false)), async () => {
        expect(await runBackupDrill(other, real())).toMatchObject({ pass: false, reason: 'addon_mismatch', addon_sha256: null });
      });
      expect(existsSync(join(other, 'drills'))).toBe(false);
    });
  });

  test('a copy an earlier drill left behind is cleared before the disk check, so it cannot hold the space it needs', async () => {
    const { dir } = shadow(10 * 1024 * 1024);
    const old = join(dir, 'drills', 'scratch-old');
    mkdirSync(join(old, 'restored'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-old', drill_id: 'old', scratch: old, started_at: 'x' }));
    const short = { bavail: Math.floor((2 * 10 * 1024 * 1024 + 2 * 1024 ** 3 - 1) / 4096), bsize: 4096 };
    const owner = fakeOwner();
    const rec = await runBackupDrill(dir, deps(owner, { statfs: () => (existsSync(old) ? short : plenty) }));
    expect(rec).toMatchObject({ pass: true });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(false);
    // Still short once it is cleared: refused with disk_space, the old copy gone, no new copy made.
    mkdirSync(join(old, 'restored'), { recursive: true });
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-old', drill_id: 'old', scratch: old, started_at: 'x' }));
    const again = fakeOwner();
    expect(await runBackupDrill(dir, deps(again, { statfs: () => short }))).toMatchObject({ pass: false, reason: 'disk_space', op_id: null });
    expect(existsSync(old)).toBe(false);
    expect(again.snapshots).toHaveLength(0);
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(false);
  });

  describe('the probe of the opened copy', () => {
    interface FakePage { slug: string; source_id: string; text: string }
    function engine(pages: FakePage[], hitsFor: (word: string) => number, seen: { words: string[]; scopes: unknown[] } = { words: [], scopes: [] }): ProbeEngine & { seen: typeof seen } {
      return {
        seen,
        getStats: async () => ({ page_count: pages.length }) as never,
        listPages: async () => pages.map(p => ({ slug: p.slug, source_id: p.source_id })) as never,
        getChunks: async (slug: string, opts?: { sourceId?: string }) => {
          seen.scopes.push(opts);
          // Like the real member: a read without the page's own source finds only the default source.
          const page = pages.find(p => p.slug === slug && p.source_id === (opts?.sourceId ?? 'default'));
          return (page ? [{ chunk_text: page.text }] : []) as never;
        },
        searchKeyword: async (word: string) => { seen.words.push(word); return Array.from({ length: hitsFor(word) }, () => ({})) as never; },
      };
    }

    test('a longest word that is a stop word is skipped: the next word that the engine answers is the probe', async () => {
      const e = engine([{ slug: 'notes/a', source_id: 'default', text: 'quasar themselves' }], w => (w === 'quasar' ? 2 : 0));
      expect(await probeCopy(e, true)).toEqual({ pages: 1, searchHits: 2 });
      expect(e.seen.words).toEqual(['quasar']); // the stop word is never searched
    });

    test('a page of a named source is read in its own source', async () => {
      const e = engine([{ slug: 'notes/a', source_id: 'wiki', text: 'harbor lanterns' }], () => 1);
      expect(await probeCopy(e, true)).toEqual({ pages: 1, searchHits: 1 });
      expect(e.seen.scopes).toEqual([{ sourceId: 'wiki' }]);
    });

    test('pages under a slug prefix the search excludes give no probe word', async () => {
      const prefix = DEFAULT_HARD_EXCLUDES[0]!;
      const e = engine([{ slug: `${prefix}x`, source_id: 'default', text: 'harbor lanterns' }], () => 1);
      await expect(probeCopy(e, true)).rejects.toMatchObject({ drillReason: 'no_probe_term' });
      expect(e.seen.words).toEqual([]);
    });

    test('a populated copy where no word is answered, or no word exists, is no_probe_term; an incomplete index may miss but must query', async () => {
      const text = [{ slug: 'notes/a', source_id: 'default', text: 'Because cats' }];
      await expect(probeCopy(engine(text, () => 0), true)).rejects.toMatchObject({ drillReason: 'no_probe_term' });
      expect(await probeCopy(engine(text, () => 0), false)).toEqual({ pages: 1, searchHits: 0 });
      const none = [{ slug: 'notes/a', source_id: 'default', text: '12 34 ab' }];
      await expect(probeCopy(engine(none, () => 1), false)).rejects.toMatchObject({ drillReason: 'no_probe_term' });
      expect(await probeCopy(engine([], () => 1), true)).toEqual({ pages: 0, searchHits: null });
    });

    test('stop words are dropped before the budget: 30 stop words longer than the real word never use up its tries', async () => {
      const stops = ENGLISH_STOPWORDS.filter(w => w.length >= 5).slice(0, 30);
      expect(stops.length).toBe(30);
      const e = engine([{ slug: 'notes/a', source_id: 'default', text: `${stops.join(' ')} cats` }], w => (w === 'cats' ? 1 : 0));
      expect(await probeCopy(e, true)).toEqual({ pages: 1, searchHits: 1 });
      expect(e.seen.words).toEqual(['cats']);
    });

    test('excluded pages cannot fill the page budget: the exclusion runs in the listing, before its limit', async () => {
      const prefix = DEFAULT_HARD_EXCLUDES[0]!;
      const newest = Array.from({ length: 25 }, (_, n) => ({ slug: `${prefix}p${n}`, source_id: 'default', text: 'attached filler words' }));
      const pages = [...newest, { slug: 'notes/older', source_id: 'default', text: 'harbor lanterns' }];
      const seen = { words: [] as string[], scopes: [] as unknown[] };
      const base = engine(pages, w => (w === 'harbor' || w === 'lanterns' ? 1 : 0), seen);
      const filters: unknown[] = [];
      const e: ProbeEngine = {
        ...base,
        // Like the store: the exclusion and the limit are applied in this order.
        listPages: async (f?: { limit?: number; excludeSlugPrefixes?: string[] }) => {
          filters.push(f);
          const kept = pages.filter(p => !(f?.excludeSlugPrefixes ?? []).some(x => p.slug.startsWith(x)));
          return kept.slice(0, f?.limit ?? kept.length).map(p => ({ slug: p.slug, source_id: p.source_id })) as never;
        },
      };
      expect(await probeCopy(e, true)).toEqual({ pages: 26, searchHits: 1 });
      expect((filters[0] as { excludeSlugPrefixes: string[] }).excludeSlugPrefixes).toContain(prefix);
    });

    test('the drill records no_probe_term, never a pass, for a populated copy that ran no search', async () => {
      const { dir } = shadow();
      const viaProbe = await runBackupDrill(dir, deps(fakeOwner(), { openCopy: (_a, _d, hit) => probeCopy(engine([{ slug: 'notes/a', source_id: 'default', text: 'Because cats' }], () => 0), hit) }));
      expect(viaProbe).toMatchObject({ pass: false, reason: 'no_probe_term' });
      const noSearch = await runBackupDrill(dir, deps(fakeOwner(), { openCopy: async () => ({ pages: 3, searchHits: null }) }));
      expect(noSearch).toMatchObject({ pass: false, reason: 'no_probe_term' });
      expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_reason: 'backup_drill_failed:no_probe_term' });
    });
  });
});

describe('review of the third merge: a failed result write never leaves an earlier pass standing, and a hung owner cannot hold the drill', () => {
  const criterion10 = (dir: string): string => evaluateReadiness({ drills: { ...buildDrillStatus(dir).drills, eval_gates_e1_e3: true } } as ShadowStatus).criteria.find(c => c.n === 10)!.state;

  test('a drill that cannot write its result (history append fails) after an earlier pass leaves readiness failing, not passing', async () => {
    const { dir } = shadow();
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(true);
    // The next drill finds a damaged copy, but its history file cannot be appended to (a directory stands where it was).
    rmSync(join(dir, 'drills', 'history.jsonl'));
    mkdirSync(join(dir, 'drills', 'history.jsonl'));
    const rec = await runBackupDrill(dir, deps(fakeOwner(), { verify: async () => report({ verdict: 'mismatch', mismatches: ['tag_digest:50'] }) }));
    expect(rec).toMatchObject({ pass: false, reason: 'drill_error' });
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(false);
    expect(criterion10(dir)).toBe('fail');
    // The marker stays until a result is durable, so the state reads as an unfinished copy, never as the earlier pass.
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(true);
    // A later drill that refuses before it publishes (no free disk) cannot bring the earlier pass back either.
    const refused = await runBackupDrill(dir, deps(fakeOwner(), { statfs: () => ({ bavail: 1, bsize: 1 }) }));
    expect(refused.reason).toBe('disk_space');
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(false);
    expect(criterion10(dir)).toBe('fail');
  });

  test('a result that is written removes the pending marker only after it is durable', async () => {
    const { dir } = shadow();
    const rec = await runBackupDrill(dir, deps(fakeOwner()));
    expect(rec.pass).toBe(true);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'drills', 'backup.json'), 'utf8')).drill_id).toBe(rec.drill_id);
  });

  test('an owner whose status call never answers does not hold the drill past its deadline: the lock is released and the copy stays pending', async () => {
    const { dir } = shadow();
    const owner = fakeOwner({
      snapshot: async () => { throw stopped('cancelled'); },
      status: () => new Promise<SnapshotStatus>(() => { /* never answers */ }),
    });
    const t0 = Date.now();
    const rec = await runBackupDrill(dir, deps(owner, { endedWaitMs: 60, endedPollMs: 5 }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(rec).toMatchObject({ pass: false, reason: 'snapshot_cancelled', scratch_deleted: false });
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(false);
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(true);
    expect(scratches(dir)).toHaveLength(1);
    expect(buildDrillStatus(dir).drills).toMatchObject({ backup_restore_passed: false, backup_state: 'cleanup_pending' });
  });
});

describe('second fix round: recovery never revives an older pass, and the lock is held through publication', () => {
  const criterion10 = (dir: string): string => evaluateReadiness({ drills: { ...buildDrillStatus(dir).drills, eval_gates_e1_e3: true } } as ShadowStatus).criteria.find(c => c.n === 10)!.state;
  const lowDisk = { bavail: 1, bsize: 1 };

  test('recovery of an unpublished failed drill cannot revive an older pass (the drill that wrote the marker could neither publish nor remove the old record)', async () => {
    const { dir } = shadow();
    const first = await runBackupDrill(dir, deps(fakeOwner()));
    expect(first.pass).toBe(true);
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(true);
    // What a drill leaves when both its result write and its removal of the old record failed: the old pass, plus its own
    // pending marker, with its scratch already gone.
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-lost', drill_id: 'lost', scratch: join(dir, 'drills', 'scratch-lost'), started_at: new Date().toISOString() }) + '\n');
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(false);
    // The next drill clears that marker and then refuses for lack of disk, publishing nothing: the old pass must not come back.
    const refused = await runBackupDrill(dir, deps(fakeOwner(), { statfs: () => lowDisk }));
    expect(refused.reason).toBe('disk_space');
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(false);
    expect(criterion10(dir)).toBe('fail');
  });

  test('recovery that cannot remove the old result refuses cleanup_failed and keeps the pending marker', async () => {
    const { dir } = shadow();
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-lost', drill_id: 'lost', scratch: join(dir, 'drills', 'scratch-lost'), started_at: new Date().toISOString() }) + '\n');
    // A non-empty directory stands where backup.json was: removing it as a file fails.
    rmSync(join(dir, 'drills', 'backup.json'));
    mkdirSync(join(dir, 'drills', 'backup.json'));
    writeFileSync(join(dir, 'drills', 'backup.json', 'x'), 'x');
    const refused = await runBackupDrill(dir, deps(fakeOwner()));
    expect(refused).toMatchObject({ pass: false, reason: 'cleanup_failed', op_id: null });
    expect(existsSync(join(dir, 'drills', 'pending.json'))).toBe(true);
    expect(buildDrillStatus(dir).drills.backup_restore_passed).toBe(false);
  });

  test('the drill lock is held while the result is published: a second process cannot take it between the end of one drill and its write', async () => {
    const { dir } = shadow();
    const lock = join(dir, 'drills', 'drill.lock');
    const seen: boolean[] = [];
    // Every clock read in the drill says whether another process could take the lock right now (an exclusive create, as the
    // lock itself is made); the last read is the one `finish` makes just before it writes history.jsonl and backup.json.
    const now = (): number => {
      let acquirable = false;
      try { writeFileSync(lock, '{"pid":1}', { flag: 'wx' }); acquirable = true; rmSync(lock); } catch { /* held, or no drills dir yet */ }
      seen.push(acquirable);
      return Date.now();
    };
    const rec = await runBackupDrill(dir, deps(fakeOwner(), { now }));
    expect(rec.pass).toBe(true);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe(false);
    expect(existsSync(lock)).toBe(false); // and it is released once the result is written
  });

  test('every path out of a drill that took the lock releases it, including a refusal before the copy', async () => {
    const { dir } = shadow();
    expect((await runBackupDrill(dir, deps(fakeOwner()))).pass).toBe(true);
    writeFileSync(join(dir, 'drills', 'pending.json'), JSON.stringify({ version: 1, op_id: 'drill-lost', drill_id: 'lost', scratch: join(dir, 'drills', 'scratch-lost'), started_at: new Date().toISOString() }) + '\n');
    expect((await runBackupDrill(dir, deps(fakeOwner(), { statfs: () => lowDisk }))).reason).toBe('disk_space');
    expect(existsSync(join(dir, 'drills', 'drill.lock'))).toBe(false);
  });
});

describe('the stop word list is the Rust engine list (review round 2)', () => {
  test('ENGLISH_STOPWORDS equals the list in rust/crates/gbrain-store/src/keyword/stem.rs, word for word and in order', () => {
    // test-reads-source-ok[structural]: the addon does not export its stop word list (src/shadow/english-stopwords.ts), so the hand copy is checked against the Rust source it must equal.
    const source = readFileSync(join(import.meta.dir, '..', 'rust', 'crates', 'gbrain-store', 'src', 'keyword', 'stem.rs'), 'utf8');
    const block = /const ENGLISH_STOPWORDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(source);
    expect(block).not.toBeNull();
    const rust = [...block![2]!.matchAll(/"([^"]*)"/g)].map(m => m[1]!);
    expect(rust.length).toBe(Number(block![1]));
    expect([...ENGLISH_STOPWORDS]).toEqual(rust);
  });

  test('the check reads the Rust file: a list that differs by one word is not equal', () => {
    expect([...ENGLISH_STOPWORDS.slice(0, -1)]).not.toEqual([...ENGLISH_STOPWORDS]);
    expect(ENGLISH_STOPWORDS).toContain('themselves');
  });
});

describe('gbrain engine shadow drill: a shadow deleted by the backup half is not recreated by the eval half (review round 2)', () => {
  test('the default drill reports shadow_gone for both halves and leaves nothing behind', async () => {
    const CONFIG = { engine: 'postgres' as const, database_url: 'postgresql://postgres:postgres@127.0.0.1:55499/gbrain_test' };
    const home = mkdtempSync(join(tmpdir(), 'gbrain-drill-home-'));
    dirs.push(home);
    const fileText = JSON.stringify(gatesObject());
    const routes: Record<string, string> = {
      [`https://github.com/garrytan/gbrain/releases/download/${TAG}/gbrain-eval-gates.pin.json`]: JSON.stringify(pinFor(fileText)), [evalUrl()]: fileText,
    };
    const fetcher = (async (url: string) => (routes[url] ? new Response(routes[url]) : new Response('', { status: 404 }))) as unknown as typeof fetch;
    const out: string[] = [];
    let shadowDir = '';
    const owner = fakeOwner({
      snapshot: async (target, options) => {
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, 'records.redb'), 'copy');
        rmSync(shadowDir, { recursive: true, force: true }); // gbrain engine shadow stop --delete
        return { op_id: options.opId, state: 'done', manifest: MANIFEST, free_bytes: { initial: 1, low: 1 } } as never;
      },
    });
    const code = await withEnv({ GBRAIN_HOME: home }, async () => {
      shadowDir = shadowDirFor(shadowBrainKey(CONFIG)!);
      writeStoreFiles(shadowDir);
      writeEpoch(shadowDir);
      return runEngineShadow(['drill', '--json'], { config: () => CONFIG, out: l => out.push(l), err: () => undefined, drill: deps(owner), fetchEvals: { fetch: fetcher, hostTarget: TARGET } });
    });
    expect(code).toBe(1);
    const result = JSON.parse(out.join('\n'));
    expect(result.backup.reason).toBe('shadow_gone');
    expect(result.evals).toEqual({ cached: false, reason: 'shadow_gone', passed: false });
    expect(existsSync(shadowDir)).toBe(false);
  });
});
