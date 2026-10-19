/** D-24 (#7027): explicit, coordinated recovery of an empty db_only cache preserves canonical database state. */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { operations } from '../../src/core/operations.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../../src/core/persistence/reconcile.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { retainReconcileBackup } from '../../src/core/persistence/reconcile-backup.ts';
import { prepareReconcileMutation } from '../../src/core/persistence/reconcile-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const slug = 'meetings/2026-04-03-example';
const content = (body: string) => `---\ntype: meeting\ntitle: Example sync\ntags: [example]\naliases: [Example planning sync]\ncustom: preserved\n---\n\n${body}\n`;
const previewParams = { source_id: 'default', slug, remove_empty_db_only_cache: true };
const setup = async ({ engine, root }: { engine: BrainEngine; root: string }) => {
  writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - meetings/\n');
  await importFromContent(engine, slug, content('Earlier durable observation.'), { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, slug, content('Current durable observation with [[notes/example]] reference.'), { sourceId: 'default', noEmbed: true });
  await engine.putPage('notes/example', { type: 'note', title: 'Example target', compiled_truth: 'Linked durable target.', timeline: '' }, { sourceId: 'default' });
  await engine.addLink(slug, 'notes/example', 'preserve this relation', 'related', 'markdown', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
  const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
  await engine.executeRaw("INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2026-04-03','test:fixture','Agreed on durable criteria','Preserve timeline detail')", [page.id]);
  await engine.executeRaw("INSERT INTO page_versions(page_id,compiled_truth,frontmatter) VALUES($1,'Historical observation','{}'::jsonb)", [page.id]);
  await engine.insertFacts([{ fact: 'Example team preserves a private launch criterion.', kind: 'fact', entity_slug: slug, visibility: 'private', source: 'test:fixture', row_num: 1, source_markdown_slug: slug }], { source_id: 'default' });
  const file = join(root, `${slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
};

// Compare the actual stored rows as well as the canonical snapshot: normalization must not silently
// rewrite provenance, timestamps, tags, chunks, links or history during this filesystem-only repair.
async function storedState(engine: BrainEngine) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const page = await engine.executeRaw('SELECT to_jsonb(p) AS row FROM pages p WHERE id=$1', [snapshot.page.id]);
  const columns = await engine.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
      AND ((column_name IN ('page_id','from_page_id','to_page_id','origin_page_id','event_page_id') AND data_type IN ('integer','bigint','smallint'))
        OR column_name IN ('entity_slug','source_markdown_slug')) ORDER BY table_name,column_name`);
  const tables = new Map<string, string[]>();
  for (const { table_name, column_name } of columns) {
    if (table_name.startsWith('persistence_') || !/^[a-z_]+$/.test(table_name)) continue;
    tables.set(table_name, [...(tables.get(table_name) ?? []), column_name]);
  }
  const associated: Record<string, unknown> = {};
  for (const [table, fields] of tables) {
    const values = fields.map(f => f.endsWith('_slug') ? slug : snapshot.page.id);
    associated[table] = await engine.executeRaw(
      `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${fields.map((f, i) => `"${f}"=$${i + 1}`).join(' OR ')} ORDER BY to_jsonb(t)::text`, values);
  }
  return { snapshot, page, associated };
}

for (const { backend, databaseUrl } of pathologicalArms()) describe(`D-24 empty db_only cache recovery (${backend})`, () => {
  test('guard remains strict; preview is read-only; apply deletes only the cache and replay is idempotent', async () => {
    await managedBrain(async ({ engine, root, ctx }) => {
      const file = join(root, `${slug}.md`), before = await storedState(engine);
      for (const table of ['facts', 'links', 'tags', 'timeline_entries', 'page_versions']) expect(before.associated[table]).not.toHaveLength(0);
      expect(before.snapshot.page.frontmatter.aliases).toEqual(['Example planning sync']);
      const put = (revision: string) => operations.find(o => o.name === 'put_page')!.handler(ctx,
        { slug, expected_revision: revision, content: content('A subsequent coordinated observation.') });
      await expect(put(before.snapshot.revision)).rejects.toMatchObject({ code: 'source_changed' });
      expect(await storedState(engine)).toEqual(before);
      expect(readFileSync(file).length).toBe(0);
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        // Recovery is opt-in: ordinary reconciliation cannot adopt a null-origin empty cache.
        await expect(runReconcilePreview(engine, { source_id: 'default', slug })).rejects.toBeDefined();
        const { preview } = await runReconcilePreview(engine, previewParams);
        expect(preview).toMatchObject({ action: 'remove_empty_db_only_cache', status: 'ready', conflicts: [], decisions: [] });
        expect(await storedState(engine)).toEqual(before);
        expect(readFileSync(file).length).toBe(0);
        const params = { source_id: 'default', slug, preview, request_id: randomUUID() };
        const receipt = await runReconcileApply(engine, params);
        expect(receipt).toMatchObject({ state: 'committed', revision: before.snapshot.revision,
          outcome: { action: 'remove_empty_db_only_cache', database_changed: false, file_changed: true } });
        expect(existsSync(file)).toBe(false);
        expect(await storedState(engine)).toEqual(before);
        expect(await engine.executeRaw('SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid', [params.request_id])).toHaveLength(0);
        // Replay must succeed after the preimage has disappeared, and leave a later file alone.
        writeFileSync(file, 'independent later edit');
        expect(await runReconcileApply(engine, params)).toMatchObject({ state: 'committed', revision: receipt.revision, outcome: receipt.outcome });
        expect(readFileSync(file, 'utf8')).toBe('independent later edit');
        unlinkSync(file);
        await put(before.snapshot.revision);
        expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toContain('subsequent coordinated');
        expect((await engine.getPage(slug, { sourceId: 'default' }))!.source_path).toBeNull();
        expect(existsSync(file)).toBe(false);
      });
    }, { databaseUrl, setup });
  }, 180_000);

  test('publication failure after unlink restores the empty cache and leaves every database row intact', async () => {
    await managedBrain(async ({ engine, root, ctx }) => {
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        const before = await storedState(engine), file = join(root, `${slug}.md`);
        const { preview } = await runReconcilePreview(engine, previewParams);
        const binding = (await getWorktreeBinding(engine, 'default'))!;
        const authority = await submissionAuthority(ctx, 'put_page', 'default', preview.preconditions.source_incarnation, slug);
        const requestId = randomUUID();
        const reference = await retainReconcileBackup(engine, preview, authority.principal, requestId);
        const callerIntent = { kind: 'canonical_reconcile', preview };
        await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: 'default',
          sourceIncarnation: preview.preconditions.source_incarnation, slug, pageId: before.snapshot.page.id,
          worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation, requestId, authority,
          callerIntent, intent: { ...callerIntent, backup_reference: reference } });
        const row = (await claimNextWrite(engine, localHostId()))!;
        expect(row.request_id).toBe(requestId);
        const prepared = await prepareReconcileMutation(engine, row, { engine: engine.kind });
        let removedBeforeFailure = false;
        const receipt = await publishMutation(engine, row, prepared, localHostId(), {
          boundary: async name => {
            if (name === 'after_publication') {
              removedBeforeFailure = !existsSync(file);
              throw new Error('D-24 injected publication failure after empty-cache unlink');
            }
          },
        });
        expect(removedBeforeFailure).toBe(true);
        expect(receipt.state).not.toBe('committed');
        expect(receipt.recovery).toBeNull();
        expect(readFileSync(file).length).toBe(0);
        expect(lstatSync(file).isFile()).toBe(true);
        expect(await storedState(engine)).toEqual(before);
        expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid', [row.id])).toHaveLength(0);
      });
    }, { databaseUrl, setup });
  }, 180_000);

  for (const change of ['bytes', 'policy', 'revision', 'owner'] as const) test(`stale ${change} refuses apply and preserves current state`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        const { preview } = await runReconcilePreview(engine, previewParams);
        const file = join(root, `${slug}.md`);
        if (change === 'bytes') writeFileSync(file, 'later unpublished bytes');
        if (change === 'policy') writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only: []\n');
        if (change === 'revision') await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          await tx.executeRaw("UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$1", [slug]);
        }, TEST_WRITE_ATTRIBUTION));
        if (change === 'owner') await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=$1::uuid', [preview.preconditions.worktree_id]);
        const before = await storedState(engine), bytes = readFileSync(file);
        await expect(runReconcileApply(engine, { source_id: 'default', slug, preview, request_id: randomUUID() }))
          .rejects.toMatchObject({ code: 'source_changed' });
        expect(await storedState(engine)).toEqual(before);
        expect(readFileSync(file)).toEqual(bytes);
      });
    }, { databaseUrl, setup });
  }, 180_000);

  for (const kind of ['nonempty', 'symlink', 'hardlink', 'recorded-origin', 'shared-claim', 'undeclared'] as const) test(`refuses ${kind} without deleting anything`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const file = join(root, `${slug}.md`), target = join(root, 'other-empty.md');
      if (kind === 'nonempty') writeFileSync(file, '\n'); // Whitespace is still data.
      if (kind === 'symlink' || kind === 'hardlink') {
        writeFileSync(target, ''); unlinkSync(file);
        if (kind === 'symlink') symlinkSync(target, file); else linkSync(target, file);
      }
      if (kind === 'recorded-origin' || kind === 'shared-claim') await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        await tx.executeRaw("UPDATE pages SET source_path=$1 WHERE source_id='default' AND slug=$2", [`${slug}.md`, kind === 'shared-claim' ? 'notes/example' : slug]);
      }, TEST_WRITE_ATTRIBUTION));
      if (kind === 'undeclared') writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only: []\n');
      const before = await storedState(engine), stat = lstatSync(file), bytes = readFileSync(file);
      const registration = await registerLocalWriter(engine, 'cli');
      await withVerifiedLocalRegistration(engine, registration, async () => {
        await expect(runReconcilePreview(engine, previewParams)).rejects.toBeDefined();
      });
      expect(await storedState(engine)).toEqual(before);
      expect(readFileSync(file)).toEqual(bytes);
      expect(lstatSync(file).ino).toBe(stat.ino);
      if (kind === 'symlink' || kind === 'hardlink') expect(readFileSync(target).length).toBe(0);
    }, { databaseUrl, setup });
  }, 180_000);
});
