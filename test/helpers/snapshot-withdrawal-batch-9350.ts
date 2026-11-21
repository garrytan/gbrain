import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pageSnapshotKey, readPageSnapshotsBatch } from '../../src/core/page-snapshot-batch.ts';
import type { ReadQuery } from '../../src/core/search/read-enrichment.ts';
import { FENCE } from './page-snapshot-batch-cases.ts';

/** The journal travels once per source, not once per page; the public snapshots retain exact parity. */
export async function snapshotWithdrawalBatchBound(engine: BrainEngine) {
  const source = `batch-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
  const refs = Array.from({ length: 16 }, (_, i) => ({ sourceId: source, slug: `notes/page-${i}` }));
  for (const ref of refs) await engine.putPage(ref.slug, { type: 'note', title: ref.slug, compiled_truth: FENCE, timeline: '' }, { sourceId: source });
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
    SELECT $1,'world','*',md5(n::text)||md5(n::text) FROM generate_series(1,128) n`, [source]);
  const statements: Array<{ sql: string; params: unknown[]; rows: Array<Record<string, unknown>> }> = [];
  const query: ReadQuery = async <T>(sql: string, params?: unknown[]) => {
    const rows = await engine.executeRaw<T>(sql, params);
    statements.push({ sql, params: params ?? [], rows: rows as Array<Record<string, unknown>> });
    return rows;
  };
  const result = await readPageSnapshotsBatch(query, refs);
  expect(result.covered).toBe(refs.length);
  expect(statements).toHaveLength(1);
  for (const ref of refs) expect(result.snapshots.get(pageSnapshotKey(source, ref.slug)) ?? null).toEqual(await engine.readPageSnapshot(ref.slug, { sourceId: source }));
  const statement = statements[0]!;
  const carried = statement.rows.reduce((n, row) => n + (row.snapshot_withdrawals as unknown[]).length
    + ((row.snapshot_source_withdrawals as unknown[] | null | undefined)?.length ?? 0), 0);
  expect(carried).toBe(128);
  const [explained] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.params);
  const scans: PlanNode[] = [];
  const walk = (node: PlanNode) => { if (node['Relation Name'] === 'fact_withdrawals') scans.push(node); for (const child of node.Plans ?? []) walk(child); };
  walk(explained!['QUERY PLAN'][0]!.Plan);
  expect(scans.length).toBeGreaterThan(0);
  const visits = scans.reduce((n, node) => n + ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0), 0);
  expect(visits).toBeLessThanOrEqual(256);

  const localSource = `local-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [localSource]);
  const localRefs = Array.from({ length: 64 }, (_, i) => ({ sourceId: localSource, slug: `notes/page-${i}` }));
  for (const ref of localRefs) await engine.putPage(ref.slug, { type: 'note', title: ref.slug, compiled_truth: FENCE, timeline: '' }, { sourceId: localSource });
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
    SELECT $1,'world','notes/page-'||n::text,md5(n::text)||md5(n::text) FROM generate_series(0,63) n`, [localSource]);
  statements.length = 0;
  await readPageSnapshotsBatch(query, localRefs);
  const localStatement = statements[0]!;
  const [localPlan] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${localStatement.sql}`, localStatement.params);
  let localVisits = 0;
  const localWalk = (node: PlanNode) => {
    if (node['CTE Name'] === 'page_withdrawals') localVisits += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 0);
    for (const child of node.Plans ?? []) localWalk(child);
  };
  localWalk(localPlan!['QUERY PLAN'][0]!.Plan);
  expect(localVisits).toBeGreaterThan(0);
  expect(localVisits).toBeLessThanOrEqual(128);
}

interface PlanNode {
  'Relation Name'?: string;
  'CTE Name'?: string;
  'Actual Rows'?: number;
  'Rows Removed by Filter'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

/** Global/local duplicates preserve SQL min precision, visibility, source and original ordering. */
export async function snapshotWithdrawalBatchParity(engine: BrainEngine) {
  const source = `parity-${randomUUID()}`, other = `other-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)', [source, other]);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const page = { type: 'note', title: 'Synthetic', compiled_truth: FENCE, timeline: FENCE };
  for (const sourceId of [source, other]) {
    await engine.putPage('notes/a', page, { sourceId });
    await engine.putPage('notes/b', page, { sourceId });
  }
  const insert = (sourceId: string, subject: string, visibility: string, claim: string, time: string) =>
    engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,subject,visibility,fact_hash,withdrawn_at)
      VALUES($1,$2,$3,$4,$5::text::timestamptz)`, [sourceId, subject, visibility, hash(claim), time]);
  await insert(source, '*', 'world', 'ships weekly', '2026-01-01T00:00:00.000002Z');
  await insert(source, 'notes/a', 'world', 'ships weekly', '2026-01-01T00:00:00.000001Z');
  await insert(source, 'notes/b', 'world', 'ships weekly', '2026-01-01T00:00:00.000003Z');
  await insert(source, '*', 'private', 'ships weekly', '2026-01-02T00:00:00Z');
  await insert(source, 'notes/a', 'world', 'hires slowly', '2026-01-03T00:00:00Z');
  await insert(other, '*', 'world', 'hires slowly', '2026-01-04T00:00:00Z');
  const [precision] = await engine.executeRaw<{ stamp: string }>(`SELECT withdrawn_at::text AS stamp FROM fact_withdrawals
    WHERE source_id=$1 AND subject='notes/a' AND fact_hash=$2`, [source, hash('ships weekly')]);
  expect(precision!.stamp).toContain('.000001');
  await engine.softDeletePage('notes/b', { sourceId: other });
  const refs = [
    { sourceId: source, slug: 'notes/missing' }, { sourceId: source, slug: 'notes/a' },
    { sourceId: other, slug: 'notes/b' }, { sourceId: other, slug: 'notes/a' },
    { sourceId: source, slug: 'notes/b' }, { sourceId: source, slug: 'notes/a' },
  ];
  for (const includeDeleted of [false, true]) {
    const batch = await engine.readPageSnapshotsBatch(refs, { includeDeleted, absentIsNull: true });
    expect(batch.covered).toBe(refs.length);
    for (const ref of refs) expect(batch.snapshots.get(pageSnapshotKey(ref.sourceId, ref.slug)) ?? null)
      .toEqual(await engine.readPageSnapshot(ref.slug, { sourceId: ref.sourceId, includeDeleted }));
  }
  const bounded = await engine.readPageSnapshotsBatch(refs, { maxBytes: 1, absentIsNull: true });
  expect(bounded.covered).toBe(2);
  expect(bounded.snapshots.get(pageSnapshotKey(source, 'notes/a')) ?? null).toEqual(await engine.readPageSnapshot('notes/a', { sourceId: source }));

  const before = await engine.readPageSnapshot('notes/a', { sourceId: source });
  let calls = 0;
  const query: ReadQuery = async <T>(sql: string, params?: unknown[]) => {
    calls++;
    const rows = await engine.executeRaw<T>(sql, params);
    await insert(source, '*', 'world', 'later claim', '2026-01-05T00:00:00Z');
    await engine.putPage('notes/a', { ...page, compiled_truth: 'Later body' }, { sourceId: source, expectedRevision: before!.revision });
    return rows;
  };
  const pinned = await readPageSnapshotsBatch(query, [{ sourceId: source, slug: 'notes/a' }]);
  expect(calls).toBe(1);
  expect(pinned.snapshots.get(pageSnapshotKey(source, 'notes/a')) ?? null).toEqual(before);
  expect((await engine.readPageSnapshot('notes/a', { sourceId: source }))!.revision).not.toBe(before!.revision);
}
