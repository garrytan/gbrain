/**
 * GST-2988 PR 3: the purge cascade. A page purged for good takes its secret store occurrences with it, and every sealed
 * original no other page or commit references; an original another page or a publish commit still references stays.
 * Doctor counts originals nothing references. Runs through gbrain delete --purge (delete_page), the batch hard delete
 * and the tombstone expiry, on PGLite and on Postgres when DATABASE_URL is set. Repo-less and keyless.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { operations } from '../src/core/operations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { markerOf, recordOccurrence, reveal, seal } from '../src/core/secret-store/store.ts';
import { scrubPurgedSlugStores } from '../src/core/persistence/purge-slug-stores.ts';
import { backupDue, backupStore, restoreBackup } from '../src/core/secret-store/backup.ts';
import { carryRenameIdentity } from '../src/commands/sync/renames.ts';
import { createStorage } from '../src/core/storage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretStoreCheck } from '../src/commands/doctor/checks/secret-store.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { testBackends } from './helpers/test-backends.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const deleteOp = operations.find(o => o.name === 'delete_page')!;

/** Records an occurrence the way the redactor does: the page it names (by id, else by slug) holds the entry's marker. */
async function record(b: BeliefBrain, o: Parameters<typeof recordOccurrence>[1]) {
  await recordOccurrence(b.engine, o);
  if (o.commit || (!o.pageId && !o.slug)) return;
  await b.engine.executeRaw(`UPDATE pages SET compiled_truth = compiled_truth || ' ' || $4 WHERE source_id = $1 AND (id = $2 OR ($2::integer IS NULL AND slug = $3))`,
    [o.sourceId, o.pageId ?? null, o.slug ?? null, markerOf('github_token', o.entryId)]);
}
const value = (tag: string) => ['ghp', tag.padEnd(36, 'Q')].join('_');

/** Three originals on page `slug`: one only there, one also on `other`, one also recorded on a publish commit. */
async function seed(b: BeliefBrain, slug: string, other: string, marked = false) {
  const rec = (o: Parameters<typeof recordOccurrence>[1]) => marked ? record(b, o) : recordOccurrence(b.engine, o);
  const ids: Record<'only' | 'shared' | 'committed', string> = { only: '', shared: '', committed: '' };
  for (const kind of ['only', 'shared', 'committed'] as const) {
    ids[kind] = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`${kind}${randomUUID().slice(0, 6)}`) })).id;
    await rec({ entryId: ids[kind], sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair', path: `${slug}.md` });
  }
  await rec({ entryId: ids.shared, sourceId: b.sourceId, slug: other, field: 'compiled_truth', origin: 'repair', path: `${other}.md` });
  await rec({ entryId: ids.committed, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'a'.repeat(40), path: `${slug}.md` });
  return ids;
}

async function state(b: BeliefBrain, ids: Record<string, string>) {
  const entries = new Set((await b.engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE id = ANY($1::text[])', [Object.values(ids)])).map(r => r.id));
  const occ = await b.engine.executeRaw<{ entry_id: string; slug: string; commit_sha: string | null }>(
    'SELECT entry_id, slug, commit_sha FROM secret_store_occurrence WHERE entry_id = ANY($1::text[]) ORDER BY entry_id, slug, commit_sha', [Object.values(ids)]);
  return { only: entries.has(ids.only!), shared: entries.has(ids.shared!), committed: entries.has(ids.committed!), occ };
}

function expectCascade(s: Awaited<ReturnType<typeof state>>, ids: Record<string, string>, slug: string, other: string) {
  expect({ only: s.only, shared: s.shared, committed: s.committed }).toEqual({ only: false, shared: true, committed: true });
  expect(s.occ.filter(o => o.slug === slug && o.commit_sha === null)).toEqual([]);
  expect(s.occ.filter(o => o.entry_id === ids.shared).map(o => o.slug)).toEqual([other]);
  expect(s.occ.filter(o => o.entry_id === ids.committed).map(o => o.commit_sha)).toEqual(['a'.repeat(40)]);
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`secret store purge cascade (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { databaseUrl: engineCase.databaseUrl, enable: false });
    const pages = async (b: BeliefBrain, marked = false) => {
      const slug = `notes/deploy-${randomUUID().slice(0, 6)}`, other = `notes/other-${randomUUID().slice(0, 6)}`;
      await b.put(slug, beliefPage({ prose: 'Deploy notes.' }));
      await b.put(other, beliefPage({ prose: 'Other notes.' }));
      return { slug, other, ids: await seed(b, slug, other, marked) };
    };

    test('gbrain delete --purge removes the page\'s occurrences and the original only it referenced; shared and committed originals stay', async () => {
      await brain(async b => {
        const { slug, other, ids } = await pages(b);
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true });
        await deleteOp.handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() });
        expect(await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true })).toBeNull();
        expectCascade(await state(b, ids), ids, slug, other);
      });
    }, 120_000);

    test('the batch hard delete and the tombstone expiry cascade the same way', async () => {
      await brain(async b => {
        const batch = await pages(b);
        await b.engine.deletePages([batch.slug], { sourceId: b.sourceId });
        expectCascade(await state(b, batch.ids), batch.ids, batch.slug, batch.other);
        const expiry = await pages(b);
        const live = await b.engine.readPageSnapshot(expiry.slug, { sourceId: b.sourceId });
        await b.op('delete_page', { slug: expiry.slug, expected_revision: live!.revision });
        await b.engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id = $1 AND slug = $2", [b.sourceId, expiry.slug]);
        await purgeDeletedPagesCoordinated(b.engine, 1);
        expectCascade(await state(b, expiry.ids), expiry.ids, expiry.slug, expiry.other);
      });
    }, 120_000);

    test('an original on a redacted commit that is not pushed yet (held back, slug or no slug) is never removed by the cascade', async () => {
      await brain(async b => {
        const { slug, other, ids } = await pages(b);
        const held = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`held${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: held, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
        await recordOccurrence(b.engine, { entryId: held, sourceId: b.sourceId, field: 'file', origin: 'publish_rebuild', commit: 'b'.repeat(40), path: `${slug}.md`, line: 3 });
        await b.engine.deletePages([slug], { sourceId: b.sourceId });
        expectCascade(await state(b, ids), ids, slug, other);
        const [kept] = await b.engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM secret_store_occurrence WHERE entry_id = $1 AND commit_sha IS NOT NULL', [held]);
        expect((await reveal(b.engine, held, 'test')).value).toStartWith('ghp_held');
        expect(Number(kept!.n)).toBe(1);
      });
    }, 120_000);

    test('two pages purged in one batch that share an original remove it once, after both; a failure inside the delete leaves everything', async () => {
      await brain(async b => {
        const one = `notes/one-${randomUUID().slice(0, 6)}`, two = `notes/two-${randomUUID().slice(0, 6)}`;
        await b.put(one, beliefPage({ prose: 'One.' }));
        await b.put(two, beliefPage({ prose: 'Two.' }));
        const shared = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`pair${randomUUID().slice(0, 6)}`) })).id;
        for (const slug of [one, two]) await recordOccurrence(b.engine, { entryId: shared, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
        const rows = async () => (await b.engine.executeRaw('SELECT 1 FROM secret_store_occurrence WHERE entry_id = $1', [shared])).length;
        const entry = async () => (await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [shared])).length;
        const failed = await b.engine.transaction(async tx => {
          await tx.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])', [b.sourceId, [one, two]]);
          const removed = await scrubPurgedSlugStores(tx, b.sourceId, [one, two]);
          expect(removed).toMatchObject({ secret_store_occurrence: 2, secret_store: 1 });
          throw new Error('fault between the page delete and commit');
        }).then(() => 'committed', (e: Error) => e.message);
        expect(failed).toBe('fault between the page delete and commit');
        expect({ occurrences: await rows(), entry: await entry() }).toEqual({ occurrences: 2, entry: 1 });
        expect(await b.engine.readPageSnapshot(one, { sourceId: b.sourceId })).not.toBeNull();
        expect(await b.engine.deletePages([one, two], { sourceId: b.sourceId })).toHaveLength(2);
        expect({ occurrences: await rows(), entry: await entry() }).toEqual({ occurrences: 0, entry: 0 });
        expect(await scrubPurgedSlugStores(b.engine, b.sourceId, [one, two])).toMatchObject({ secret_store_occurrence: 0, secret_store: 0 });
      });
    }, 120_000);

    test('a soft-deleted page inside its window still references its originals, and restore_page brings it back with the secret readable', async () => {
      await brain(async b => {
        const { slug, ids } = await pages(b);
        const live = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
        await b.op('delete_page', { slug, expected_revision: live!.revision });
        await purgeDeletedPagesCoordinated(b.engine, 72);
        expect((await state(b, ids)).only).toBe(true);
        expect((await reveal(b.engine, ids.only, 'test')).value).toStartWith('ghp_only');
        const gone = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId, includeDeleted: true });
        await b.op('restore_page', { slug, expected_revision: gone!.revision });
        expect(await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId })).not.toBeNull();
        const back = await reveal(b.engine, ids.only, 'test');
        expect(back.value).toStartWith('ghp_only');
        expect(back.occurrences.map(o => o.slug)).toEqual([slug]);
      });
    }, 120_000);

    test('a backup restore never brings back an original a purge removed, and leaves a newer local row as it is', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-purge-bucket-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const { slug, ids } = await pages(b, true);
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw("UPDATE secret_store SET status = 'allowed', updated_at = now() WHERE id = $1", [ids.shared]);
          await b.engine.deletePages([slug], { sourceId: b.sourceId });
          const restored = await restoreBackup(b.engine, storage, out.object);
          expect(restored).toMatchObject({ inserted: 0, skipped_no_page: 1, unreadable: [] });
          expect(restored.existing).toBeGreaterThanOrEqual(2);
          expect((await state(b, ids)).only).toBe(false);
          const [row] = await b.engine.executeRaw<{ status: string }>('SELECT status FROM secret_store WHERE id = $1', [ids.shared]);
          expect(row!.status).toBe('allowed');
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a renamed page keeps its originals when another page takes its old slug and is purged, and takes them when it is purged', async () => {
      await brain(async b => {
        const foo = `notes/foo-${randomUUID().slice(0, 6)}`, bar = `notes/bar-${randomUUID().slice(0, 6)}`, stale = `notes/stale-${randomUUID().slice(0, 6)}`;
        await b.put(foo, beliefPage({ prose: 'Foo.' }));
        const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, foo]);
        const moved = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`moved${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: moved, sourceId: b.sourceId, pageId: page!.id, slug: foo, field: 'compiled_truth', origin: 'repair' });
        await b.engine.updateSlug(foo, bar, { sourceId: b.sourceId });
        const old = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`stale${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: old, sourceId: b.sourceId, pageId: page!.id, slug: stale, field: 'compiled_truth', origin: 'repair' });
        const entry = async (id: string) => (await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length;
        for (const slug of [foo, stale]) {
          await b.engine.putPage(slug, { type: 'note', title: 'Other', compiled_truth: 'A different page at the old slug.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await b.engine.deletePages([slug], { sourceId: b.sourceId });
        }
        expect({ moved: await entry(moved), old: await entry(old) }).toEqual({ moved: 1, old: 1 });
        await b.engine.deletePages([bar], { sourceId: b.sourceId });
        expect(await entry(moved)).toBe(0);
      });
    }, 120_000);

    test('a restore binds each occurrence to the page that holds its slug, never to whatever page has the backed-up page id, so a later purge removes it', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-rebuild-bucket-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const slug = `notes/rebuilt-${randomUUID().slice(0, 6)}`, unrelated = `notes/unrelated-${randomUUID().slice(0, 6)}`;
          await b.engine.putPage(slug, { type: 'note', title: 'Rebuilt', compiled_truth: 'Rebuilt.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          const pageId = async (s: string) => (await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, s]))[0]!.id;
          const oldId = await pageId(slug);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`rebuilt${randomUUID().slice(0, 6)}`) })).id;
          await record(b, { entryId: id, sourceId: b.sourceId, pageId: oldId, slug, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.deletePages([slug], { sourceId: b.sourceId });
          await b.engine.putPage(unrelated, { type: 'note', title: 'Unrelated', compiled_truth: 'Unrelated.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await b.engine.executeRaw('UPDATE pages SET id = $3 WHERE source_id = $1 AND slug = $2', [b.sourceId, unrelated, oldId]);
          await b.engine.putPage(slug, { type: 'note', title: 'Rebuilt', compiled_truth: `Rebuilt. ${markerOf('github_token', id)}`, timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ skipped_no_page: 0 });
          const [occ] = await b.engine.executeRaw<{ page_id: number | null }>('SELECT page_id FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          expect(occ!.page_id).toBe(await pageId(slug));
          await b.engine.deletePages([slug], { sourceId: b.sourceId });
          expect((await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length).toBe(0);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a restore adds the occurrences of an entry the store already holds, so a later purge of one page keeps an original another page holds', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-existing-bucket-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const { slug, other, ids } = await pages(b, true);
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1 AND slug = $2', [ids.shared, other]);
          const restored = await restoreBackup(b.engine, storage, out.object);
          expect(restored).toMatchObject({ inserted: 0, occurrences: 1, unreadable: [] });
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 0, occurrences: 0 });
          await b.engine.deletePages([slug], { sourceId: b.sourceId });
          const s = await state(b, ids);
          expect(s.shared).toBe(true);
          expect(s.occ.filter(o => o.entry_id === ids.shared).map(o => o.slug)).toEqual([other]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('an occurrence still under an old slug goes with its page, by every hard delete', async () => {
      await brain(async b => {
        const staleOn = async (slug: string) => {
          await b.put(slug, beliefPage({ prose: 'Renamed long ago.' }));
          const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`old${randomUUID().slice(0, 6)}`) })).id;
          await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, pageId: page!.id, slug: `notes/before-rename-${randomUUID().slice(0, 6)}`, field: 'compiled_truth', origin: 'repair' });
          return id;
        };
        const entry = async (id: string) => (await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length;
        const purged = `notes/purged-${randomUUID().slice(0, 6)}`, batch = `notes/batch-${randomUUID().slice(0, 6)}`, expired = `notes/expired-${randomUUID().slice(0, 6)}`;
        const ids = { purged: await staleOn(purged), batch: await staleOn(batch), expired: await staleOn(expired) };
        const snapshot = await b.engine.readPageSnapshot(purged, { sourceId: b.sourceId });
        await deleteOp.handler(b.ctx, { slug: purged, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() });
        await b.engine.deletePages([batch], { sourceId: b.sourceId });
        const live = await b.engine.readPageSnapshot(expired, { sourceId: b.sourceId });
        await b.op('delete_page', { slug: expired, expected_revision: live!.revision });
        await b.engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id = $1 AND slug = $2", [b.sourceId, expired]);
        await purgeDeletedPagesCoordinated(b.engine, 1);
        expect({ purged: await entry(ids.purged), batch: await entry(ids.batch), expired: await entry(ids.expired) }).toEqual({ purged: 0, batch: 0, expired: 0 });
      });
    }, 120_000);

    test('a rename that falls back to a new row moves the stale row\'s occurrences to it, so expiring the stale row keeps the original', async () => {
      await brain(async b => {
        const stale = `notes/stale-${randomUUID().slice(0, 6)}`, dest = `notes/dest-${randomUUID().slice(0, 6)}`;
        await b.put(stale, beliefPage({ prose: 'Old place.' }));
        await b.put(dest, beliefPage({ prose: 'New place.' }));
        const ids = await b.engine.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])', [b.sourceId, [stale, dest]]);
        const from = ids.find(r => r.slug === stale)!, to = ids.find(r => r.slug === dest)!;
        const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`fb${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, pageId: from.id, slug: stale, field: 'compiled_truth', origin: 'repair' });
        await carryRenameIdentity(b.engine, b.sourceId, stale, dest);
        expect(await b.engine.executeRaw('SELECT slug, page_id FROM secret_store_occurrence WHERE entry_id = $1', [id])).toEqual([{ slug: dest, page_id: to.id }]);
        await b.engine.deletePages([stale], { sourceId: b.sourceId });
        expect((await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length).toBe(1);
      });
    }, 120_000);

    test('a restore keeps two recorded occurrences at one place that differ in origin, and adds neither twice', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-origin-bucket-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const slug = `notes/two-${randomUUID().slice(0, 6)}`;
          await b.put(slug, beliefPage({ prose: 'Two records.' }));
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`two${randomUUID().slice(0, 6)}`) })).id;
          await record(b, { entryId: id, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair', path: `${slug}.md` });
          await record(b, { entryId: id, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'publish_rebuild', path: `${slug}.md` });
          const out = await backupStore(b.engine, storage);
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 0, occurrences: 0 });
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE id = $1', [id]);
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 1, occurrences: 2 });
          expect((await b.engine.executeRaw<{ origin: string }>('SELECT origin FROM secret_store_occurrence WHERE entry_id = $1 ORDER BY origin', [id])).map(r => r.origin)).toEqual(['publish_rebuild', 'repair']);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a restore whose value the store holds under another id is not reported as a missing page', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-reseal-bucket-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const slug = `notes/reseal-${randomUUID().slice(0, 6)}`;
          await b.put(slug, beliefPage({ prose: 'Resealed.' }));
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`rs${randomUUID().slice(0, 6)}`) })).id;
          await record(b, { entryId: id, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          await b.engine.executeRaw('UPDATE secret_store SET id = $2 WHERE id = $1', [id, `ss_${'f'.repeat(12)}`]);
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 0, skipped_no_page: 0 });
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a rename makes the next backup due, so the newest backup names the page by its new slug', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-rename-due-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const { slug } = await pages(b, true);
          await backupStore(b.engine, storage);
          expect(await backupDue(b.engine)).toBe(false);
          await b.engine.updateSlug(slug, `notes/renamed-${randomUUID().slice(0, 6)}`, { sourceId: b.sourceId });
          expect(await backupDue(b.engine)).toBe(true);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a backup names a place by the slug its page has now, so a page renamed before occurrences moved restores', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-old-rename-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const first = `notes/first-${randomUUID().slice(0, 6)}`, now = `notes/now-${randomUUID().slice(0, 6)}`, last = `notes/last-${randomUUID().slice(0, 6)}`;
          await b.put(now, beliefPage({ prose: 'Renamed before occurrences moved.' }));
          const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, now]);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`or${randomUUID().slice(0, 6)}`) })).id;
          await record(b, { entryId: id, sourceId: b.sourceId, pageId: page!.id, slug: first, field: 'compiled_truth', origin: 'repair' });
          await b.engine.updateSlug(now, last, { sourceId: b.sourceId });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE id = $1', [id]);
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 1, skipped_no_page: 0, occurrences: 1 });
          expect(await b.engine.executeRaw('SELECT slug, page_id FROM secret_store_occurrence WHERE entry_id = $1', [id])).toEqual([{ slug: last, page_id: page!.id }]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a rename moves only the renamed page\'s own occurrences, never another page\'s still under that slug', async () => {
      await brain(async b => {
        const owner = 'notes/owner-' + randomUUID().slice(0, 6), reused = 'notes/reused-' + randomUUID().slice(0, 6), moved = 'notes/moved-' + randomUUID().slice(0, 6);
        await b.put(owner, beliefPage({ prose: 'Owner, renamed long ago.' }));
        await b.put(reused, beliefPage({ prose: 'Took the old slug.' }));
        const ids = await b.engine.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])', [b.sourceId, [owner, reused]]);
        const o = ids.find(r => r.slug === owner)!, u = ids.find(r => r.slug === reused)!;
        const theirs = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('th' + randomUUID().slice(0, 6)) })).id;
        const mine = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('mi' + randomUUID().slice(0, 6)) })).id;
        await recordOccurrence(b.engine, { entryId: theirs, sourceId: b.sourceId, pageId: o.id, slug: reused, field: 'compiled_truth', origin: 'repair' });
        await recordOccurrence(b.engine, { entryId: mine, sourceId: b.sourceId, pageId: u.id, slug: reused, field: 'compiled_truth', origin: 'repair' });
        await b.engine.updateSlug(reused, moved, { sourceId: b.sourceId });
        const at = async (id: string) => b.engine.executeRaw('SELECT slug, page_id FROM secret_store_occurrence WHERE entry_id = $1', [id]);
        expect({ theirs: await at(theirs), mine: await at(mine) }).toEqual({ theirs: [{ slug: reused, page_id: o.id }], mine: [{ slug: moved, page_id: u.id }] });
      });
    }, 120_000);

    test('a restore never ties an original to a page that took its old slug, even one quoting the entry id, and skips it', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-reused-slug-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const foo = `notes/foo-${randomUUID().slice(0, 6)}`, bar = `notes/bar-${randomUUID().slice(0, 6)}`;
          await b.engine.putPage(foo, { type: 'note', title: 'Owner', compiled_truth: 'Owner.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, foo]);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`ru${randomUUID().slice(0, 6)}`) })).id;
          await record(b, { entryId: id, sourceId: b.sourceId, pageId: page!.id, slug: foo, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.updateSlug(foo, bar, { sourceId: b.sourceId });
          await b.engine.putPage(foo, { type: 'note', title: 'Unrelated', compiled_truth: `Took the old slug; see :${id}> and ${id}.`, timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE id = $1', [id]);
          await expect(restoreBackup(b.engine, storage, out.object)).rejects.toMatchObject({ code: 'invalid_params' });
          expect(await b.engine.executeRaw('SELECT 1 FROM secret_store_occurrence WHERE entry_id = $1', [id])).toEqual([]);
          expect(await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).toEqual([]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a backup that names a page by a slug it had before an older rename skips that entry, and never ties it to the page holding the marker', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-old-backup-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          const first = `notes/first-${randomUUID().slice(0, 6)}`, now = `notes/now-${randomUUID().slice(0, 6)}`;
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`ob${randomUUID().slice(0, 6)}`) })).id;
          await b.engine.putPage(now, { type: 'note', title: 'Renamed', compiled_truth: `Renamed long ago. ${markerOf('github_token', id)}`, timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, slug: first, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE entry_id = $1', [id]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE id = $1', [id]);
          await expect(restoreBackup(b.engine, storage, out.object)).rejects.toMatchObject({ code: 'invalid_params' });
          expect(await b.engine.executeRaw('SELECT 1 FROM secret_store_occurrence WHERE entry_id = $1', [id])).toEqual([]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a rename moves a place with no page along with the page, so a page that later takes the old slug gets nothing', async () => {
      await brain(async b => {
        const from = `notes/from-${randomUUID().slice(0, 6)}`, to = `notes/to-${randomUUID().slice(0, 6)}`;
        await b.engine.putPage(from, { type: 'note', title: 'Took the slug', compiled_truth: 'No marker here.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
        const leftover = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`lo${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: leftover, sourceId: b.sourceId, slug: from, field: 'compiled_truth', origin: 'repair' });
        await b.engine.updateSlug(from, to, { sourceId: b.sourceId });
        await b.engine.putPage(from, { type: 'note', title: 'New page at the old slug', compiled_truth: 'Unrelated.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
        expect((await b.engine.executeRaw<{ slug: string }>('SELECT slug FROM secret_store_occurrence WHERE entry_id = $1', [leftover])).map(r => r.slug)).toEqual([to]);
      });
    }, 120_000);

    test('a page stored in segments holds a marker only when its segments do, and a store row of the page counts too', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-segmented-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const seal1 = async (tag: string) => (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(tag + randomUUID().slice(0, 6)) })).id;
          const ids = { inSegments: await seal1('sg'), notInSegments: await seal1('ns'), frontmatter: await seal1('fm'), rawData: await seal1('rd'), timeline: await seal1('te') };
          const slugs = Object.fromEntries(Object.keys(ids).map(k => [k, 'notes/' + k.toLowerCase() + '-' + randomUUID().slice(0, 6)])) as Record<keyof typeof ids, string>;
          const filler = 'a long line of ordinary text\n'.repeat(3000);
          await createSegmentedPage(b.engine, { slug: slugs.inSegments, sourceId: b.sourceId, truth: filler + 'held here ' + markerOf('github_token', ids.inSegments) + '\n' + filler });
          await createSegmentedPage(b.engine, { slug: slugs.notInSegments, sourceId: b.sourceId, truth: filler + 'took the old slug\n' + filler });
          await b.engine.putPage(slugs.frontmatter, { type: 'note', title: 'Frontmatter', compiled_truth: 'Body.', timeline: '', frontmatter: { token: markerOf('github_token', ids.frontmatter) } }, { sourceId: b.sourceId });
          for (const k of ['rawData', 'timeline'] as const) await b.engine.putPage(slugs[k], { type: 'note', title: k, compiled_truth: 'Body.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          const pid = async (slug: string) => (await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, slug]))[0]!.id;
          await b.engine.executeRaw("INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'test', $2::jsonb)", [await pid(slugs.rawData), JSON.stringify({ note: markerOf('github_token', ids.rawData) })]);
          await b.engine.executeRaw("INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', $2)", [await pid(slugs.timeline), 'Met ' + markerOf('github_token', ids.timeline)]);
          for (const k of Object.keys(ids) as (keyof typeof ids)[]) await recordOccurrence(b.engine, { entryId: ids[k], sourceId: b.sourceId, slug: slugs[k], field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 4, skipped_no_page: 1 });
          const tied = await b.engine.executeRaw<{ entry_id: string; slug: string }>('SELECT entry_id, slug FROM secret_store_occurrence WHERE source_id = $1 ORDER BY slug', [b.sourceId]);
          expect(new Set(tied.map(t => t.entry_id))).toEqual(new Set([ids.inSegments, ids.frontmatter, ids.rawData, ids.timeline]));
          expect(await b.engine.executeRaw('SELECT id FROM secret_store WHERE id = $1', [ids.notInSegments])).toEqual([]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a fallback rename moves a place with no page off the stale slug it retires', async () => {
      await brain(async b => {
        const stale = 'notes/stale-' + randomUUID().slice(0, 6), dest = 'notes/dest-' + randomUUID().slice(0, 6);
        const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('fr' + randomUUID().slice(0, 6)) })).id;
        await b.engine.putPage(stale, { type: 'note', title: 'Old body', compiled_truth: 'Old body ' + markerOf('github_token', id), timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
        await b.engine.putPage(dest, { type: 'note', title: 'New body', compiled_truth: 'New body without it.', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
        await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, slug: stale, field: 'compiled_truth', origin: 'repair' });
        await carryRenameIdentity(b.engine, b.sourceId, stale, dest);
        expect((await b.engine.executeRaw<{ slug: string }>('SELECT slug FROM secret_store_occurrence WHERE entry_id = $1', [id])).map(r => r.slug)).toEqual([dest]);
      });
    }, 120_000);

    test('a restore that writes an entry whose page is gone before its place lands takes the entry back out', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-takeback-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const slug = 'notes/raced-' + randomUUID().slice(0, 6), keep = 'notes/kept-' + randomUUID().slice(0, 6);
          const raced = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('rc' + randomUUID().slice(0, 6)) })).id;
          const kept = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('kp' + randomUUID().slice(0, 6)) })).id;
          await b.engine.putPage(slug, { type: 'note', title: 'Raced', compiled_truth: 'Raced ' + markerOf('github_token', raced), timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await b.engine.putPage(keep, { type: 'note', title: 'Kept', compiled_truth: 'Kept ' + markerOf('github_token', kept), timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await recordOccurrence(b.engine, { entryId: raced, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
          await recordOccurrence(b.engine, { entryId: kept, sourceId: b.sourceId, slug: keep, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw(`CREATE FUNCTION test_purge_raced() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${raced}' THEN DELETE FROM pages WHERE slug = '${slug}'; END IF; RETURN NEW; END $$`);
          await b.engine.executeRaw('CREATE TRIGGER test_purge_raced AFTER INSERT ON secret_store FOR EACH ROW EXECUTE FUNCTION test_purge_raced()');
          try {
            expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 1, skipped_no_page: 1 });
          } finally {
            await b.engine.executeRaw('DROP TRIGGER test_purge_raced ON secret_store');
            await b.engine.executeRaw('DROP FUNCTION test_purge_raced()');
          }
          expect((await b.engine.executeRaw<{ id: string }>('SELECT id FROM secret_store WHERE id = ANY($1::text[])', [[raced, kept]])).map(r => r.id)).toEqual([kept]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a restore ties a place to the page it checked, never to one that took the slug while it ran', async () => {
      await brain(async b => {
        const bucket = mkdtempSync(join(tmpdir(), 'gbrain-ss-pin-'));
        try {
          const storage = await createStorage({ backend: 'local', bucket: 'b', localPath: bucket });
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          const tag = randomUUID().slice(0, 6), slug = 'notes/pinned-' + tag, other = 'notes/taker-' + tag;
          const pinned = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('pn' + tag) })).id;
          await b.engine.putPage(slug, { type: 'note', title: 'Pinned', compiled_truth: 'Pinned ' + markerOf('github_token', pinned), timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await b.engine.putPage(other, { type: 'note', title: 'Taker', compiled_truth: 'No marker', timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          const kept = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value('kq' + tag) })).id;
          await b.engine.putPage('notes/kept-' + tag, { type: 'note', title: 'Kept', compiled_truth: 'Kept ' + markerOf('github_token', kept), timeline: '', frontmatter: {} }, { sourceId: b.sourceId });
          await recordOccurrence(b.engine, { entryId: pinned, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
          await recordOccurrence(b.engine, { entryId: kept, sourceId: b.sourceId, slug: 'notes/kept-' + tag, field: 'compiled_truth', origin: 'repair' });
          const out = await backupStore(b.engine, storage);
          await b.engine.executeRaw('DELETE FROM secret_store_occurrence WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw('DELETE FROM secret_store WHERE source_id = $1', [b.sourceId]);
          await b.engine.executeRaw(`CREATE FUNCTION test_take_slug() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${pinned}' THEN UPDATE pages SET slug = '${slug}-moved' WHERE slug = '${slug}'; UPDATE pages SET slug = '${slug}' WHERE slug = '${other}'; END IF; RETURN NEW; END $$`);
          await b.engine.executeRaw('CREATE TRIGGER test_take_slug AFTER INSERT ON secret_store FOR EACH ROW EXECUTE FUNCTION test_take_slug()');
          try {
            expect(await restoreBackup(b.engine, storage, out.object)).toMatchObject({ inserted: 1, skipped_no_page: 1 });
          } finally {
            await b.engine.executeRaw('DROP TRIGGER test_take_slug ON secret_store');
            await b.engine.executeRaw('DROP FUNCTION test_take_slug()');
          }
          expect(await b.engine.executeRaw('SELECT entry_id FROM secret_store_occurrence WHERE entry_id = $1', [pinned])).toEqual([]);
          expect(await b.engine.executeRaw('SELECT id FROM secret_store WHERE id = $1', [pinned])).toEqual([]);
        } finally { rmSync(bucket, { recursive: true, force: true }); }
      });
    }, 120_000);

    test('a rename that fails partway leaves the page and its secret occurrences where they were', async () => {
      await brain(async b => {
        const foo = `notes/foo-${randomUUID().slice(0, 6)}`, bar = `notes/bar-${randomUUID().slice(0, 6)}`;
        await b.put(foo, beliefPage({ prose: 'Foo.' }));
        const [page] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [b.sourceId, foo]);
        const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`roll${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, pageId: page!.id, slug: foo, field: 'compiled_truth', origin: 'repair' });
        await b.engine.executeRaw(`CREATE OR REPLACE FUNCTION gst3074_fail_move() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'forced failure in the occurrence move'; END $f$`);
        await b.engine.executeRaw('CREATE TRIGGER gst3074_fail_move BEFORE UPDATE ON secret_store_occurrence FOR EACH ROW EXECUTE FUNCTION gst3074_fail_move()');
        try {
          const failed = await b.engine.updateSlug(foo, bar, { sourceId: b.sourceId }).then(() => 'renamed', (e: Error) => e.message);
          expect(failed).toContain('forced failure in the occurrence move');
        } finally {
          await b.engine.executeRaw('DROP TRIGGER gst3074_fail_move ON secret_store_occurrence');
          await b.engine.executeRaw('DROP FUNCTION gst3074_fail_move()');
        }
        expect(await b.engine.readPageSnapshot(foo, { sourceId: b.sourceId })).not.toBeNull();
        expect(await b.engine.readPageSnapshot(bar, { sourceId: b.sourceId })).toBeNull();
        const [occ] = await b.engine.executeRaw<{ slug: string; page_id: number }>('SELECT slug, page_id FROM secret_store_occurrence WHERE entry_id = $1', [id]);
        expect(occ).toEqual({ slug: foo, page_id: page!.id });
        await b.engine.updateSlug(foo, bar, { sourceId: b.sourceId });
        await b.engine.deletePages([bar], { sourceId: b.sourceId });
        expect((await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length).toBe(0);
      });
    }, 120_000);

    if (engineCase.databaseUrl) test('a purge racing a redaction of the same secret on another page keeps the original (Postgres READ COMMITTED)', async () => {
      await brain(async b => {
        const { slug } = await pages(b);
        const third = `notes/third-${randomUUID().slice(0, 6)}`;
        await b.put(third, beliefPage({ prose: 'Third.' }));
        const id = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`race${randomUUID().slice(0, 6)}`) })).id;
        await recordOccurrence(b.engine, { entryId: id, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair' });
        const { default: postgres } = await import('#postgres');
        const [{ db }] = await b.engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const url = new URL(engineCase.databaseUrl!); url.pathname = `/${db}`;
        const other2 = postgres(url.toString(), { max: 1, onnotice: () => {} });
        try {
          let release!: () => void;
          const hold = new Promise<void>(r => { release = r; });
          let inserted!: () => void;
          const ready = new Promise<void>(r => { inserted = r; });
          const redaction = other2.begin(async sql => {
            await sql`INSERT INTO secret_store_occurrence (entry_id, source_id, slug, field, origin) VALUES (${id}, ${b.sourceId}, ${third}, 'compiled_truth', 'repair')`;
            inserted();
            await hold;
          });
          await ready;
          const purge = b.engine.deletePages([slug], { sourceId: b.sourceId });
          await Bun.sleep(500);
          release();
          await redaction;
          await purge;
        } finally { await other2.end(); }
        expect((await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [id])).length).toBe(1);
        expect((await b.engine.executeRaw<{ slug: string }>('SELECT slug FROM secret_store_occurrence WHERE entry_id = $1', [id])).map(o => o.slug)).toEqual([third]);
      });
    }, 120_000);

    test('doctor counts sealed originals no page or commit references', async () => {
      await brain(async b => {
        const ctx = { engine: b.engine, remote: true, progress: { heartbeat() {} } } as unknown as DoctorContext;
        const before = await secretStoreCheck(ctx);
        const orphan = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`orphan${randomUUID().slice(0, 6)}`) })).id;
        const after = await secretStoreCheck(ctx);
        expect((after.details as { unreferenced: number }).unreferenced).toBe(((before.details as { unreferenced?: number } | undefined)?.unreferenced ?? 0) + 1);
        expect(after.status).toBe('warn');
        expect(after.message).toContain('referenced by no page or commit');
        expect((await b.engine.executeRaw('SELECT 1 FROM secret_store WHERE id = $1', [orphan])).length).toBe(1);
        await recordOccurrence(b.engine, { entryId: orphan, sourceId: b.sourceId, slug: 'notes/x', field: 'compiled_truth', origin: 'repair' });
        expect((await secretStoreCheck(ctx)).message).not.toContain('referenced by no page or commit');
      });
    }, 120_000);
  });
}
