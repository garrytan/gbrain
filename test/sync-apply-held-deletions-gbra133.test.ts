/**
 * GBRA-133 wave 3: `sync.apply_held_deletions` (default off). A managed pass holds a live page whose file a commit deleted
 * when nothing proves the page still holds what the file held (an older import: no import record, no write request).
 * With the switch on, the pass deletes such a page itself only when the page equals the file's last committed blob and
 * its revision is file-backed by the #7382 test; every other held deletion stays held and its hold records why.
 *   - a page equal to the deleted file's last committed bytes is soft-deleted by the pass, with a receipt (its
 *     `managed_sync_delete` request names the deleting commit and the blob) and a restorable version;
 *   - a page whose content differs from that blob is kept (`content_differs`);
 *   - a page written in the database after the deleting commit is kept even with equal content (`database_ahead_of_file`);
 *   - a path deleted, re-added with other bytes and deleted again is judged against the re-added bytes, its last
 *     committed blob, so a page holding the first version is kept (`content_differs`);
 *   - with the switch off nothing changes: all four stay held. A refused hold is not screened again while its page stays.
 * Before: no switch existed, so every proven held deletion waited for `gbrain repair file-drift`.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git; older imports are modelled as
 * pages whose revision no import record or write request produced, last written an hour before the deleting commit.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d'];

async function holds(engine: BrainEngine): Promise<Record<string, { code: string; meta: Record<string, any> }>> {
  const rows = await engine.executeRaw<{ record: { path: string; code: string; meta: Record<string, unknown> } }>("SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'");
  return Object.fromEntries(rows.map(({ record }) => [record.path, record]));
}
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE 'notes/%' ORDER BY slug")).map(row => row.slug);

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: sync.apply_held_deletions`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('deletes only a page equal to its file\'s last committed blob, and keeps the rest held with the reason', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    // Older imports: a revision no import record or sync request produced, last written an hour ago.
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug LIKE 'notes/%')`);
    for (const slug of SLUGS) await coordinated(`UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL, updated_at = now() - interval '1 hour'
      WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
    // notes/b moved on in the database (still before the deletion).
    await coordinated(`UPDATE pages SET compiled_truth = compiled_truth || ' Edited in the database.', knowledge_revision = $1::uuid WHERE source_id='default' AND slug='notes/b'`, [randomUUID()]);
    git(root, 'rm', '-q', ...SLUGS.map(slug => `${slug}.md`)); git(root, 'commit', '-qm', 'cull a, b, c and d');
    const cull = git(root, 'rev-parse', 'HEAD');
    const blobA = git(root, 'rev-parse', `${cull}^:notes/a.md`);
    // notes/d comes back with other bytes and is deleted again: its last committed blob is the second version.
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes/d.md'), note('notes/d', 'A second version of notes/d.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 're-add d');
    git(root, 'rm', '-q', 'notes/d.md'); git(root, 'commit', '-qm', 'cull d again');
    // notes/c is written in the database after the deleting commit, with the same content (a new revision, no write request).
    await coordinated(`UPDATE pages SET knowledge_revision = $1::uuid, updated_at = now() + interval '1 hour' WHERE source_id='default' AND slug='notes/c'`, [randomUUID()]);

    // Off (the default): every deletion is held, nothing is deleted.
    await performManagedSync(engine, OPTS);
    const off = await holds(engine);
    for (const slug of SLUGS) expect(off[`${slug}.md`]).toMatchObject({ code: 'file_drift', meta: { side: 'deleted', state: 'file_gone' } });
    for (const slug of SLUGS) expect(off[`${slug}.md`]!.meta.reason).toBeUndefined();
    expect(await live(engine)).toEqual(SLUGS);

    await engine.setConfig('sync.apply_held_deletions', 'true');
    await performManagedSync(engine, OPTS);
    expect(await live(engine)).toEqual(['notes/b', 'notes/c', 'notes/d']);
    const on = await holds(engine);
    expect(on['notes/a.md']).toBeUndefined();
    expect([on['notes/b.md']?.meta.held_deletion?.refused, on['notes/c.md']?.meta.held_deletion?.refused, on['notes/d.md']?.meta.held_deletion?.refused])
      .toEqual(['content_differs', 'database_ahead_of_file', 'content_differs']);
    // The receipt: an ordinary sync deletion of notes/a naming the deleting commit and the blob it equals, and a version to restore from.
    const receipts = await engine.executeRaw<{ slug: string; state: string; proof: { commit: string; blob_oid: string } }>(
      "SELECT slug, state, intent->'heldDeletion' AS proof FROM persistence_requests WHERE intent->>'kind'='managed_sync_delete' AND intent ? 'heldDeletion'");
    expect(receipts).toEqual([{ slug: 'notes/a', state: 'committed', proof: { commit: cull, blob_oid: blobA } }]);
    const [versions] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id='default' AND p.slug='notes/a'");
    expect(versions!.n).toBeGreaterThan(0);

    // A refused hold is not screened again while its page stays at that revision.
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await live(engine)).toEqual(['notes/b', 'notes/c', 'notes/d']);
    const again = await holds(engine);
    for (const slug of ['notes/b', 'notes/c', 'notes/d']) expect(again[`${slug}.md`]!.meta.held_deletion).toEqual(on[`${slug}.md`]!.meta.held_deletion);
  }, { databaseUrl, setup }), 300_000);
});
