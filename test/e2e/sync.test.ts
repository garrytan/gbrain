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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir, homedir } from 'os';
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
    'Alice is a frontend engineer at Acme Corp.',
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
      'Bob is a product designer who loves typography.',
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

/**
 * E2E: --skip-failed loop with structured error code summary.
 *
 * Closes the v0.22.12 ship-blocker gap from issue #500 — the whole code path
 * (record → classify → block → skip → doctor render → second cycle) had only
 * mocked-JSONL unit coverage. This is the integration test that proves the
 * chain holds together with a real Postgres engine, real git history, and
 * real frontmatter validation.
 *
 * Owns its own repo + sync-failures.jsonl lifecycle so it can't leak state
 * into the shared describeE2E above. Saves and restores the user's real
 * ~/.gbrain/sync-failures.jsonl so running E2E on a developer machine
 * doesn't trash their local sync state.
 */
describeE2E('E2E: sync --skip-failed structured summary loop (v0.22.12, issue #500)', () => {
  let repoPath: string;
  const realFailuresPath = join(homedir(), '.gbrain', 'sync-failures.jsonl');
  let savedFailuresContent: string | null = null;

  beforeAll(async () => {
    await setupDB();

    // Save+clear the real ~/.gbrain/sync-failures.jsonl so the test starts from
    // a known-empty state. Restored in afterAll. This file is per-machine, NOT
    // per-repo, so we have to be defensive about a developer running this
    // suite on their actual brain machine.
    if (existsSync(realFailuresPath)) {
      savedFailuresContent = readFileSync(realFailuresPath, 'utf-8');
      unlinkSync(realFailuresPath);
    }

    // Fresh git repo with one valid file. Mirrors createTestRepo above but
    // scoped to this describe block.
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-skipfailed-e2e-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---', 'type: person', 'title: Alice', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });

    // Restore the user's real sync-failures.jsonl, if any.
    if (savedFailuresContent !== null) {
      mkdirSync(join(homedir(), '.gbrain'), { recursive: true });
      writeFileSync(realFailuresPath, savedFailuresContent);
    } else if (existsSync(realFailuresPath)) {
      // Test wrote one but there was none before. Clean up.
      unlinkSync(realFailuresPath);
    }
  });

  test('full --skip-failed loop: blocks on bad file, skip advances bookmark, doctor shows code breakdown', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const { loadSyncFailures, summarizeFailuresByCode } = await import('../../src/core/sync.ts');
    const engine = getEngine();

    // Step 1: First sync of the clean repo — should succeed.
    let result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('first_sync');
    const firstCommit = await engine.getConfig('sync.last_commit');
    expect(firstCommit).toBeTruthy();

    // Step 2: Add a broken file — frontmatter slug doesn't match path-derived slug.
    // The file path is people/bob.md so the path-derived slug is "people/bob",
    // but we declare slug: "wrong-slug" in frontmatter. import-file.ts:368-377
    // raises "Frontmatter slug ... does not match path-derived slug ..." which
    // classifier hits as SLUG_MISMATCH.
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---', 'type: person', 'title: Bob', 'slug: wrong-slug', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add broken bob"', { cwd: repoPath, stdio: 'pipe' });

    // Step 3: Sync should block. Bookmark must NOT advance.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('blocked_by_failures');
    const afterBlockedCommit = await engine.getConfig('sync.last_commit');
    expect(afterBlockedCommit).toBe(firstCommit); // bookmark stuck at the pre-broken commit

    // JSONL has one unacked entry with code SLUG_MISMATCH.
    let failures = loadSyncFailures();
    expect(failures.length).toBe(1);
    expect(failures[0].code).toBe('SLUG_MISMATCH');
    expect(failures[0].acknowledged).toBeFalsy();
    // Group summary aggregates correctly across the unacked set.
    expect(summarizeFailuresByCode(failures)).toEqual([{ code: 'SLUG_MISMATCH', count: 1 }]);

    // Step 4: Run with skipFailed — bookmark advances, entry gets acked.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true, skipFailed: true });
    expect(result.status).toBe('synced');
    const afterSkipCommit = await engine.getConfig('sync.last_commit');
    expect(afterSkipCommit).not.toBe(firstCommit); // bookmark moved past the broken commit
    failures = loadSyncFailures();
    expect(failures.length).toBe(1);
    expect(failures[0].acknowledged).toBe(true);
    expect(typeof failures[0].acknowledged_at).toBe('string');

    // Step 5: Verify what doctor would render for the historical entry.
    // We call the same primitives doctor's `sync_failures` check uses
    // (src/commands/doctor.ts:252-275) — loadSyncFailures + summarizeFailuresByCode —
    // and assert the rendering string. Directly invoking runDoctor() here is a CLI
    // entrypoint with stdout/exit side effects that would truncate this test mid-flow.
    {
      const all = loadSyncFailures();
      const ackedSummary = summarizeFailuresByCode(all);
      const ackedBreakdown = ackedSummary.map(s => `${s.code}=${s.count}`).join(', ');
      // This is the literal string interpolation doctor.ts:271-274 produces.
      const doctorMessage = `${all.length} historical sync failure(s), all acknowledged [${ackedBreakdown}].`;
      expect(doctorMessage).toContain('SLUG_MISMATCH=1');
      expect(doctorMessage).toContain('1 historical');
    }

    // Step 6: Add a second broken file — this one with a different failure code
    // (also SLUG_MISMATCH but on a different file) so the JSONL has 2 entries
    // with DIFFERENT paths but the same code. This proves both: per-file dedup
    // honors path identity, and summary aggregation sums across files.
    //
    // We'd ideally test a different code class here, but the sync path uses
    // parseMarkdown WITHOUT {validate:true}, so the markdown.ts validation
    // codes (MISSING_OPEN/CLOSE, NESTED_QUOTES, EMPTY_FRONTMATTER, NULL_BYTES)
    // don't naturally surface — they'd need {validate:true} plumbed in. That
    // plumbing is the v0.22.13+ follow-up. For v0.22.12, two SLUG_MISMATCH
    // entries from different files still proves the dedup + aggregation chain.
    writeFileSync(join(repoPath, 'people/carol.md'), [
      '---', 'type: person', 'title: Carol', 'slug: also-wrong-slug', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add carol with bad slug"', { cwd: repoPath, stdio: 'pipe' });

    // Step 7: Sync blocks again on the new failure. Old entry stays acked.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('blocked_by_failures');
    failures = loadSyncFailures();
    expect(failures.length).toBe(2);
    const acked = failures.filter(f => f.acknowledged);
    const unacked = failures.filter(f => !f.acknowledged);
    expect(acked.length).toBe(1);
    expect(acked[0].code).toBe('SLUG_MISMATCH');
    expect(acked[0].path).toContain('bob');
    expect(unacked.length).toBe(1);
    expect(unacked[0].code).toBe('SLUG_MISMATCH');
    expect(unacked[0].path).toContain('carol');

    // Step 8: Skip again — both entries acked, summary aggregates the count.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true, skipFailed: true });
    expect(result.status).toBe('synced');
    failures = loadSyncFailures();
    expect(failures.length).toBe(2);
    expect(failures.every(f => f.acknowledged)).toBe(true);

    const finalSummary = summarizeFailuresByCode(failures);
    expect(finalSummary).toEqual([{ code: 'SLUG_MISMATCH', count: 2 }]);
  });
});
