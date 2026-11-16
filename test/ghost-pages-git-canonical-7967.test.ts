/**
 * #7967 item 2: retiring a code ghost on a git-canonical source (`sources.config.canonical = "git"`).
 *
 * A JSON file is committed and indexed as a code page, then removed from the worktree without a commit, so HEAD still
 * holds it. The ghost repair's soft delete must go through the door at the recorded file, not at `<slug>.md`: the
 * request commits, its Git effect settles (never parks), and HEAD drops the file in the same door commit, so Git and the
 * database agree. Before the fix the door committed a removal of `<slug>.md` (a path Git never held), HEAD kept the
 * recorded file and the worktree was left with an uncommitted deletion. Runs on PGLite and, with DATABASE_URL, Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { slugifyCodePath } from '../src/core/sync.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const logger = { info() {}, warn() {}, error() {} };
const CODE_PATH = 'projects/example/decisions.active.json';
const CODE_SLUG = slugifyCodePath(CODE_PATH);
const JSON_BYTES = '{"decision":"keep"}\n';
const repair = async (engine: BrainEngine, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run('ghost-pages', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect: opts.expect });
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'projects/example'), { recursive: true });
  writeFileSync(join(root, CODE_PATH), JSON_BYTES);
  durableGitRepo(root, [CODE_PATH]);
};

for (const backend of testBackends()) describe(`[${backend}] #7967 code ghost on a git-canonical source`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the retirement commits the recorded file\'s removal through the door and its Git effect settles', () => managedBrain(async ({ engine, root }) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await importCodeFile(engine, CODE_PATH, JSON_BYTES, { noEmbed: true, sourceId: 'default' });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    unlinkSync(join(root, CODE_PATH));
    expect(git(root, 'ls-tree', '--name-only', '-r', 'HEAD').trim()).toBe(CODE_PATH);

    const preview = await repair(engine);
    expect(preview.sample).toEqual([`default:${CODE_SLUG}`]);
    const applied = await repair(engine, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 1, failed: [], outcomes: { soft_deleted: 1 } });
    await settleManagedGitEffects(engine);

    const requests = await engine.executeRaw<{ state: string }>(
      "SELECT state FROM persistence_requests WHERE source_id='default' AND intent->>'kind'='managed_maintenance_retire_ghost_page'");
    expect(requests).toEqual([{ state: 'committed' }]);
    const effects = await engine.executeRaw<{ state: string; path: string }>(
      "SELECT state, data->>'relative_path' AS path FROM persistence_effects WHERE source_id='default' AND kind='git'");
    expect(effects).toEqual([{ state: 'committed', path: CODE_PATH }]);
    const [page] = await engine.executeRaw<{ live: boolean }>("SELECT deleted_at IS NULL AS live FROM pages WHERE source_id='default' AND slug=$1", [CODE_SLUG]);
    expect(page).toEqual({ live: false });
    expect(git(root, 'ls-tree', '--name-only', '-r', 'HEAD').trim()).toBe('');
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(join(root, `${CODE_SLUG}.md`))).toBe(false);
  }, { databaseUrl, setup }), 120_000);
});
