/**
 * #9743: purging a page deletes the source's unreferenced segment texts that hold one of the page's claims. The sweep
 * ran one DELETE per batch of up to 512 claim forms and lowered every text once per form, so a few MB of unreferenced
 * text outlasted the publication's 5 s statement_timeout on every attempt and the purge never committed.
 *
 * PGLite, and Postgres when DATABASE_URL is set; synthetic filler only. The sweep runs under the same transaction-local
 * 5 s statement_timeout the publication sets. A second case pins the deleted set: every text the single-statement sweep
 * deleted (kept here as OLD_SWEEP) is still deleted, and nothing else is: plain and fence-escaped claims in any case,
 * claims past the first batch of forms, texts across several chunks, and texts another page references or a live
 * staging still needs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { deletePageWithSegments } from '../src/core/persistence/page-purge.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { stagingNeedsTextSql } from '../src/core/page-body/schema.ts';
import { CLAIM_FORMS_BATCH, claimTextForms } from '../src/core/fence-shared.ts';

/** The claim sweep as it ran before #9743: one DELETE per batch of claim forms over every unreferenced text. */
async function OLD_SWEEP(tx: BrainEngine, sourceId: string, claims: readonly string[]): Promise<void> {
  const forms = claimTextForms(claims);
  for (let at = 0; at < forms.length; at += CLAIM_FORMS_BATCH) {
    await tx.executeRaw(`DELETE FROM page_segment_texts d WHERE (d.source_id,d.sha256) IN (SELECT t.source_id,t.sha256
      FROM page_segment_texts t WHERE t.source_id=$1 AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) OFFSET 0)
    AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS n WHERE strpos(lower(convert_from(d.body,'UTF8')),n)>0) AND NOT ${stagingNeedsTextSql('d')}`,
    [sourceId, forms.slice(at, at + CLAIM_FORMS_BATCH)]);
  }
}

const SLUG = 'people/alice-example';
const CLAIMS = Array.from({ length: 600 }, (_, i) => `Alice Example claim number ${i} about acme-example`);
const FILLER_TEXTS = 256;
const FILLER_BYTES = 64 * 1024;

async function seedTexts(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
    SELECT 'default', sha256(b), octet_length(b), 1, b FROM (
      SELECT convert_to(left(repeat('Meeting Notes — Résumé of the Ünïon call: Alice Example met Bob Example at Acme Example. ' || md5(i::text) || E'\\n', $2), $3), 'UTF8') AS b
      FROM generate_series(1, $1) AS i) s`,
    [FILLER_TEXTS, Math.ceil(FILLER_BYTES / 100), FILLER_BYTES / 2]);
  await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
    SELECT 'default', sha256(b), octet_length(b), 1, b FROM (SELECT convert_to('Old notes: ' || $1 || '.', 'UTF8') AS b) s`, [CLAIMS[550]!.toUpperCase()]);
}

for (const kind of testBackends()) {
  describe(`#9743 the page purge claim sweep fits the publication statement budget (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a founder.', frontmatter: { type: 'person' } });
      await seedTexts(engine);
    }, 120_000);
    afterAll(async () => { await close(); });

    test('a purge with 600 claim forms over 8 MiB of unreferenced text commits inside 5 s', async () => {
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
      const started = performance.now();
      const result = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('statement_timeout','5000',true)");
        return deletePageWithSegments(tx, 'default', SLUG, Number(page!.id), CLAIMS);
      });
      const elapsed = performance.now() - started;
      expect(result.page_segment_texts).toBe(1);
      expect(elapsed).toBeLessThan(5_000);
      const [left] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_segment_texts WHERE source_id='default'");
      expect(left!.n).toBe(FILLER_TEXTS);
    }, 120_000);
  });
}

const EQ_SOURCE = 'src-eq';
const EQ_SLUG = 'people/dana-example';
const EQ_CLAIMS = Array.from({ length: 700 }, (_, i) => i === 3 ? 'Dana | acme-example deal closed' : `Dana Example fact ${i}`);

async function insertText(engine: BrainEngine, body: string): Promise<string> {
  const [row] = await engine.executeRaw<{ sha: string }>(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body)
    SELECT $1, sha256(b), octet_length(b), 1, b FROM (SELECT convert_to($2, 'UTF8') AS b) s RETURNING encode(sha256,'hex') AS sha`, [EQ_SOURCE, body]);
  return row!.sha;
}

async function seedEquivalence(engine: BrainEngine): Promise<Record<string, string>> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [EQ_SOURCE]);
  await engine.putPage(EQ_SLUG, { type: 'person', title: 'Dana Example', compiled_truth: 'Dana is a founder.', frontmatter: { type: 'person' } }, { sourceId: EQ_SOURCE });
  await engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: 'Erin is an investor.', frontmatter: { type: 'person' } }, { sourceId: EQ_SOURCE });
  const filler = (i: number) => `Résumé of the Ünïon call ${i}: Dana Example met Erin Example at acme-example. `.repeat(2500);
  for (let i = 0; i < 24; i++) await insertText(engine, filler(i));
  const shas = {
    upper: await insertText(engine, `Notes: ${EQ_CLAIMS[5]!.toUpperCase()}.`),
    escaped: await insertText(engine, '| 3 | Dana \\| acme-example deal closed | fact |'),
    pipeOnly: await insertText(engine, 'Dana | acme-example deal closed, plainly.'),
    secondBatch: await insertText(engine, `${filler(99)} then ${EQ_CLAIMS[650]} at the end.`),
    noClaim: await insertText(engine, 'Dana Example fact without a number.'),
    otherPage: await insertText(engine, `Erin's page also says ${EQ_CLAIMS[5]}.`),
    staged: await insertText(engine, `A pending write says ${EQ_CLAIMS[7]}.`),
    ownPage: await insertText(engine, `Dana's own segment: ${EQ_CLAIMS[9]}.`),
  };
  const pageId = async (slug: string) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [EQ_SOURCE, slug]))[0]!.id);
  for (const [slug, sha] of [['people/erin-example', shas.otherPage], [EQ_SLUG, shas.ownPage]] as const) {
    await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256, byte_start, byte_len, line_start, line_count,
        cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
      SELECT $1, 1, 1, 0, 'truth', source_id, sha256, 0, byte_len, 0, 1, 'eof', '{}'::jsonb, byte_len, 1, sha256 FROM page_segment_texts WHERE source_id=$2 AND sha256=decode($3,'hex')`,
      [await pageId(slug), EQ_SOURCE, sha]);
  }
  const [staging] = await engine.executeRaw<{ id: string }>(`INSERT INTO page_body_stagings (id, kind, principal_kind, principal_id, client_request_id, source_id, source_incarnation,
      slug, mode, declared_bytes, reserved_bytes, idle_expires_at, hard_expires_at)
    VALUES (gen_random_uuid(), 'put', 'test', 'test', gen_random_uuid(), $1, gen_random_uuid(), 'notes/pending-example', 'create', 0, 0, now() + interval '1 hour', now() + interval '1 hour')
    RETURNING id::text`, [EQ_SOURCE]);
  await engine.executeRaw('INSERT INTO page_body_staging_texts (staging_id, source_id, sha256) VALUES ($1::uuid, $2, decode($3,\'hex\'))', [staging!.id, EQ_SOURCE, shas.staged]);
  return shas;
}

const remaining = async (engine: BrainEngine) => new Set((await engine.executeRaw<{ sha: string }>(
  "SELECT encode(sha256,'hex') AS sha FROM page_segment_texts WHERE source_id=$1", [EQ_SOURCE])).map(row => row.sha));

for (const kind of testBackends()) {
  describe(`#9743 the chunked claim sweep deletes exactly what the single sweep deleted (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close(); });

    test('same deleted set across chunks and claim batches, with referenced and staged texts kept', async () => {
      const shas = await seedEquivalence(engine);
      const before = await remaining(engine);
      const rolledBack = new Error('rolled back');
      let oldKept: Set<string> | undefined;
      await engine.transaction(async tx => {
        await tx.deletePage(EQ_SLUG, { sourceId: EQ_SOURCE });
        await tx.executeRaw(`DELETE FROM page_segment_texts t WHERE t.source_id=$1 AND t.sha256=decode($2,'hex')`, [EQ_SOURCE, shas.ownPage]);
        await OLD_SWEEP(tx, EQ_SOURCE, EQ_CLAIMS);
        oldKept = await remaining(tx);
        throw rolledBack;
      }).catch(error => { if (error !== rolledBack) throw error; });
      expect(await remaining(engine)).toEqual(before);

      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [EQ_SOURCE, EQ_SLUG]);
      await engine.transaction(tx => deletePageWithSegments(tx, EQ_SOURCE, EQ_SLUG, Number(page!.id), EQ_CLAIMS));
      const newKept = await remaining(engine);
      expect(newKept).toEqual(oldKept!);
      const deleted = [...before].filter(sha => !newKept.has(sha));
      expect(deleted.sort()).toEqual([shas.upper, shas.escaped, shas.pipeOnly, shas.secondBatch, shas.ownPage].sort());
      for (const kept of [shas.noClaim, shas.otherPage, shas.staged]) expect(newKept.has(kept)).toBe(true);
    }, 120_000);
  });
}
