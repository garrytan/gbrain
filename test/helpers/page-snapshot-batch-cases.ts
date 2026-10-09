/** Shared cases for readPageSnapshotsBatch (PGLite unit test and Postgres E2E). */
import { createHash } from 'node:crypto';
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { normalizeLoweredClaim } from '../../src/core/facts/withdrawal-schema.ts';
import { pageSnapshotKey, readPageSnapshotsBatch } from '../../src/core/page-snapshot-batch.ts';

const OTHER = 'snapshot-batch-example';
const FENCE = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
  + '| 1 | Ships  Weekly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n'
  + '| 2 | Hires slowly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n<!--- gbrain:facts:end -->';

async function seed(engine: BrainEngine) {
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

const REFS = [
  { slug: 'people/alice-example', sourceId: 'default' },
  { slug: 'companies/acme-example', sourceId: 'default' },
  { slug: 'people/alice-example', sourceId: OTHER },
  { slug: 'notes/deleted-example', sourceId: 'default' },
  { slug: 'notes/missing-example', sourceId: 'default' },
  { slug: 'companies/acme-example', sourceId: OTHER },
];

export async function pageSnapshotBatchMatchesPerPageReads(engine: BrainEngine) {
  await seed(engine);
  const { snapshots, covered } = await readPageSnapshotsBatch(engine, REFS);
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
  expect((await readPageSnapshotsBatch(engine, live, { maxBytes: 1 })).covered).toBe(1);
  const two = await readPageSnapshotsBatch(engine, live, { maxBytes: Number(bytes) + 1 });
  expect(two.covered).toBe(2);
  expect([...two.snapshots.keys()]).toEqual([pageSnapshotKey('default', 'people/alice-example'), pageSnapshotKey('default', 'companies/acme-example')]);
  const missingFirst = await readPageSnapshotsBatch(engine, [REFS[4]!, REFS[3]!, REFS[1]!], { maxBytes: 1 });
  expect(missingFirst.covered).toBe(3);
  expect([...missingFirst.snapshots.keys()]).toEqual([pageSnapshotKey('default', 'companies/acme-example')]);
  expect((await readPageSnapshotsBatch(engine, [])).covered).toBe(0);
}
