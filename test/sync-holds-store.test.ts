/**
 * #5988 Lane B: the Git hold store. One row per hold plus a per-source
 * summary; version-conditional on the run's discovery time; exempt from the
 * 7-day checkpoint purge while the source incarnation lives.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import {
  GIT_HOLD_OP, buildHoldReport, clearGitHold, commonPathPrefix, countGitHolds, gitHoldFingerprint, gitHoldItem, holdsEscalated,
  readGitHold, readGitHoldRetryPaths, readGitSourceHolds, readSyncHoldPolicy, requestGitHoldRetry, clearGitHoldRetryPaths, writeGitHold,
  recordSyncImportProvenance, readSyncImportProvenance, recordSyncConversion, readSyncConversions, SYNC_CONVERSION_KEEP, type GitHoldRecord,
} from '../src/core/persistence/sync-holds.ts';
import { readHeldCoverage } from '../src/core/persistence/held-reads.ts';

let engine: BrainEngine;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('holds-a','holds-a','{}'),('holds-b','holds-b','{}')");
  incarnation = (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='holds-a'"))[0].incarnation;
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

const hold = (path: string, observed: string, extra: Partial<GitHoldRecord> = {}): Omit<GitHoldRecord, 'version' | 'held_at' | 'updated_at'> => ({
  source_id: 'holds-a', incarnation, path, source_path: path, slug: path.replace(/\.md$/, ''), page_id: null, code: 'invalid_frontmatter',
  message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.', upstream_version: `sha-${observed}`, observed_at: observed,
  run_id: 'run-1', mode: 'managed', meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 }, ...extra,
});

describe('git hold store', () => {
  test('write, re-write and clear keep the summary count exact', async () => {
    expect(await writeGitHold(engine, hold('notes/a.md', '2026-01-01T00:00:00.000Z'))).toBe('inserted');
    expect(await writeGitHold(engine, hold('notes/a.md', '2026-01-01T00:00:00.000Z'))).toBe('updated');
    expect(await writeGitHold(engine, hold('notes/b.md', '2026-01-01T00:00:00.000Z'))).toBe('inserted');
    expect(await countGitHolds(engine, 'holds-a', incarnation)).toBe(2);
    expect(await clearGitHold(engine, { sourceId: 'holds-a', incarnation, path: 'notes/b.md', observedAt: '2026-01-02T00:00:00.000Z' })).toBe(true);
    expect(await clearGitHold(engine, { sourceId: 'holds-a', incarnation, path: 'notes/b.md', observedAt: '2026-01-02T00:00:00.000Z' })).toBe(false);
    expect(await countGitHolds(engine, 'holds-a', incarnation)).toBe(1);
  });

  test('an older run neither replaces nor clears a hold a newer run wrote', async () => {
    await writeGitHold(engine, hold('notes/c.md', '2026-02-01T00:00:00.000Z'));
    const before = await readGitHold(engine, 'holds-a', incarnation, 'notes/c.md');
    expect(await writeGitHold(engine, hold('notes/c.md', '2026-01-15T00:00:00.000Z', { upstream_version: 'older' }))).toBe('skipped');
    expect(await clearGitHold(engine, { sourceId: 'holds-a', incarnation, path: 'notes/c.md', observedAt: '2026-01-15T00:00:00.000Z' })).toBe(false);
    expect(await readGitHold(engine, 'holds-a', incarnation, 'notes/c.md')).toEqual(before);
  });

  test('reads are scoped to the source and its current incarnation, and items carry code, reason, key, line, fix and docs', async () => {
    const listed = await readGitSourceHolds(engine, { sourceIds: ['holds-a'] });
    expect(listed.map(entry => entry.holds.map(h => h.path))).toEqual([['notes/a.md', 'notes/c.md']]);
    expect(await readGitSourceHolds(engine, { sourceIds: ['holds-b'] })).toEqual([]);
    const item = gitHoldItem(listed[0].holds[0]);
    expect(item).toMatchObject({ path: 'notes/a.md', code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2,
      docs: 'docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation' });
    expect(item.fix.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'holds-a', '--include-ambiguous']);
    const big = gitHoldItem({ ...listed[0].holds[0], code: 'file_too_large', meta: { recovery_version: 1 } });
    expect(big.fix.why).toContain('size limit is fixed');
    expect(big.fix.why).toContain('sync.exclude');
  });

  test('hold rows 8 days old survive the checkpoint purge; a retired incarnation does not', async () => {
    await writeGitHold(engine, hold('notes/old.md', '2026-01-01T00:00:00.000Z'));
    await engine.executeRaw('UPDATE op_checkpoints SET updated_at=now()-interval \'8 days\' WHERE op LIKE \'sync-hold%\'');
    await purgeStaleCheckpoints(engine, 7);
    expect(await readGitHold(engine, 'holds-a', incarnation, 'notes/old.md')).not.toBeNull();
    expect(await countGitHolds(engine, 'holds-a', incarnation)).toBe(3);
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,now()-interval '8 days')`,
      [GIT_HOLD_OP, gitHoldFingerprint('holds-a', '00000000-0000-0000-0000-000000000000', 'x.md'),
        JSON.stringify([{ ...hold('x.md', '2026-01-01T00:00:00.000Z'), incarnation: '00000000-0000-0000-0000-000000000000' }])]);
    await purgeStaleCheckpoints(engine, 7);
    const [retired] = await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [GIT_HOLD_OP, gitHoldFingerprint('holds-a', '00000000-0000-0000-0000-000000000000', 'x.md')]);
    expect(retired).toBeUndefined();
  });

  test('a hold write costs the same statements with 20k holds already stored', async () => {
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      SELECT $1,'holds-b:'||$2||':bulk/'||g||'.md',jsonb_build_array(jsonb_build_object('source_id','holds-b','incarnation',$2::text,'path','bulk/'||g||'.md','observed_at','2026-01-01T00:00:00.000Z'))
      FROM generate_series(1,20000) g`, [GIT_HOLD_OP, 'inc-b']);
    let statements = 0;
    const counting = { executeRaw: async (sql: string, params?: unknown[]) => { statements++; return engine.executeRaw(sql, params); } } as Pick<BrainEngine, 'executeRaw'>;
    await writeGitHold(counting, hold('notes/d.md', '2026-03-01T00:00:00.000Z'));
    const few = statements;
    statements = 0;
    await writeGitHold(counting, { ...hold('bulk/20001.md', '2026-03-01T00:00:00.000Z'), source_id: 'holds-b', incarnation: 'inc-b' });
    expect(statements).toBe(few);
    expect(few).toBeLessThanOrEqual(4);
  });

  test('retry requests accumulate paths and clear only the ones taken', async () => {
    await requestGitHoldRetry(engine, 'holds-a', incarnation, ['notes/a.md']);
    await requestGitHoldRetry(engine, 'holds-a', incarnation, ['notes/c.md', 'notes/a.md']);
    expect((await readGitHoldRetryPaths(engine, 'holds-a', incarnation)).sort()).toEqual(['notes/a.md', 'notes/c.md']);
    await clearGitHoldRetryPaths(engine, 'holds-a', incarnation, ['notes/a.md']);
    expect(await readGitHoldRetryPaths(engine, 'holds-a', incarnation)).toEqual(['notes/c.md']);
    await clearGitHoldRetryPaths(engine, 'holds-a', incarnation, ['notes/c.md']);
    expect(await readGitHoldRetryPaths(engine, 'holds-a', incarnation)).toEqual([]);
  });

  test('policy defaults, overrides and escalation thresholds (count, and percentage only from 40 screened)', async () => {
    expect(await readSyncHoldPolicy(engine)).toEqual({ mode: 'hold', cap: 500, escalateCount: 50, escalatePct: 5, parserRegression: 'hold' });
    // #6712 PR 2: sync.holds stays a brain key; the cap, the thresholds and the parser-regression stop are tuned by their
    // GBRAIN_SYNC_* environment variables, and the retired keys stored on a brain are not applied.
    await engine.setConfig('sync.holds', 'fail'); await engine.setConfig('sync.hold_cap', '2'); await engine.setConfig('sync.parser_regression', 'stop');
    await engine.setConfig('sync.hold_escalate_count', '10'); await engine.setConfig('sync.hold_escalate_pct', '20');
    expect(await readSyncHoldPolicy(engine, {})).toEqual({ mode: 'fail', cap: 500, escalateCount: 50, escalatePct: 5, parserRegression: 'hold' });
    expect(await readSyncHoldPolicy(engine, { GBRAIN_SYNC_HOLD_CAP: '2', GBRAIN_SYNC_PARSER_REGRESSION: 'stop', GBRAIN_SYNC_HOLD_ESCALATE_COUNT: '10', GBRAIN_SYNC_HOLD_ESCALATE_PCT: '20' }))
      .toEqual({ mode: 'fail', cap: 2, escalateCount: 10, escalatePct: 20, parserRegression: 'stop' });
    const defaults = { escalateCount: 50, escalatePct: 5 };
    expect(holdsEscalated(defaults, 51, { held: 0, screened: 0 })).toBe(true);
    expect(holdsEscalated(defaults, 50, { held: 0, screened: 0 })).toBe(false);
    expect(holdsEscalated(defaults, 3, { held: 3, screened: 39 })).toBe(false);
    expect(holdsEscalated(defaults, 3, { held: 3, screened: 40 })).toBe(true);
    expect(holdsEscalated(defaults, 2, { held: 2, screened: 40 })).toBe(false);
    for (const key of ['sync.holds', 'sync.hold_cap', 'sync.parser_regression', 'sync.hold_escalate_count', 'sync.hold_escalate_pct']) await engine.unsetConfig(key);
  });

  test('the report caps detail at the cap, never storage, and remote callers get counts only', async () => {
    const policy = { mode: 'hold' as const, cap: 1, escalateCount: 50, escalatePct: 5, parserRegression: 'stop' as const };
    const local = await buildHoldReport(engine, { sourceId: 'holds-a', incarnation, runId: 'run-1', remote: false, policy, screened: 10 });
    expect(local.held).toHaveLength(1);
    expect(local).toMatchObject({ held_count: 4, holds_outstanding: 4, holds_truncated: true });
    expect(local.holds_fix!.why).toContain('gbrain sources status holds-a');
    expect(local.holds_fix!.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', 'holds-a']);
    const remote = await buildHoldReport(engine, { sourceId: 'holds-a', incarnation, runId: 'run-1', remote: true, policy, screened: 10 });
    expect(Object.keys(remote).sort()).toEqual(['held_count', 'holds_fix']);
    expect(remote.holds_fix).toMatchObject({ actor: 'host_admin' });
    expect(JSON.stringify(remote)).not.toContain('notes/');
  });

  test('the summary row counts holds whose page exists as stale, through updates and clears', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('holds-c','holds-c','{}')");
    const inc = (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text FROM sources WHERE id='holds-c'"))[0].incarnation;
    const at = (path: string, observed: string, page_id: number | null) => ({ ...hold(path, observed), source_id: 'holds-c', incarnation: inc, page_id });
    await writeGitHold(engine, at('n/new.md', '2026-01-01T00:00:00.000Z', null));
    await writeGitHold(engine, at('n/mod.md', '2026-01-01T00:00:00.000Z', 41));
    expect(await readHeldCoverage(engine, { sourceId: 'holds-c' })).toEqual([{ source_id: 'holds-c', missing: 1, stale: 1 }]);
    await writeGitHold(engine, at('n/new.md', '2026-01-02T00:00:00.000Z', 42));
    expect(await readHeldCoverage(engine, { sourceId: 'holds-c' })).toEqual([{ source_id: 'holds-c', missing: 0, stale: 2 }]);
    await clearGitHold(engine, { sourceId: 'holds-c', incarnation: inc, path: 'n/mod.md', observedAt: '2026-01-03T00:00:00.000Z' });
    expect(await readHeldCoverage(engine, { sourceId: 'holds-c' })).toEqual([{ source_id: 'holds-c', missing: 0, stale: 1 }]);
    await clearGitHold(engine, { sourceId: 'holds-c', incarnation: inc, path: 'n/new.md', observedAt: '2026-01-03T00:00:00.000Z' });
    expect(await readHeldCoverage(engine, { sourceId: 'holds-c' })).toEqual([]);
  });

  test('the conversion log keeps the newest conversions, bounded, and survives the checkpoint purge', async () => {
    for (let i = 0; i < SYNC_CONVERSION_KEEP + 3; i++) {
      await recordSyncConversion(engine, 'holds-a', incarnation, { request_id: `req-${i}`, path: `notes/${i}.md`, slug: `notes/${i}`, run_id: 'run-9', outcome: i % 2 ? 'held' : 'refrozen' });
    }
    const all = (await readSyncConversions(engine, ['holds-a', 'holds-b'], 100)).get('holds-a')!;
    expect(all).toHaveLength(SYNC_CONVERSION_KEEP);
    expect(all[0]).toMatchObject({ request_id: `req-${SYNC_CONVERSION_KEEP + 2}`, outcome: 'refrozen' });
    expect(all.at(-1)!.request_id).toBe('req-3');
    expect((await readSyncConversions(engine, ['holds-a'], 2)).get('holds-a')!.map(c => c.request_id)).toEqual([`req-${SYNC_CONVERSION_KEEP + 2}`, `req-${SYNC_CONVERSION_KEEP + 1}`]);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='sync-conversions'");
    await purgeStaleCheckpoints(engine, 7);
    expect((await readSyncConversions(engine, ['holds-a'], 100)).get('holds-a')).toHaveLength(SYNC_CONVERSION_KEEP);
  });

  test('import provenance round-trips and the common prefix names the generator directory', async () => {
    await recordSyncImportProvenance(engine, { source_id: 'holds-a', incarnation, page_id: 7, origin: 'notes/a.md', raw_sha256: 'abc', gbrain_version: '0.0.0' });
    expect(await readSyncImportProvenance(engine, 'holds-a', incarnation, 7)).toMatchObject({ raw_sha256: 'abc', validated: true });
    expect(commonPathPrefix(['tweets/2026/a.md', 'tweets/2026/b.md'])).toBe('tweets/2026');
    expect(commonPathPrefix(['a.md', 'tweets/b.md'])).toBe('');
  });
});
