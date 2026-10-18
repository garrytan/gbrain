/**
 * Wave B PR 2 fix lane C2 (D6): purge_fact leaves no pre-purge residue in
 * page_view_digests or in an upload staging whose parts split the claim.
 *
 * 1. Protects: the purge deletes the cached view digests (sizes and sha256 of
 *    a read view) of every segmented page it rewrites, in its transaction; and
 *    it finds an open upload staging whose claim straddles a part boundary
 *    (also across a part shorter than the claim), aborts it and deletes its
 *    parts. The cross-part scan reads only each part's head and tail of the
 *    claim's length minus one (a work counter, not time), never a whole part.
 * 2. Fails when: the digests of the pre-purge revision stay until the next
 *    write, or the staging scan matches only within one part (the staging
 *    stays open with the claim's bytes in its parts).
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
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
import { purgeStagingWork } from '../../src/core/facts/purge.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = 'Garage gate code is 7734';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-residue-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
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

/** An open upload staging whose parts are `parts`, in order. */
async function stage(engine: BrainEngine, slug: string, parts: Buffer[]): Promise<string> {
  const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
  const stagingId = randomUUID();
  const total = parts.reduce((n, part) => n + part.length, 0);
  await coordinated(engine, async tx => {
    await tx.openBodyStaging({ id: stagingId, kind: 'upload', principalKind: 'application', principalId: 'test:fixture', clientRequestId: randomUUID(),
      sourceId: 'default', sourceIncarnation: source!.incarnation, slug, pageId: null, mode: 'create', baseRevision: null,
      baseGeneration: null, declaredBytes: total, declaredSha256: null, reservedBytes: 0,
      idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) });
    let at = 0;
    for (const [n, part] of parts.entries()) {
      await tx.executeRaw(`INSERT INTO page_body_staging_parts(staging_id,part_no,byte_start,byte_len,sha256,body) VALUES ($1::uuid,$2,$3,$4,$5,$6)`,
        [stagingId, n, at, part.length, createHash('sha256').update(part).digest(), part]);
      at += part.length;
    }
  });
  return stagingId;
}

describe('purge_fact residue in view digests and staging parts', () => {
  test('pre-purge view digests go, and stagings splitting the claim across parts are aborted', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/residue', `---\ntitle: Residue\ntype: note\n---\n\n# Residue\n\n## Facts\n\n${fence(CLAIM)}\n\n${filler(1_300_000)}`,
        { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/residue');
      expect(page.body_storage).toBe('segmented');
      // A digest of the page's pre-purge read view, as get_page caches it.
      const [revision] = await engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id=$1', [page.id]);
      await engine.executeRaw(`INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines, sha256) VALUES ($1,$2,'markdown','trusted',1000,10,$3)`,
        [page.id, revision!.r, 'ab'.repeat(32)]);

      // Two stagings: the claim split in the middle by a 1 MiB part boundary, and split over three parts by a 4-byte middle part.
      const text = `Uploaded notes.\n${fence(CLAIM)}\n`;
      const cut = text.indexOf(CLAIM) + 10;
      const pad = Buffer.alloc(1024 * 1024, 'p');
      const split = await stage(engine, 'notes/upload-split', [Buffer.concat([pad, Buffer.from(text.slice(0, cut))]), Buffer.concat([Buffer.from(text.slice(cut)), pad])]);
      const three = await stage(engine, 'notes/upload-three', [Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut, cut + 4)), Buffer.from(text.slice(cut + 4))]);
      const untouched = await stage(engine, 'notes/upload-other', [Buffer.from('Unrelated notes about the garage.\n'), Buffer.from('Nothing to purge here.\n')]);
      for (const id of [split, three]) {
        const [whole] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_staging_parts WHERE staging_id=$1::uuid AND position(convert_to($2::text,'UTF8') in body)>0`, [id, CLAIM]);
        expect(Number(whole!.n)).toBe(0);
      }

      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test','notes/residue',1) RETURNING id`, [CLAIM]));
      Object.assign(purgeStagingWork, { parts: 0, bytes: 0 });
      const dry = await run(engine, { id: Number(fact!.id), dry_run: true });
      const work = { ...purgeStagingWork };
      const done = await run(engine, { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(done.state).toBe('committed');
      const state = async (id: string) => ({
        state: (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [id]))[0]?.state,
        parts: Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_staging_parts WHERE staging_id=$1::uuid', [id]))[0]!.n),
      });
      expect({
        digests: Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_view_digests WHERE page_id=$1', [page.id]))[0]!.n),
        split: await state(split), three: await state(three), untouched: await state(untouched),
        // The dry run's scan visited the 7 parts and read at most a head and a tail of the claim's length minus one from each.
        work: { parts: work.parts, withinBound: work.bytes <= work.parts * 2 * (Buffer.byteLength(CLAIM) - 1) },
      }).toEqual({ digests: 0, split: { state: 'aborted', parts: 0 }, three: { state: 'aborted', parts: 0 }, untouched: { state: 'open', parts: 2 },
        work: { parts: 7, withinBound: true } });
      for (const id of [split, three, untouched]) await engine.executeRaw('DELETE FROM page_body_stagings WHERE id=$1::uuid', [id]);
    }
  }), 300_000);
});
