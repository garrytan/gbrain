/**
 * #8109: `gbrain repair contact-rows` on real publication, PGLite and Postgres. A managed source (claimed worktree: the
 * canonical file is published through the coordinated writer) and a database-only (repo-less) source share one run.
 * The preview writes nothing, a moved preview refuses, the apply collapses exactly the planned pages without dropping a
 * distinct value, a page whose file drifted is listed needs_reconcile and left alone, and a second preview finds nothing.
 * put_page itself keeps one row per (type, value).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
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
const row = (type: string, value: string, last_used: string, extra = '') => `  - type: ${type}\n    value: '${value}'\n    last_used: '${last_used}'${extra}`;
const doc = (title: string, rows: string[]) => `---\ntype: person\ntitle: ${title}\ncompany: acme-example\ncontacts:\n${rows.join('\n')}\n---\n\n${title} is a synthetic person.\n`;
const TRIPLED = [row('phone', '+15550100', '2026-10-01'), row('email', 'alice@example.com', '2026-09-01'), row('phone', '+15550100', '2026-10-03'),
  row('phone', '+15550100', '2026-10-02'), row('phone', '+1 555 0100', '2026-08-01')];
const CONFLICT = [row('phone', '+15550111', '2026-10-01', "\n    label: 'mobile'"), row('phone', '+15550111', '2026-10-02', "\n    label: 'work'"),
  row('phone', '+15550111', '2026-10-01', "\n    label: 'mobile'")];

/**
 * Pages imported before the brain is managed, as sync imports a file another writer produced, so they keep their
 * duplicates: a default-source page also gets its file in the checkout.
 */
const seeded = (pages: Array<[sourceId: string, slug: string, content: string]>) => async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  await gitRoot({ engine, root });
  for (const [sourceId, slug, content] of pages) {
    const managed = sourceId === 'default';
    if (managed) { mkdirSync(join(root, 'people'), { recursive: true }); writeFileSync(join(root, `${slug}.md`), content); }
    await importFromContent(engine, slug, content, { sourceId, ...(managed ? { sourcePath: `${slug}.md` } : {}), noEmbed: true });
  }
};
const contacts = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.contacts as Array<Record<string, unknown>>;
const revision = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.readPageSnapshot(slug, { sourceId }))!.revision;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#8109 gbrain repair contact-rows (${backend})`, () => {
    test('preview writes nothing; the apply collapses exactly the planned pages on a managed and a repo-less source; drift is left for reconcile', () => managedBrain(async ({ engine, ctx, root }) => {
      const file = (slug: string) => readFileSync(join(root, `${slug}.md`), 'utf8');
      // Dana's file moved one last_used forward outside gbrain: file/database drift.
      writeFileSync(join(root, 'people/dana-example.md'), file('people/dana-example').replace("'2026-10-03'", "'2026-10-30'"));
      const files = { alice: file('people/alice-example'), bob: file('people/bob-example'), dana: file('people/dana-example') };
      const revisions = { bob: await revision(engine, 'default', 'people/bob-example'), dana: await revision(engine, 'default', 'people/dana-example') };

      expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('contact-rows');
      const scope = await resolveRepairScope(engine);
      const preview = () => repairRunner(engine, { apply: false, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true }));
      const apply = (hash: string) => repairRunner(engine, { apply: true, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true, expect: hash }));
      await expect(repairRunner(engine, { apply: true, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true }))).rejects.toThrow(/preview/i);

      const first = await preview();
      expect(first.affected).toBe(3);
      expect(first.residuals).toEqual({ pages_to_dedupe: 3, rows_to_remove: 5, needs_reconcile: 1 });
      expect(first.listing!.map(entry => [entry.class, entry.item.split(' ')[0]])).toEqual([
        ['dedupe', 'default:people/alice-example'], ['dedupe', 'default:people/bob-example'], ['needs_reconcile', 'default:people/dana-example'], ['dedupe', 'source-a:people/carol-example']]);
      expect(first.listing!.find(entry => entry.class === 'needs_reconcile')!.detail).toContain('gbrain sources reconcile default people/dana-example --brain host --preview --auto-additive');
      expect({ alice: file('people/alice-example'), bob: file('people/bob-example'), dana: file('people/dana-example') }).toEqual(files);
      expect(await contacts(engine, 'source-a', 'people/carol-example')).toHaveLength(5);

      await expect(apply('f'.repeat(64))).rejects.toMatchObject({ code: 'preview_changed' });
      const applied = await apply(first.preview_hash!);
      expect(applied.applied).toBe(3);
      expect(applied.outcomes).toEqual({ deduped: 3 });

      const expected = [{ type: 'phone', value: '+15550100', last_used: '2026-10-03' }, { type: 'email', value: 'alice@example.com', last_used: '2026-09-01' },
        { type: 'phone', value: '+1 555 0100', last_used: '2026-08-01' }];
      expect(await contacts(engine, 'default', 'people/alice-example')).toEqual(expected);
      expect(await contacts(engine, 'source-a', 'people/carol-example')).toEqual(expected);
      // The managed page's canonical file carries the same rows; nothing else in the page changed.
      const alice = parseMarkdown(file('people/alice-example'), 'people/alice-example.md');
      expect(alice.frontmatter.contacts).toEqual(expected);
      expect(alice.frontmatter.company).toBe('acme-example');
      expect(alice.compiled_truth).toBe(parseMarkdown(files.alice, 'people/alice-example.md').compiled_truth);
      // Rows that differ in another field are all kept; only the exact copy went.
      expect((await contacts(engine, 'default', 'people/bob-example')).map(r => r.label)).toEqual(['mobile', 'work']);
      expect(await revision(engine, 'default', 'people/bob-example')).not.toBe(revisions.bob);
      // The drifted page was not written.
      expect(file('people/dana-example')).toBe(files.dana);
      expect(await revision(engine, 'default', 'people/dana-example')).toBe(revisions.dana);

      const second = await preview();
      expect(second.affected).toBe(0);
      expect(second.residuals).toEqual({ pages_to_dedupe: 0, rows_to_remove: 0, needs_reconcile: 1 });
      await expect(apply(first.preview_hash!)).rejects.toMatchObject({ code: 'preview_changed' });
    }, { databaseUrl, setup: seeded([['default', 'people/alice-example', doc('Alice Example', TRIPLED)], ['default', 'people/bob-example', doc('Bob Example', CONFLICT)],
      ['default', 'people/dana-example', doc('Dana Example', TRIPLED)], ['source-a', 'people/carol-example', doc('Carol Example', TRIPLED)]]) }), 180_000);

    test('a previewed page that moved refuses the apply; --slug narrows the preview', () => managedBrain(async ({ engine, ctx }) => {
      const scope = await resolveRepairScope(engine, 'source-a');
      const narrowed = await repairRunner(engine, { apply: false, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true, slugs: ['people/carol-example'] }));
      expect(narrowed.listing!.map(entry => entry.item.split(' ')[0])).toEqual(['source-a:people/carol-example']);
      const first = await repairRunner(engine, { apply: false, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true }));
      expect(first.affected).toBe(2);
      const snapshot = (await engine.readPageSnapshot('people/carol-example', { sourceId: 'source-a' }))!;
      await submitPageMutation({ ...ctx, sourceId: 'source-a' } as OperationContext, { operation: 'put_page', params: { slug: 'people/carol-example', source_id: 'source-a',
        request_id: randomUUID(), expected_revision: snapshot.revision, content: doc('Carol Example', TRIPLED).replace('is a synthetic person.', 'was edited after the preview.') } });
      await expect(repairRunner(engine, { apply: true, logger }).then(runner => runner.run('contact-rows', scope, { explicit: true, expect: first.preview_hash! })))
        .rejects.toMatchObject({ code: 'preview_changed' });
      expect(await contacts(engine, 'source-a', 'people/alice-example')).toHaveLength(5);
    }, { databaseUrl, setup: seeded([['source-a', 'people/alice-example', doc('Alice Example', TRIPLED)], ['source-a', 'people/carol-example', doc('Carol Example', TRIPLED)]]) }), 180_000);

    test('put_page keeps one contact row per (type, value), in the file and the database', () => managedBrain(async ({ engine, ctx, root }) => {
      for (const sourceId of ['default', 'source-a']) {
        await submitPageMutation({ ...ctx, sourceId } as OperationContext, { operation: 'put_page', params: { slug: 'people/alice-example', source_id: sourceId,
          request_id: randomUUID(), content: doc('Alice Example', TRIPLED) } });
        expect(await contacts(engine, sourceId, 'people/alice-example')).toEqual([{ type: 'phone', value: '+15550100', last_used: '2026-10-03' },
          { type: 'email', value: 'alice@example.com', last_used: '2026-09-01' }, { type: 'phone', value: '+1 555 0100', last_used: '2026-08-01' }]);
      }
      expect(parseMarkdown(readFileSync(join(root, 'people/alice-example.md'), 'utf8'), 'people/alice-example.md').frontmatter.contacts)
        .toEqual(await contacts(engine, 'default', 'people/alice-example'));
    }, { databaseUrl, setup: gitRoot }), 180_000);
  });
}
