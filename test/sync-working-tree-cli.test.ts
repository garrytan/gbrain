/**
 * Untracked-gap wiring tests — the CLI layer above performSync.
 *
 * test/sync-working-tree.test.ts pins performSync's behavior; this file pins
 * the three wiring seams the ship coverage audit flagged:
 *
 *   1. printSyncResult renders the drift NOTE on BOTH 'up_to_date' and
 *      'synced' statuses, and stays silent when `uncommitted` is absent.
 *      (printSyncResult is module-internal — asserted through runSync's
 *      captured stdout, the same seam production output uses.)
 *   2. `--working-tree` parses to SyncOpts.workingTree === true, and an
 *      absent flag leaves it undefined so performSync's config fallback
 *      (sync.include_working_tree) engages — observable as drift counted
 *      but NOT imported when the config is unset.
 *   3. syncOneSource threads shared.workingTree into performSync.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync, runSync, syncOneSource } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let repoPath: string;
const SOURCE_ID = 'wtree-cli';

function commitAll(msg: string): void {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoPath, stdio: 'pipe' });
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, SOURCE_ID],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

const baseArgs = () => [
  '--no-embed', '--no-extract', '--no-pull',
  '--repo', repoPath, '--source', SOURCE_ID, '--yes',
];

/**
 * Drive runSync with stdout captured (printSyncResult's sink) and
 * process.exit guarded — same harness as sync-sole-non-default-routing.
 */
async function runSyncCaptured(args: string[]): Promise<string> {
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as typeof process.exit;
  try {
    await runSync(engine, args);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    process.exit = origExit;
    process.stdout.write = stdoutOrig;
  }
  expect(exitCode === undefined || exitCode === 0).toBe(true);
  return chunks.join('');
}

describe('sync working-tree CLI wiring (drift NOTE + --working-tree flag)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-wtree-cli-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\ncommitted content\n');
    commitAll('base');

    await runSources(engine, ['add', SOURCE_ID, '--path', repoPath, '--no-federated']);

    // Anchor: first sync establishes last_commit so later runs are incremental.
    const first = await performSync(engine, {
      repoPath, sourceId: SOURCE_ID, noPull: true, noEmbed: true, noExtract: true,
    });
    expect(first.status).toBe('first_sync');
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('absent flag: up_to_date prints the drift NOTE and drift is NOT imported (config fallback engages)', async () => {
    writeFileSync(join(repoPath, 'topics/untracked.md'), '# Untracked\n\nnever committed\n');
    writeFileSync(join(repoPath, 'topics/base.md'), '# Base\n\nedited but not committed\n');

    const stdout = await runSyncCaptured(baseArgs());
    expect(stdout).toContain('Already up to date.');
    // The NOTE line printSyncResult renders from SyncResult.uncommitted.
    expect(stdout).toContain('NOTE: 2 uncommitted file(s) not synced');
    expect(stdout).toContain('(1 untracked/added, 1 modified, 0 deleted)');
    expect(stdout).toContain("--working-tree");
    // workingTree was passed as undefined (flag absent) and
    // sync.include_working_tree is unset → drift counted, never imported.
    expect(await pageExists('topics/untracked')).toBe(false);
  }, 60_000);

  test('synced status ALSO carries the drift NOTE', async () => {
    // Advance HEAD with a targeted commit while the drift from the previous
    // test stays uncommitted → this run takes the 'synced' path.
    writeFileSync(join(repoPath, 'topics/second.md'), '# Second\n\ncommitted addition\n');
    execSync('git add topics/second.md && git commit -m "second"', { cwd: repoPath, stdio: 'pipe' });

    const stdout = await runSyncCaptured(baseArgs());
    expect(stdout).toContain('Synced ');
    expect(stdout).toContain('NOTE: 2 uncommitted file(s) not synced');
    expect(stdout).toContain('(1 untracked/added, 1 modified, 0 deleted)');
  }, 60_000);

  test('--working-tree flag parses through to import: drift imported, NOTE absent', async () => {
    const stdout = await runSyncCaptured([...baseArgs(), '--working-tree']);
    // The flag reached performSync as workingTree: true — the untracked file
    // imported and the uncommitted field (hence the NOTE) is absent.
    expect(stdout).toContain('Synced ');
    expect(stdout).not.toContain('NOTE:');
    expect(await pageExists('topics/untracked')).toBe(true);
  }, 60_000);

  test('clean tree: up_to_date with no NOTE (uncommitted undefined)', async () => {
    commitAll('settle working tree');
    await runSyncCaptured(baseArgs()); // import the settle commit → anchor at HEAD

    const stdout = await runSyncCaptured(baseArgs());
    expect(stdout).toContain('Already up to date.');
    expect(stdout).not.toContain('NOTE:');
  }, 60_000);

  test('syncOneSource threads shared.workingTree into performSync', async () => {
    writeFileSync(join(repoPath, 'topics/one-source.md'), '# OneSource\n\nuntracked for the pool\n');
    const src = { id: SOURCE_ID, name: SOURCE_ID, local_path: repoPath, config: {} };
    const shared = {
      dryRun: false, full: false, noPull: true, noEmbed: true, noExtract: true,
      skipFailed: false, retryFailed: false, concurrency: undefined,
    };

    // workingTree undefined → drift counted, not imported (fallback path).
    const counted = await syncOneSource(engine, src, shared);
    expect(counted.result.status).toBe('up_to_date');
    expect(counted.result.uncommitted).toEqual({ added: 1, modified: 0, deleted: 0 });
    expect(await pageExists('topics/one-source')).toBe(false);

    // workingTree: true → the same drift imports.
    const imported = await syncOneSource(engine, src, { ...shared, workingTree: true });
    expect(imported.result.status).toBe('synced');
    expect(imported.result.added).toBe(1);
    expect(imported.result.uncommitted).toBeUndefined();
    expect(await pageExists('topics/one-source')).toBe(true);
  }, 60_000);
});
