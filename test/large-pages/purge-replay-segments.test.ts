/**
 * Wave B PR 2 fix lane R, gap 2: a restore-time purge replay cleans segment storage as purge_fact does.
 *
 * 1. Protects: replaying a committed fact purge into a restored brain (replayPurgesInRestore, the step both the PGLite
 *    restore and gbrain beliefs replay-purges run) rewrites a segmented page's live body and retained generation and then
 *    deletes, in the same transaction, every segment text that held the purged claim and is no longer referenced: the
 *    texts the rewrites replaced, and a text only an in-flight create recorded (page_body_staging_texts), whose staging
 *    is aborted as purge_fact aborts it. An unrelated in-flight create keeps its staging and texts. Afterwards no row of
 *    page_segment_texts holds the claim, and the purge receipt's page_segment_texts probe reads clean. A replayed page
 *    purge deletes the texts only that page's manifests referenced with it, as delete_page purge:true does.
 * 2. Fails when: the replay rewrites segmented bodies but leaves the replaced texts or the staging-held text to segment
 *    GC (or forever, while the staging pins it): the probe reads incomplete; or a replayed page purge deletes the page
 *    row and leaves its segment texts behind.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). pages.segmented_storage is forced on.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { segmentedBodyContains } from '../../src/core/page-body/segment-rewrite.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { replayPurgesInRestore, type PurgeMirrorLine } from '../../src/core/belief/purge-mirror.ts';
import { planFactPurge, type PurgeTarget } from '../../src/core/facts/purge.ts';
import { verifyFactPurge } from '../../src/core/facts/purge-verify.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = ['Vault', 'code', 'is', '9046'].join(' ');
const FENCE = [
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | ' + CLAIM + ' | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |',
  '| 2 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |',
  '<!--- gbrain:facts:end -->',
].join('\n');
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-replay-segments-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

function filler(bytes: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = '## Section ' + tag + ' ' + i + '\n\n' + ('Notes on launch planning, pricing and roadmap review for week ' + i + '. ').repeat(30) + '\n\n';
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const page = (title: string, body: string) => '---\ntitle: ' + title + '\ntype: note\n---\n\n' + body;
const withFence = (tag: string, tail: string) => '# Shared notes\n\nIntro paragraph.\n\n## Facts\n\n' + FENCE + '\n\n' + filler(1_300_000, tag) + '## Tail\n\n' + tail + '\n';

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe('restore-time purge replay on segmented pages (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
    }), 120_000);
    afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

    /** A create whose preparation finished (texts staged and recorded in page_body_staging_texts) and has not published. */
    async function inFlightCreate(slug: string, content: string): Promise<string> {
      const parsed = parseMarkdown(content, slug + '.md');
      const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing: null,
        page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
        policy: await readPageBodyPolicy(engine), chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, baseRevision: null });
      return staged.prepared.stagingId;
    }
    const stagingState = async (id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [id]))[0]?.state;
    const carryingTexts = async () => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
      WHERE position(convert_to($1::text,'UTF8') in body)>0 OR strpos(lower(convert_from(body,'UTF8')),lower($1))>0`, [CLAIM]))[0]!.n);

    test('a replayed fact purge deletes the segment texts that held the claim, staging-held ones included, and the probe reads clean', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const slug = 'notes/replayed-' + tag;
      // The restored brain: a segmented page whose live body and a retained generation hold the claim's fence row,
      // the fact row, an in-flight create that recorded a claim-bearing text, and an unrelated in-flight create.
      await importFromContent(engine, slug, page('Replayed', withFence(tag, 'First tail.')), { sourceId: 'default', noEmbed: true });
      await coordinated(engine, tx => tx.createVersion(slug, { sourceId: 'default' }));
      await importFromContent(engine, slug, page('Replayed', withFence(tag, 'Second tail, rewritten.')), { sourceId: 'default', noEmbed: true });
      const row = await segmentedPageRow(engine, slug);
      expect(row.body_storage).toBe('segmented');
      const [version] = await engine.executeRaw<{ body_generation: number }>(`SELECT body_generation FROM page_versions WHERE page_id=$1 AND body_storage='segmented'
        ORDER BY id LIMIT 1`, [row.id]);
      expect(Number(version!.body_generation)).toBeLessThan(row.body_generation);
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test',$2,1) RETURNING id`, [CLAIM, slug]));
      const holder = await inFlightCreate('notes/holder-' + tag, page('Holder', withFence(tag + '-holder', 'The in-flight create tail.')));
      const bystander = await inFlightCreate('notes/bystander-' + tag, page('Bystander', '# Other notes\n\n' + filler(1_300_000, tag + '-bystander') + '## Tail\n\nThe bystander tail.\n'));
      const bystanderShas = (await engine.executeRaw<{ sha: string }>("SELECT encode(sha256,'hex') AS sha FROM page_body_staging_texts WHERE staging_id=$1::uuid", [bystander])).map(r => r.sha);
      expect(bystanderShas.length).toBeGreaterThan(0);
      expect(await carryingTexts()).toBeGreaterThan(0);

      const [target] = await engine.executeRaw<PurgeTarget>(`SELECT id,source_id,visibility,fact,entity_slug,source_markdown_slug,
        gbrain_fact_fingerprint(fact) AS fact_hash,embedding::text AS embedding,embedding_model FROM facts WHERE id=$1`, [fact!.id]);
      const purged = { ...target!, id: Number(target!.id) };
      const plan = await planFactPurge(engine, purged, false);
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      const request = randomUUID();
      const lines: PurgeMirrorLine[] = [
        { kind: 'intent', request, request_id: request, source_id: 'default', source_incarnation: source!.incarnation, scope: 'fact', recorded_at: new Date().toISOString(),
          purge_epoch: 1, facts: [{ fact_hash: purged.fact_hash, visibility: 'world', subject: '*' }], takes: [], lifetimes: [] },
        { kind: 'committed', request, recorded_at: new Date().toISOString() },
      ];
      const result = await engine.transaction(tx => replayPurgesInRestore(tx, { lines, archivedAt: new Date(Date.now() - 60_000).toISOString(), restoreId: randomUUID() }));
      expect(result.replays.map(r => [r.request, r.outcome])).toEqual([[request, 'complete']]);

      expect(await segmentedBodyContains(engine, row.id, 'default', [CLAIM])).toBe(false);
      expect(await segmentedBodyContains(engine, row.id, 'default', [CLAIM], { generation: Number(version!.body_generation) })).toBe(false);
      expect(await segmentedBodyContains(engine, row.id, 'default', ['likes green tea'])).toBe(true);
      expect(await carryingTexts()).toBe(0);
      expect(await stagingState(holder)).toBe('aborted');
      expect(await stagingState(bystander)).toBe('prepared');
      expect(Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
        WHERE source_id='default' AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)`, [bystanderShas]))[0]!.n)).toBe(bystanderShas.length);
      const receipt = await verifyFactPurge(engine, { target: purged, plan, dryRun: false, removed: {} });
      expect(receipt.stores.find(s => s.store === 'page_segment_texts')).toMatchObject({ status: 'not_present' });
      for (const store of ['pages', 'page_versions', 'facts']) expect({ store, status: receipt.stores.find(s => s.store === store)?.status }).toEqual({ store, status: 'not_present' });
    }), 300_000);

    test('a replayed page purge deletes the segment texts only that page referenced', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const slug = 'notes/page-replayed-' + tag;
      const marker = 'Page scope tail ' + tag;
      await importFromContent(engine, slug, page('Page replayed', withFence(tag + '-page', marker + ' one.')), { sourceId: 'default', noEmbed: true });
      await coordinated(engine, tx => tx.createVersion(slug, { sourceId: 'default' }));
      await importFromContent(engine, slug, page('Page replayed', withFence(tag + '-page', marker + ' two.')), { sourceId: 'default', noEmbed: true });
      const row = await segmentedPageRow(engine, slug);
      expect(row.body_storage).toBe('segmented');
      const shas = (await engine.executeRaw<{ sha: string }>("SELECT DISTINCT encode(sha256,'hex') AS sha FROM page_body_manifest WHERE page_id=$1", [row.id])).map(r => r.sha);
      const texts = async () => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
        WHERE source_id='default' AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)`, [shas]))[0]!.n);
      expect(await texts()).toBe(shas.length);
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      const request = randomUUID();
      const lines: PurgeMirrorLine[] = [
        { kind: 'intent', request, request_id: request, source_id: 'default', source_incarnation: source!.incarnation, scope: 'page', slug, content_hashes: [row.content_hash],
          recorded_at: new Date().toISOString(), purge_epoch: 1, facts: [], takes: [], lifetimes: [] },
        { kind: 'committed', request, recorded_at: new Date().toISOString() },
      ];
      await engine.transaction(tx => replayPurgesInRestore(tx, { lines, archivedAt: new Date(Date.now() - 60_000).toISOString(), restoreId: randomUUID() }));
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug])).toHaveLength(0);
      expect(await texts()).toBe(0);
      expect(await engine.executeRaw("SELECT 1 FROM page_segment_texts WHERE position(convert_to($1::text,'UTF8') in body)>0", [marker])).toHaveLength(0);
    }), 300_000);
  });
}
