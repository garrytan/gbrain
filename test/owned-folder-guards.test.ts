/**
 * GST-3022: the default source's own doors leave `.gbrain-owned/` to the source that owns it. Full, incremental and
 * `--include-hidden '**'` syncs import nothing from it; a sync root, an import target, an uploaded file or a
 * frontmatter --fix inside it is refused; a commit or an untrack that would take one of its files is refused.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { performSync } from '../src/commands/sync.ts';
import { runImport } from '../src/commands/import.ts';
import { runFrontmatter } from '../src/commands/frontmatter.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { acquireCommitLock, commitPaths } from '../src/core/git/commit-push.ts';
import { untrackTargets } from '../src/core/git/untrack-admission.ts';
import { isPathPruned } from '../src/core/sync.ts';
import { captureHookSessionCwd, HOOK_CWD_ENV } from '../src/core/session-cwd.ts';
import { withEnv } from './helpers/with-env.ts';

setDefaultTimeout(60_000);

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const OWNED = '.gbrain-owned/imessage-x/imessage/abc/2026-06-14.md';

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-owned-guards-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
function checkout() {
  const repo = join(home, `repo-${++n}`);
  mkdirSync(join(repo, 'notes'), { recursive: true });
  mkdirSync(join(repo, '.gbrain-owned/imessage-x/imessage/abc'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.invalid');
  writeFileSync(join(repo, 'notes/a.md'), '# A\n\nA note.\n');
  writeFileSync(join(repo, OWNED), '---\ntitle: chat\n---\n# chat\n\nLunch at noon.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const capture = async <T>(fn: () => Promise<T>) => {
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { err += String(chunk); return true; };
  try { return { value: await fn(), err }; } catch (error) { return { error, err }; } finally { (process.stderr as { write: unknown }).write = write; }
};

test('isPathPruned reserves the folder whatever --include-hidden says', () => {
  expect(isPathPruned(OWNED)).toBe(true);
  expect(isPathPruned(OWNED, ['**'])).toBe(true);
  expect(isPathPruned('notes/a.md', ['**'])).toBe(false);
});

// The walk is engine-independent (isPathPruned), so this runs on PGLite only.
test('full, incremental and --include-hidden ** syncs of the default source import nothing from the folder (pglite)', async () => {
  const owned = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND (slug LIKE '%gbrain-owned%' OR slug LIKE 'imessage/%' OR compiled_truth LIKE '%Lunch at noon%')"))[0]!.n;
  const repo = checkout();
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  await performSync(engine, { sourceId: 'default', repoPath: repo, noPull: true, noEmbed: true, noExtract: true, full: true });
  expect(await owned()).toBe(0);
  writeFileSync(join(repo, OWNED), '# chat\n\nLunch at noon, moved.\n');
  writeFileSync(join(repo, 'notes/b.md'), '# B\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'more');
  await performSync(engine, { sourceId: 'default', repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
  await performSync(engine, { sourceId: 'default', repoPath: repo, noPull: true, noEmbed: true, noExtract: true, full: true, includeHidden: ['**'] });
  expect(await owned()).toBe(0);
  const [b] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/b'");
  expect(b!.n).toBe(1);
});

for (const kind of testBackends()) describe(`the default source leaves the owned folder alone (${kind})`, () => {
  let pglite: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind !== 'postgres') return;
    pglite = engine;
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { if (pglite) { await close!(); engine = pglite; } });

  const owned = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND (slug LIKE '%gbrain-owned%' OR slug LIKE 'imessage/%' OR compiled_truth LIKE '%Lunch at noon%')"))[0]!.n;

  test('a sync root, an import target and an uploaded file inside it are refused', async () => {
    const repo = checkout();
    const inside = join(repo, '.gbrain-owned/imessage-x');
    const sync = await capture(() => performSync(engine, { sourceId: 'default', repoPath: inside, noPull: true, noEmbed: true, noExtract: true, full: true }));
    expect(sync.error).toMatchObject({ code: 'owned_folder_conflict' });
    const imp = await capture(() => runImport(engine, [inside, '--no-embed']));
    expect(String((imp.error as Error)?.message)).toContain('.gbrain-owned/');
    const linked = join(home, `link-${n}`);
    spawnSync('ln', ['-s', inside, linked]);
    expect(String(((await capture(() => runImport(engine, [linked, '--no-embed']))).error as Error)?.message)).toContain('.gbrain-owned/');
    // A stdio session started in the checkout: the upload path is relative to it and passes the working-directory confinement.
    try {
      await withEnv({ [HOOK_CWD_ENV]: repo }, async () => {
        captureHookSessionCwd();
        const out = await dispatchToolCall(engine, 'file_upload', { path: OWNED }, { remote: true, transport: 'stdio', sourceId: 'default' });
        expect(out.isError).toBe(true);
        expect(out.content.map(c => c.text).join('\n')).toContain('owned_folder_conflict');
      });
    } finally {
      captureHookSessionCwd();
    }
    expect(await owned()).toBe(0);
  });

  test('a commit of a directory that holds a changed owned file, and an untrack of one, are refused', () => {
    const repo = checkout();
    writeFileSync(join(repo, OWNED), '# edited by someone else\n');
    const lock = acquireCommitLock(repo, 5_000);
    try {
      expect(() => commitPaths(repo, ['.'], 'everything', { roots: [''], lockPath: lock.lockPath, markHeld: false })).toThrow(/gbrain-owned/);
      expect(git(repo, 'diff', '--cached', '--name-only').stdout).toBe('');
      expect(() => commitPaths(repo, [OWNED], 'one', { roots: [''], lockPath: lock.lockPath, markHeld: false })).toThrow(/gbrain-owned/);
    } finally {
      lock.release();
    }
    expect(() => untrackTargets(repo, ['.'])).toThrow(/gbrain-owned/);
    expect(git(repo, 'log', '--oneline').stdout.trim().split('\n').length).toBe(1);
  });

  test('frontmatter validate --fix and generate --fix refuse a file there', async () => {
    const repo = checkout();
    writeFileSync(join(repo, OWNED), '---\ntitle: "broken\n---\n# chat\n');
    await expect(runFrontmatter(['validate', join(repo, OWNED), '--fix'])).rejects.toMatchObject({ code: 'owned_folder_conflict' });
    await expect(runFrontmatter(['generate', join(repo, '.gbrain-owned/imessage-x'), '--fix'])).rejects.toMatchObject({ code: 'owned_folder_conflict' });
  });
});
