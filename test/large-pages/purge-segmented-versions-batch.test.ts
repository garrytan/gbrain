/**
 * Wave B PR 2 fix lane C2 (D4): purge_fact redacts every retained segmented
 * generation, past the first batch of versions.
 *
 * 1. Protects: the segmented version redaction walks page_versions in keyset
 *    batches of VERSION_REDACTION_BATCH (5,000), as the inline redaction does,
 *    so a generation whose version sorts after the first 5,000 candidate
 *    versions is rebuilt without the claim. Versions sharing a generation share
 *    one rebuild (the receipt counts two rebuilt generations).
 * 2. Fails when: the segmented redaction reads one LIMIT 5000 page with no
 *    continuation (the later generation keeps the purged claim).
 * 3. Fixture: 5,000 extra version rows of the first page reference generation
 *    0, which no manifest row covers (an empty, 0-byte generation, so each costs
 *    one manifest read and its rows tile it),
 *    and push the second page's real version past the first batch. purge_fact versions each page before rewriting it,
 *    and every segmented version insert prunes the page's history to `versions.segmented_max_per_page`, so the fixture
 *    raises that cap above the 5,000 extra rows: the redaction still walks them.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operations } from '../../src/core/operations.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { segmentedBodyContains } from '../../src/core/page-body/segment-rewrite.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = 'Locker combination is 2291';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-versions-batch-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const FENCE = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
function filler(bytes: number): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## Section ${i}\n\n${`Notes on launch planning, pricing and roadmap review for week ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const page = (title: string, tail: string) => `---\ntitle: ${title}\ntype: note\n---\n\n# ${title}\n\n## Facts\n\n${FENCE}\n\n${filler(1_300_000)}## Tail\n\n${tail}\n`;

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const purge = operations.find(o => o.name === 'purge_fact')!;
const run = (engine: BrainEngine, params: Record<string, unknown>) => purge.handler(ctx(engine), params) as Promise<Record<string, any>>;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) {
    await registerLocalWriter(engine, 'cli');
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('versions.segmented_max_per_page', '10000');
  }
}), 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

/** The generation a page's (only) segmented version references. */
async function versionGeneration(engine: BrainEngine, pageId: number): Promise<number> {
  const rows = await engine.executeRaw<{ g: number }>(`SELECT DISTINCT body_generation AS g FROM page_versions WHERE page_id=$1 AND body_storage='segmented' AND body_generation>0`, [pageId]);
  expect(rows).toHaveLength(1);
  return Number(rows[0]!.g);
}

describe('purge_fact over more than one batch of segmented versions', () => {
  test('a retained generation whose version sorts after the first 5,000 candidates is rebuilt without the claim', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/batch-a', page('Batch A', 'First tail.'), { noEmbed: true, sourceId: 'default' });
      await importFromContent(engine, 'notes/batch-a', page('Batch A', 'Second tail.'), { noEmbed: true, sourceId: 'default' });
      const a = await segmentedPageRow(engine, 'notes/batch-a');
      const aGeneration = await versionGeneration(engine, a.id);
      const [first] = await engine.executeRaw<{ g: number }>('SELECT min(gen_from) AS g FROM page_body_manifest WHERE page_id=$1', [a.id]);
      expect(Number(first!.g)).toBeGreaterThan(0);
      await coordinated(engine, tx => tx.executeRaw(`INSERT INTO page_versions (page_id,body_storage,body_generation,body_bytes,content_hash,frontmatter,knowledge_revision,title,type,tags,is_deleted,source_path)
        SELECT v.page_id,'segmented',0,0,v.content_hash,v.frontmatter,v.knowledge_revision,v.title,v.type,v.tags,v.is_deleted,v.source_path
          FROM page_versions v CROSS JOIN generate_series(1,5000) WHERE v.page_id=$1 AND v.body_storage='segmented' AND v.body_generation=$2`, [a.id, aGeneration]));
      await importFromContent(engine, 'notes/batch-b', page('Batch B', 'First tail.'), { noEmbed: true, sourceId: 'default' });
      await importFromContent(engine, 'notes/batch-b', page('Batch B', 'Second tail.'), { noEmbed: true, sourceId: 'default' });
      const b = await segmentedPageRow(engine, 'notes/batch-b');
      const bGeneration = await versionGeneration(engine, b.id);
      const [order] = await engine.executeRaw<{ before: number }>(`SELECT count(*)::int AS before FROM page_versions
        WHERE body_storage='segmented' AND id < (SELECT max(id) FROM page_versions WHERE page_id=$1)`, [b.id]);
      expect(Number(order!.before)).toBeGreaterThanOrEqual(5001);
      expect(await segmentedBodyContains(engine, b.id, 'default', [CLAIM], { generation: bGeneration })).toBe(true);

      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test','notes/batch-a',1) RETURNING id`, [CLAIM]));
      const dry = await run(engine, { id: Number(fact!.id), dry_run: true });
      const done = await run(engine, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(done.state).toBe('committed');
      expect({
        a: await segmentedBodyContains(engine, a.id, 'default', [CLAIM], { generation: aGeneration }),
        b: await segmentedBodyContains(engine, b.id, 'default', [CLAIM], { generation: bGeneration }),
        kept: await segmentedBodyContains(engine, b.id, 'default', ['likes green tea'], { generation: bGeneration }),
        rebuilt: done.purge.removed.page_versions,
      }).toEqual({ a: false, b: false, kept: true, rebuilt: 2 });
      expect(JSON.stringify(done)).not.toContain(CLAIM);
    }
  }), 600_000);
});
