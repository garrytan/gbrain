/**
 * GBRA-133 (#7340 follow-up): before #7340's fix, a Git edit to a page with no import record was held `file_drift` with an
 * unknown side. The fix imports such an edit when the page still holds its file at the baseline commit, but only for new
 * edits: a hold written by the older screen stayed "at its level" (its blob unchanged) and was never screened again, so the
 * page stayed stale. Such a hold (no `drift_version`) is now re-screened once: it imports when the page still holds its
 * baseline file, and otherwise stays held, stamped with the current screen so it is not re-screened again.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; meta: { side?: string; drift_version?: number } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code} ${r.meta.side ?? ''} v${r.meta.drift_version ?? 0}`);
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ t: string }>(
  "SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.t;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/a', 'notes/b', 'notes/other']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test(`GBRA-133 [${backend}]: an unknown-side file_drift hold from the screen before #7340 is screened again and imports the Git edit`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    // Older imports: no import record, a revision no request wrote. notes/b also moved on in the database.
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug IN ('notes/a', 'notes/b'))`);
    for (const slug of ['notes/a', 'notes/b']) await coordinated(`UPDATE pages SET knowledge_revision = $1::uuid, revision_write_request_id = NULL,
      updated_at = now() - interval '1 hour' WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
    await coordinated(`UPDATE pages SET compiled_truth = compiled_truth || ' Edited in the database.', knowledge_revision = $1::uuid WHERE source_id='default' AND slug='notes/b'`, [randomUUID()]);
    for (const slug of ['notes/a', 'notes/b']) writeFileSync(join(root, `${slug}.md`), note(slug, `A Git edit of ${slug}.`));
    git(root, 'commit', '-qam', 'edit a and b');
    // The holds the screen before #7340 wrote for those edits: unknown side, the edited blob, no drift_version.
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    for (const slug of ['notes/a', 'notes/b']) {
      const path = `${slug}.md`, page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path, source_path: path, slug, page_id: Number(page.page.id), code: 'file_drift',
        message: `${path}: page ${slug} changed in the database since the file was last imported and there is no import record to tell which side changed`,
        upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, sides: 'unknown', side: 'unknown', blob_oid: git(root, 'rev-parse', `HEAD:${path}`), page_revision: page.revision } }));
    }
    expect(await holds(engine)).toEqual(['notes/a.md file_drift unknown v0', 'notes/b.md file_drift unknown v0']);

    await performManagedSync(engine, OPTS);
    expect(await body(engine, 'notes/a')).toContain('A Git edit of notes/a.');
    expect(await body(engine, 'notes/b')).toContain('Edited in the database.');
    expect(await holds(engine)).toEqual(['notes/b.md file_drift unknown v1']);

    writeFileSync(join(root, 'notes/other.md'), note('notes/other', 'An unrelated edit.')); git(root, 'commit', '-qam', 'edit other');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual(['notes/b.md file_drift unknown v1']);
    expect(await body(engine, 'notes/b')).toContain('Edited in the database.');
  }, { databaseUrl, setup }), 180_000);
}
