import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REVIVE_PAGE_REFERENCES, REVIVE_SLUG_STORES } from '../src/core/persistence/concept-revive.ts';
import { PURGE_SWEEP_STORES } from '../src/core/persistence/page-purge.ts';
import { scrubPurgedSlugs } from '../src/core/feedback/store.ts';
import { scrubPurgedNameStores } from '../src/core/persistence/purge-name-stores.ts';
import { scrubPurgedSlugHolds, scrubPurgedSlugStores } from '../src/core/persistence/purge-slug-stores.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// #9653 (PR 2): a concept rebuild clears every store holding text of the old body. Each column with a foreign key to
// pages, and each store a hard purge scrubs outside them, is classified in concept-revive.ts; a new one fails here.
const sorted = (keys: Iterable<string>) => [...new Set(keys)].sort();

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`concept rebuild store classification (${backend})`, () => {
    test('every foreign key to pages is classified', async () => {
      await managedBrain(async ({ engine }) => {
        const rows = await engine.executeRaw<{ key: string }>(`SELECT c.conrelid::regclass::text || '.' || a.attname AS key FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.contype = 'f' AND c.confrelid = 'pages'::regclass`);
        expect(sorted(rows.map(row => row.key))).toEqual(sorted(Object.keys(REVIVE_PAGE_REFERENCES)));
      }, { databaseUrl });
    }, 300_000);

    test('every store the hard purge scrubs is classified, taken from the purge code\'s own list', async () => {
      await managedBrain(async ({ engine }) => {
        const scrubbed = await engine.transaction(async tx => [
          ...Object.keys(await scrubPurgedSlugs(tx, 'default', ['concepts/none'])),
          ...Object.keys(await scrubPurgedNameStores(tx, 'default', ['concepts/none'])),
          ...Object.keys(await scrubPurgedSlugStores(tx, 'default', ['concepts/none'])),
          ...Object.keys(await scrubPurgedSlugHolds(tx, 'default', [{ slug: 'concepts/none' }])),
        ]);
        expect(sorted(Object.keys(REVIVE_SLUG_STORES))).toEqual(sorted([...scrubbed, ...PURGE_SWEEP_STORES, 'facts', 'query_cache']));
      }, { databaseUrl });
    }, 300_000);
  });
}

test('the purge code calls no scrub this classification does not read', () => {
  const calls = (file: string) => [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/(?<!function )\b(scrub[A-Za-z]+|expireGonePageFacts|clearRebuildableCache)\(/g)].map(m => m[1]!);
  expect(sorted([...calls('../src/core/persistence/purge-deleted.ts'), ...calls('../src/core/engine-sql/pages.ts'), ...calls('../src/core/persistence/page-purge.ts')]))
    .toEqual(['clearRebuildableCache', 'expireGonePageFacts', 'scrubGenerationLedger', 'scrubPurgedNameStores', 'scrubPurgedSlugHolds', 'scrubPurgedSlugStores', 'scrubPurgedSlugs']);
});
