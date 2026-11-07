/**
 * #8751: a `concurrent_write` hold on a path whose file is gone from Git and whose page is soft-deleted was never released
 * (only deleted-side `file_drift` holds were). Both versions agree on the deletion, so the next stamping pass releases it;
 * the same hold on a page that is still live stays held.
 */
import { expect, test } from 'bun:test';
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
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/gone', 'notes/live', 'notes/other'];

const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string; state?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''} ${r.meta.state ?? ''}`.trim());

/** A commit that touches only notes/other, so the next pass stamps. */
function unrelatedCommit(root: string): void {
  writeFileSync(join(root, 'notes/other.md'), note('notes/other', `Edited ${randomUUID()}.`)); git(root, 'commit', '-qam', 'edit other');
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test(`#8751 [${backend}]: a concurrent_write hold on a deleted file with a soft-deleted page is released; one on a live page stays`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    for (const slug of ['notes/gone', 'notes/live']) await coordinated(`UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL,
      updated_at = now() - interval '1 hour' WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'`);
    git(root, 'rm', '-q', 'notes/gone.md', 'notes/live.md'); git(root, 'commit', '-qm', 'remove gone and live');
    await performManagedSync(engine, OPTS);
    // Present the two held deletions as the import-side hold the issue reports.
    await coordinated(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,code}','"concurrent_write"') WHERE op='sync-hold'`);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.softDeletePage('notes/gone', { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
    expect(await holds(engine)).toEqual(['notes/gone.md concurrent_write deleted file_gone', 'notes/live.md concurrent_write deleted file_gone']);
    unrelatedCommit(root);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/live.md concurrent_write deleted file_gone']);
  }, { databaseUrl, setup }), 180_000);
}
