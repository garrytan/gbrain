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
import { runBackupDrill, type DrillDeps, type DrillOwner } from '../src/shadow/drill.ts';
import { buildDrillStatus } from '../src/shadow/drill-status.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { ensureEpoch } from '../src/shadow/evidence-epoch.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import type { StoreSnapshotManifest, StoreVerifyReport } from '../src/core/rust-engine/store.ts';
import type { SnapshotStatus } from '../src/core/rust-engine/store-snapshot.ts';
import { evalUrl, gatesObject, pinFor, SEED, TARGET, TAG, writeEpoch, writeStoreFiles } from './helpers/shadow-drill-fixtures.ts';
import { withEnv } from './helpers/with-env.ts';

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
    openCopy: async () => ({ pages: 3, searchHits: 1 }), statfs: () => plenty, id: () => `d${++ids}`, endedWaitMs: 40, endedPollMs: 5, ...over,
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
