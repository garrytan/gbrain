/**
 * #7247: `gbrain repair timeline-order` on real publication, PGLite and Postgres. A managed source (claimed worktree:
 * the canonical file is published and the database re-projected from it) and a database-only source share one run.
 * The preview writes nothing, a stale or moved preview refuses, the apply rewrites exactly the planned pages without
 * touching a timeline row, other pages stay byte-identical, and a second preview finds nothing.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const logger = { info() {}, warn() {}, error() {} };
const gitRoot = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','source-a') ON CONFLICT DO NOTHING");
};
const doc = (title: string, body: string, timeline: string) => `---\ntype: person\ntitle: ${title}\n---\n\n${body}\n\n<!-- timeline -->\n\n${timeline}\n`;

const ALICE = ['## Timeline', '', '- **2020-01-01** | import — Joined acme-example', '  Detail kept with its bullet.', '- **2024-03-01** | meeting — Quarterly review',
  '- **2021-06-01** | import — Moved to the city', '- **2022-01-01** | import — Promoted', '- **2020-01-01** | import — Joined acme-example', '  Detail kept with its bullet.',
  '', '## Timeline', '', '- **2019-05-01** | import — Graduated', '- **2023-02-01** | manual — Spoke at a meetup'].join('\n');
const ALICE_AFTER = ['## Timeline', '', '- **2019-05-01** | import — Graduated', '- **2020-01-01** | import — Joined acme-example', '  Detail kept with its bullet.',
  '- **2021-06-01** | import — Moved to the city', '- **2022-01-01** | import — Promoted', '- **2023-02-01** | manual — Spoke at a meetup', '- **2024-03-01** | meeting — Quarterly review'].join('\n');
const ACME = '## Timeline\n\n- **2018-01-01** | import — Founded\n- **2020-01-01** | import — Raised a seed round';
const BOB = '## Timeline\n\n- **2024-01-01** | import — Joined\nwrapped words with no indent\n- **2020-01-01** | import — Graduated\n- **2019-01-01** | import — Born';
const CAROL = '## Timeline\n\n- **2021-01-01** | import — Second\n- **2022-01-01** | import — Third\n- **2020-01-01** | import — First';

async function put(ctx: OperationContext, sourceId: string, slug: string, content: string, expected_revision?: string) {
  await submitPageMutation({ ...ctx, sourceId }, { operation: 'put_page', params: { slug, source_id: sourceId, request_id: randomUUID(), content,
    ...(expected_revision ? { expected_revision } : {}) } });
}
const rows = (engine: BrainEngine) => engine.executeRaw<Record<string, unknown>>(`SELECT t.id, p.source_id, p.slug, t.date::text AS date, t.source, t.summary, t.detail
  FROM timeline_entries t JOIN pages p ON p.id=t.page_id ORDER BY t.id`);
const revision = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
const timelineOf = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.page.timeline ?? '';

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7247 gbrain repair timeline-order (${backend})`, () => {
    test('preview writes nothing; a stale or moved preview refuses; the apply rewrites exactly the planned pages; a second preview is empty', () => managedBrain(async ({ engine, ctx, root }) => {
      await put(ctx, 'default', 'people/alice-example', doc('Alice Example', 'Alice Example is a synthetic person.', ALICE));
      await put(ctx, 'default', 'companies/acme-example', doc('Acme Example', 'A synthetic company.', ACME));
      await put(ctx, 'default', 'people/bob-example', doc('Bob Example', 'A synthetic person.', BOB));
      await put(ctx, 'source-a', 'people/carol-example', doc('Carol Example', 'A synthetic person on a database-only source.', CAROL));
      const file = (slug: string) => readFileSync(join(root, `${slug}.md`), 'utf8');
      const files = { alice: file('people/alice-example'), acme: file('companies/acme-example'), bob: file('people/bob-example') };
      const revisions = { acme: await revision(engine, 'default', 'companies/acme-example'), bob: await revision(engine, 'default', 'people/bob-example'),
        carol: await revision(engine, 'source-a', 'people/carol-example') };
      const rowsBefore = await rows(engine);
      expect(rowsBefore.filter(row => row.slug === 'people/alice-example')).toHaveLength(6);

      expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('timeline-order');
      const scope = await resolveRepairScope(engine);
      const preview = () => repairRunner(engine, { apply: false, logger }).then(runner => runner.run('timeline-order', scope, { explicit: true }));
      const apply = (expect_: string) => repairRunner(engine, { apply: true, logger }).then(runner => runner.run('timeline-order', scope, { explicit: true, expect: expect_ }));
      await expect(repairRunner(engine, { apply: true, logger }).then(runner => runner.run('timeline-order', scope, { explicit: true }))).rejects.toThrow(/preview/i);

      const first = await preview();
      expect(first.affected).toBe(2);
      expect(first.residuals).toEqual({ pages_to_reorder: 2, duplicates_to_merge: 1, sections_to_join: 1, needs_human: 1, near_duplicates: 0 });
      expect(first.listing!.map(entry => [entry.class, entry.item.split(' ')[0]])).toEqual([
        ['reorder', 'default:people/alice-example'], ['needs_human', 'default:people/bob-example'], ['reorder', 'source-a:people/carol-example']]);
      expect(first.listing!.find(entry => entry.class === 'needs_human')!.detail).toContain('a plain line directly under a bullet');
      // The preview writes nothing.
      expect({ alice: file('people/alice-example'), acme: file('companies/acme-example'), bob: file('people/bob-example') }).toEqual(files);
      expect(await rows(engine)).toEqual(rowsBefore);
      expect(await timelineOf(engine, 'source-a', 'people/carol-example')).toBe(CAROL);

      // An unknown hash refuses, and so does the printed hash once a previewed page moved.
      await expect(apply('f'.repeat(64))).rejects.toMatchObject({ code: 'preview_changed' });
      await put(ctx, 'source-a', 'people/carol-example', doc('Carol Example', 'Edited after the preview.', CAROL), revisions.carol);
      await expect(apply(first.preview_hash!)).rejects.toMatchObject({ code: 'preview_changed' });
      expect(file('people/alice-example')).toBe(files.alice);
      revisions.carol = await revision(engine, 'source-a', 'people/carol-example');

      const second = await preview();
      expect(second.preview_hash).not.toBe(first.preview_hash);
      const applied = await apply(second.preview_hash!);
      expect(applied.applied).toBe(2);
      expect(applied.outcomes).toEqual({ reordered: 2 });

      // The managed page's canonical file and database row are the reordered page; nothing else in them changed.
      // Body bytes are exact; the frontmatter is re-rendered from the stored page as every page write renders it (same keys and values).
      const body = (text: string) => text.slice(text.indexOf('\n---\n') + 5);
      expect(body(file('people/alice-example'))).toBe(body(files.alice).replace(ALICE, ALICE_AFTER));
      expect(parseMarkdown(file('people/alice-example'), 'people/alice-example.md').frontmatter).toEqual(parseMarkdown(files.alice, 'people/alice-example.md').frontmatter);
      expect((await timelineOf(engine, 'default', 'people/alice-example')).trim()).toBe(ALICE_AFTER);
      expect((await timelineOf(engine, 'source-a', 'people/carol-example')).trim())
        .toBe('## Timeline\n\n- **2020-01-01** | import — First\n- **2021-01-01** | import — Second\n- **2022-01-01** | import — Third');
      // Not one timeline row was deleted, inserted or rewritten; the dropped copy shared its row with the one that stays.
      expect(await rows(engine)).toEqual(rowsBefore);
      // Pages outside the plan are byte-identical.
      expect(file('companies/acme-example')).toBe(files.acme);
      expect(file('people/bob-example')).toBe(files.bob);
      expect(await revision(engine, 'default', 'companies/acme-example')).toBe(revisions.acme);
      expect(await revision(engine, 'default', 'people/bob-example')).toBe(revisions.bob);

      // Idempotent: nothing left to reorder, and the consumed hash approves nothing.
      const third = await preview();
      expect(third.affected).toBe(0);
      expect(third.residuals).toMatchObject({ pages_to_reorder: 0, duplicates_to_merge: 0, sections_to_join: 0, needs_human: 1 });
      await expect(apply(second.preview_hash!)).rejects.toMatchObject({ code: 'preview_changed' });
    }, { databaseUrl, setup: gitRoot }), 180_000);

    test('--slug narrows the preview and its hash; a page whose database-only rows the write would materialize is kept', () => managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'default', 'people/alice-example', doc('Alice Example', 'Alice Example is a synthetic person.', ALICE));
      await put(ctx, 'default', 'people/dana-example', doc('Dana Example', 'A synthetic person.', CAROL));
      const scope = await resolveRepairScope(engine, 'default');
      const runner = await repairRunner(engine, { apply: false, logger });
      const narrowed = await runner.run('timeline-order', scope, { explicit: true, sourceFlag: 'default', slugs: ['people/dana-example'] });
      expect(narrowed.listing!.map(entry => entry.item.split(' ')[0])).toEqual(['default:people/dana-example']);
      expect(narrowed.apply_command).toContain('--slug people/dana-example');
      const all = await runner.run('timeline-order', scope, { explicit: true, sourceFlag: 'default' });
      expect(all.affected).toBe(2);
      expect(all.preview_hash).not.toBe(narrowed.preview_hash);

      const [{ id }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug='people/dana-example'");
      await engine.transaction(async tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        "INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2019-01-01','legacy','Database-only event','')", [id]), await maintenanceAttribution(tx)));
      const held = await runner.run('timeline-order', scope, { explicit: true, sourceFlag: 'default', slugs: ['people/dana-example'] });
      expect(held.affected).toBe(0);
      expect(held.residuals).toMatchObject({ needs_human: 1, pending_materialization: 1 });
      expect(held.listing![0]!.detail).toContain('gbrain repair timeline --source default');
    }, { databaseUrl, setup: gitRoot }), 180_000);
  });
}
