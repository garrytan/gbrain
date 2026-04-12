/**
 * E2E Sync Tests — Tier 1 (no API keys required)
 *
 * Tests the full git-to-DB sync pipeline: create a git repo, commit
 * markdown files, run gbrain sync, verify pages appear in the database.
 * Covers first sync, incremental add/modify/delete, and the critical
 * "edit → sync → search returns corrected text" flow.
 *
 * Run: DATABASE_URL=... bun test test/e2e/sync.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import {
  hasDatabase, setupDB, teardownDB, getEngine,
} from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E sync tests (DATABASE_URL not set)');
}

/** Create a temp git repo with initial markdown files */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-sync-e2e-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  // Create initial structure
  mkdirSync(join(dir, 'people'), { recursive: true });
  mkdirSync(join(dir, 'concepts'), { recursive: true });

  writeFileSync(join(dir, 'people/alice.md'), [
    '---',
    'type: person',
    'title: Alice Smith',
    'tags: [engineer, frontend]',
    '---',
    '',
    'Alice is a frontend engineer at Acme Corp. She follows [[concepts/testing]].',
    '',
    '---',
    '',
    '- 2026-01-15: Joined Acme Corp',
  ].join('\n'));

  writeFileSync(join(dir, 'concepts/testing.md'), [
    '---',
    'type: concept',
    'title: Testing Philosophy',
    'tags: [engineering]',
    '---',
    '',
    'Every untested path is a path where bugs hide.',
  ].join('\n'));

  // Initial commit
  execSync('git add -A && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });

  return dir;
}

function gitCommit(repoPath: string, message: string) {
  execSync(`git add -A && git commit -m "${message}"`, { cwd: repoPath, stdio: 'pipe' });
}

describeE2E('E2E: Git-to-DB Sync Pipeline', () => {
  let repoPath: string;

  beforeAll(async () => {
    await setupDB();
    repoPath = createTestRepo();
  });

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('first sync imports all pages from git repo', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('first_sync');
    // performFullSync delegates to runImport which doesn't populate pagesAffected
    // Verify pages exist in DB directly instead
    const alice = await engine.getPage('people/alice');
    expect(alice).not.toBeNull();
    expect(alice!.title).toBe('Alice Smith');

    const testing = await engine.getPage('concepts/testing');
    expect(testing).not.toBeNull();
    expect(testing!.title).toBe('Testing Philosophy');

    const links = await engine.getLinks('people/alice');
    expect(links.some(l => l.to_slug === 'concepts/testing' && l.link_type === 'obsidian_link')).toBe(true);
  });

  test('second sync with no changes returns up_to_date', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('up_to_date');
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test('incremental sync picks up new files', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a new file
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---',
      'type: person',
      'title: Bob Jones',
      'tags: [designer]',
      '---',
      '',
      'Bob is a product designer who loves typography and works with [[people/alice|Alice]].',
    ].join('\n'));
    gitCommit(repoPath, 'add bob');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('people/bob');

    const bob = await engine.getPage('people/bob');
    expect(bob).not.toBeNull();
    expect(bob!.title).toBe('Bob Jones');
    expect(bob!.compiled_truth).toContain('typography');

    const links = await engine.getLinks('people/bob');
    expect(links.some(l => l.to_slug === 'people/alice' && l.context.includes('Alice'))).toBe(true);
  });

  test('incremental sync picks up modifications — corrected text appears', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Modify alice's page — this is the critical "correction" test
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice Smith',
      'tags: [engineer, frontend]',
      '---',
      '',
      'Alice is a staff frontend engineer at Acme Corp, leading the design system team.',
      '',
      '---',
      '',
      '- 2026-04-01: Promoted to staff engineer',
      '- 2026-01-15: Joined Acme Corp',
    ].join('\n'));
    gitCommit(repoPath, 'update alice - promotion');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.modified).toBe(1);
    expect(result.pagesAffected).toContain('people/alice');

    // THE CRITICAL CHECK: corrected text appears in the DB
    const alice = await engine.getPage('people/alice');
    expect(alice!.compiled_truth).toContain('staff frontend engineer');
    expect(alice!.compiled_truth).toContain('design system team');
    // Old text should be replaced, not appended
    expect(alice!.compiled_truth).not.toBe('Alice is a frontend engineer at Acme Corp.');
  });

  test('keyword search finds corrected text after sync', async () => {
    const engine = getEngine();

    // Search for the new text
    const results = await engine.searchKeyword('design system team');
    expect(results.length).toBeGreaterThanOrEqual(1);

    const aliceResult = results.find((r: any) => r.slug === 'people/alice');
    expect(aliceResult).toBeDefined();
  });

  test('incremental sync handles deletes', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Delete bob's page
    unlinkSync(join(repoPath, 'people/bob.md'));
    gitCommit(repoPath, 'remove bob');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.deleted).toBe(1);

    const bob = await engine.getPage('people/bob');
    expect(bob).toBeNull();
  });

  test('sync skips non-syncable files (README, hidden, .raw)', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add files that should be excluded
    writeFileSync(join(repoPath, 'README.md'), '# Brain Repo\nThis is the readme.');
    mkdirSync(join(repoPath, '.raw'), { recursive: true });
    writeFileSync(join(repoPath, '.raw/data.md'), '---\ntitle: Raw\n---\nRaw data.');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/deploy.md'), '---\ntitle: Deploy\n---\nOps stuff.');
    gitCommit(repoPath, 'add non-syncable files');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    // These should not create pages
    const readme = await engine.getPage('README');
    expect(readme).toBeNull();

    const raw = await engine.getPage('.raw/data');
    expect(raw).toBeNull();

    const ops = await engine.getPage('ops/deploy');
    expect(ops).toBeNull();
  });

  test('sync stores last_commit and last_run in config', async () => {
    const engine = getEngine();

    const lastCommit = await engine.getConfig('sync.last_commit');
    const lastRun = await engine.getConfig('sync.last_run');
    const repoPathConfig = await engine.getConfig('sync.repo_path');

    expect(lastCommit).toBeTruthy();
    expect(lastCommit!.length).toBe(40); // full SHA
    expect(lastRun).toBeTruthy();
    expect(repoPathConfig).toBe(repoPath);
  });

  test('sync logs to ingest_log', async () => {
    const engine = getEngine();

    const logs = await engine.getIngestLog();
    const syncLogs = logs.filter((l: any) => l.source_type === 'git_sync');

    expect(syncLogs.length).toBeGreaterThanOrEqual(1);
    expect(syncLogs[0].source_ref).toContain(repoPath);
  });

  test('--full reimports everything regardless of last_commit', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      full: true,
    });

    expect(result.status).toBe('first_sync');
    // performFullSync delegates to runImport — verify pages exist instead
    const alice = await engine.getPage('people/alice');
    expect(alice).not.toBeNull();
    const testing = await engine.getPage('concepts/testing');
    expect(testing).not.toBeNull();
  });

  test('dry-run shows changes without applying them', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a new file
    writeFileSync(join(repoPath, 'concepts/dry-run-test.md'), [
      '---',
      'type: concept',
      'title: Dry Run Test',
      '---',
      '',
      'This should not be imported.',
    ].join('\n'));
    gitCommit(repoPath, 'add dry run test');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      dryRun: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(1);

    // Page should NOT exist in DB
    const page = await engine.getPage('concepts/dry-run-test');
    expect(page).toBeNull();

    // Clean up: do a real sync so the commit is consumed
    await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
  });

  test('files with spaces in names get slugified slugs', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a file with spaces (Apple Notes style)
    mkdirSync(join(repoPath, 'Apple Notes'), { recursive: true });
    writeFileSync(join(repoPath, 'Apple Notes/2017-05-03 ohmygreen.md'), [
      '---',
      'title: Ohmygreen Notes',
      '---',
      '',
      'Notes about ohmygreen lunch service.',
    ].join('\n'));
    gitCommit(repoPath, 'add apple notes file with spaces');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);

    // Slug should be slugified (lowercase, spaces → hyphens)
    const page = await engine.getPage('apple-notes/2017-05-03-ohmygreen');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Ohmygreen Notes');

    // Original space-based slug should NOT exist
    const rawSlug = await engine.getPage('Apple Notes/2017-05-03 ohmygreen');
    expect(rawSlug).toBeNull();
  });

  test('incremental sync adds file with special characters', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a file with parens and special chars
    writeFileSync(join(repoPath, 'Apple Notes/meeting notes (draft).md'), [
      '---',
      'title: Draft Meeting Notes',
      '---',
      '',
      'Some draft notes from the meeting.',
    ].join('\n'));
    gitCommit(repoPath, 'add file with parens');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');

    // Slug should have parens stripped, spaces → hyphens
    const page = await engine.getPage('apple-notes/meeting-notes-draft');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Draft Meeting Notes');
  });
});
