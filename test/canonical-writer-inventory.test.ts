import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const method = 'putPage|refreshPageBody|deletePage|deletePages|softDeletePage|softDeletePages|restorePage|purgeDeletedPages|addTag|removeTag|addTimelineEntry|addTimelineEntriesBatch|upsertEventProjection|addTakesBatch|updateTake|supersedeTake|resolveTake|insertFact|insertFacts|deleteFactsForPage|expireFact|consolidateFact|migrateFactsToCanonical|revertToVersion|updateSlug|setPageAliases|addLink|removeLink|rewriteLinks';
const pattern = new RegExp(`\\.(?:${method})\\s*(?:\\?\\.)?\\s*\\(|\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(?:pages|tags|slug_aliases|page_aliases|facts|takes|timeline_entries|sources)\\b`, 'gi');
// Direct content imports bypass the coordinator unless they carry `prepare`; count every call site.
const importPattern = /(?<!function\s+)(?<![.\w])importFromContent\s*\(/g;
function count(body: string): number { return [...body.matchAll(pattern)].length + [...body.matchAll(importPattern)].length; }
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [join(directory, entry.name)] : []);
}
type Inventory = Map<string, { ceiling: number; boundary: string; reason: string }>;
function loadInventory(): Inventory {
  const rows = readFileSync(join(root, 'docs/architecture/canonical-writers.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  return new Map(rows.map(([path, ceiling, boundary, reason]) => [path, { ceiling: Number(ceiling), boundary, reason }]));
}
function gapsFor(sources: Iterable<[string, string]>, inventory: Inventory): string[] {
  const gaps: string[] = [];
  for (const [path, body] of sources) {
    const sites = count(body); const row = inventory.get(path);
    if (sites && (!row || sites > row.ceiling)) gaps.push(`${path}: ${sites} write references; reviewed ceiling ${row?.ceiling ?? 0}`);
  }
  return gaps;
}
test('new canonical write callsites require a reviewed inventory and an enforcement boundary', () => {
  const inventory = loadInventory();
  const gaps = gapsFor(files(join(root, 'src')).map(file => [relative(root, file), readFileSync(file, 'utf8')] as [string, string]), inventory);
  for (const [path, row] of inventory) {
    expect(['coordinator', 'engine_guard', 'early_refusal', 'filesystem_guard', 'projection', 'schema', 'isolated_eval', 'contract']).toContain(row.boundary);
    expect(row.reason.length).toBeGreaterThan(20);
    expect(readFileSync(join(root, path), 'utf8').length).toBeGreaterThan(0);
  }
  expect(gaps, 'Classify each addition in canonical-writers.tsv after checking DB and filesystem ordering.').toEqual([]);
});
test('a planted bypass in a converted writer or a new file fails the census', () => {
  const inventory = loadInventory();
  // test-reads-source-ok[structural]: the census is a source-text tripwire by design; the planted copy proves it flags a new bypass.
  const links = readFileSync(join(root, 'src/core/ops/links.ts'), 'utf8');
  const concepts = readFileSync(join(root, 'src/core/cycle/synthesize-concepts.ts'), 'utf8');
  expect(gapsFor([['src/core/ops/links.ts', links], ['src/core/cycle/synthesize-concepts.ts', concepts]], inventory)).toEqual([]);
  expect(gapsFor([
    ['src/core/ops/links.ts', `${links}\nawait ctx.engine.addLink(a, b, '', '', 'manual');`],
    ['src/core/cycle/synthesize-concepts.ts', `${concepts}\nawait importFromContent(engine, slug, md, { sourceId });`],
    ['src/core/cycle/new-writer.ts', 'await engine.putPage(slug, page);'],
  ], inventory)).toEqual([
    'src/core/ops/links.ts: 4 write references; reviewed ceiling 3',
    'src/core/cycle/synthesize-concepts.ts: 3 write references; reviewed ceiling 2',
    'src/core/cycle/new-writer.ts: 1 write references; reviewed ceiling 0',
  ]);
});
test('every mutating operation and named CLI writer is classified for managed brains', async () => {
  const { operations } = await import('../src/core/operations.ts');
  const rows = readFileSync(join(root, 'docs/architecture/managed-mutating-writers.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const classes = ['coordinator', 'no_canonical_write', 'early_refusal', 'engine_guard'];
  for (const [kind, name, klass, reason] of rows) {
    expect(['op', 'cli']).toContain(kind);
    expect(classes).toContain(klass);
    expect(reason?.length ?? 0).toBeGreaterThan(20);
    if (kind === 'cli') expect(readFileSync(join(root, name), 'utf8').length).toBeGreaterThan(0);
  }
  const classified = rows.filter(([kind]) => kind === 'op').map(([, name]) => name).sort();
  const mutating = operations.filter(op => op.mutating).map(op => op.name).sort();
  expect(classified, 'Classify each mutating operation in managed-mutating-writers.tsv.').toEqual(mutating);
});
test('the census detects direct, optional and multiline SQL writers', () => {
  expect(count('await engine.putPage("x", page); await engine.insertFact?.(fact); await tx.executeRaw(`UPDATE\n pages SET title=$1`);')).toBe(3);
  expect(count('await engine.getPage("x"); await tx.executeRaw(`UPDATE embedding_jobs SET status=$1`);')).toBe(0);
});
