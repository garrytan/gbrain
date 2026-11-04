/**
 * #7974: follow-ups from #7909's review of the sync-holds wave.
 *
 * 1. liveFileDrift's stale-mirror branch threw when several spellings of the slug path import as the slug (and none is
 *    spelled exactly): every other failure there is still_present null, and the throw aborted the conflict audit.
 * 2. The same branch called a stale mirror page drifted whenever its slug-path file existed, without comparing: an agreeing
 *    page was never offered release_hold. It now compares through the reconcile reading.
 * 3. slugPathFile took an exact `<slug>.md` that existsSync found (a symlink, or a case-insensitive match) and always read
 *    source-root slugs. It now reads through slugDerivedOrigin in the source's slug-root mode.
 * 4. release_hold was offered when the agreeing file was not the held one; such a page is listed unknown now.
 * 7. A file_drift hold an older gbrain wrote without meta.page_revision reads as moved; its re-screen records the revision,
 *    so the next pass is idle again.
 *
 * Holds exist only where sync imports a Git checkout, so there is no repo-less arm.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { readGitHold, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { movedDriftHolds } from '../src/core/persistence/sync-prescreen.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { slugPathFile } from '../src/core/persistence/unbound-pages.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };
const commitAll = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
const holdRows = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string; page_id: number | null; meta: { page_revision?: string } } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => r);
const incarnation = async (engine: BrainEngine) => (await engine.executeRaw<{ i: string }>("SELECT incarnation::text AS i FROM sources WHERE id='default'"))[0]!.i;
async function heldPreview(engine: BrainEngine, prefer: 'file' | 'database', expectHash?: string) {
  return withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
    (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'unknown', prefer, ...(expectHash ? { expect: expectHash } : {}) }));
}
const listing = (plan: Awaited<ReturnType<typeof heldPreview>>) => (plan as { listing?: Array<{ item: string; class: string }> }).listing?.map(row => `${row.item} ${row.class}`);
const mirrorPage = (engine: BrainEngine, body: string) => coordinated(engine, `INSERT INTO pages(source_id, slug, type, title, compiled_truth, timeline, frontmatter, database_only_reason)
  VALUES('default', 'notes/mirror-page', 'concept', 'notes/mirror-page', $1, '', '{}'::jsonb, 'mirror_read_only')`, [body]);

test('#7974 item 3: slugPathFile never takes a symlink for the slug file, and reads git-root slugs in a Git subfolder source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slug-path-7974-'));
  try {
    git(dir, 'init', '-q');
    mkdirSync(join(dir, 'sub/notes'), { recursive: true });
    writeFileSync(join(dir, 'outside.md'), note('outside', 'Not this page.'));
    writeFileSync(join(dir, 'sub/HEARTBEAT.md'), note('heartbeat', 'The page.'));
    symlinkSync(join(dir, 'outside.md'), join(dir, 'sub/heartbeat.md'));
    expect(slugPathFile(join(dir, 'sub'), 'heartbeat', 'source-root')).toBe(join(dir, 'sub/HEARTBEAT.md'));
    writeFileSync(join(dir, 'sub/notes/a.md'), note('sub/notes/a', 'Git-root slug.'));
    expect(slugPathFile(join(dir, 'sub'), 'sub/notes/a', 'git-root')).toBe(join(dir, 'sub/notes/a.md'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/n0', 'notes/n1']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    commitAll(root, 'notes');
  };

  test(`#7974 item 1 [${backend}]: a stale mirror page whose slug path has several spellings is unknown, not a thrown audit`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await mirrorPage(engine, 'The database copy.');
    writeFileSync(join(root, 'notes/Mirror-Page.md'), note('notes/mirror-page', 'One spelling.'));
    writeFileSync(join(root, 'notes/MIRROR-PAGE.md'), note('notes/mirror-page', 'Another spelling.'));
    expect(await liveFileDrift(engine, 'default', 'notes/mirror-page')).toEqual({ still_present: null, reason: 'slug_path_ambiguous' });
  }, { databaseUrl, setup }), 180_000);

  test(`#7974 item 2 [${backend}]: a held stale mirror page that agrees with its slug-path file is listed release_hold, and its apply releases the hold`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await mirrorPage(engine, 'The database copy, written while the source was a mirror.');
    writeFileSync(join(root, 'notes/mirror-page.md'), note('notes/mirror-page', 'The upstream file.')); commitAll(root, 'upstream');
    await performManagedSync(engine, OPTS);
    expect((await holdRows(engine)).map(row => `${row.path} ${row.code}`)).toEqual(['notes/mirror-page.md file_drift']);
    expect(await liveFileDrift(engine, 'default', 'notes/mirror-page')).toMatchObject({ still_present: true, reason: 'file_database_drift', path: 'notes/mirror-page.md' });
    await coordinated(engine, "UPDATE pages SET compiled_truth='The upstream file.', knowledge_revision=$1::uuid WHERE source_id='default' AND slug='notes/mirror-page'", [randomUUID()]);
    expect(await liveFileDrift(engine, 'default', 'notes/mirror-page')).toMatchObject({ still_present: false, reason: 'agrees', path: 'notes/mirror-page.md' });
    const preview = await heldPreview(engine, 'database');
    expect(listing(preview)).toEqual(['default:notes/mirror-page release_hold']);
    expect((await heldPreview(engine, 'database', preview.preview_hash!)).outcomes).toEqual({ repaired: 1 });
    await performManagedSync(engine, OPTS);
    expect(await holdRows(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test(`#7974 item 4 [${backend}]: a held path whose page agrees with another file is listed unknown, not release_hold`, () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const [page] = await engine.executeRaw<{ id: number; revision: string }>("SELECT id, knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug='notes/n1'");
    const inc = await incarnation(engine);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: inc, path: 'notes/n1-twin.md', source_path: 'notes/n1-twin.md',
      slug: 'notes/n1', page_id: Number(page!.id), code: 'file_drift', message: 'notes/n1-twin.md is held: file drift (unknown)', upstream_version: null,
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'unknown', page_revision: page!.revision } }));
    expect(listing(await heldPreview(engine, 'file'))).toEqual(['default:notes/n1 unknown']);
  }, { databaseUrl, setup }), 180_000);

  test(`#7974 item 7 [${backend}]: an older hold with no recorded page revision is re-screened once, records the revision, and the next pass is idle`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await coordinated(engine, `DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
      AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug='notes/n0')`);
    await coordinated(engine, `UPDATE pages SET source_path=NULL, compiled_truth='A stub.', knowledge_revision=$1::uuid, revision_write_request_id=NULL
      WHERE source_id='default' AND slug='notes/n0'`, [randomUUID()]);
    writeFileSync(join(root, 'notes/n0.md'), note('notes/n0', 'The edited body of notes/n0.')); commitAll(root, 'edit n0');
    await performManagedSync(engine, OPTS);
    const [held] = await holdRows(engine);
    expect(held).toMatchObject({ path: 'notes/n0.md', code: 'file_drift' });
    expect(held!.meta.page_revision).toBeString();
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta}',(completed_keys->0->'meta') - 'page_revision') WHERE op='sync-hold'`);
    expect([...await movedDriftHolds(engine, 'default', await holdRows(engine))]).toEqual(['notes/n0.md']);
    await performManagedSync(engine, OPTS);
    const [again] = await holdRows(engine);
    expect(again).toMatchObject({ path: 'notes/n0.md', code: 'file_drift', meta: { page_revision: held!.meta.page_revision } });
    expect([...await movedDriftHolds(engine, 'default', await holdRows(engine))]).toEqual([]);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(await readGitHold(engine, 'default', await incarnation(engine), 'notes/n0.md')).not.toBeNull();
  }, { databaseUrl, setup }), 180_000);
}
