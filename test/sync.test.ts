import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { buildSyncManifest, isSyncable, pathToSlug } from '../src/core/sync.ts';
import { buildAutoEmbedArgs, buildGitInvocation } from '../src/commands/sync.ts';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

describe('buildSyncManifest', () => {
  test('parses A/M/D entries from single commit', () => {
    const output = `A\tpeople/new-person.md\nM\tpeople/existing-person.md\nD\tpeople/deleted-person.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/new-person.md']);
    expect(manifest.modified).toEqual(['people/existing-person.md']);
    expect(manifest.deleted).toEqual(['people/deleted-person.md']);
    expect(manifest.renamed).toEqual([]);
  });

  test('parses R100 rename entries', () => {
    const output = `R100\tpeople/old-name.md\tpeople/new-name.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old-name.md', to: 'people/new-name.md' }]);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
  });

  test('parses partial rename (R075)', () => {
    const output = `R075\tpeople/old.md\tpeople/new.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old.md', to: 'people/new.md' }]);
  });

  test('handles empty diff', () => {
    const manifest = buildSyncManifest('');
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });

  test('handles mixed entries with blank lines', () => {
    const output = `A\tpeople/a.md\n\nM\tpeople/b.md\n\nD\tpeople/c.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
    expect(manifest.deleted).toEqual(['people/c.md']);
  });

  test('skips malformed lines', () => {
    const output = `A\tpeople/a.md\ngarbage line\nM\tpeople/b.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
  });
});

describe('isSyncable', () => {
  test('accepts normal .md files', () => {
    expect(isSyncable('people/pedro-franceschi.md')).toBe(true);
    expect(isSyncable('meetings/2026-04-03-lunch.md')).toBe(true);
    expect(isSyncable('daily/2026-04-05.md')).toBe(true);
    expect(isSyncable('notes.md')).toBe(true);
  });

  test('accepts .mdx files', () => {
    expect(isSyncable('components/hero.mdx')).toBe(true);
    expect(isSyncable('docs/getting-started.mdx')).toBe(true);
  });

  test('rejects non-.md/.mdx files', () => {
    expect(isSyncable('people/photo.jpg')).toBe(false);
    expect(isSyncable('config.json')).toBe(false);
    expect(isSyncable('src/cli.ts')).toBe(false);
  });

  test('rejects files in hidden directories', () => {
    expect(isSyncable('.git/config')).toBe(false);
    expect(isSyncable('.obsidian/plugins.md')).toBe(false);
    expect(isSyncable('people/.hidden/secret.md')).toBe(false);
  });

  test('rejects .raw/ sidecar directories', () => {
    expect(isSyncable('people/pedro.raw/source.md')).toBe(false);
    expect(isSyncable('dir/.raw/notes.md')).toBe(false);
  });

  test('rejects skip-list basenames', () => {
    expect(isSyncable('schema.md')).toBe(false);
    expect(isSyncable('index.md')).toBe(false);
    expect(isSyncable('log.md')).toBe(false);
    expect(isSyncable('README.md')).toBe(false);
    expect(isSyncable('people/README.md')).toBe(false);
  });

  test('rejects ops/ directory', () => {
    expect(isSyncable('ops/deploy-log.md')).toBe(false);
    expect(isSyncable('ops/config.md')).toBe(false);
  });
});

describe('pathToSlug', () => {
  test('strips .md extension and lowercases', () => {
    expect(pathToSlug('people/pedro-franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('normalizes to lowercase', () => {
    expect(pathToSlug('People/Pedro-Franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('strips leading slash', () => {
    expect(pathToSlug('/people/pedro.md')).toBe('people/pedro');
  });

  test('normalizes backslash separators', () => {
    expect(pathToSlug('people\\pedro.md')).toBe('people/pedro');
  });

  test('handles flat files', () => {
    expect(pathToSlug('notes.md')).toBe('notes');
  });

  test('handles nested paths', () => {
    expect(pathToSlug('projects/gbrain/spec.md')).toBe('projects/gbrain/spec');
  });

  test('adds repo prefix when provided', () => {
    expect(pathToSlug('people/pedro.md', 'brain')).toBe('brain/people/pedro');
  });

  test('no prefix when not provided', () => {
    expect(pathToSlug('people/pedro.md')).toBe('people/pedro');
  });

  test('handles empty string', () => {
    expect(pathToSlug('')).toBe('');
  });

  test('handles file with only extension', () => {
    expect(pathToSlug('.md')).toBe('');
  });

  test('slugifies spaces to hyphens', () => {
    expect(pathToSlug('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
  });

  test('strips special characters', () => {
    expect(pathToSlug('notes/meeting (march 2024).md')).toBe('notes/meeting-march-2024');
  });
});

describe('isSyncable edge cases', () => {
  test('rejects uppercase .MD extension', () => {
    // isSyncable checks path.endsWith('.md'), so .MD should fail
    expect(isSyncable('people/someone.MD')).toBe(false);
  });

  test('rejects files with no extension', () => {
    expect(isSyncable('README')).toBe(false);
  });

  test('accepts deeply nested .md files', () => {
    expect(isSyncable('a/b/c/d/e/f/deep.md')).toBe(true);
  });

  test('rejects .md files inside nested hidden dirs', () => {
    expect(isSyncable('docs/.internal/secret.md')).toBe(false);
  });
});

describe('buildSyncManifest edge cases', () => {
  test('handles tab-separated fields correctly', () => {
    const output = "A\tpath/to/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['path/to/file.md']);
  });

  test('handles multiple renames', () => {
    const output = [
      'R100\told/a.md\tnew/a.md',
      'R095\told/b.md\tnew/b.md',
    ].join('\n');
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toHaveLength(2);
    expect(manifest.renamed[0].from).toBe('old/a.md');
    expect(manifest.renamed[1].from).toBe('old/b.md');
  });

  test('ignores unknown status codes', () => {
    const output = "X\tunknown/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// performSync dry-run (v0.17 regression guard for full-sync silent writes)
// ────────────────────────────────────────────────────────────────

describe('performSync dry-run never writes', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  // One PGLite per file — beforeEach wipes data only. Each test still gets a
  // fresh git repo via mkdtempSync, but skips the ~20s PGLite cold-start.
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-dryrun-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      '---',
      '',
      'Alice is a person.',
    ].join('\n'));
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---',
      'type: person',
      'title: Bob',
      '---',
      '',
      'Bob is another person.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('first-sync dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    // Status + counts reflect what WOULD be imported.
    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob, both syncable
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // DB is clean: no pages written.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark NOT set — this is the regression the guard enforces.
    expect(await engine.getConfig('sync.last_commit')).toBeNull();
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
  });

  test('incremental dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // First do a real sync to seed the bookmark.
    const real = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(real.status).toBe('first_sync');
    const bookmarkAfterReal = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterReal).not.toBeNull();

    // Add a third file.
    writeFileSync(join(repoPath, 'people/carol.md'), [
      '---',
      'type: person',
      'title: Carol',
      '---',
      '',
      'Carol joins the cast.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add carol"', { cwd: repoPath, stdio: 'pipe' });

    // Incremental sync in dry-run mode.
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(1); // carol only
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // carol is NOT in the DB.
    expect(await engine.getPage('people/carol')).toBeNull();
    // alice + bob still present from the real sync.
    expect(await engine.getPage('people/alice')).not.toBeNull();
    expect(await engine.getPage('people/bob')).not.toBeNull();

    // Bookmark unchanged — still at the pre-carol commit.
    const bookmarkAfterDry = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterDry).toBe(bookmarkAfterReal);
  });

  test('full-sync (--full) dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Seed the bookmark so we hit the full-sync-with-bookmark path when --full is set.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // Clear DB so we can observe that a --full dry-run doesn't re-import.
    await (engine as any).db.exec(`DELETE FROM content_chunks; DELETE FROM pages;`);
    const bookmarkBefore = await engine.getConfig('sync.last_commit');
    expect(bookmarkBefore).not.toBeNull();

    const result = await performSync(engine, {
      repoPath,
      full: true,        // force full-sync path
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob would be imported
    expect(result.chunksCreated).toBe(0);

    // DB empty — full-sync dry-run did not reimport.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark unchanged.
    const bookmarkAfter = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfter).toBe(bookmarkBefore);
  });

  test('SyncResult exposes embedded count field', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });
    // Structural assertion: the contract includes `embedded: number`.
    expect(typeof result.embedded).toBe('number');
  });

  test('detached HEAD skips git pull and ingests local working-tree files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-local.md'), [
      '---',
      'type: person',
      'title: Detached Local',
      '---',
      '',
      'This file exists only in the detached working tree.',
    ].join('\n'));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    try {
      const result = await performSync(engine, {
        repoPath,
        noEmbed: true,
        noExtract: true,
      });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(1);
      expect(result.pagesAffected).toContain('people/detached-local');
    } finally {
      console.error = originalError;
    }

    expect(errors.join('\n')).toContain(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
    expect(errors.join('\n')).not.toContain('git pull failed');

    const page = await engine.getPage('people/detached-local');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Detached Local');
  });

  test('detached HEAD with --no-pull also ingests local working-tree files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-nopull.md'), [
      '---',
      'type: person',
      'title: Detached NoPull',
      '---',
      '',
      'Only in detached working tree, --no-pull caller.',
    ].join('\n'));

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('people/detached-nopull');

    const page = await engine.getPage('people/detached-nopull');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Detached NoPull');
  });
});

describe('sync regression — #132 nested transaction deadlock', () => {
  test('src/commands/sync.ts does not wrap the add/modify loop in engine.transaction()', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    // Accept either of the historical loop shapes: the original inline
    // `for (const path of [...filtered.added, ...filtered.modified])` or
    // the v0.15.2 progress-wrapped variant where the list is hoisted into
    // a local `addsAndMods` variable first.
    const inlineIdx = source.indexOf('for (const path of [...filtered.added, ...filtered.modified]');
    const hoistedIdx = source.indexOf('const addsAndMods = [...filtered.added, ...filtered.modified]');
    const loopStart = inlineIdx !== -1 ? inlineIdx : hoistedIdx;
    expect(loopStart).toBeGreaterThan(-1);
    const prelude = source.slice(0, loopStart);
    const lastTxIdx = prelude.lastIndexOf('engine.transaction');
    if (lastTxIdx !== -1) {
      const lineStart = prelude.lastIndexOf('\n', lastTxIdx) + 1;
      const line = prelude.slice(lineStart, prelude.indexOf('\n', lastTxIdx));
      expect(line.trim().startsWith('//')).toBe(true);
    }
  });
});

describe('resolveSlugByPathOrSourcePath (CJK wave v0.32.7, codex F4)', () => {
  let pgEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = new PGLiteEngine();
    await pgEngine.connect({});
    await pgEngine.initSchema();
  });

  afterAll(async () => {
    await pgEngine.disconnect();
  });

  beforeEach(async () => {
    await (pgEngine as any).db.exec('DELETE FROM content_chunks');
    await (pgEngine as any).db.exec('DELETE FROM pages');
  });

  test('returns stored slug when source_path matches a row', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Seed a frontmatter-fallback page: slug doesn't derive from path (emoji)
    await pgEngine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('projects/launch', 'project', 'Launch', 'body', 'markdown', '🚀.md')`,
    );
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md');
    expect(slug).toBe('projects/launch');
  });

  test('falls back to resolveSlugForPath when no source_path matches', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // No row seeded — fallback returns the path-derived slug.
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, 'concepts/hello-world.md');
    expect(slug).toBe('concepts/hello-world');
  });

  test('scoped by source_id when provided', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Same source_path under TWO sources — without source_id scope we'd
    // get either at random. With source_id we get the right one.
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-a', 'A') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-b', 'B') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-a', 'slug-a/page', 'note', 'A', 'a', 'markdown', '🚀.md')`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-b', 'slug-b/page', 'note', 'B', 'b', 'markdown', '🚀.md')`,
    );
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-a')).toBe('slug-a/page');
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-b')).toBe('slug-b/page');
  });
});

describe('git() helper invocation order (CJK wave v0.32.7)', () => {
  // The git CLI requires `-c key=val` to appear BEFORE the subcommand,
  // and `-C path` BEFORE the subcommand too. Pin the emit order so a future
  // refactor can't silently put `-c` after the subcommand and break CJK
  // path emission.

  test('core.quotepath=false is always emitted first', () => {
    const argv = buildGitInvocation('/repo', ['diff', '--name-status']);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-C', '/repo',
      'diff', '--name-status',
    ]);
  });

  test('extra configs append AFTER quotepath, BEFORE -C and subcommand', () => {
    const argv = buildGitInvocation('/repo', ['diff'], ['foo=bar', 'baz=qux']);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-c', 'foo=bar',
      '-c', 'baz=qux',
      '-C', '/repo',
      'diff',
    ]);
  });

  test('empty args produces a valid invocation', () => {
    const argv = buildGitInvocation('/repo', []);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-C', '/repo',
    ]);
  });
});

describe('sync auto-embed arguments', () => {
  test('scopes incremental source sync embedding to the same source', () => {
    expect(buildAutoEmbedArgs(['hello-js'], 'source-a')).toEqual([
      '--source',
      'source-a',
      '--slugs',
      'hello-js',
    ]);
  });

  test('keeps default-source sync embed arguments unchanged', () => {
    expect(buildAutoEmbedArgs(['people/alice'])).toEqual(['--slugs', 'people/alice']);
  });
});
