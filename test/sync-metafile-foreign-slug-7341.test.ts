/**
 * #7341: since GBRA-150 a managed sync imports a typed nested scaffolding file (`index.md`, `README.md`, …) as a page.
 * One whose frontmatter `slug:` names another page (typically its folder: `slug: dir/x` in `dir/x/index.md`) could
 * only be held `frontmatter_slug_conflict` (it may name the folder, or just its leaf: `slug: x`), so a folder of generated hub pages turned into hundreds of holds after the
 * upgrade. Such a file stays scaffolding, as it was before GBRA-150:
 *   - it is not imported and not held, and the source converges;
 *   - a hold an earlier version wrote for it is released by the next sync;
 *   - a typed index whose `slug:` is its own path slug, and one with no `slug:`, still import as pages.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const hub = (name: string, slug: string | null) => `---\ntype: project\ntitle: ${name}\n${slug === null ? '' : `slug: ${slug}\n`}---\n\nThe project hub of ${name}.\n`;
const FILES: Record<string, string> = {
  'projects/acme-example/index.md': hub('acme-example', 'projects/acme-example'),
  'projects/beta-example/index.md': hub('beta-example', '"projects/beta-example"'),
  'projects/gamma-example/index.md': hub('gamma-example', 'projects/gamma-example/index'),
  'projects/delta-example/index.md': hub('delta-example', null),
  'projects/epsilon-example/index.md': hub('epsilon-example', 'epsilon-example'),
  'notes/a.md': '---\ntitle: A\n---\nA synthetic observation.\n',
};
const holdCodes = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ record: { path: string; code: string } }>(
  "SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'")).map(({ record }) => [record.path, record.code]));
const slugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

for (const backend of testBackends()) describe(`[${backend}] #7341: a scaffolding file whose slug: names another page stays scaffolding`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    git(root, 'init', '-q');
    for (const [path, content] of Object.entries(FILES)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'hubs');
  };

  test('not imported, not held, converges; an earlier hold is released; own-slug and slug-less hubs import', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect(await holdCodes(engine)).toEqual({});
    expect(await slugs(engine)).toEqual(['notes/a', 'projects/delta-example/index', 'projects/gamma-example/index']);
    expect((await shadowConvergence(engine, { sourceId: 'default' }))!.counts).toEqual({ matched: 3 });

    // A hold an earlier version wrote for the folder-slug hub is released by the next sync.
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: 'projects/acme-example/index.md',
      source_path: 'projects/acme-example/index.md', slug: 'projects/acme-example/index', page_id: null, code: 'frontmatter_slug_conflict',
      message: 'The frontmatter slug of projects/acme-example/index.md does not match its path-derived slug.', upstream_version: null,
      observed_at: new Date(Date.now() - 60_000).toISOString(), run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, key: 'slug' } }));
    await performManagedSync(engine, OPTS);
    expect(await holdCodes(engine)).toEqual({});
    expect(await slugs(engine)).toEqual(['notes/a', 'projects/delta-example/index', 'projects/gamma-example/index']);
  }, { databaseUrl, setup }), 300_000);
});
