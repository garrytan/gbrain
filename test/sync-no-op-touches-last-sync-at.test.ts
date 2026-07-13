/**
 * Regression test for the sync_freshness no-op miss.
 *
 * Pre-fix bug: when `performSync` returned early via the `up_to_date` path
 * (git HEAD unchanged AND chunker version current AND no detached working-tree
 * changes), `sources.last_sync_at` was never updated. Doctor's
 * `sync_freshness` check reads `last_sync_at` and was misreading quiet sources
 * (no upstream commits in N days) as "stale 16d" even though every cron tick
 * was attempting to sync them and getting "Already up to date" back.
 *
 * Post-fix: the no-op path UPDATEs `last_sync_at = now()` when `opts.sourceId`
 * is set, so doctor sees an accurate "last attempted sync" timestamp.
 *
 * The legacy non-federated path (no `opts.sourceId`) still writes to
 * `config.sync.last_run` elsewhere and isn't reached by sync_freshness's
 * `WHERE local_path IS NOT NULL` filter, so the fix is targeted to the
 * federated-source path only. We test both paths explicitly.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function git(repo: string, ...args: string[]): string {
  return execSync(`git ${args.join(' ')}`, { cwd: repo, encoding: 'utf-8' }).trim();
}

function seedRepoWithMarkdown(repoPath: string, fileCount: number): string {
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'people'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(repoPath, `people/p${i}.md`), [
      '---',
      'type: person',
      `title: Person ${i}`,
      '---',
      '',
      `This is person ${i}.`,
    ].join('\n'));
  }
  execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  return git(repoPath, 'rev-parse', 'HEAD');
}

describe('sync no-op touches last_sync_at (federated source)', () => {
  let engine: PGLiteEngine;
  let repoPath: string;
  const sourceId = 'test-source-noop';

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-noop-'));
  });

  afterEach(async () => {
    await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('no-op sync (git HEAD unchanged) UPDATEs last_sync_at on the source row', async () => {
    seedRepoWithMarkdown(repoPath, 3);

    // Register the source so writeSyncAnchor/UPDATE finds the row.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      [sourceId, 'Test Source', repoPath],
    );

    const { performSync } = await import('../src/commands/sync.ts');

    // First sync imports the files and sets last_sync_at via the
    // writeSyncAnchor('last_commit', ...) path.
    await performSync(engine, {
      repoPath,
      sourceId,
      noPull: true,
      noEmbed: true,
    });

    const after1 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      [sourceId],
    );
    const firstTs = new Date(after1[0].last_sync_at).getTime();
    expect(firstTs).toBeGreaterThan(0);

    // Sleep ~25ms to make the post-no-op timestamp distinguishable from
    // the post-first-sync timestamp.
    await new Promise(r => setTimeout(r, 25));

    // Second sync: git HEAD unchanged, chunker version matches. Pre-fix
    // this would return without touching last_sync_at.
    const result = await performSync(engine, {
      repoPath,
      sourceId,
      noPull: true,
      noEmbed: true,
    });
    expect(result.status).toBe('up_to_date');

    const after2 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      [sourceId],
    );
    const secondTs = new Date(after2[0].last_sync_at).getTime();

    // Post-fix: timestamp MUST have advanced even though no work was done.
    expect(secondTs).toBeGreaterThan(firstTs);
  });

  test('no-op sync without opts.sourceId does NOT touch sources rows (legacy path)', async () => {
    seedRepoWithMarkdown(repoPath, 3);

    // Seed a sources row that we will use to detect any accidental write.
    // last_sync_at deliberately starts NULL.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      ['unrelated-source', 'Unrelated', '/some/other/path'],
    );

    const { performSync } = await import('../src/commands/sync.ts');

    // Two syncs on the legacy path (no sourceId).
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('up_to_date');

    // The unrelated sources row was never targeted — last_sync_at stays NULL.
    const row = await engine.executeRaw<{ last_sync_at: Date | null }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['unrelated-source'],
    );
    expect(row[0].last_sync_at).toBeNull();
  });

  test('--dry-run on a head-unchanged source does NOT mutate last_sync_at', async () => {
    // Dry-run preview must be side-effect free. The freshness write would
    // otherwise mislead doctor/autopilot into treating a preview run as a
    // real sync.
    const sid = 'dryrun-source';
    seedRepoWithMarkdown(repoPath, 2);

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      [sid, 'Dry Run', repoPath],
    );

    const { performSync } = await import('../src/commands/sync.ts');

    // First sync seeds the source. last_sync_at populated.
    await performSync(engine, { repoPath, sourceId: sid, noPull: true, noEmbed: true });
    const after1 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`, [sid],
    );
    const beforeTs = new Date(after1[0].last_sync_at).getTime();

    await new Promise(r => setTimeout(r, 25));

    // Dry-run on head-unchanged source. Status should still be 'up_to_date'
    // (the no-op early-return fires) but last_sync_at MUST NOT advance.
    const result = await performSync(engine, {
      repoPath,
      sourceId: sid,
      noPull: true,
      noEmbed: true,
      dryRun: true,
    });
    expect(result.status).toBe('up_to_date');

    const after2 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`, [sid],
    );
    const afterTs = new Date(after2[0].last_sync_at).getTime();

    expect(afterTs).toBe(beforeTs);
  });

  test('incremental sync (local commits, pull failed) does NOT advance last_sync_at', async () => {
    // Codex finding scope-2: the pull-failure suppression must cover the
    // incremental path too, not just the no-op early-return. Scenario: pull
    // fails (network/auth gone), but a local commit advanced HEAD beforehand,
    // so sync enters the diff+import branch and ends at writeSyncAnchor at
    // the bottom of performSyncInner. That site also receives the flag and
    // must keep last_sync_at frozen even though last_commit advances.
    const sourceIdLocal = 'pull-fail-incremental';
    seedRepoWithMarkdown(repoPath, 2);

    // Configure invalid origin BEFORE first sync, but use --no-pull on
    // the first sync so it succeeds and seeds last_sync_at + last_commit.
    execSync(`git remote add origin /nonexistent/incremental.git`, {
      cwd: repoPath, stdio: 'pipe',
    });

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      [sourceIdLocal, 'Incremental Pull-Fail', repoPath],
    );

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath,
      sourceId: sourceIdLocal,
      noPull: true,
      noEmbed: true,
    });

    const after1 = await engine.executeRaw<{ last_sync_at: Date; last_commit: string }>(
      `SELECT last_sync_at, last_commit FROM sources WHERE id = $1`,
      [sourceIdLocal],
    );
    const firstTs = new Date(after1[0].last_sync_at).getTime();
    const firstCommit = after1[0].last_commit;

    // Add a local commit so the next sync has work to do (forces it
    // through the incremental import path, not the no-op early-return).
    writeFileSync(join(repoPath, 'people/added.md'), [
      '---', 'type: person', 'title: Added', '---', '', 'Added.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add"', { cwd: repoPath, stdio: 'pipe' });
    const newHead = git(repoPath, 'rev-parse', 'HEAD');
    expect(newHead).not.toBe(firstCommit);

    await new Promise(r => setTimeout(r, 25));

    // Second sync: pull is ATTEMPTED (no --no-pull, origin remote present)
    // and FAILS. The local diff still gets imported.
    const result = await performSync(engine, {
      repoPath,
      sourceId: sourceIdLocal,
      noEmbed: true,
    });
    expect(result.status).toBe('synced');

    const after2 = await engine.executeRaw<{ last_sync_at: Date; last_commit: string }>(
      `SELECT last_sync_at, last_commit FROM sources WHERE id = $1`,
      [sourceIdLocal],
    );
    const secondTs = new Date(after2[0].last_sync_at).getTime();

    // last_commit advances (local import succeeded) but last_sync_at
    // does NOT (pull failed, no observed upstream).
    expect(after2[0].last_commit).toBe(newHead);
    expect(secondTs).toBe(firstTs);
  });

  test('no-op sync does NOT advance last_sync_at when git pull was attempted and failed', async () => {
    // This case pins the codex-finding fix: if the pull was attempted (origin
    // remote present, no --no-pull, no detached HEAD) and threw, we never
    // observed upstream state, so advancing freshness would mask the failure
    // for doctor + autopilot's sync_freshness check. The UPDATE must be
    // suppressed in that path.
    const initialHead = seedRepoWithMarkdown(repoPath, 3);

    // Configure an origin remote pointing at a non-existent path so git pull
    // throws. This avoids needing the network to test the failure path.
    execSync(`git remote add origin /nonexistent/repo/that/does/not/exist.git`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $2, $3)`,
      ['pull-fail-source', 'Pull Fail', repoPath],
    );

    const { performSync } = await import('../src/commands/sync.ts');

    // First sync seeds the brain. We do NOT pull on the first sync (avoid
    // failure during initial import) so the bookmark advances cleanly.
    await performSync(engine, {
      repoPath,
      sourceId: 'pull-fail-source',
      noPull: true,
      noEmbed: true,
    });

    const after1 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['pull-fail-source'],
    );
    const firstTs = new Date(after1[0].last_sync_at).getTime();
    expect(firstTs).toBeGreaterThan(0);

    // Pause so a clock-tick-collision can't accidentally satisfy the assertion.
    await new Promise(r => setTimeout(r, 25));

    // Second sync: attempt the pull. With the non-existent origin URL, the
    // pull throws inside the try/catch. lastCommit === headCommit still, so
    // we hit the no-op early-return. Pre-fix this would still advance
    // last_sync_at. Post-fix it must NOT.
    const result = await performSync(engine, {
      repoPath,
      sourceId: 'pull-fail-source',
      // NOTE: omitting noPull — we WANT the pull to be attempted so we
      // exercise the failure-suppression branch.
      noEmbed: true,
    });
    expect(result.status).toBe('up_to_date');

    const after2 = await engine.executeRaw<{ last_sync_at: Date }>(
      `SELECT last_sync_at FROM sources WHERE id = $1`,
      ['pull-fail-source'],
    );
    const secondTs = new Date(after2[0].last_sync_at).getTime();

    // Pull failed → timestamp must NOT have advanced.
    expect(secondTs).toBe(firstTs);

    // Sanity: confirm headCommit didn't change either (pure no-op).
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(initialHead);
  });
});
