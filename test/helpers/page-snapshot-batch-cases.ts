/** Shared cases for readPageSnapshotsBatch (PGLite unit test and Postgres E2E). */
import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { normalizeLoweredClaim } from '../../src/core/facts/withdrawal-schema.ts';
import { pageSnapshotKey, readPageSnapshotsBatch } from '../../src/core/page-snapshot-batch.ts';
import type { ReadQuery } from '../../src/core/search/read-enrichment.ts';

export const OTHER = 'snapshot-batch-example';
export const FENCE = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
  + '| 1 | Ships  Weekly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n'
  + '| 2 | Hires slowly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n<!--- gbrain:facts:end -->';

export async function seed(engine: BrainEngine) {
  if ((await engine.executeRaw('SELECT 1 FROM sources WHERE id=$1', [OTHER])).length) return;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [OTHER]);
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: `Alice.\n\n${FENCE}`, timeline: '- **2026-01-02** | call — Met' });
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice elsewhere', compiled_truth: `Other Alice.\n\n${FENCE}`, timeline: '' }, { sourceId: OTHER });
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme', compiled_truth: 'Acme  Corp\nSecond   line', timeline: 'T' });
  await engine.putPage('notes/deleted-example', { type: 'note', title: 'Deleted', compiled_truth: 'Gone.', timeline: '' });
  await engine.addTag('companies/acme-example', 'b-tag');
  await engine.addTag('companies/acme-example', 'a-tag');
  await engine.softDeletePage('notes/deleted-example');
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',$1)`,
    [createHash('sha256').update(normalizeLoweredClaim('ships weekly')).digest('hex')]);
}

export const REFS = [
  { slug: 'people/alice-example', sourceId: 'default' },
  { slug: 'companies/acme-example', sourceId: 'default' },
  { slug: 'people/alice-example', sourceId: OTHER },
  { slug: 'notes/deleted-example', sourceId: 'default' },
  { slug: 'notes/missing-example', sourceId: 'default' },
  { slug: 'companies/acme-example', sourceId: OTHER },
];

export async function pageSnapshotBatchMatchesPerPageReads(engine: BrainEngine) {
  await seed(engine);
  const { snapshots, covered } = await engine.readPageSnapshotsBatch(REFS);
  expect(covered).toBe(REFS.length);
  for (const ref of REFS) {
    const single = await engine.readPageSnapshot(ref.slug, { sourceId: ref.sourceId });
    expect(snapshots.get(pageSnapshotKey(ref.sourceId, ref.slug)) ?? null).toEqual(single);
  }
  expect([...snapshots.keys()].sort()).toEqual([pageSnapshotKey('default', 'companies/acme-example'),
    pageSnapshotKey('default', 'people/alice-example'), pageSnapshotKey(OTHER, 'people/alice-example')].sort());
  const alice = snapshots.get(pageSnapshotKey('default', 'people/alice-example'))!;
  expect(alice.withdrawals).toHaveLength(1);
  const [stored] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id='default' AND slug='people/alice-example'`);
  expect(alice.page.compiled_truth).not.toBe(stored!.compiled_truth);
  expect(snapshots.get(pageSnapshotKey(OTHER, 'people/alice-example'))!.withdrawals).toEqual([]);
  expect(snapshots.get(pageSnapshotKey('default', 'companies/acme-example'))!.tags).toEqual(['a-tag', 'b-tag']);
}

export async function pageSnapshotBatchRespectsByteBudget(engine: BrainEngine) {
  await seed(engine);
  const live = [REFS[0]!, REFS[1]!, REFS[2]!];
  const bytes = (await engine.executeRaw<{ n: number }>(`SELECT octet_length(compiled_truth) + octet_length(timeline) AS n FROM pages
    WHERE source_id='default' AND slug='people/alice-example'`))[0]!.n;
  expect((await engine.readPageSnapshotsBatch(live, { maxBytes: 1 })).covered).toBe(1);
  const two = await engine.readPageSnapshotsBatch(live, { maxBytes: Number(bytes) + 1 });
  expect(two.covered).toBe(2);
  expect([...two.snapshots.keys()]).toEqual([pageSnapshotKey('default', 'people/alice-example'), pageSnapshotKey('default', 'companies/acme-example')]);
  const missingFirst = await engine.readPageSnapshotsBatch([REFS[4]!, REFS[3]!, REFS[1]!], { maxBytes: 1 });
  expect(missingFirst.covered).toBe(3);
  expect([...missingFirst.snapshots.keys()]).toEqual([pageSnapshotKey('default', 'companies/acme-example')]);
  expect((await engine.readPageSnapshotsBatch([])).covered).toBe(0);
}

export const PURGED = 'snapshot-batch-purge-example';
const claimHash = (claim: string) => createHash('sha256').update(normalizeLoweredClaim(claim)).digest('hex');

/** Page-subject purges and the source's '*' purge marker overlay batched bodies exactly as the per-page read does. */
export async function seedPurged(engine: BrainEngine) {
  if (!(await engine.executeRaw('SELECT 1 FROM sources WHERE id=$1', [PURGED])).length) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [PURGED]);
    await engine.putPage('people/carol-example', { type: 'person', title: 'Carol', compiled_truth: `Carol.\n\n${FENCE}`, timeline: '' }, { sourceId: PURGED });
    await engine.putPage('people/dave-example', { type: 'person', title: 'Dave', compiled_truth: `Dave.\n\n${FENCE}`, timeline: '' }, { sourceId: PURGED });
    await engine.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'No  fence\nhere', timeline: 'T' }, { sourceId: PURGED });
    const purge = `INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason) VALUES ($1,'world',$2,$3,$4::uuid,'test','test')`;
    await engine.executeRaw(purge, [PURGED, 'people/carol-example', claimHash('hires slowly'), '00000000-0000-4000-8000-000000000001']);
    await engine.executeRaw(purge, [PURGED, '*', claimHash('ships weekly'), '00000000-0000-4000-8000-000000000002']);
  }
}

export async function pageSnapshotBatchMatchesPurgedReads(engine: BrainEngine) {
  await seedPurged(engine);
  const refs = ['people/carol-example', 'people/dave-example', 'notes/plain-example'].map(slug => ({ slug, sourceId: PURGED }));
  const { snapshots, covered } = await engine.readPageSnapshotsBatch(refs);
  expect(covered).toBe(refs.length);
  for (const ref of refs) expect(snapshots.get(pageSnapshotKey(ref.sourceId, ref.slug)) ?? null).toEqual(await engine.readPageSnapshot(ref.slug, { sourceId: ref.sourceId }));
  const carol = snapshots.get(pageSnapshotKey(PURGED, 'people/carol-example'))!;
  expect(carol.withdrawals.map(w => [w.fact_hash, w.purged]).sort()).toEqual([[claimHash('hires slowly'), true], [claimHash('ships weekly'), true]].sort());
  expect(carol.page.compiled_truth).not.toContain('Hires slowly');
  expect(carol.page.compiled_truth).not.toContain('Ships  Weekly');
  const dave = snapshots.get(pageSnapshotKey(PURGED, 'people/dave-example'))!;
  expect(dave.page.compiled_truth).toContain('Hires slowly');
  expect(dave.page.compiled_truth).not.toContain('Ships  Weekly');
  expect(dave.globalPurges?.count).toBe(1);
}

export const SOURCE_WIDE = 'snapshot-batch-wide-example';
const SOURCE_WIDE_COUNT = 40;

/**
 * #9350: a source's '*' withdrawals cross the wire once per batch, not once per page, and every batched snapshot
 * still equals the per-page read: a page-subject withdrawal of a claim that is also withdrawn source-wide keeps the
 * earlier time, a page-only withdrawal and another visibility stay separate, and a second source keeps its own ledger.
 */
export async function pageSnapshotBatchCarriesSourceWideOnce(engine: BrainEngine) {
  await seed(engine);
  if (!(await engine.executeRaw('SELECT 1 FROM sources WHERE id=$1', [SOURCE_WIDE])).length) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [SOURCE_WIDE]);
    for (const slug of ['people/erin-example', 'people/frank-example', 'notes/wide-plain-example']) {
      await engine.putPage(slug, { type: slug.startsWith('people/') ? 'person' : 'note', title: slug, compiled_truth: `${slug}.\n\n${FENCE}`, timeline: '' }, { sourceId: SOURCE_WIDE });
    }
    const add = `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash,withdrawn_at) VALUES ($1,$2,$3,$4,$5::timestamptz)`;
    for (let i = 0; i < SOURCE_WIDE_COUNT; i++) await engine.executeRaw(add, [SOURCE_WIDE, 'world', '*', claimHash(`unrelated claim ${i}`), '2026-03-01T00:00:00Z']);
    await engine.executeRaw(add, [SOURCE_WIDE, 'world', '*', claimHash('ships weekly'), '2026-03-02T00:00:00Z']);
    await engine.executeRaw(add, [SOURCE_WIDE, 'world', 'people/erin-example', claimHash('ships weekly'), '2026-02-01T00:00:00Z']);
    await engine.executeRaw(add, [SOURCE_WIDE, 'private', 'people/erin-example', claimHash('ships weekly'), '2026-04-01T00:00:00Z']);
    await engine.executeRaw(add, [SOURCE_WIDE, 'world', 'people/frank-example', claimHash('hires slowly'), '2026-04-01T00:00:00Z']);
  }
  const refs = [
    { slug: 'notes/missing-example', sourceId: SOURCE_WIDE },
    { slug: 'people/erin-example', sourceId: SOURCE_WIDE },
    { slug: 'people/alice-example', sourceId: 'default' },
    { slug: 'people/frank-example', sourceId: SOURCE_WIDE },
    { slug: 'notes/wide-plain-example', sourceId: SOURCE_WIDE },
    { slug: 'companies/acme-example', sourceId: 'default' },
  ];
  const shipped: number[] = [];
  const counted: ReadQuery = async <T,>(sql: string, params?: unknown[]) => {
    const rows = await engine.executeRaw<Record<string, unknown>>(sql, params);
    if (sql.includes('batch_n')) {
      for (const row of rows) for (const value of Object.values(row)) {
        if (Array.isArray(value) && value.some(w => w && typeof w === 'object' && 'fact_hash' in w)) shipped.push(value.length);
      }
    }
    return rows as T[];
  };
  const { snapshots, covered } = await readPageSnapshotsBatch(counted, refs);
  expect(covered).toBe(refs.length);
  expect(shipped.reduce((a, b) => a + b, 0)).toBeLessThan(2 * (SOURCE_WIDE_COUNT + 1));
  for (const ref of refs) expect(snapshots.get(pageSnapshotKey(ref.sourceId, ref.slug)) ?? null).toEqual(await engine.readPageSnapshot(ref.slug, { sourceId: ref.sourceId }));
  const erin = snapshots.get(pageSnapshotKey(SOURCE_WIDE, 'people/erin-example'))!;
  expect(erin.withdrawals).toHaveLength(SOURCE_WIDE_COUNT + 2);
  const shipsWeekly = erin.withdrawals.filter(w => w.fact_hash === claimHash('ships weekly'));
  expect(shipsWeekly.map(w => [w.visibility, new Date(w.withdrawn_at).toISOString()])).toEqual([
    ['private', '2026-04-01T00:00:00.000Z'], ['world', '2026-02-01T00:00:00.000Z']]);
  expect(erin.page.compiled_truth).toContain('~~Ships  Weekly~~');
  expect(snapshots.get(pageSnapshotKey(SOURCE_WIDE, 'people/frank-example'))!.withdrawals).toHaveLength(SOURCE_WIDE_COUNT + 2);
  expect(snapshots.get(pageSnapshotKey(SOURCE_WIDE, 'notes/wide-plain-example'))!.withdrawals).toHaveLength(SOURCE_WIDE_COUNT + 1);
  expect(snapshots.get(pageSnapshotKey('default', 'people/alice-example'))!.withdrawals).toHaveLength(1);
}

