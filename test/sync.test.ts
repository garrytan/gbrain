import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { buildSyncManifest, isSyncable, pathToSlug } from '../src/core/sync.ts';
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

  test('full sync writes pages under the requested source, not default', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['source-sync', 'source-sync', repoPath],
    );

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      sourceId: 'source-sync',
    });

    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/alice', { sourceId: 'source-sync' })).not.toBeNull();
    expect(await engine.getPage('people/bob', { sourceId: 'source-sync' })).not.toBeNull();
    expect(await engine.getPage('people/alice')).toBeNull();

    const rows = await engine.executeRaw<{ source_id: string; n: number }>(
      `SELECT source_id, COUNT(*)::int AS n
         FROM pages
        WHERE slug IN ('people/alice', 'people/bob')
        GROUP BY source_id
        ORDER BY source_id`,
    );
    expect(rows).toEqual([{ source_id: 'source-sync', n: 2 }]);
  });

  test('empty-string source id is still an explicit source scope', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['', 'empty-source', repoPath],
    );

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      sourceId: '',
    });

    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/alice', { sourceId: '' })).not.toBeNull();
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getConfig('sync.last_commit')).toBeNull();
    const rows = await engine.executeRaw<{ last_commit: string | null; chunker_version: string | null }>(
      `SELECT last_commit, chunker_version FROM sources WHERE id = $1`,
      [''],
    );
    expect(rows[0].last_commit).toBeTruthy();
    expect(rows[0].chunker_version).toBeTruthy();
  });

  test('runImport threads sourceId into imported pages, chunks, tags, and versions', async () => {
    const { runImport } = await import('../src/commands/import.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['source-import', 'source-import', repoPath],
    );
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      'tags: [original]',
      '---',
      '',
      'Alice is a person.',
    ].join('\n'));

    const first = await runImport(engine, [repoPath, '--no-embed'], { sourceId: 'source-import' });
    expect(first.imported).toBe(2);
    expect(await engine.getPage('people/alice', { sourceId: 'source-import' })).not.toBeNull();
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getChunks('people/alice', { sourceId: 'source-import' })).toHaveLength(1);
    expect(await engine.getTags('people/alice', { sourceId: 'source-import' })).toEqual(['original']);

    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice Updated',
      'tags: [updated]',
      '---',
      '',
      'Alice is a person with updated notes.',
    ].join('\n'));

    const second = await runImport(engine, [repoPath, '--no-embed'], { sourceId: 'source-import' });
    expect(second.imported).toBe(1);
    expect(await engine.getTags('people/alice', { sourceId: 'source-import' })).toEqual(['updated']);
    const versions = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
        WHERE p.slug = 'people/alice'
          AND p.source_id = 'source-import'`,
    );
    expect(versions[0].n).toBe(1);
  });

  test('version history and revert are scoped by source id', async () => {
    const { importFromContent } = await import('../src/core/import-file.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['version-source', 'version-source', repoPath],
    );

    await importFromContent(engine, 'people/shared', [
      '---',
      'type: person',
      'title: Default Shared',
      '---',
      '',
      'Default source body.',
    ].join('\n'), { noEmbed: true });
    await importFromContent(engine, 'people/shared', [
      '---',
      'type: person',
      'title: Named Shared',
      '---',
      '',
      'Named source first body.',
    ].join('\n'), { noEmbed: true, sourceId: 'version-source' });
    await importFromContent(engine, 'people/shared', [
      '---',
      'type: person',
      'title: Named Shared Updated',
      '---',
      '',
      'Named source updated body.',
    ].join('\n'), { noEmbed: true, sourceId: 'version-source' });

    const defaultVersions = await engine.getVersions('people/shared');
    const namedVersions = await engine.getVersions('people/shared', { sourceId: 'version-source' });
    expect(defaultVersions).toHaveLength(0);
    expect(namedVersions).toHaveLength(1);

    await engine.revertToVersion('people/shared', namedVersions[0].id, { sourceId: 'version-source' });
    expect((await engine.getPage('people/shared'))?.title).toBe('Default Shared');
    expect((await engine.getPage('people/shared', { sourceId: 'version-source' }))?.compiled_truth).toBe('Named source first body.');
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
