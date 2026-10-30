/**
 * GBRA-133: `gbrain repair file-drift --held --side deleted --state file_gone --prefer file` soft-deleted the page but left
 * its `file_drift` hold, and no later sync released it, not even `--full`: the pass found the hold "at its level" (no file)
 * and kept it. The soft delete is the decision the hold waited for, so the ghost retirement now clears it in the same
 * publication. A hold an earlier version left behind (its page already deleted, its file gone) is released by the next
 * pass that stamps; a held deletion whose page is still live stays held.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/gone', 'notes/live', 'notes/other'];
const logger = { info() {}, warn() {}, error() {} };

const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string; state?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''} ${r.meta.state ?? ''}`.trim());
const deleted = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ d: boolean }>(
  "SELECT deleted_at IS NOT NULL AS d FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.d;

/** Older imports of notes/gone and notes/live (no import record, no write request), whose files one commit then deletes: two held file_gone deletions. */
async function heldDeletions(engine: BrainEngine, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug IN ('notes/gone', 'notes/live'))`);
  for (const slug of ['notes/gone', 'notes/live']) await coordinated(`UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL,
    updated_at = now() - interval '1 hour' WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
  git(root, 'rm', '-q', 'notes/gone.md', 'notes/live.md'); git(root, 'commit', '-qm', 'remove gone and live');
  await performManagedSync(engine, OPTS);
  expect(await holds(engine)).toEqual(['notes/gone.md file_drift deleted file_gone', 'notes/live.md file_drift deleted file_gone']);
}

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

  test(`GBRA-133 [${backend}]: repair file-drift --prefer file soft-deletes a file_gone page and clears its hold in the same publication`, () => managedBrain(async ({ engine, root }) => {
    await heldDeletions(engine, root);
    const run = async (expect?: string) => withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: expect !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
        { explicit: true, sourceFlag: 'default', held: true, prefer: 'file', side: 'deleted', state: 'file_gone', only: ['notes/gone.md'], ...(expect ? { expect } : {}) }));
    const preview = await run();
    expect(preview.details!.pages).toEqual([expect.objectContaining({ slug: 'notes/gone', action: 'soft_delete' })]);
    expect((await run(preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    expect(await deleted(engine, 'notes/gone')).toBe(true);
    expect(await holds(engine)).toEqual(['notes/live.md file_drift deleted file_gone']);
    unrelatedCommit(root);
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await holds(engine)).toEqual(['notes/live.md file_drift deleted file_gone']);
  }, { databaseUrl, setup }), 180_000);

  test(`GBRA-133 [${backend}]: a hold left on a page deleted since is released by the next stamping pass; a held page still live stays held`, () => managedBrain(async ({ engine, root }) => {
    await heldDeletions(engine, root);
    // The soft delete an earlier version's repair made, which left the hold.
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.softDeletePage('notes/gone', { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
    expect(await deleted(engine, 'notes/gone')).toBe(true);
    expect(await holds(engine)).toEqual(['notes/gone.md file_drift deleted file_gone', 'notes/live.md file_drift deleted file_gone']);
    unrelatedCommit(root);
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/live.md file_drift deleted file_gone']);
    expect(await deleted(engine, 'notes/live')).toBe(false);
  }, { databaseUrl, setup }), 180_000);
}
