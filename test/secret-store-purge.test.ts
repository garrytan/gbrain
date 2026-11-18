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
import { recordOccurrence, seal } from '../src/core/secret-store/store.ts';
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

    test('doctor counts sealed originals no page or commit references', async () => {
      await brain(async b => {
        const ctx = { engine: b.engine, remote: true, progress: { heartbeat() {} } } as unknown as DoctorContext;
        const before = await secretStoreCheck(ctx);
        const orphan = (await seal(b.engine, { sourceId: b.sourceId, rule: 'github_token', value: value(`orphan${randomUUID().slice(0, 6)}`) })).id;
        const after = await secretStoreCheck(ctx);
        expect((after.details as { unreferenced: number }).unreferenced).toBe(((before.details as { unreferenced?: number } | undefined)?.unreferenced ?? 0) + 1);
        expect(after.status).toBe('warn');
        expect(after.message).toContain('referenced by no page or commit');
        await recordOccurrence(b.engine, { entryId: orphan, sourceId: b.sourceId, slug: 'notes/x', field: 'compiled_truth', origin: 'repair' });
        expect((await secretStoreCheck(ctx)).message).not.toContain('referenced by no page or commit');
      });
    }, 120_000);
  });
}
