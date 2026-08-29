/**
 * #4342 — explicit + sticky slug namespacing (slug_root_mode).
 *
 * A source whose local_path is a SUBDIRECTORY of a bigger git repo used to
 * get git-root-PREFIXED slugs implicitly (`notes/foo` instead of `foo`),
 * diverging from `gbrain import <dir>` naming. The mode is now decided once
 * and pinned per source:
 *
 *   1. fresh subdir source (no --src-subpath, no prefixed pages) →
 *      'source-root': slugs are local_path-relative, on BOTH full and
 *      incremental syncs; the pin is persisted.
 *   2. live install whose pages already carry the git-root prefix →
 *      auto-pins 'git-root' (no re-slug of existing brains).
 *   3. explicit --src-subpath → 'git-root' (the #774 contract).
 *   4. a stored pin wins over everything (sticky).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import {
  readSlugRootMode,
  writeSlugRootMode,
  resolveSlugRootMode,
} from '../src/core/sync-anchor.ts';

let engine: PGLiteEngine;
let repoRoot: string;
let subdir: string;

function git(cmd: string) {
  execSync(cmd, { cwd: repoRoot, stdio: 'pipe' });
}

function mdFile(rel: string, title: string) {
  writeFileSync(join(repoRoot, rel), `---\ntype: concept\ntitle: ${title}\n---\n\nBody of ${title}.\n`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  repoRoot = mkdtempSync(join(tmpdir(), 'gbrain-4342-'));
  subdir = join(repoRoot, 'notes');
  git('git init');
  git('git config user.email "t@t.com"');
  git('git config user.name "T"');
  mkdirSync(subdir, { recursive: true });
  mdFile('notes/alpha.md', 'Alpha');
  mdFile('outside.md', 'Outside');
  git('git add -A && git commit -m seed');
});

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

async function slugsIn(sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`,
    [sourceId],
  );
  return rows.map(r => r.slug);
}

describe('#4342 slug_root_mode', () => {
  test('fresh subdir source pins source-root: local_path-relative slugs, full + incremental', async () => {
    await runSources(engine, ['add', 'vault-sub', '--path', subdir, '--no-federated']);

    const first = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-sub', noEmbed: true, noPull: true,
    });
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(await slugsIn('vault-sub')).toEqual(['alpha']);
    expect(await readSlugRootMode(engine, 'vault-sub')).toBe('source-root');

    // Incremental add lands local_path-relative too.
    mdFile('notes/beta.md', 'Beta');
    git('git add -A && git commit -m add-beta');
    const second = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-sub', noEmbed: true, noPull: true,
    });
    expect(second.status).toBe('synced');
    expect(await slugsIn('vault-sub')).toEqual(['alpha', 'beta']);

    const third = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-sub', noEmbed: true, noPull: true,
    });
    expect(third.status).toBe('up_to_date');

    // Incremental delete resolves in the same namespace.
    rmSync(join(repoRoot, 'notes/beta.md'));
    git('git add -A && git commit -m del-beta');
    const fourth = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-sub', noEmbed: true, noPull: true,
    });
    expect(fourth.status).toBe('synced');
    expect(await slugsIn('vault-sub')).toEqual(['alpha']);
  }, 120_000);

  test('live install with git-root-prefixed pages auto-pins git-root (no re-slug)', async () => {
    await runSources(engine, ['add', 'vault-legacy', '--path', subdir, '--no-federated']);
    // Simulate a pre-#4342 install: a page already carries the git-root prefix.
    await engine.putPage('notes/legacy-note', {
      type: 'concept' as never,
      title: 'Legacy Note',
      compiled_truth: 'Imported before #4342 under the git-root namespace.',
    }, { sourceId: 'vault-legacy' });

    const r = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-legacy', noEmbed: true, noPull: true,
    });
    expect(['first_sync', 'synced']).toContain(r.status);
    expect(await readSlugRootMode(engine, 'vault-legacy')).toBe('git-root');
    // alpha imported under the PREFIXED namespace, matching the live install.
    expect(await slugsIn('vault-legacy')).toContain('notes/alpha');
    expect(await slugsIn('vault-legacy')).not.toContain('alpha');
  }, 120_000);

  test('explicit --src-subpath pins git-root (the #774 contract)', async () => {
    const r = await performSync(engine, {
      repoPath: repoRoot, srcSubpath: 'notes', sourceId: 'default', noEmbed: true, noPull: true,
    });
    expect(['first_sync', 'synced']).toContain(r.status);
    expect(await readSlugRootMode(engine, 'default')).toBe('git-root');
    expect(await slugsIn('default')).toContain('notes/alpha');
  }, 120_000);

  test('a stored pin is sticky — wins over the explicit flag and the heuristic', async () => {
    await runSources(engine, ['add', 'vault-pin', '--path', subdir, '--no-federated']);
    await writeSlugRootMode(engine, 'vault-pin', 'source-root');
    const mode = await resolveSlugRootMode(engine, {
      sourceId: 'vault-pin',
      explicitGitRoot: true, // would say git-root — the pin must win
      slugPrefix: 'notes',
    });
    expect(mode).toBe('source-root');
    expect(await readSlugRootMode(engine, 'vault-pin')).toBe('source-root');
  });

  test('helpers: config-table storage for the legacy no-source path', async () => {
    expect(await readSlugRootMode(engine, undefined)).toBeNull();
    await writeSlugRootMode(engine, undefined, 'git-root');
    expect(await readSlugRootMode(engine, undefined)).toBe('git-root');
  });

  test('--dry-run never persists the sticky pin (review fix: a preview must not mutate config)', async () => {
    await runSources(engine, ['add', 'vault-dry', '--path', subdir, '--no-federated']);

    // resolver-level: dryRun resolves the mode in-memory only.
    const mode = await resolveSlugRootMode(engine, {
      sourceId: 'vault-dry',
      explicitGitRoot: false,
      slugPrefix: 'notes',
      dryRun: true,
    });
    expect(mode).toBe('source-root');
    expect(await readSlugRootMode(engine, 'vault-dry')).toBeNull();

    // end-to-end: a full `sync --dry-run` on a fresh scoped source leaves the
    // pin unset — pre-fix it persisted slug_root_mode before the dry-run
    // early-returned.
    await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-dry', noEmbed: true, noPull: true, dryRun: true,
    });
    expect(await readSlugRootMode(engine, 'vault-dry')).toBeNull();

    // The first REAL sync still pins it.
    await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-dry', noEmbed: true, noPull: true,
    });
    expect(await readSlugRootMode(engine, 'vault-dry')).toBe('source-root');
  }, 120_000);
});

// ─── #4521 — a string-scalar sources.config must not abort the sync ───────
//
// Historical writers could leave sources.config as a jsonb STRING scalar
// (double-encoded object). v0.46.28.0's writeSlugRootMode ran jsonb_set
// directly on it → 'cannot set path in scalar' → every subdir-scoped sync
// exited 1 right after sync.discover_git_root. The write now heals the
// column through the canonical SOURCE_CONFIG_OBJECT_SQL coercion first.
describe('#4521 scalar sources.config heal-on-write', () => {
  test('writeSlugRootMode heals a string-scalar config and pins the mode', async () => {
    await runSources(engine, ['add', 'vault-scalar', '--path', subdir, '--no-federated']);
    // Simulate the historical corruption: a double-encoded object scalar.
    await engine.executeRaw(
      `UPDATE sources SET config = to_jsonb($2::text) WHERE id = $1`,
      ['vault-scalar', JSON.stringify({ federated: false })],
    );
    await writeSlugRootMode(engine, 'vault-scalar', 'source-root');
    expect(await readSlugRootMode(engine, 'vault-scalar')).toBe('source-root');
    // The heal is a RECOVERY, not a wipe: keys inside the double-encoded
    // object survive, and the column is an object again.
    const rows = await engine.executeRaw<{ federated: string | null; t: string }>(
      `SELECT config->>'federated' AS federated, jsonb_typeof(config) AS t
         FROM sources WHERE id = $1`,
      ['vault-scalar'],
    );
    expect(rows[0]?.t).toBe('object');
    expect(rows[0]?.federated).toBe('false');
  });

  test('a subdir-scoped sync over a scalar config completes instead of aborting', async () => {
    await runSources(engine, ['add', 'vault-scalar-sync', '--path', subdir, '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET config = to_jsonb($2::text) WHERE id = $1`,
      ['vault-scalar-sync', '"not-an-object"'],
    );
    const res = await performSync(engine, {
      repoPath: subdir, sourceId: 'vault-scalar-sync', noEmbed: true, noPull: true,
    });
    expect(['first_sync', 'synced']).toContain(res.status);
    expect(await readSlugRootMode(engine, 'vault-scalar-sync')).toBe('source-root');
  }, 120_000);

  test('a failed pin write names the source in the error', async () => {
    const fake = {
      executeRaw: async () => { throw new Error('cannot set path in scalar'); },
    } as unknown as PGLiteEngine;
    await expect(writeSlugRootMode(fake, 'vault-broken', 'git-root'))
      .rejects.toThrow(/vault-broken/);
  });
});
