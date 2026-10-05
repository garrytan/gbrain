/**
 * `sync --full` file walk: it runs without holding the event loop, and it runs
 * once per source.
 *
 * Pre-fix, `runImport` walked the tree with `execFileSync('git ls-files')`
 * plus one `lstatSync` per listed file, and `performFullSync`'s delete
 * reconcile then walked the same tree a second time. In a `sync --all` process
 * the walk of one large source on a network filesystem froze the thread that
 * drives every other source's database handshakes, long enough for their
 * connect timeouts to fire.
 *
 * Post-fix the walk is awaited (`collectSyncableFilesAsync`), and the hold
 * settle and the delete reconcile reuse `runImport`'s list (before
 * `--exclude`) via `onCollected`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'walk-once';
let engine: PGLiteEngine;
let repo: string;
let shimDir: string;

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
  const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [SOURCE]);
  if (rows.length === 0) await runSources(engine, ['add', SOURCE, '--no-federated']);
  repo = mkdtempSync(join(tmpdir(), 'gbrain-walk-once-'));
  execSync('git init -q && git config user.email "t@example.com" && git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'notes'), { recursive: true });
  for (const name of ['a', 'b', 'c']) {
    writeFileSync(join(repo, `notes/${name}.md`), `---\ntype: note\ntitle: Note ${name}\n---\n\nBody of ${name}.\n`);
  }
  execSync('git add -A && git commit -q -m fixture', { cwd: repo, stdio: 'pipe' });
  shimDir = mkdtempSync(join(tmpdir(), 'gbrain-walk-once-shim-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

function fullSync(opts: { exclude?: string[] } = {}) {
  return performSync(engine, { repoPath: repo, full: true, sourceId: SOURCE, noPull: true, noEmbed: true, ...opts });
}

/** Runs `fn` with a git on PATH that records every syncable-file listing; returns how many it saw. */
async function countListings(fn: () => Promise<unknown>): Promise<number> {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const log = join(shimDir, 'listings.log');
  rmSync(log, { force: true });
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
case " $* " in *" ls-files --cached --others --exclude-standard "*) echo listing >> "${log}" ;; esac
exec "${realGit}" "$@"
`, { mode: 0o755 });
  await withEnv({ PATH: `${shimDir}:${process.env.PATH}` }, fn);
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function liveSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [SOURCE],
  );
  return rows.map((r) => r.slug);
}

describe('sync --full file walk', () => {
  test('the import walk lets timers run while it lists and stats the tree', async () => {
    let fired = false;
    let firedBeforeWalkDone = null as boolean | null;
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const line = String(args[0] ?? '');
      if (line.includes('[gbrain phase] import.collect_files start')) setTimeout(() => { fired = true; }, 0);
      else if (line.includes('[gbrain phase] import.collect_files done')) firedBeforeWalkDone = fired;
    };
    try {
      await fullSync();
    } finally {
      console.error = original;
    }
    // Between the phase's start and done lines a synchronous walk never
    // yields, so the timer could only run after it.
    expect(firedBeforeWalkDone).toBe(true);
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/c']);
  });

  test('one walk per full sync; the reconcile still sees --exclude\'d files as present', async () => {
    await fullSync();
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b', 'notes/c']);

    rmSync(join(repo, 'notes/c.md'));
    execSync('git add -A && git commit -q -m "remove c"', { cwd: repo, stdio: 'pipe' });

    expect(await countListings(() => fullSync({ exclude: ['notes/b.md'] }))).toBe(1);
    // c is gone from the tree → reconciled away. b is excluded from the import
    // but still on disk → kept, exactly as when the reconcile walked again.
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b']);
  });

  test('one walk per full sync with a hold outstanding; the hold settle sees the same tree', async () => {
    // #5988: a file whose frontmatter needs interpretation is held, not failed.
    writeFileSync(join(repo, 'notes/held.md'), '---\ntitle: first line\nsecond line\n---\nBody.\n');
    execSync('git add -A && git commit -q -m "add a held file"', { cwd: repo, stdio: 'pipe' });
    const first = await fullSync();
    expect(first).toMatchObject({ holds_outstanding: 1 });

    // An outstanding hold makes the next full sync settle holds against the tree.
    rmSync(join(repo, 'notes/c.md'));
    execSync('git add -A && git commit -q -m "remove c"', { cwd: repo, stdio: 'pipe' });
    let second: unknown;
    expect(await countListings(async () => { second = await fullSync(); })).toBe(1);
    // The held file is still on disk, so its hold stays; c is reconciled away.
    expect(second).toMatchObject({ holds_outstanding: 1 });
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b']);
  });
});
