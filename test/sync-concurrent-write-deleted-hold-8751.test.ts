/**
 * #8751: a `concurrent_write` hold on a file that ended deleted while its page was soft-deleted is released.
 *
 * Protects: a stamping managed sync pass releases a `concurrent_write` hold once both sides agree the path is gone
 * (the file is gone from Git and no live page has the hold's id or slug), the way it releases a deleted-side
 * `file_drift` hold; the same hold on a page that is still live stays held.
 * Fails when: the pass's deletion candidates keep only `file_drift` holds again; the hold then stays `needs_human`
 * forever and its `sources reconcile` fix refuses `page_not_found`.
 * Seam: the hold is written with `writeGitHold` as the import race writes it (sync-page-fault.ts `pageChangedHold`),
 * after the deletion, as in the report; the page delete is a real `delete_page` request and every sync is a real
 * managed pass over real Git.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/retired-example', 'notes/live-example', 'notes/other-example'];

const heldPaths = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string; code: string }>(
  "SELECT completed_keys->0->>'path' AS path, completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='sync-hold' ORDER BY 1"))
  .map(row => `${row.path} ${row.code}`);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test(`#8751 [${backend}]: a concurrent_write hold whose file and page both ended deleted is released; one on a live page stays`, () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // notes/live-example changes in the database only; notes/retired-example is deleted through a real delete_page.
    const coordinated = (sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug=$1)`, ['notes/live-example']);
    await coordinated(`UPDATE pages SET knowledge_revision=$1::uuid, revision_write_request_id=NULL, updated_at=now() - interval '1 hour'
      WHERE source_id='default' AND slug=$2`, [randomUUID(), 'notes/live-example']);
    const retired = (await engine.readPageSnapshot('notes/retired-example', { sourceId: 'default' }))!;
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/retired-example', request_id: randomUUID(), expected_revision: retired.revision } });
    await settleManagedGitEffects(engine);
    // Both files leave Git in one commit, and a pass sees it.
    for (const path of ['notes/retired-example.md', 'notes/live-example.md']) if (existsSync(join(root, path))) git(root, 'rm', '-q', '--', path);
    git(root, 'commit', '-qm', 'retire and remove');
    await performManagedSync(engine, OPTS);

    // The race's concurrent_write holds land after the deletion.
    for (const slug of ['notes/retired-example', 'notes/live-example']) {
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }))!;
      const path = `${slug}.md`;
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: snapshot.sourceIncarnation, path, source_path: path, slug,
        page_id: snapshot.page.id, code: 'concurrent_write', message: `${path}: page ${slug} changed after this sync enumerated it.`, upstream_version: null,
        observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, page_revision: snapshot.revision } }));
    }
    expect(await heldPaths(engine)).toEqual(['notes/live-example.md concurrent_write', 'notes/retired-example.md concurrent_write']);

    writeFileSync(join(root, 'notes/other-example.md'), note('notes/other-example', 'An unrelated edit.'));
    git(root, 'commit', '-qam', 'edit other');
    await performManagedSync(engine, OPTS);
    // The live page's deletion stays held (the pass re-screens it as its deleted-side file_drift hold); only the agreed deletion is released.
    expect(await heldPaths(engine)).toEqual(['notes/live-example.md file_drift']);
    expect((await engine.readPageSnapshot('notes/live-example', { sourceId: 'default' }))!.page.deleted_at).toBeFalsy();
  }, { databaseUrl, setup }), 180_000);
}
