/**
 * An unknown-side `file_drift` hold (a Git edit to a page with no import record) written by the screen that compared only
 * the file at the last synced commit was never screened again after the screen learned to compare the path's earlier
 * committed versions too. A page that still held an older committed version of its file, with only the file moving since,
 * stayed held although Git alone had changed. Such a hold is screened once more: it imports the Git edit when the page
 * holds one of those earlier versions, and otherwise stays held, stamped so it is not screened again.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
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
    for (const slug of ['notes/a', 'notes/b']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test(`[${backend}] an unknown-side hold screened before the earlier-versions rule is screened again and imports the Git edit`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const coordinated = (sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
    const original = await body(engine, 'notes/a');
    // Older imports with no import record; both pages then change in the database, and both files change in Git.
    await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug IN ('notes/a', 'notes/b'))`);
    for (const slug of ['notes/a', 'notes/b']) await coordinated(`UPDATE pages SET compiled_truth = compiled_truth || ' Edited in the database.', knowledge_revision = $1::uuid,
      revision_write_request_id = NULL, updated_at = now() - interval '1 hour' WHERE source_id='default' AND slug=$2`, [randomUUID(), slug]);
    for (const slug of ['notes/a', 'notes/b']) writeFileSync(join(root, `${slug}.md`), note(slug, `A first Git edit of ${slug}.`));
    git(root, 'commit', '-qam', 'first edit');
    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([`notes/a.md file_drift unknown v${FILE_DRIFT_VERSION}`, `notes/b.md file_drift unknown v${FILE_DRIFT_VERSION}`]);
    // notes/a goes back to the version it imported from the first commit: only Git has moved since. notes/b keeps its edit.
    await coordinated(`UPDATE pages SET compiled_truth = $1, knowledge_revision = $2::uuid WHERE source_id='default' AND slug='notes/a'`, [original, randomUUID()]);
    for (const slug of ['notes/a', 'notes/b']) writeFileSync(join(root, `${slug}.md`), note(slug, `A second Git edit of ${slug}.`));
    git(root, 'commit', '-qam', 'second edit');
    // The holds the baseline-only screen (version 1) wrote for the second edit: the page differs from the file at the last
    // synced commit (the first edit), so that screen held both.
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    for (const slug of ['notes/a', 'notes/b']) {
      const path = `${slug}.md`, page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path, source_path: path, slug, page_id: Number(page.page.id), code: 'file_drift',
        message: `${path}: page ${slug} differs from its file and has no import record to tell whether the file or the database changed`,
        upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, sides: 'unknown', side: 'unknown', drift_version: 1, blob_oid: git(root, 'rev-parse', `HEAD:${path}`), page_revision: page.revision } }));
    }
    expect(await holds(engine)).toEqual(['notes/a.md file_drift unknown v1', 'notes/b.md file_drift unknown v1']);

    await performManagedSync(engine, OPTS);
    expect(await body(engine, 'notes/a')).toContain('A second Git edit of notes/a.');
    expect(await body(engine, 'notes/b')).toContain('Edited in the database.');
    expect(await holds(engine)).toEqual([`notes/b.md file_drift unknown v${FILE_DRIFT_VERSION}`]);

    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual([`notes/b.md file_drift unknown v${FILE_DRIFT_VERSION}`]);
    expect(await body(engine, 'notes/b')).toContain('Edited in the database.');
  }, { databaseUrl, setup }), 180_000);
}
