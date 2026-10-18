/**
 * Fact purge across segmented pages (Wave B, spec 11).
 *
 * 1. Protects: purge_fact on a claim whose facts row lives in a segment two
 *    pages share removes it everywhere a segment holds it: both live bodies
 *    (each a new generation, whose content_hash is the reconstructed body's),
 *    a retained version's generation (rebuilt, the version's content_hash
 *    updated), the old shared text row, an upload staging's part (the staging
 *    aborted) and the queued request whose `body_ref` names that staging
 *    (cancelled with purged_content). The receipt finds nothing: the page,
 *    version, segment-text and staging-part stores read deleted. Untouched
 *    segments keep their chunk rows.
 * 2. Fails when: the purge refuses or skips a segmented page, leaves the claim
 *    in a retained generation or in an unreferenced text, keeps the staging or
 *    the request alive, or the receipt does not probe segment texts.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
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
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { requestPrincipalForContext } from '../../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { segmentedBodyContains } from '../../src/core/page-body/segment-rewrite.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reconstructedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = 'Door code is 4417';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-segments-'));
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
const COMMON = `# Shared notes\n\nIntro paragraph.\n\n## Facts\n\n${FENCE}\n\n${filler(1_300_000)}`;
const page = (title: string, tail: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${COMMON}## Tail\n\n${tail}\n`;

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const purge = operations.find(o => o.name === 'purge_fact')!;
const run = (engine: BrainEngine, params: Record<string, unknown>) => purge.handler(ctx(engine), params) as Promise<Record<string, any>>;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) { await registerLocalWriter(engine, 'cli'); await engine.setConfig('pages.segmented_storage', 'on'); }
}), 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe('purge_fact on segmented pages', () => {
  test('a claim in a segment two pages share leaves live bodies, a retained generation, texts, a staged part and a body_ref request', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/shared-a', page('Shared A', 'First tail of page A.'), { noEmbed: true, sourceId: 'default' });
      await coordinated(engine, tx => tx.createVersion('notes/shared-a', { sourceId: 'default' }));
      await importFromContent(engine, 'notes/shared-a', page('Shared A', 'Second tail of page A, rewritten.'), { noEmbed: true, sourceId: 'default' });
      await importFromContent(engine, 'notes/shared-b', page('Shared B', 'The tail of page B.'), { noEmbed: true, sourceId: 'default' });
      const a = await segmentedPageRow(engine, 'notes/shared-a'), b = await segmentedPageRow(engine, 'notes/shared-b');
      expect([a.body_storage, b.body_storage]).toEqual(['segmented', 'segmented']);
      const [version] = await engine.executeRaw<{ body_generation: number }>(`SELECT body_generation FROM page_versions WHERE page_id=$1 AND body_storage='segmented'
        ORDER BY id LIMIT 1`, [a.id]);
      expect(Number(version!.body_generation)).toBeLessThan(a.body_generation);
      // The fence's segment is one text both pages reference.
      const [shared] = await engine.executeRaw<{ sha: string; pages: number }>(`SELECT encode(sha256,'hex') AS sha,count(DISTINCT page_id)::int AS pages
        FROM page_body_manifest WHERE page_id=ANY($1::int[]) AND seq=0 AND gen_to IS NULL GROUP BY sha256`, [[a.id, b.id]]);
      expect(shared!.pages).toBe(2);
      const untouched = await engine.executeRaw<{ id: number }>(`SELECT c.id FROM content_chunks c JOIN page_body_manifest m ON m.page_id=c.page_id
        AND m.occurrence_id=c.occurrence_id AND m.gen_to IS NULL AND m.staging_id IS NULL WHERE c.page_id=$1 AND m.seq>0 ORDER BY c.id`, [a.id]);
      expect(untouched.length).toBeGreaterThan(0);

      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test','notes/shared-a',1) RETURNING id`, [CLAIM]));
      // An upload staging whose part holds the claim, and the queued request that would publish it.
      const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
      const stagingId = randomUUID();
      const part = Buffer.from(`Uploaded notes.\n${FENCE}\n`, 'utf8');
      await coordinated(engine, async tx => {
        await tx.openBodyStaging({ id: stagingId, kind: 'upload', principalKind: 'application', principalId: 'test:fixture', clientRequestId: randomUUID(),
          sourceId: 'default', sourceIncarnation: source!.incarnation, slug: 'notes/upload-example', pageId: null, mode: 'create', baseRevision: null,
          baseGeneration: null, declaredBytes: part.length, declaredSha256: null, reservedBytes: 0,
          idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) });
        await tx.executeRaw(`INSERT INTO page_body_staging_parts(staging_id,part_no,byte_start,byte_len,sha256,body) VALUES ($1::uuid,0,0,$2,$3,$4)`,
          [stagingId, part.length, createHash('sha256').update(part).digest(), part]);
      });
      const c = ctx(engine);
      const principal = await requestPrincipalForContext(c);
      const held = await admitWrite(engine, { principal, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
        slug: 'notes/upload-example', requestId: randomUUID(), callerIntent: { body_ref: { staging_id: stagingId } }, intent: { body_ref: { staging_id: stagingId } },
        authority: await submissionAuthority(c, 'put_page', 'default', source!.incarnation, 'notes/upload-example') });

      const dry = await run(engine, { id: Number(fact!.id), dry_run: true });
      expect(dry.stores.find((s: any) => s.store === 'pages')).toMatchObject({ status: 'would_remove', removed: 2 });
      const done = await run(engine, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(done.state).toBe('committed');

      for (const slug of ['notes/shared-a', 'notes/shared-b']) {
        const { page: row, body, hash } = await reconstructedPage(engine, slug);
        expect(body.compiled_truth).not.toContain(CLAIM);
        expect(body.compiled_truth).toContain('Likes green tea');
        expect(row.content_hash).toBe(hash);
      }
      expect(await segmentedBodyContains(engine, a.id, 'default', [CLAIM], { generation: Number(version!.body_generation) })).toBe(false);
      expect(await segmentedBodyContains(engine, a.id, 'default', ['likes green tea'], { generation: Number(version!.body_generation) })).toBe(true);
      expect(await engine.executeRaw(`SELECT 1 FROM page_segment_texts WHERE sha256=decode($1,'hex')`, [shared!.sha])).toHaveLength(0);
      expect(await engine.executeRaw(`SELECT 1 FROM page_segment_texts WHERE position(convert_to($1::text,'UTF8') in body)>0`, [CLAIM])).toHaveLength(0);
      expect(await engine.executeRaw(`SELECT 1 FROM page_body_staging_parts WHERE staging_id=$1::uuid`, [stagingId])).toHaveLength(0);
      expect((await engine.executeRaw<{ state: string }>(`SELECT state FROM page_body_stagings WHERE id=$1::uuid`, [stagingId]))[0]?.state).toBe('aborted');
      expect((await engine.executeRaw<{ state: string; error_code: string }>(`SELECT state,error_code FROM persistence_requests WHERE id=$1::uuid`, [held.id]))[0])
        .toEqual({ state: 'cancelled', error_code: 'purged_content' });
      const kept = await engine.executeRaw<{ id: number }>(`SELECT id FROM content_chunks WHERE id=ANY($1::bigint[]) ORDER BY id`, [untouched.map(r => r.id)]);
      expect(kept.length).toBe(untouched.length);
      for (const store of ['pages', 'page_versions', 'page_segment_texts', 'page_body_staging_parts']) {
        expect(done.stores.find((s: any) => s.store === store)).toMatchObject({ status: 'deleted' });
      }
      expect(done.residuals.filter((r: any) => r.reason === 'source_prose')).toEqual([]);
      expect(JSON.stringify(done)).not.toContain(CLAIM);
    }
  }), 300_000);
});
