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
import { recordOccurrence, reveal, seal } from '../src/core/secret-store/store.ts';
import { scrubPurgedSlugStores } from '../src/core/persistence/purge-slug-stores.ts';
import { backupStore, restoreBackup } from '../src/core/secret-store/backup.ts';
import { createStorage } from '../src/core/storage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretStoreCheck } from '../src/commands/doctor/checks/secret-store.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const deleteOp = operations.find(o => o.name === 'delete_page')!;
const value = (tag: string) => ['ghp', tag.padEnd(36, 'Q')].join('_');

/** Three originals on page `slug`: one only there, one also on `other`, one also recorded on a publish commit. */
async function seed(b: BeliefBrain, slug: string, other: string) {
  const ids: Record<'only' | 'shared' | 'committed', string> = { only: '', shared: '', committed: '' };
  for (const kind of ['only', 'shared', 'committed'] as const) {
    ids[kind] = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`${kind}${randomUUID().slice(0, 6)}`) })).id;
    await recordOccurrence(b.engine, { entryId: ids[kind], sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'repair', path: `${slug}.md` });
  }
  await recordOccurrence(b.engine, { entryId: ids.shared, sourceId: b.sourceId, slug: other, field: 'compiled_truth', origin: 'repair', path: `${other}.md` });
  await recordOccurrence(b.engine, { entryId: ids.committed, sourceId: b.sourceId, slug, field: 'compiled_truth', origin: 'publish_rebuild', commit: 'a'.repeat(40), path: `${slug}.md` });
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
    const pages = async (b: BeliefBrain) => {
      const slug = `notes/deploy-${randomUUID().slice(0, 6)}`, other = `notes/other-${randomUUID().slice(0, 6)}`;
      await b.put(slug, beliefPage({ prose: 'Deploy notes.' }));
      await b.put(other, beliefPage({ prose: 'Other notes.' }));
      return { slug, other, ids: await seed(b, slug, other) };
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
          const { slug, ids } = await pages(b);
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
