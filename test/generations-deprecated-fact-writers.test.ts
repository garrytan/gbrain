/**
 * GBRA-161 PR 2: `deleteFactsForPage`, `expireFact` and `insertFacts({ deleteForPageFirst })` retire facts with no proof
 * and no before-state, so they are deprecated: fence rows retire through `publishFenceGeneration`, extracted rows through
 * `publishExtractedFacts`. Only the engine layers that implement them may name them; a new production caller fails here.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const IMPLEMENTERS = new Set(['src/core/engine.ts', 'src/core/engine-sql/facts.ts', 'src/core/pglite-engine.ts', 'src/core/postgres-engine.ts']);
const CALL = /\.(?:deleteFactsForPage|expireFact)\s*\(|\bdeleteForPageFirst\s*:/g;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}

test('no production code calls the deprecated fact writers', () => {
  const callers = files(join(root, 'src')).map(path => relative(root, path)).filter(path => !IMPLEMENTERS.has(path))
    .flatMap(path => [...readFileSync(join(root, path), 'utf8').matchAll(CALL)].map(match => `${path}: ${match[0]}`));
  expect(callers, 'Retire facts through publishFenceGeneration or publishExtractedFacts (docs/architecture/generations.md).').toEqual([]);
});

test('the guard sees a planted call', () => {
  expect('await engine.deleteFactsForPage(slug, sourceId)'.match(CALL)).toHaveLength(1);
  expect('await tx.expireFact (id)'.match(CALL)).toHaveLength(1);
  expect('insertFacts(rows, ctx, { deleteForPageFirst: { slug } })'.match(CALL)).toHaveLength(1);
});
