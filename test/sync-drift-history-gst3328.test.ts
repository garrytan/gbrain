/**
 * GST-3328: a page with no import record (imported by an older gbrain) whose file changed in Git is held `file_drift` of
 * unknown side unless the page still holds its file's earlier content. The screen compared it with the file at the last
 * synced commit, and with the path's earlier committed versions only for holds an older gbrain wrote, so a page one commit
 * further behind, or one whose last synced commit no longer resolves, stayed held although only Git had moved.
 *   - sync compares every such page with its file's earlier committed versions and imports the Git edit when one matches;
 *   - a hold the current screen already wrote is screened that way again after `gbrain sources retry-held` (or a new commit);
 *   - `gbrain repair file-drift --held` names the match and the retry instead of a per-page decision;
 *   - a page edited in the database stays held, and the doctor routes file-drift holds to the whole-set preview.
 * Real PGLite (and Postgres when DATABASE_URL is set), a managed worktree with real Git commits; no seams.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { holdRepairSteps } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\ntags: [zeta, alpha]\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const logger = { info() {}, warn() {}, error() {} };

const held = async (engine: BrainEngine) => (await engine.executeRaw<{ path: string }>(
  "SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'code'='file_drift' ORDER BY 1")).map(row => row.path);
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ t: string }>(
  "SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.t;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };
  const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  /** What an older gbrain left: pages with no import record and a revision no sync request wrote (`edited` also changed in the database). */
  const unrecorded = async (engine: BrainEngine, edited: string[] = []) => {
    await coordinated(engine, "DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) await coordinated(engine, `UPDATE pages SET compiled_truth = compiled_truth || $1, knowledge_revision = $2::uuid,
      revision_write_request_id = NULL, updated_at = now() - interval '1 hour' WHERE source_id='default' AND slug=$3`, [edited.includes(slug) ? ' Edited in the database.' : '', randomUUID(), slug]);
  };
  const edit = (root: string, slugs: string[], body: string) => { for (const slug of slugs) writeFileSync(join(root, `${slug}.md`), note(slug, `${body} of ${slug}.`)); };

  test(`[${backend}] a record-less page that equals an earlier committed version of its file imports the Git edit when the last synced commit no longer resolves`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await unrecorded(engine, ['notes/b']);
    edit(root, ['notes/a', 'notes/b'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    edit(root, ['notes/c'], 'A Git edit'); git(root, 'commit', '-qam', 'second edit');
    // The source's last synced commit is gone from the repository (a rewritten upstream, a re-cloned checkout).
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    await performManagedSync(engine, OPTS);
    expect(await body(engine, 'notes/a')).toContain('A first Git edit of notes/a.');
    expect(await body(engine, 'notes/c')).toContain('A Git edit of notes/c.');
    // A page edited in the database still differs from every committed version: it stays held for a person.
    expect(await held(engine)).toEqual(['notes/b.md']);
    expect(await body(engine, 'notes/b')).toContain('Edited in the database.');
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] the earlier version a record-less page holds is found by the file's own history, however many other commits came since`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await unrecorded(engine);
    edit(root, ['notes/a'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    for (let i = 0; i < 55; i++) { writeFileSync(join(root, 'log.txt'), `entry ${i}\n`); git(root, 'add', 'log.txt'); git(root, 'commit', '-qm', `log ${i}`); }
    edit(root, ['notes/a'], 'A second Git edit'); git(root, 'commit', '-qam', 'second edit');
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    await performManagedSync(engine, OPTS);
    expect(await held(engine)).toEqual([]);
    expect(await body(engine, 'notes/a')).toContain('A second Git edit of notes/a.');
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] the preview and sync compare the same earlier versions after a merge that kept one side`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await unrecorded(engine);
    let at = 1_800_000_000;
    const commit = (message: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-qam', message], { env: { ...process.env, GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at++} +0000` } });
    const main = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    edit(root, ['notes/a'], 'A main edit'); commit('main edit');
    git(root, 'checkout', '-q', '-b', 'side', 'HEAD~1');
    for (const n of [1, 2, 3]) { edit(root, ['notes/a'], `Side edit ${n}`); commit(`side ${n}`); }
    git(root, 'checkout', '-q', main);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'merge', '-q', '-s', 'ours', '--no-edit', 'side'],
      { env: { ...process.env, GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at++} +0000` } });
    edit(root, ['notes/a'], 'A last main edit'); commit('last main edit');
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    await performManagedSync(engine, OPTS);
    const preview = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', held: true, side: 'unknown' }));
    const listed = preview.listing!.find(entry => entry.item === 'default:notes/a');
    // The read follows every parent, so the three versions before HEAD are the side's, and neither sync nor the preview
    // reaches the page's own (older) version: sync keeps the page held and the preview does not promise the retry route.
    expect(await held(engine)).toEqual(['notes/a.md']);
    expect(String(listed!.detail)).not.toContain('an earlier version');
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] a hold the current screen wrote is screened against earlier versions after retry-held, and the preview says so first`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const original = await body(engine, 'notes/a');
    await unrecorded(engine, ['notes/a', 'notes/b']);
    edit(root, ['notes/a', 'notes/b'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    await performManagedSync(engine, OPTS);
    expect(await held(engine)).toEqual(['notes/a.md', 'notes/b.md']);
    // notes/a goes back to what its first commit held: only Git has moved for it since, and its hold is already written.
    await coordinated(engine, "UPDATE pages SET compiled_truth = $1, knowledge_revision = $2::uuid WHERE source_id='default' AND slug='notes/a'", [original, randomUUID()]);

    const preview = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', held: true, side: 'unknown' }));
    const listed = (slug: string) => preview.listing!.find(entry => entry.item === `default:${slug}`)!;
    expect(listed('notes/a').class).toBe('prefer_file');
    expect(String(listed('notes/a').detail)).toContain('an earlier version, so only the file moved since (Git is the parent): gbrain sources retry-held default re-screens it');
    expect(String(listed('notes/b').detail)).not.toContain('retry-held');
    expect(await held(engine)).toEqual(['notes/a.md', 'notes/b.md']);

    await retryHeld(engine, 'default');
    await performManagedSync(engine, OPTS);
    expect(await body(engine, 'notes/a')).toContain('A first Git edit of notes/a.');
    expect(await held(engine)).toEqual(['notes/b.md']);
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] a source rooted in a subdirectory of its checkout gets the same preview and retry route`, () => managedBrain(async ({ engine, root }) => {
    const pages = join(root, 'brain');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const original = await body(engine, 'notes/a');
    await unrecorded(engine, ['notes/a', 'notes/b']);
    edit(pages, ['notes/a', 'notes/b'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    await performManagedSync(engine, OPTS);
    expect(await held(engine)).toHaveLength(2);
    await coordinated(engine, "UPDATE pages SET compiled_truth = $1, knowledge_revision = $2::uuid WHERE source_id='default' AND slug='notes/a'", [original, randomUUID()]);

    const preview = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', held: true, side: 'unknown' }));
    const listed = (slug: string) => preview.listing!.find(entry => entry.item === `default:${slug}`)!;
    expect(String(listed('notes/a').detail)).toContain('an earlier version, so only the file moved since (Git is the parent): gbrain sources retry-held default re-screens it');
    expect(String(listed('notes/b').detail)).not.toContain('retry-held');

    await retryHeld(engine, 'default');
    await performManagedSync(engine, OPTS);
    expect(await body(engine, 'notes/a')).toContain('A first Git edit of notes/a.');
    expect(await held(engine)).toHaveLength(1);
  }, { databaseUrl, sourceDir: 'brain', setup: ({ root }) => {
    mkdirSync(join(root, 'brain', 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) writeFileSync(join(root, 'brain', `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  } }), 240_000);

  test(`[${backend}] a record-less page with an older import's stored keys and a schema-pack retype stamp still imports the Git edit when it equals an earlier version`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await unrecorded(engine);
    // An older import kept the reserved keys (tags sorted) in the stored frontmatter, the grandfather stamped validate: false, and
    // unify-types retyped the page in the database only: a new type, the old one kept as legacy_type, and a subtype.
    await coordinated(engine, `UPDATE pages SET type='note', frontmatter = COALESCE(frontmatter,'{}'::jsonb)
      || '{"type":"note","title":"notes/a","tags":["alpha","zeta"],"legacy_type":"concept","subtype":"idea","validate":false}'::jsonb
      WHERE source_id='default' AND slug='notes/a'`);
    edit(root, ['notes/a'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    edit(root, ['notes/a'], 'A second Git edit'); git(root, 'commit', '-qam', 'second edit');
    await coordinated(engine, "UPDATE sources SET last_commit='0123456789abcdef0123456789abcdef01234567' WHERE id='default'");
    await performManagedSync(engine, OPTS);
    expect(await held(engine)).toEqual([]);
    expect(await body(engine, 'notes/a')).toContain('A second Git edit of notes/a.');
    const [page] = await engine.executeRaw<{ type: string; legacy: string }>("SELECT type, frontmatter->>'legacy_type' AS legacy FROM pages WHERE source_id='default' AND slug='notes/a'");
    expect(page).toEqual({ type: 'note', legacy: 'concept' });
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] a drift check that cannot read the file keeps the refusal's message, not only its code`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    // A page stored database-only by a read-only mirror whose source is no longer one reads its file at the slug path.
    await coordinated(engine, "UPDATE pages SET source_path=NULL, database_only_reason='mirror_read_only' WHERE source_id='default' AND slug='notes/a'");
    writeFileSync(join(root, 'notes/a.md'), Buffer.concat([Buffer.from(note('notes/a', 'Bytes that are not ')), Buffer.from([0xff, 0xfe])]));
    const live = await liveFileDrift(engine, 'default', 'notes/a');
    expect(live).toMatchObject({ still_present: null, reason: 'invalid_params' });
    expect(live.message).toContain('valid UTF-8');
  }, { databaseUrl, setup }), 240_000);

  test(`[${backend}] on a read-only mirror the held preview names why it could not read a held file, not only the error code`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await unrecorded(engine, ['notes/a']);
    edit(root, ['notes/a'], 'A first Git edit'); git(root, 'commit', '-qam', 'first edit');
    await performManagedSync(engine, OPTS);
    expect(await held(engine)).toEqual(['notes/a.md']);
    await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
    writeFileSync(join(root, 'notes/a.md'), Buffer.concat([Buffer.from(note('notes/a', 'Bytes that are not ')), Buffer.from([0xff, 0xfe])]));
    const preview = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', held: true, side: 'unknown' }));
    const listed = preview.listing!.find(entry => entry.item === 'default:notes/a')!;
    expect(listed.class).toBe('unknown');
    expect(String(listed.detail)).toContain('invalid_params: The canonical file must contain valid UTF-8.');
  }, { databaseUrl, setup }), 240_000);
}

test('the doctor routes file-drift holds to the whole-set preview, on a writable source and on a read-only mirror', () => {
  for (const mirror of [false, true]) {
    const { text } = holdRepairSteps('source-a', { fences: 0, others: 0, drift: 1300, ...(mirror ? { mirror: true } : {}) });
    expect(text).toContain('gbrain repair file-drift --source source-a --held');
    expect(text).not.toContain('--state file_gone');
    expect(text).not.toContain('--slug <slug>');
    expect(text).toContain('gbrain sources retry-held source-a');
    expect(text).toContain('uncommitted');
  }
});
