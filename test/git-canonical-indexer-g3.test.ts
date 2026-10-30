/**
 * G3 of git-canonical memory (docs/designs/GIT_CANONICAL_MEMORY.md): a strict source (`sources.config.canonical = "git"`)
 * indexes its commits alone, and Git wins. The managed sync pass of such a source:
 *   - imports the committed blob over a database version sync never saw (`db_ahead`), where a source that is not strict
 *     keeps the database version;
 *   - imports a commit over a page the database also moved (drift), where a source that is not strict holds `file_drift`;
 *   - imports the committed bytes of a file whose working tree holds an uncommitted edit, and leaves the edit on disk,
 *     where a source that is not strict holds `worktree_dirty`;
 *   - deletes a page whose file a commit removed while an untracked copy stays on disk, as a page imported from Git does;
 *   - refuses `--working-tree` with `managed_sync_flag_refused`.
 * `gbrain sources reindex --from-git` previews every database version that pass replaces and applies it under its hash;
 * doctor `git_index_lag` reports how far a strict source's index trails HEAD.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { previewReindex, runSourcesReindex } from '../src/commands/sources-reindex.ts';
import { gitIndexLagEntry } from '../src/commands/doctor/checks/git-index-lag.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUGS = ['notes/ahead', 'notes/drift', 'notes/dirty', 'notes/removed'];
const putPage = operations.find(op => op.name === 'put_page')!;

const holds = async (engine: BrainEngine) => (await engine.executeRaw<{ r: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => `${r.path} ${r.code}`);
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ body: string; deleted: boolean }>(
  "SELECT compiled_truth AS body, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0];
/** A database-only edit: the page moves to a revision no request and no import wrote. */
const databaseOnlyEdit = (engine: BrainEngine, slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  `UPDATE pages SET compiled_truth=$1, knowledge_revision=$2::uuid, revision_write_request_id=NULL WHERE source_id='default' AND slug=$3`, [body, randomUUID(), slug]), TEST_WRITE_ATTRIBUTION));
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);

/**
 * From a first sync: notes/ahead moves in the database only; notes/drift moves in the database and in a commit; notes/dirty
 * gets a commit and then an uncommitted edit on top; notes/removed leaves Git in a commit while its file stays on disk.
 */
async function diverge(engine: BrainEngine, root: string): Promise<void> {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
  await databaseOnlyEdit(engine, 'notes/drift', 'Written to the database alone.');
  writeFileSync(join(root, 'notes/drift.md'), note('notes/drift', 'The committed edit of notes/drift.'));
  writeFileSync(join(root, 'notes/dirty.md'), note('notes/dirty', 'The committed edit of notes/dirty.'));
  git(root, 'commit', '-qam', 'edit drift and dirty');
  git(root, 'rm', '-q', '--cached', 'notes/removed.md'); git(root, 'commit', '-qm', 'remove notes/removed from git');
  writeFileSync(join(root, 'notes/dirty.md'), note('notes/dirty', 'An uncommitted edit of notes/dirty.'));
}

for (const backend of testBackends()) describe(`[${backend}] G3: a strict source indexes its commits, and Git wins`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    // The door commits with the repository's own identity: CI runners have no global one.
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, '.gitignore'), '\n');
    for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('a source that is not strict keeps the database version and holds drift and the dirty file', () => managedBrain(async ({ engine, root }) => {
    await diverge(engine, root);
    await performManagedSync(engine, { ...OPTS, full: true });
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
    expect((await page(engine, 'notes/drift'))!.body).toContain('Written to the database alone.');
    expect(await holds(engine)).toEqual(expect.arrayContaining(['notes/drift.md file_drift', 'notes/dirty.md worktree_dirty']));
  }, { databaseUrl, setup }), 180_000);

  test('a strict source imports every committed blob over the database, deletes the removed page and holds nothing', () => managedBrain(async ({ engine, root }) => {
    await diverge(engine, root);
    await strict(engine);
    await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
    expect((await page(engine, 'notes/drift'))!.body).toContain('The committed edit of notes/drift.');
    expect((await page(engine, 'notes/dirty'))!.body).toContain('The committed edit of notes/dirty.');
    expect(readFileSync(join(root, 'notes/dirty.md'), 'utf8')).toContain('An uncommitted edit of notes/dirty.');
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(true);
    expect(await holds(engine)).toEqual([]);
    const again = await performManagedSync(engine, OPTS);
    expect(again.status).toBe('up_to_date');
    expect((await page(engine, 'notes/dirty'))!.body).toContain('The committed edit of notes/dirty.');
  }, { databaseUrl, setup }), 180_000);

  test('a strict source refuses --working-tree before anything runs', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await strict(engine);
    writeFileSync(join(root, 'notes/ahead.md'), note('notes/ahead', 'An uncommitted edit.'));
    await expect(performManagedSync(engine, { ...OPTS, workingTree: true })).rejects.toMatchObject({ code: 'managed_sync_flag_refused', detail: '--working-tree' });
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
  }, { databaseUrl, setup }), 180_000);

  test('sources reindex --from-git previews what Git replaces, refuses a stale hash, and its apply leaves nothing to replace', () => managedBrain(async ({ engine, root }) => {
    await diverge(engine, root);
    await expect(previewReindex(engine, 'default')).rejects.toMatchObject({ code: 'invalid_params' });
    await strict(engine);
    const preview = await previewReindex(engine, 'default');
    expect(preview.overwrites).toEqual(expect.arrayContaining([
      { path: 'notes/ahead.md', slug: 'notes/ahead', action: 'import', replaces: 'db_ahead' },
      { path: 'notes/drift.md', slug: 'notes/drift', action: 'import', replaces: 'drift' },
    ]));
    expect(preview.overwrites).toHaveLength(2);
    expect(preview).toMatchObject({ imports: 1, deletes: 1 });
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
    const log = console.log, priorExitCode = process.exitCode;
    try {
      console.log = () => {};
      await runSourcesReindex(engine, ['default', '--from-git', '--apply', '--expect', 'stale', '--no-embed', '--no-extract']);
      expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
      _resetCliExitVerdictForTests();
      await runSourcesReindex(engine, ['default', '--from-git', '--apply', '--expect', preview.preview_hash, '--no-embed', '--no-extract']);
    } finally { console.log = log; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
    expect((await page(engine, 'notes/removed'))!.deleted).toBe(true);
    expect((await previewReindex(engine, 'default')).overwrites).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('doctor git_index_lag reads strict sources only and warns when an unindexed commit is older than its bound', () => managedBrain(async ({ engine, root }) => {
    const ctx = { engine, progress: { heartbeat: () => {} } } as never;
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect(await gitIndexLagEntry.run(ctx)).toMatchObject([{ name: 'git_index_lag', status: 'ok', details: { sources: [] } }]);
    await strict(engine);
    expect(await gitIndexLagEntry.run(ctx)).toMatchObject([{ status: 'ok', details: { sources: [{ source_id: 'default', indexed: true, commits_behind: 0 }] } }]);
    writeFileSync(join(root, 'notes/ahead.md'), note('notes/ahead', 'An old commit sync has not read.'));
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'old edit'],
      { env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' }, stdio: 'ignore' });
    const [late] = await gitIndexLagEntry.run(ctx) as Array<{ status: string; details: any; fix?: { argv: string[] } }>;
    expect(late).toMatchObject({ status: 'warn', details: { sources: [{ source_id: 'default', commits_behind: 1 }] }, fix: { argv: ['gbrain', 'sync', '--source', 'default', '--no-pull'] } });
    expect(late!.details.sources[0].seconds_behind).toBeGreaterThan(900);
    await performManagedSync(engine, OPTS);
    expect(await gitIndexLagEntry.run(ctx)).toMatchObject([{ status: 'ok', details: { sources: [{ commits_behind: 0 }] } }]);
  }, { databaseUrl, setup }), 180_000);

  test('flipping canonical between two passes on the same HEAD reads the level again each way', () => managedBrain(async ({ engine }) => {
    __resetTreeReuseForTests();
    await engine.setConfig('sync.level_reuse', 'true');
    const listings: string[] = [];
    let pass = 0;
    installFaultHook((point, detail) => {
      if (point === 'sync:level_read' && detail.round === 1) listings.push(`${pass}:${(detail.level?.shadow as { treeReuse?: string } | undefined)?.treeReuse}`);
    });
    try {
    pass = 1; expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone.');
    pass = 2; await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone.');
    await strict(engine);
    pass = 3; await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
    await engine.executeRaw(`UPDATE sources SET config = config - 'canonical' WHERE id='default'`);
    await databaseOnlyEdit(engine, 'notes/ahead', 'Written to the database alone, again.');
    pass = 4; await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written to the database alone, again.');
    await strict(engine);
    pass = 5; await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('The committed body of notes/ahead.');
    pass = 6; await performManagedSync(engine, OPTS);
    } finally { installFaultHook(undefined); __resetTreeReuseForTests(); }
    // Every pass is at one HEAD, and passes 2 and 6 change nothing Git holds (they read no level): each pass after a flip
    // reads the listing whole instead of taking the one the last pass of that mode kept.
    expect(listings).toEqual(['1:read', '3:read', '4:read', '5:read']);
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('a sync pass that runs between a door commit and its replay leaves the replay to complete it, once', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await strict(engine);
    const before = await page(engine, 'notes/ahead');
    const [{ revision }] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE source_id='default' AND slug='notes/ahead'");
    const initial = git(root, 'log', '--format=%H', '--', 'notes/ahead.md');
    const requestId = randomUUID();
    let thrown = 0, crashedAt = '';
    let syncing: Promise<unknown> | undefined;
    installFaultHook(async (point, detail) => {
      if (detail.requestId !== requestId) return;
      if (point === 'publication:before_commit' && !thrown) { thrown++; crashedAt = git(root, 'rev-parse', 'HEAD'); throw Object.assign(new Error('database interruption'), { code: 'CONNECTION_CLOSED' }); }
      // The replay: PGLite claims it again (consumer:preparing); Postgres retries the group's publication (publication:prepared).
      if ((point === 'consumer:preparing' || point === 'publication:prepared') && thrown && !syncing) {
        // The pass starts while the door commit has landed and its row has not: it classifies the page in flight (its request is
        // open) or reads the level after the replay, and never imports over the replay.
        syncing = performManagedSync(engine, OPTS);
      }
    });
    try {
      const done = await putPage.handler(ctx, { slug: 'notes/ahead', content: note('notes/ahead', 'Written through the door.'), request_id: requestId, wait_ms: 30_000, expected_revision: revision }) as Record<string, any>;
      expect(done).toMatchObject({ state: 'committed' });
      await syncing;
    } finally { installFaultHook(undefined); }
    expect(thrown).toBe(1);
    expect(before!.body).toContain('The committed body of notes/ahead.');
    expect(git(root, 'show', `${crashedAt}:notes/ahead.md`)).toContain('Written through the door.');
    expect(git(root, 'log', '--format=%H', '--', 'notes/ahead.md').split('\n')).toEqual([crashedAt, initial]);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written through the door.');
    await performManagedSync(engine, OPTS);
    expect((await page(engine, 'notes/ahead'))!.body).toContain('Written through the door.');
    expect(git(root, 'status', '--porcelain', '--', 'notes/ahead.md')).toBe('');
    expect(await holds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 180_000);
});
