import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const method = 'putPage|refreshPageBody|deletePage|deletePages|softDeletePage|softDeletePages|restorePage|purgeDeletedPages|addTag|removeTag|addTimelineEntry|addTimelineEntriesBatch|upsertEventProjection|addTakesBatch|updateTake|supersedeTake|resolveTake|insertFact|insertFacts|deleteFactsForPage|expireFact|consolidateFact|migrateFactsToCanonical|revertToVersion|updateSlug|setPageAliases|addLink|removeLink|rewriteLinks';
const pattern = new RegExp(`\\.(?:${method})\\s*(?:\\?\\.)?\\s*\\(|\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(?:pages|tags|slug_aliases|page_aliases|facts|takes|timeline_entries|sources)\\b`, 'gi');
function count(body: string): number { return [...body.matchAll(pattern)].length; }
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [join(directory, entry.name)] : []);
}
test('new canonical write callsites require a reviewed inventory and an enforcement boundary', () => {
  const rows = readFileSync(join(root, 'docs/architecture/canonical-writers.tsv'), 'utf8').split('\n')
    .filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const inventory = new Map(rows.map(([path, ceiling, boundary, reason]) => [path, { ceiling: Number(ceiling), boundary, reason }]));
  const gaps: string[] = [];
  for (const file of files(join(root, 'src'))) {
    const path = relative(root, file); const sites = count(readFileSync(file, 'utf8')); const row = inventory.get(path);
    if (sites && (!row || sites > row.ceiling)) gaps.push(`${path}: ${sites} write references; reviewed ceiling ${row?.ceiling ?? 0}`);
  }
  for (const [path, row] of inventory) {
    expect(['coordinator', 'engine_guard', 'early_refusal', 'filesystem_guard', 'projection', 'schema', 'isolated_eval', 'contract']).toContain(row.boundary);
    expect(row.reason.length).toBeGreaterThan(20);
    expect(readFileSync(join(root, path), 'utf8').length).toBeGreaterThan(0);
  }
  expect(gaps, 'Classify each addition in canonical-writers.tsv after checking DB and filesystem ordering.').toEqual([]);
});
test('the census detects direct, optional and multiline SQL writers', () => {
  expect(count('await engine.putPage("x", page); await engine.insertFact?.(fact); await tx.executeRaw(`UPDATE\n pages SET title=$1`);')).toBe(3);
  expect(count('await engine.getPage("x"); await tx.executeRaw(`UPDATE embedding_jobs SET status=$1`);')).toBe(0);
});
