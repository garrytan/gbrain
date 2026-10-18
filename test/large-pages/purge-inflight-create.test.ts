/**
 * Page purge while another write of the same text is in flight (Wave B PR 2, lane A).
 *
 * 1. Protects: delete_page purge:true and the TTL hard delete (purgeDeletedPages) of a segmented page never delete a
 *    segment text that a live staging staged or deduped onto (an in-flight create keeps its manifest rows in memory
 *    until it publishes), so the create publishes with its own text; and both still delete, in the same
 *    transaction, every text only the purged page referenced, even while an unrelated staging opened before that
 *    text was written is still live.
 * 2. Fails when: the purge deletes every text no manifest row references (the in-flight create dies on
 *    page_body_manifest_source_id_sha256_fkey, 23503), or keeps texts by GC's time window (a live staging older
 *    than the text keeps the purged page's private text until it ends).
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
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-inflight-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

function sections(tag: string, n = 60): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(`## Section ${tag}${i}\n\n` + `Paragraph ${i} of ${tag} about widgets and gadgets number ${i}. `.repeat(400) + '\n\n');
  return parts.join('');
}
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${body}`;
const tail = (word: string) => `## Tail\n\n${`Only this page says ${word} in its last section. `.repeat(300)}\n`;

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe(`page purge with a write of the same text in flight (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
    }), 120_000);
    afterAll(async () => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close?.(); }));

    const shasOf = async (pageId: number) => (await engine.executeRaw<{ sha: string }>(
      "SELECT DISTINCT encode(sha256,'hex') AS sha FROM page_body_manifest WHERE page_id=$1", [pageId])).map(r => r.sha);
    const textsLeft = async (shas: readonly string[]) => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_segment_texts
      WHERE source_id='default' AND sha256=ANY(SELECT decode(h,'hex') FROM unnest($1::text[]) AS h)`, [shas]))[0]!.n);

    /** A create of slug whose preparation finished (texts staged, manifest rows held in memory) and has not published. */
    async function inFlightCreate(slug: string, content: string) {
      const parsed = parseMarkdown(content, `${slug}.md`);
      const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing: null,
        page: { title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags },
        policy: await readPageBodyPolicy(engine), chunking: { quarantined: false, corpusGeneration: null, tier: 'none' }, baseRevision: null });
      return {
        parsed,
        publish: () => engine.transaction(tx => staged.apply(tx, { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter, page_kind: 'markdown' },
          { mode: 'none', corpusGeneration: null })),
      };
    }

    /** A staging of another slug, opened (live) before the purged page is written: GC's time window would keep that page's texts. */
    async function olderLiveStaging(slug: string) {
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      await coordinated(engine, tx => tx.openBodyStaging({ id: randomUUID(), kind: 'upload', principalKind: 'application', principalId: 'test:fixture',
        clientRequestId: randomUUID(), sourceId: 'default', sourceIncarnation: source!.incarnation, slug, pageId: null, mode: 'create', baseRevision: null,
        baseGeneration: null, declaredBytes: 16, declaredSha256: null, reservedBytes: 0,
        idleExpiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) }));
      await engine.executeRaw("UPDATE page_body_stagings SET created_at = now() - interval '1 minute' WHERE slug = $1", [slug]);
    }

    for (const path of ['delete_page purge', 'TTL hard delete'] as const) {
      test(`${path}: the in-flight create publishes with the shared texts and the purged page's own texts are gone`, async () => withEnv(env, async () => {
        const tag = randomUUID().slice(0, 8);
        const purged = `notes/purged-${tag}`, created = `notes/created-${tag}`;
        await olderLiveStaging(`notes/upload-${tag}`);
        await importFromContent(engine, purged, page('Purged', sections(tag) + tail('purgedonlyword')), { sourceId: 'default', noEmbed: true });
        const victim = await segmentedPageRow(engine, purged);
        expect(victim.body_storage).toBe('segmented');
        const create = await inFlightCreate(created, page('Created', sections(tag) + tail('createdonlyword')));
        if (path === 'delete_page purge') {
          const snapshot = await engine.readPageSnapshot(purged, { sourceId: 'default', includeDeleted: true });
          const result = await op('delete_page').handler(ctx(engine), { slug: purged, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
          expect(result.status).toBe('purged');
          const segmentStore = (result.receipt.stores as Array<{ store: string; status: string }>).find(s => s.store === 'page_segment_texts');
          expect(segmentStore?.status).toBe('deleted');
        } else {
          await coordinated(engine, tx => tx.softDeletePage(purged, { sourceId: 'default' }));
          await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '96 hours' WHERE source_id='default' AND slug=$1", [purged]);
          expect((await engine.purgeDeletedPages(72)).slugs).toEqual([purged]);
        }
        expect(await engine.executeRaw("SELECT 1 FROM page_segment_texts WHERE source_id='default' AND strpos(convert_from(body,'UTF8'), 'purgedonlyword') > 0")).toHaveLength(0);
        await create.publish();
        const row = await segmentedPageRow(engine, created);
        const body = await materializeSegmentedBody(engine, row.id, 'default');
        expect(body.compiled_truth).toBe(create.parsed.compiled_truth);
        expect(await textsLeft(await shasOf(row.id))).toBe((await shasOf(row.id)).length);
      }), 240_000);
    }
  });
}
