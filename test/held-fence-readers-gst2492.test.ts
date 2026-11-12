/**
 * GST-2492 PR 2: the purge readers read memory/unattributed's entity column.
 *
 * 1. Protects: memory/unattributed's Facts table carries an `entity` column (PR 1), which only a parser told the slug
 *    reads; any other parse reports the fence malformed and returns no rows. The purge guard that drops a failed write's
 *    stored copy of purged content (`intentCarriesPurgedContent`) and a page purge's claim inventory (`pagePurgeClaims`,
 *    which redacts the belief ledger) read that page's rows, so a purged held claim is found there.
 * 2. Fails when: a failed write to memory/unattributed keeps a purged claim in its stored intent, or a page purge of
 *    memory/unattributed misses a claim in its retained versions.
 * 3. Existing coverage: test/remember-strict-held-gst2492.test.ts purges a held fact end to end.
 * 4. Real seams: the SQL fingerprint the guards use, on PGLite and Postgres.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { intentCarriesPurgedContent } from '../src/core/persistence/purged-intent.ts';
import { pagePurgeClaims } from '../src/core/belief/purge.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const CLAIM = 'The kitchen remodel starts in March.';
const fence = [
  '## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | entity |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  `| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-11-11 |  | chat 2026-11-11 |  | notes/kitchen-remodel |`,
  '<!--- gbrain:facts:end -->', '',
].join('\n');

async function unguarded(engine: BrainEngine, write: () => Promise<unknown>): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await write(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

for (const backend of testBackends()) describe(`[${backend}] the purge readers read memory/unattributed's entity column (GST-2492 PR 2)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a failed write to memory/unattributed that carries a purged held claim is found by the purge guard', async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES('default','world',$1,gbrain_fact_fingerprint($2))`, [HOLD, CLAIM]);
      const content = `---\ntype: note\ntitle: Unattributed memory\n---\n\n${fence}`;
      expect(await intentCarriesPurgedContent(engine, { source_id: 'default', slug: HOLD, intent: { content } } as never, { facts: true, pages: false })).toBe(true);
    } finally { await close(); }
  }, 120_000);

  test("a page purge of memory/unattributed collects a held claim from the page's retained versions", async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await unguarded(engine, () => engine.putPage(HOLD, { type: 'note', title: 'Unattributed memory', compiled_truth: 'Nothing held yet.', frontmatter: {} } as never, { sourceId: 'default' }));
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [HOLD]);
      await unguarded(engine, () => engine.executeRaw('INSERT INTO page_versions(page_id, compiled_truth) VALUES($1, $2)', [page!.id, fence]));
      const { claims } = await pagePurgeClaims(engine, { sourceId: 'default', slug: HOLD, pageId: Number(page!.id), lifetimes: [] });
      expect(claims).toContain(CLAIM);
    } finally { await close(); }
  }, 120_000);
});
