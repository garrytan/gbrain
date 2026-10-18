/**
 * Wave B PR 2 fix lane F (F2): purge_fact and segment GC with a create in flight.
 *
 * 1. Protects: a create keeps its manifest rows in memory until it publishes and records its texts in
 *    page_body_staging_texts. purge_fact aborts a live staging that recorded a text holding the purged claim, deletes
 *    that text in the same transaction, and the create then refuses cleanly with body_staging_expired (nothing
 *    claim-bearing survives); a create in flight that shares only texts without the claim keeps its staging and publishes. The
 *    segment GC keeps every text a live staging recorded, even one older than the staging (a create that deduped onto
 *    an older text), and still collects the texts of an aborted staging.
 *    A page purge of an inline page never probes other pages' segment texts as its own residue: a segmented page that
 *    states the purged page's claim in prose leaves the receipt complete.
 *    L3: rewriteSegmentedGeneration (the in-place rebuild of a version's retained generation) refuses the page's live
 *    generation, which only a flip may change.
 * 2. Fails when: planFactPurge ignores page_body_staging_texts (b9787c6a9: the purge committed, deleted the text and
 *    left the staging open, so the create's manifest insert died on page_body_manifest's text foreign key), or GC
 *    protects a staging's texts only when the staging is older than the text, or the page purge receipt of an inline page
 *    probes page_segment_texts for its claims (b9787c6a9: page_segment_texts incomplete, so the purge exits 75), or
 *    rewriteSegmentedGeneration accepts the live generation (b9787c6a9: it rewrote the live body in place).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
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
import { parseMarkdown } from '../../src/core/markdown.ts';
import { operations } from '../../src/core/operations.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { rewriteSegmentedGeneration } from '../../src/core/page-body/segment-rewrite.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = ['Gate', 'code', 'is', '7731'].join(' ');
const FENCE = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Likes green tea | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-staging-texts-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const purge = operations.find(o => o.name === 'purge_fact')!;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

function filler(bytes: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## Section ${tag} ${i}\n\n${`Notes on launch planning, pricing and roadmap review for week ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${body}`;
const withFence = (tag: string, tail: string) => `# Shared notes\n\nIntro paragraph.\n\n## Facts\n\n${FENCE}\n\n${filler(1_300_000, tag)}## Tail\n\n${tail}\n`;

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe(`purge_fact and segment GC with a create in flight (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
    }), 120_000);
    afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

    /** A create whose preparation finished (texts staged and recorded, manifest rows in memory) and has not published. */
    async function inFlightCreate(slug: string, content: string) {
      const parsed = parseMarkdown(content, `${slug}.md`);
      const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing: null,
        page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
        policy: await readPageBodyPolicy(engine), chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, baseRevision: null });
      return {
        parsed, stagingId: staged.prepared.stagingId,
        publish: () => engine.transaction(tx => staged.apply(tx, { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter, page_kind: 'markdown' },
          { mode: 'none', corpusGeneration: null })),
      };
    }
    const stagingState = async (id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [id]))[0]?.state;
    const recorded = async (id: string) => (await engine.executeRaw<{ sha: string }>("SELECT encode(sha256,'hex') AS sha FROM page_body_staging_texts WHERE staging_id=$1::uuid", [id])).map(r => r.sha);
    const textsLeft = async (shas: readonly string[]) => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
      WHERE source_id='default' AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)`, [shas]))[0]!.n);
    const expectPublished = async (slug: string, create: { parsed: { compiled_truth: string } }) => {
      const row = await segmentedPageRow(engine, slug);
      expect((await materializeSegmentedBody(engine, row.id, 'default')).compiled_truth).toBe(create.parsed.compiled_truth);
    };

    test('purge_fact aborts the in-flight create that recorded a claim-bearing text; an unrelated create still publishes', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const purged = `notes/purged-${tag}`;
      await importFromContent(engine, purged, page('Purged', withFence(tag, 'The purged page tail.')), { sourceId: 'default', noEmbed: true });
      expect((await segmentedPageRow(engine, purged)).body_storage).toBe('segmented');
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test',$2,1) RETURNING id`, [CLAIM, purged]));
      const holder = await inFlightCreate(`notes/holder-${tag}`, page('Holder', withFence(tag, 'The in-flight create tail.')));
      const bystander = await inFlightCreate(`notes/bystander-${tag}`, page('Bystander', `# Other notes\n\n${filler(1_300_000, tag)}## Tail\n\nThe bystander tail.\n`));
      const claimShas = (await engine.executeRaw<{ sha: string }>(`SELECT encode(t.sha256,'hex') AS sha FROM page_body_staging_texts r JOIN page_segment_texts t
        ON t.source_id=r.source_id AND t.sha256=r.sha256 WHERE r.staging_id=$1::uuid AND position(convert_to($2::text,'UTF8') in t.body)>0`, [holder.stagingId, CLAIM])).map(r => r.sha);
      expect(claimShas.length).toBeGreaterThan(0);
      expect(await engine.executeRaw('SELECT 1 FROM page_body_manifest WHERE staging_id IN ($1::uuid,$2::uuid)', [holder.stagingId, bystander.stagingId])).toHaveLength(0);
      const bystanderShas = await recorded(bystander.stagingId);
      const [purgedRow] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', ['default', purged]);
      const shared = await engine.executeRaw("SELECT DISTINCT sha256 FROM page_body_manifest WHERE page_id=$1 AND encode(sha256,'hex')=ANY($2::text[])", [purgedRow!.id, bystanderShas]);
      expect(shared.length).toBeGreaterThan(0);

      const dry = await purge.handler(ctx(engine), { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
      const done = await purge.handler(ctx(engine), { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
      expect(done.state).toBe('committed');
      expect(await textsLeft(claimShas)).toBe(0);
      expect(await engine.executeRaw("SELECT 1 FROM page_segment_texts WHERE position(convert_to($1::text,'UTF8') in body)>0", [CLAIM])).toHaveLength(0);
      expect(done.stores.find((s: { store: string }) => s.store === 'page_segment_texts')).toMatchObject({ status: 'deleted' });
      expect(await stagingState(holder.stagingId)).toBe('aborted');
      expect(await stagingState(bystander.stagingId)).toBe('prepared');
      expect(await textsLeft(bystanderShas)).toBe(bystanderShas.length);

      const refusal = await holder.publish().then(() => null, (e: { canonical?: string; code?: string; message?: string }) => ({ code: e.canonical ?? e.code, message: e.message }));
      expect(refusal?.code).toBe('body_staging_expired');
      expect(refusal?.message).toContain('aborted');
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', ['default', `notes/holder-${tag}`])).toHaveLength(0);
      await bystander.publish();
      await expectPublished(`notes/bystander-${tag}`, bystander);
    }), 300_000);

    test('segment GC keeps a text a live staging recorded even when the text is older than the staging', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const live = await inFlightCreate(`notes/gc-live-${tag}`, page('Live', filler(1_300_000, `live-${tag}`)));
      const dead = await inFlightCreate(`notes/gc-dead-${tag}`, page('Dead', filler(1_300_000, `dead-${tag}`)));
      await engine.setBodyStagingState(dead.stagingId, 'aborted');
      const liveShas = await recorded(live.stagingId), deadShas = await recorded(dead.stagingId);
      expect(liveShas.length).toBeGreaterThan(0);
      // A dedup onto an older text: the texts predate the staging and are past GC's grace.
      await engine.executeRaw("UPDATE page_segment_texts SET created_at = now() - interval '30 days' WHERE source_id='default' AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)",
        [[...liveShas, ...deadShas]]);
      await engine.sweepSegments({ sourceId: 'default' });
      expect(await textsLeft(liveShas)).toBe(liveShas.length);
      expect(await textsLeft(deadShas.filter(sha => !liveShas.includes(sha)))).toBe(0);
      await live.publish();
      await expectPublished(`notes/gc-live-${tag}`, live);
    }), 300_000);

    test('purging an inline page is complete when a segmented page states the same claim in its prose', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const inline = `notes/inline-${tag}`, other = `notes/prose-${tag}`;
      const claim = `The vault code is ${tag}`;
      await importFromContent(engine, other, page('Prose', `# Prose\n\nSomeone wrote that ${claim} in passing.\n\n${filler(1_300_000, `prose-${tag}`)}`), { sourceId: 'default', noEmbed: true });
      expect((await segmentedPageRow(engine, other)).body_storage).toBe('segmented');
      await importFromContent(engine, inline, page('Inline', `# Inline\n\n${FENCE.replace(CLAIM, claim)}\n`), { sourceId: 'default', noEmbed: true });
      const snapshot = await engine.readPageSnapshot(inline, { sourceId: 'default', includeDeleted: true });
      expect(snapshot!.page.body_storage).toBeUndefined();
      await coordinated(engine, tx => tx.executeRaw(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test',$2,1)`, [claim, inline]));
      const result = await operations.find(o => o.name === 'delete_page')!.handler(ctx(engine),
        { slug: inline, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      const stores = result.receipt.stores as Array<{ store: string; status: string }>;
      expect(stores.find(s => s.store === 'page_segment_texts')).toMatchObject({ status: 'not_present' });
      expect(stores.filter(s => s.status === 'incomplete')).toEqual([]);
      expect(stores.find(s => s.store === 'source_prose')).toMatchObject({ status: 'out_of_scope', reason: 'source_prose', items: [other] });
    }), 300_000);

    test('a retained-generation rebuild refuses the live generation and leaves the live body and revision as they were', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const slug = `notes/live-rebuild-${tag}`;
      await importFromContent(engine, slug, page('Live rebuild', withFence(tag, 'The live tail.')), { sourceId: 'default', noEmbed: true });
      const row = await segmentedPageRow(engine, slug);
      const before = await materializeSegmentedBody(engine, row.id, 'default');
      const [revision] = await engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id=$1', [row.id]);
      const outcome = await coordinated(engine, tx => rewriteSegmentedGeneration(tx, row.id, row.body_generation, async fence => fence.replace('Likes green tea', 'Likes black tea'),
        { title: 'Live rebuild', type: 'note', frontmatter: {}, tags: [] })).then(() => 'rewrote', (e: Error) => e.message);
      expect(outcome).toContain('is the live body');
      expect((await materializeSegmentedBody(engine, row.id, 'default')).compiled_truth).toBe(before.compiled_truth);
      expect((await engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE id=$1', [row.id]))[0]!.r).toBe(revision!.r);
      expect((await segmentedPageRow(engine, slug)).body_generation).toBe(row.body_generation);
    }), 300_000);

    test('purge_fact commits when a soft-deleted segmented page states the claim in prose at the generation its version references', async () => withEnv(env, async () => {
      const tag = randomUUID().slice(0, 8);
      const prose = `notes/soft-prose-${tag}`, holder = `notes/soft-holder-${tag}`;
      const claim = `The locker code is ${tag}`;
      await importFromContent(engine, prose, page('Soft prose', `# Prose\n\nSomeone said ${claim} once.\n\n${filler(1_300_000, `soft-${tag}`)}`), { sourceId: 'default', noEmbed: true });
      await importFromContent(engine, holder, page('Holder', `# Holder\n\n${FENCE.replace(CLAIM, claim)}\n`), { sourceId: 'default', noEmbed: true });
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test',$2,1) RETURNING id`, [claim, holder]));
      const snapshot = await engine.readPageSnapshot(prose, { sourceId: 'default' });
      await operations.find(o => o.name === 'delete_page')!.handler(ctx(engine), { slug: prose, request_id: randomUUID(), expected_revision: snapshot!.revision });
      const row = await segmentedPageRow(engine, prose);
      expect(await engine.executeRaw('SELECT 1 FROM page_versions WHERE page_id=$1 AND body_generation=$2', [row.id, row.body_generation])).toHaveLength(1);
      const dry = await purge.handler(ctx(engine), { id: Number(fact!.id), dry_run: true }) as Record<string, any>;
      const done = await purge.handler(ctx(engine), { id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
      expect(done.state).toBe('committed');
      expect((await segmentedPageRow(engine, prose)).body_generation).toBe(row.body_generation);
    }), 300_000);
  });
}
