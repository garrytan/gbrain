/**
 * GST-2964: `gbrain git commit-push --untrack` admits a file by its path under a declared, ignored storage.db_only folder.
 * Protects:
 *   - Every tracked file under a folder gbrain.yml declares db_only (at HEAD and on disk) and .gitignore ignores is
 *     admitted whatever its extension (.json, .csv, .txt, code); before, each was matched by its page slug, which flattens
 *     for a file sync never imports as a page, so a .json under the folder refused `untrack_not_db_only`.
 *   - Nothing else is: a file outside every declared folder, a declared folder .gitignore does not ignore, a sibling that
 *     shares the folder's name as a string prefix, a `..` path, a tracked symlink pointing out of the folder and a folder
 *     reached through a symlink on disk all refuse, with a fix that is true for the case. A page file whose slug falls
 *     outside the declared spelling still refuses, since sync keeps a page by slug.
 *   - `--dry-run --untrack` lists exactly the files the real run removes, in a managed worktree and a classic checkout.
 *   - In a managed worktree every untrack reads the source's root from the brain: a source rooted in a folder of its
 *     repository is claimed at the repository's top, so the root's gbrain.yml was read and every file refused. From either
 *     working directory the folder's gbrain.yml now decides, the dry run and the real run list the same files, and the next
 *     syncs delete nothing; a folder only a stray top-level gbrain.yml declares refuses, naming the gbrain.yml read.
 *   - Without the brain's answer (unreachable, or a PGLite brain another process holds) every untrack refuses with the
 *     stop-and-rerun text and changes nothing; a plain commit, and an untrack in a checkout with no managed source, open no
 *     brain (a listener standing in for the brain counts no connection).
 *   - The sync note for pages kept from the working tree no longer tells a database-only page to be committed.
 * Repo-less: commit-push needs a checkout; GST-2519's test covers the refusal outside one.
 * Seams: none; real repositories, the real CLI (classic checkout, the managed fail-closed cases, and on Postgres the
 * subfolder-rooted source from both working directories), managed sync on PGLite and Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { commitAndPush, previewUntrack, scopePaths, untrackAdmitted, untrackPageCandidates } from '../src/core/git/commit-push.ts';
import { readUntrackPageVerdict, type UntrackPageVerdict } from '../src/core/git/untrack-admission.ts';
import { untrackPageVerdict } from '../src/commands/git.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedFilesystemRootFor } from '../src/core/persistence/filesystem-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { printManagedSyncNotes } from '../src/commands/sync-diagnostics.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { commitFiles, drainEffects, page } from './helpers/label-repair.ts';
import { runCli } from './helpers/cli-spawn.ts';

const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const dirs: string[] = [];
const scratch = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-gst2964-${name}-`))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
const refusalOf = (fn: () => unknown): { code?: string; message?: string; suggestion?: string; detail?: string } => {
  try { fn(); } catch (e) { return e as { code?: string }; }
  throw new Error('expected a refusal');
};
const changed = (root: string) => git(root, 'diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean).sort();

const DIR = 'health/dedupe-backups/';
const INSIDE = [`${DIR}backup-1.json`, `${DIR}backup-2.csv`, `${DIR}notes-example.md`, `${DIR}sub/deep.txt`, `${DIR}tool-example.ts`];
const YML = `storage:\n  db_only:\n    - ${DIR}\n    - logs/run-example/\n    - sources/Spaced Example/\n`;
const IGNORE = `${DIR}\nhealth/dedupe-backups-old/\nundeclared/\nsources/Spaced Example/\n`;

/** A checkout (no remote) whose files were committed before gbrain.yml declared their folders db_only and .gitignore ignored them. */
function declaredCheckout(): string {
  const root = join(scratch('repo'), 'work');
  mkdirSync(root);
  for (const path of INSIDE) put(root, path, `${path}\n`);
  put(root, 'health/dedupe-backups-old/backup-0.json', 'sibling\n');
  put(root, 'notes/plain.json', 'outside\n');
  put(root, 'undeclared/x.json', 'ignored, not declared\n');
  put(root, 'logs/run-example/a.json', 'declared, not ignored\n');
  put(root, 'sources/Spaced Example/one example.md', page('sources/spaced-example/one-example', 'canary'));
  put(root, 'sources/Spaced Example/data.json', '{}\n');
  durableGitRepo(root, ['.']);
  put(root, 'gbrain.yml', YML);
  put(root, '.gitignore', IGNORE);
  git(root, 'add', 'gbrain.yml', '.gitignore'); git(root, 'commit', '-qm', 'declare the folders');
  return root;
}
const managedAt = (root: string) => ({ root, evidence: 'test' });
/** Every file the checkout holding `dir` tracks, by its path from the checkout's top: a brain read that checked them all. */
const tracked = (dir: string) => new Set(git(dir, 'ls-files', '--full-name', '-z').split('\0').filter(Boolean));
/** The brain's answer for a source rooted at `sourceRoot` where no named file is a page: every code-extension file is admitted by path. */
const noPages = (sourceRoot: string): UntrackPageVerdict => ({ sourceId: 'default', sourceRoot, slugRoot: 'source-root', checked: tracked(sourceRoot), live: new Set() });

describe('GST-2964: untrackAdmitted matches a file by its path under the declared folder', () => {
  test('every tracked file under a declared, ignored folder is admitted, whatever its extension', () => {
    const root = declaredCheckout();
    expect(untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), noPages(root)).sort()).toEqual(INSIDE);
    expect(untrackAdmitted(root, [`${DIR}backup-1.json`], managedAt(root), noPages(root))).toEqual([`${DIR}backup-1.json`]);
    expect(untrackAdmitted(root, ['sources/Spaced Example/data.json'], managedAt(root), noPages(root))).toEqual(['sources/Spaced Example/data.json']);
  });

  test('a page root below the checkout reads gbrain.yml and the folder relative to that root', () => {
    const root = join(scratch('nested'), 'work');
    mkdirSync(root);
    put(root, `brain/${DIR}backup-1.json`, 'x\n');
    put(root, `${DIR}backup-1.json`, 'outside the page root\n');
    durableGitRepo(root, ['.']);
    put(root, 'brain/gbrain.yml', `storage:\n  db_only:\n    - ${DIR}\n`);
    put(root, '.gitignore', `${DIR}\nbrain/${DIR}\n`);
    git(root, 'add', '.gitignore', 'brain/gbrain.yml'); git(root, 'commit', '-qm', 'declare');
    const managed = managedAt(root);
    expect(untrackAdmitted(root, [`brain/${DIR.slice(0, -1)}`], managed, noPages(join(root, 'brain')))).toEqual([`brain/${DIR}backup-1.json`]);
    expect(refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`], managed, noPages(join(root, 'brain')))).code).toBe('untrack_not_db_only');
  });

  test('a file outside every declared folder refuses, and its fix says to declare the folder', () => {
    const root = declaredCheckout();
    for (const path of ['notes/plain.json', 'undeclared/x.json']) {
      const refused = refusalOf(() => untrackAdmitted(root, [path], managedAt(root), noPages(root)));
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [path] });
      expect(refused.suggestion).toContain('add it under storage.db_only in gbrain.yml');
    }
  });

  test('a declared folder .gitignore does not ignore refuses, and its fix names .gitignore, not the declaration', () => {
    const root = declaredCheckout();
    const refused = refusalOf(() => untrackAdmitted(root, ['logs/run-example'], managedAt(root), noPages(root)));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: ['logs/run-example/a.json'] });
    expect(refused.suggestion).toContain('.gitignore');
    expect(refused.suggestion).not.toContain('add it under storage.db_only');
  });

  test('a sibling folder that shares the declared name as a string prefix refuses', () => {
    const root = declaredCheckout();
    expect(refusalOf(() => untrackAdmitted(root, ['health/dedupe-backups-old'], managedAt(root), noPages(root))).code).toBe('untrack_not_db_only');
    const mixed = refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`, 'health/dedupe-backups-old/backup-0.json'], managedAt(root), noPages(root)));
    expect(JSON.parse(mixed.detail!)).toEqual({ paths: ['health/dedupe-backups-old/backup-0.json'] });
  });

  test('a path that climbs out of the folder with .. refuses', () => {
    const root = declaredCheckout();
    for (const path of [`${DIR}../dedupe-backups-old/backup-0.json`, `${DIR}../../notes/plain.json`, `${DIR}..`]) {
      expect(['untrack_not_db_only', 'commit_paths_invalid']).toContain(refusalOf(() => untrackAdmitted(root, [path], managedAt(root), noPages(root))).code ?? '');
    }
  });

  test('a tracked symlink pointing out of the folder refuses; one pointing inside it is admitted', () => {
    const root = declaredCheckout();
    symlinkSync('../../notes/plain.json', join(root, `${DIR}escape.json`));
    symlinkSync('backup-1.json', join(root, `${DIR}alias.json`));
    git(root, 'add', '-f', `${DIR}escape.json`, `${DIR}alias.json`); git(root, 'commit', '-qm', 'links');
    const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), noPages(root)));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: [`${DIR}escape.json`] });
    expect(refused.suggestion).toContain('symbolic link');
    expect(untrackAdmitted(root, [`${DIR}alias.json`], managedAt(root), noPages(root))).toEqual([`${DIR}alias.json`]);
  });

  test('a declared folder that is a symlink on disk to a directory outside the checkout refuses', () => {
    const root = declaredCheckout();
    const elsewhere = join(scratch('elsewhere'), 'backups');
    renameSync(join(root, DIR), elsewhere);
    symlinkSync(elsewhere, join(root, DIR.slice(0, -1)));
    const refused = refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`], managedAt(root), noPages(root)));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(refused.suggestion).toContain('symbolic link');
  });

  test('a page file whose slug falls outside the declared spelling still refuses, with a fix about the slug spelling', () => {
    const root = declaredCheckout();
    const refused = refusalOf(() => untrackAdmitted(root, ['sources/Spaced Example'], managedAt(root), noPages(root)));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: ['sources/Spaced Example/one example.md'] });
    expect(refused.suggestion).toContain('sources/spaced-example/');
    expect(refused.suggestion).not.toContain('add it under storage.db_only');
  });
});

describe('GST-2964: a code-extension file under the declared folder, decided by what the brain says', () => {
  const json = `${DIR}backup-1.json`, ts = `${DIR}tool-example.ts`;
  test('the candidates are the code-extension files the untrack names, with the slug sync gives each; Markdown and CSV are not', () => {
    const root = declaredCheckout();
    expect(untrackPageCandidates(root, [DIR.slice(0, -1)], root)).toEqual([
      { file: json, slugs: ['health-dedupe-backups-backup-1-json'], sourcePaths: [json] },
      { file: ts, slugs: ['health-dedupe-backups-tool-example-ts'], sourcePaths: [ts] },
    ]);
    expect(untrackPageCandidates(root, [`${DIR}notes-example.md`, `${DIR}backup-2.csv`], root)).toEqual([]);
    expect(untrackPageCandidates(root, ['missing-example'], root)).toEqual([]);
  });

  test('a code file with no live page is admitted and one with a live page refuses, saying why, whatever the source\'s strategy', () => {
    const root = declaredCheckout();
    expect(untrackAdmitted(root, [json], managedAt(root), { sourceId: 'default', sourceRoot: root, slugRoot: 'source-root', checked: tracked(root), live: new Set() })).toEqual([json]);
    const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), { sourceId: 'default', sourceRoot: root, slugRoot: 'source-root', checked: tracked(root), live: new Set([json]) }));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: [json] });
    expect(refused.suggestion).toContain('pages on this source, or its sync imports them as pages, and untracking them would delete the pages at the next sync');
  });

  test('a code-extension file the brain read did not check (named after the read) refuses; the rest are admitted', () => {
    const root = declaredCheckout();
    const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), { ...noPages(root), checked: new Set([json]) } as UntrackPageVerdict));
    expect(JSON.parse(refused.detail!)).toEqual({ paths: [ts] });
    expect(refused.message).toContain('or that reached the branch after the brain was read');
    expect(refused.suggestion).toContain('Run gbrain sync --source default, then rerun the untrack');
    expect(refused.suggestion).not.toContain('could not be read');
  });

  test('an image under the declared folder is held to the page-slug rule whatever multimodal is set to here: on a git-root source its slug carries the folder and refuses', async () => {
    const root = join(scratch('image'), 'work');
    mkdirSync(root);
    put(root, 'brain/' + DIR + 'chart-example.png', 'png\n');
    durableGitRepo(root, ['.']);
    put(root, 'brain/gbrain.yml', 'storage:\n  db_only:\n    - ' + DIR + '\n');
    put(root, 'brain/.gitignore', DIR + '\n');
    git(root, 'add', 'brain/.gitignore', 'brain/gbrain.yml'); git(root, 'commit', '-qm', 'declare');
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, async () => {
      const file = 'brain/' + DIR + 'chart-example.png';
      const refused = refusalOf(() => untrackAdmitted(root, [file], managedAt(root), { ...noPages(join(root, 'brain')), slugRoot: 'git-root' } as UntrackPageVerdict));
      expect(refused.code).toBe('untrack_not_db_only');
      expect(refused.suggestion).toContain('add brain/' + DIR + ' under storage.db_only in brain/gbrain.yml');
      expect(untrackAdmitted(root, [file], managedAt(root), noPages(join(root, 'brain')))).toEqual([file]);
    });
  });

  test('with no answer from the brain, or an unreadable one, every file refuses (fail closed), Markdown and CSV included', () => {
    const root = declaredCheckout();
    for (const pages of [undefined, { unreadable: 'pglite_busy' }]) {
      for (const [paths, refused] of [[[DIR.slice(0, -1)], INSIDE], [[`${DIR}notes-example.md`, `${DIR}backup-2.csv`], [`${DIR}backup-2.csv`, `${DIR}notes-example.md`]]] as const) {
        const error = refusalOf(() => untrackAdmitted(root, [...paths], managedAt(root), pages));
        expect(error.code).toBe('untrack_not_db_only');
        expect((JSON.parse(error.detail!) as { paths: string[] }).paths.sort()).toEqual([...refused].sort());
        expect(error.suggestion).toContain('could not be read to check');
        expect(error.suggestion).toContain('If another process holds the brain (on PGLite, a running gbrain serve or a sync), stop it, then rerun the untrack');
      }
    }
  });
});

describe('GST-2964: untrackPageVerdict opens the brain only to read', () => {
  let brain: PGLiteEngine;
  let home: string;
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-gst2964-verdict-')));
    brain = new PGLiteEngine();
    await brain.connect({ database_path: join(home, 'brain.pglite') });
    await brain.initSchema();
    mkdirSync(join(home, 'content'));
    await brain.executeRaw(`UPDATE sources SET local_path=$1, config = config || '{"strategy":"auto"}'::jsonb WHERE id='default'`, [join(home, 'content')]);
    await brain.disconnect();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
  }, 120_000);
  afterAll(async () => { await brain.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('reads the source root, strategy and live pages from an on-disk brain, by source id or rooted path, and reports a missing brain or source as unreadable', async () => {
    const root = join(home, 'content'), rel = [`${DIR}backup-1.json`];
    const managed = { root, sourceId: 'default', evidence: 'test' };
    await withEnv({ GBRAIN_HOME: join(home, 'empty'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(await untrackPageVerdict(managed, root, rel)).toEqual({ unreadable: 'no brain is configured on this machine' });
    });
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const answer: UntrackPageVerdict = { sourceId: 'default', sourceRoot: root, slugRoot: 'git-root', checked: new Set(), live: new Set(), syncNote: 'source default has not finished a sync' };
      expect(await untrackPageVerdict(managed, root, rel)).toEqual(answer);
      expect(await untrackPageVerdict({ ...managed, sourceId: undefined }, root, rel)).toEqual(answer);
      expect(await untrackPageVerdict({ ...managed, sourceId: 'missing-example' }, root, rel)).toEqual({ unreadable: 'source missing-example is not in the brain' });
    });
  }, 120_000);
});

/** Stands in for an unreachable Postgres brain: counts the connections a child makes and closes each at once. */
async function countingListener(): Promise<{ url: string; connections: () => number; close: () => void }> {
  let count = 0;
  const server = createServer(socket => { count++; socket.destroy(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `postgres://127.0.0.1:${port}/gbrain_example`, connections: () => count, close: () => server.close() };
}

describe('GST-2964: the sync anchor a code file needs, read from an unmanaged brain', () => {
  test('an anchor that is not a commit in the checkout, or not on its branch\'s history, refuses the file; one that holds its current version admits it, including when a merge brought that version in or the checkout was reset behind the anchor', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-gst2964-anchor-')));
    const brain = new PGLiteEngine();
    try {
      const root = join(home, 'content');
      mkdirSync(root);
      put(root, DIR + 'backup-1.json', '{}\n');
      durableGitRepo(root, ['.']);
      await brain.connect({ database_path: join(home, 'brain.pglite') });
      await brain.initSchema();
      await brain.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      const file = DIR + 'backup-1.json', managed = { root, sourceId: 'default', evidence: 'test' };
      const note = async (anchor: string | null) => {
        await brain.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [anchor]);
        const pages = await readUntrackPageVerdict(brain, managed, root, [file]);
        return 'unreadable' in pages ? 'unreadable' : pages.checked.has(file) ? 'checked' : pages.syncNote ?? 'unchecked';
      };
      expect(await note(null)).toBe('source default has not finished a sync');
      expect(await note('0'.repeat(40))).toBe('source default\'s last sync, 000000000000, is not a commit in this checkout');
      const orphan = git(root, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'an unrelated history');
      expect(await note(orphan)).toBe('source default\'s last sync, ' + orphan.slice(0, 12) + ', is not on this branch\'s history');
      const first = git(root, 'rev-parse', 'HEAD');
      expect(await note(first)).toBe('checked');
      put(root, file, '{"changed":1}\n'); git(root, 'add', '-f', file); git(root, 'commit', '-qm', 'a later version');
      expect(await note(first)).toBe('unchecked');
      expect(await note(git(root, 'rev-parse', 'HEAD'))).toBe('checked');
      const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
      git(root, 'checkout', '-q', '-b', 'side-example');
      put(root, file, '{"side":1}\n'); git(root, 'add', '-f', file); git(root, 'commit', '-qm', 'side edit');
      const side = git(root, 'rev-parse', 'HEAD');
      git(root, 'checkout', '-q', branch);
      put(root, 'other-example.md', 'x\n'); git(root, 'add', 'other-example.md'); git(root, 'commit', '-qm', 'an unrelated change');
      const beforeMerge = git(root, 'rev-parse', 'HEAD');
      git(root, 'merge', '-q', '--no-ff', 'side-example', '-m', 'merge side');
      expect(git(root, 'rev-list', '-1', 'HEAD', '--', file)).toBe(side);
      expect(await note(beforeMerge)).toBe('unchecked');
      expect(await note(side)).toBe('checked');
      expect(await note(git(root, 'rev-parse', 'HEAD'))).toBe('checked');
      put(root, 'other-example.md', 'y\n'); git(root, 'add', 'other-example.md'); git(root, 'commit', '-qm', 'a commit the checkout later resets away');
      const ahead = git(root, 'rev-parse', 'HEAD');
      git(root, 'reset', '-q', '--hard', 'HEAD~1');
      expect(await note(ahead)).toBe('checked');
    } finally { await brain.disconnect(); rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});

describe('GST-2964: a classic checkout', () => {
  test('--dry-run --untrack lists exactly the files the real run removes, non-Markdown files included, and opens no brain', async () => {
    const root = declaredCheckout();
    const home = scratch('home');
    const pg = await countingListener();
    const run = (args: string[]) => runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_DATABASE_URL: pg.url } });
    const preview = await run(['--dry-run', '--untrack', '-m', 'm', '--', DIR.slice(0, -1)]);
    expect(preview.exitCode).toBe(0);
    const previewed = JSON.parse(preview.stdout) as { untracked: string[] };
    const real = await run(['--untrack', '-m', 'untrack backups', '--', DIR.slice(0, -1)]);
    expect(real.exitCode).toBe(0);
    expect(changed(root)).toEqual(INSIDE);
    expect(previewed.untracked.slice().sort()).toEqual(changed(root));
    for (const path of INSIDE) expect(readFileSync(join(root, path), 'utf8')).toBe(`${path}\n`);
    expect(pg.connections()).toBe(0);
    pg.close();
  });
});

describe('GST-2964: the sync note for pages kept from the working tree', () => {
  test('does not tell a page under a declared db_only folder to be committed', () => {
    const lines: string[] = [];
    printManagedSyncNotes({ status: 'synced', working_tree_kept: 2 } as Parameters<typeof printManagedSyncNotes>[0], line => lines.push(line));
    const note = lines.find(line => line.includes('in the working tree but not in Git'));
    expect(note).toContain('database-only by declaration and need nothing');
    expect(note!.indexOf('commit')).toBeGreaterThan(note!.indexOf('database-only by declaration'));
  });
});

const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const syncAll = async (engine: BrainEngine, full = false) => { const r = await performManagedSync(engine, { ...OPTS, ...(full ? { full: true } : {}) }); await drainEffects(engine); return r; };
const rows = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ slug: string; content_hash: string; deleted: boolean }>(
  "SELECT slug, content_hash, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id='default' ORDER BY slug")).map(r => [r.slug, { hash: r.content_hash, deleted: r.deleted }]));
const strategy = (engine: BrainEngine, value: string) => engine.executeRaw(`UPDATE sources SET config = config || jsonb_build_object('strategy', $1::text) WHERE id='default'`, [value]);
const PAGE = 'health/dedupe-backups/notes-example';
const JSON_FILES = [`${DIR}backup-1.json`, `${DIR}backup-2.json`];
const FILES = [...JSON_FILES, `${DIR}backup-3.csv`, `${PAGE}.md`];

function managedSetup({ root }: { root: string }): void {
  put(root, 'gbrain.yml', `storage:\n  db_only:\n    - ${DIR}\n`);
  put(root, '.gitignore', `${DIR}\n`);
  durableGitRepo(root, ['.gitignore', 'gbrain.yml']);
  put(root, `${PAGE}.md`, page(PAGE, 'canary'));
  for (const file of JSON_FILES) put(root, file, '{"backup":1}\n');
  put(root, `${DIR}backup-3.csv`, 'a,b\n1,2\n');
  commitFiles(root, FILES, 'files committed before their folder was declared db_only');
  const bare = join(dirname(root), 'origin.git');
  git(dirname(root), 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'HEAD');
}
const SUB = 'brain/', DIR2 = 'logs/run-example/', STRAY = 'stray-example/';
/** A source rooted at <checkout>/brain: its gbrain.yml declares two folders; a top-level gbrain.yml (no source reads it) declares a third. */
function subfolderSetup({ root }: { root: string }): void {
  put(root, SUB + 'gbrain.yml', 'storage:\n  db_only:\n    - ' + DIR + '\n    - ' + DIR2 + '\n');
  put(root, SUB + '.gitignore', DIR + '\n' + DIR2 + '\n' + STRAY + '\n');
  put(root, 'gbrain.yml', 'storage:\n  db_only:\n    - ' + SUB + STRAY + '\n    - ' + STRAY + '\n');
  durableGitRepo(root, [SUB + '.gitignore', SUB + 'gbrain.yml', 'gbrain.yml']);
  put(root, SUB + PAGE + '.md', page(PAGE, 'canary'));
  for (const file of JSON_FILES) put(root, SUB + file, '{"backup":1}\n');
  put(root, SUB + DIR + 'backup-3.csv', 'a,b\n1,2\n');
  put(root, SUB + DIR2 + 'run-note.md', page(DIR2 + 'run-note', 'canary'));
  put(root, SUB + DIR2 + 'run.json', '{}\n');
  put(root, SUB + STRAY + 'kept-example.md', page(STRAY + 'kept-example', 'canary'));
  const files = [...FILES, DIR2 + 'run-note.md', DIR2 + 'run.json', STRAY + 'kept-example.md'].map(file => SUB + file);
  commitFiles(root, files, 'files committed before their folders were declared db_only');
  const bare = join(dirname(root), 'origin.git');
  git(dirname(root), 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'HEAD');
}
const untrackWithBrain = async (engine: BrainEngine, root: string, paths: string[], opts: { dryRun?: boolean } = {}) => {
  const managed = { root, sourceId: 'default', evidence: 'test' };
  const untrackPages = await readUntrackPageVerdict(engine, managed, root, paths);
  return opts.dryRun ? previewUntrack(root, paths, { untrackPages }) : commitAndPush({ repo: root, cwd: root, paths, message: 'untrack the backups', untrack: true, untrackPages });
};

for (const backend of testBackends()) describe(`[${backend}] GST-2964: --untrack in a managed canonical worktree`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a Markdown source whose tracked, ignored .json files its sync has processed: the untrack is admitted, the dry run lists the same files, and the next sync creates and deletes nothing', () => managedBrain(async ({ engine, root }) => {
    git(root, 'rm', '-q', '--cached', ...JSON_FILES); git(root, 'commit', '-qm', 'the backups arrive after the first import');
    await syncAll(engine);
    git(root, 'add', '-f', ...JSON_FILES); git(root, 'commit', '-qm', 'backups committed under the ignored folder');
    await syncAll(engine);
    const before = await rows(engine);
    expect(Object.keys(before).filter(slug => slug.includes('json'))).toEqual([]);
    const previewed = (await untrackWithBrain(engine, root, [DIR.slice(0, -1)], { dryRun: true }) as string[]).sort();
    expect(await untrackWithBrain(engine, root, [DIR.slice(0, -1)])).toMatchObject({ outcome: 'committed_local', managed: true });
    expect(changed(root)).toEqual(FILES.slice().sort());
    expect(previewed).toEqual(changed(root));
    for (const full of [false, true]) {
      const synced = await syncAll(engine, full);
      expect(synced.added).toBe(0);
      expect(synced.deleted).toBe(0);
      expect(await rows(engine)).toEqual(before);
    }
  }, { databaseUrl, setup: managedSetup }), 180_000);

  test('a source switched to a code-importing strategy after its sync skipped the .json files: they refuse as pages with no page yet, dry and real, and a sync that imports them before the untrack leaves nothing to delete', () => managedBrain(async ({ engine, root }) => {
    const late = DIR + 'late-example.json';
    put(root, late, '{"backup":2}\n');
    git(root, 'add', '-f', late); git(root, 'commit', '-qm', 'a backup committed while the strategy is markdown');
    await syncAll(engine);
    await strategy(engine, 'auto');
    const managed = { root, sourceId: 'default', evidence: 'test' };
    const pages = await readUntrackPageVerdict(engine, managed, root, [late]);
    expect((await rows(engine))['health-dedupe-backups-late-example-json']).toBeUndefined();
    await syncAll(engine);
    const before = await rows(engine);
    expect(before['health-dedupe-backups-late-example-json']).toMatchObject({ deleted: false });
    const head = git(root, 'rev-parse', 'HEAD');
    for (const run of [() => previewUntrack(root, [late], { untrackPages: pages }), () => commitAndPush({ repo: root, cwd: root, paths: [late], message: 'm', untrack: true, untrackPages: pages })]) {
      const refused = refusalOf(run);
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [late] });
      expect(refused.message).toContain('or that its sync imports as pages (its strategy imports code)');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    const synced = await syncAll(engine);
    expect(synced.deleted).toBe(0);
    expect(await rows(engine)).toEqual(before);
  }, { databaseUrl, setup: managedSetup }), 180_000);

  test('a code-importing source where a .json file is a live page: the untrack refuses, the dry run refuses the same, and nothing changes', () => managedBrain(async ({ engine, root }) => {
    await strategy(engine, 'auto');
    await syncAll(engine);
    const before = await rows(engine);
    expect(before['health-dedupe-backups-backup-1-json']).toMatchObject({ deleted: false });
    const head = git(root, 'rev-parse', 'HEAD');
    for (const dryRun of [true, false]) {
      const error = await untrackWithBrain(engine, root, [DIR.slice(0, -1)], { dryRun }).then(() => null, (e: unknown) => e as { code?: string; suggestion?: string; detail?: string });
      expect(error?.code).toBe('untrack_not_db_only');
      expect(JSON.parse(error!.detail!)).toEqual({ paths: JSON_FILES });
      expect(error?.suggestion).toContain('would delete the pages at the next sync');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    await syncAll(engine);
    expect(await rows(engine)).toEqual(before);
  }, { databaseUrl, setup: managedSetup }), 180_000);

  test('a sync that imports a code file between the brain read and the untrack: the file refuses as a page the source\'s strategy imports, read before or after that sync, and no page is deleted', () => managedBrain(async ({ engine, root }) => {
    await strategy(engine, 'auto');
    await syncAll(engine);
    const late = DIR + 'late-example.json';
    put(root, late, '{"backup":2}\n');
    git(root, 'add', '-f', late); git(root, 'commit', '-qm', 'a backup another writer committed; no sync has run yet');
    const managed = { root, sourceId: 'default', evidence: 'test' };
    const pages = await readUntrackPageVerdict(engine, managed, root, [late]);
    await syncAll(engine);
    const before = await rows(engine);
    expect(before['health-dedupe-backups-late-example-json']).toMatchObject({ deleted: false });
    const head = git(root, 'rev-parse', 'HEAD');
    for (const run of [() => previewUntrack(root, [late], { untrackPages: pages }), () => commitAndPush({ repo: root, cwd: root, paths: [late], message: 'm', untrack: true, untrackPages: pages })]) {
      const refused = refusalOf(run);
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [late] });
      expect(refused.suggestion).toContain('or its sync imports them as pages, and untracking them would delete the pages at the next sync');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    await syncAll(engine);
    expect(await rows(engine)).toEqual(before);
    const fresh = await readUntrackPageVerdict(engine, managed, root, [late]);
    expect(refusalOf(() => previewUntrack(root, [late], { untrackPages: fresh })).suggestion).toContain('would delete the pages at the next sync');
  }, { databaseUrl, setup: managedSetup }), 180_000);

  test('the sync anchor decides, the same for the dry run and the real run: no finished sync, sync switched off, and a merge as the last change', () => managedBrain(async ({ engine, root }) => {
    const file = JSON_FILES[0]!;
    const managed = { root, sourceId: 'default', evidence: 'test' };
    const refusedBoth = async (note: string) => {
      const pages = await readUntrackPageVerdict(engine, managed, root, [file]);
      const head = git(root, 'rev-parse', 'HEAD');
      for (const run of [() => previewUntrack(root, [file], { untrackPages: pages }), () => commitAndPush({ repo: root, cwd: root, paths: [file], message: 'm', untrack: true, untrackPages: pages })]) {
        const refused = refusalOf(run);
        expect(refused.code).toBe('untrack_not_db_only');
        expect(JSON.parse(refused.detail!)).toEqual({ paths: [file] });
        expect(refused.message).toContain(note);
        expect(refused.suggestion).toContain('Run gbrain sync --source default');
      }
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      return pages;
    };
    await refusedBoth('source default has not finished a sync');
    await engine.executeRaw(`UPDATE sources SET config = config || '{"syncEnabled": false}'::jsonb WHERE id='default'`);
    const off = await refusedBoth('source default has not finished a sync');
    expect(refusalOf(() => previewUntrack(root, [file], { untrackPages: off })).suggestion).toContain('Run gbrain sync --source default (automatic sync is off for this source; an explicit sync still runs), then rerun the untrack');
    await engine.executeRaw("UPDATE sources SET config = config - 'syncEnabled' WHERE id='default'");
    await syncAll(engine);
    expect(previewUntrack(root, [file], { untrackPages: await readUntrackPageVerdict(engine, managed, root, [file]) })).toEqual([file]);
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'side-example');
    put(root, file, '{"side":1}\n'); git(root, 'add', '-f', file); git(root, 'commit', '-qm', 'side edit');
    git(root, 'checkout', '-q', branch);
    put(root, file, '{"main":1}\n'); git(root, 'add', '-f', file); git(root, 'commit', '-qm', 'main edit');
    try { git(root, 'merge', '-q', '--no-ff', 'side-example', '-m', 'merge side'); } catch { /* the conflict is resolved below */ }
    put(root, file, '{"merged":1}\n'); git(root, 'add', '-f', file); git(root, 'commit', '-qm', 'merge side, resolved');
    expect(git(root, 'rev-list', '-1', 'HEAD', '--', file)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length).toBe(3);
    await refusedBoth('');
    await syncAll(engine);
    const before = await rows(engine);
    const pages = await readUntrackPageVerdict(engine, managed, root, [file]);
    const dry = previewUntrack(root, [file], { untrackPages: pages });
    expect(dry).toEqual([file]);
    expect(commitAndPush({ repo: root, cwd: root, paths: [file], message: 'untrack the merged backup', untrack: true, untrackPages: pages })).toMatchObject({ outcome: 'committed_local' });
    expect(changed(root)).toEqual(dry);
    for (const full of [false, true]) {
      const synced2 = await syncAll(engine, full);
      expect(synced2.deleted).toBe(0);
      expect(await rows(engine)).toEqual(before);
    }
  }, { databaseUrl, setup: managedSetup }), 180_000);

  test('a source rooted in a folder of its repository: from either working directory the untrack reads that folder\'s gbrain.yml, the dry run lists what the real run removes, and the next syncs delete nothing; a folder only a stray top-level gbrain.yml declares refuses, naming the gbrain.yml read', () => managedBrain(async ({ engine, root }) => {
    await syncAll(engine);
    const before = await rows(engine);
    expect(before[PAGE]).toMatchObject({ deleted: false });
    const managed = managedFilesystemRootFor(root)!;
    expect(managed.root).toBe(root);
    const brain = join(root, SUB);
    const verdict = (paths: string[]) => readUntrackPageVerdict(engine, managed, root, paths);
    const listed = async (cwd: string, rel: string) => { const paths = scopePaths(root, [rel], cwd); return previewUntrack(root, paths, { untrackPages: await verdict(paths) }); };
    for (const [cwd, rel] of [[brain, STRAY.slice(0, -1)], [root, SUB + STRAY.slice(0, -1)]] as const) {
      const paths = scopePaths(root, [rel], cwd);
      const pages = await verdict(paths);
      const refused = refusalOf(() => previewUntrack(root, paths, { untrackPages: pages }));
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [SUB + STRAY + 'kept-example.md'] });
      expect(refused.message).toContain('HEAD:' + SUB + 'gbrain.yml');
      expect(refused.message).toContain(join(brain, 'gbrain.yml'));
      expect(refused.suggestion).toContain('add it under storage.db_only in ' + SUB + 'gbrain.yml');
      expect(refusalOf(() => commitAndPush({ repo: root, cwd, paths: [rel], message: 'm', untrack: true, untrackPages: pages })).code).toBe('untrack_not_db_only');
    }
    const head = git(root, 'rev-parse', 'HEAD');
    for (const [dir, cwd, rel] of [[DIR, brain, DIR.slice(0, -1)], [DIR2, root, SUB + DIR2.slice(0, -1)]] as const) {
      const dry = (await listed(brain, dir.slice(0, -1))).sort();
      expect((await listed(root, SUB + dir.slice(0, -1))).sort()).toEqual(dry);
      expect(dry.length).toBeGreaterThan(0);
      const paths = scopePaths(root, [rel], cwd);
      expect(commitAndPush({ repo: root, cwd, paths: [rel], message: 'untrack ' + dir, untrack: true, untrackPages: await verdict(paths) })).toMatchObject({ outcome: 'committed_local', managed: true });
      expect(changed(root)).toEqual(dry);
    }
    expect(git(root, 'rev-parse', 'HEAD~2')).toBe(head);
    for (const full of [false, true]) {
      const synced = await syncAll(engine, full);
      expect(synced.added).toBe(0);
      expect(synced.deleted).toBe(0);
      expect(await rows(engine)).toEqual(before);
    }
  }, { databaseUrl, setup: subfolderSetup, sourceDir: SUB }), 180_000);

  test('a source rooted in a folder of its repository that imports code: from either working directory a .json file that is a live page refuses, and so does one its last sync skipped under the Markdown strategy, which the next sync imports; nothing is deleted', () => managedBrain(async ({ engine, root }) => {
    const json = JSON_FILES.map(file => SUB + file);
    git(root, 'rm', '-q', '--cached', json[1]!); git(root, 'commit', '-qm', 'the second backup arrives after the first import');
    await strategy(engine, 'auto');
    await syncAll(engine);
    await strategy(engine, 'markdown');
    git(root, 'add', '-f', json[1]!); git(root, 'commit', '-qm', 'the second backup committed under the ignored folder');
    await syncAll(engine);
    await strategy(engine, 'auto');
    const before = await rows(engine);
    expect(before['health-dedupe-backups-backup-1-json']).toMatchObject({ deleted: false });
    expect(before['health-dedupe-backups-backup-2-json']).toBeUndefined();
    const managed = managedFilesystemRootFor(root)!;
    const brain = join(root, SUB);
    const head = git(root, 'rev-parse', 'HEAD');
    for (const [cwd, paths] of [[brain, JSON_FILES], [root, json]] as const) {
      const pages = await readUntrackPageVerdict(engine, managed, root, scopePaths(root, [...paths], cwd));
      const refused = refusalOf(() => commitAndPush({ repo: root, cwd, paths: [...paths], message: 'm', untrack: true, untrackPages: pages }));
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: json });
      expect(refused.suggestion).toContain('would delete the pages at the next sync');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    for (const full of [false, true]) {
      const synced = await syncAll(engine, full);
      expect(synced.deleted).toBe(0);
      expect((await rows(engine))['health-dedupe-backups-backup-1-json']).toEqual(before['health-dedupe-backups-backup-1-json']);
      expect((await rows(engine))['health-dedupe-backups-backup-2-json']).toMatchObject({ deleted: false });
    }
  }, { databaseUrl, setup: subfolderSetup, sourceDir: SUB }), 180_000);

  test('a source rooted in a folder of its repository that keeps git-root slugs: a page whose slug carries the folder refuses, naming that slug, and a .json page is found under either spelling; nothing is deleted', () => managedBrain(async ({ engine, root }) => {
    await engine.executeRaw("UPDATE sources SET config = config || jsonb_build_object('slug_root_mode', 'git-root', 'strategy', 'auto') WHERE id='default'");
    await syncAll(engine);
    const before = await rows(engine);
    expect(before[SUB + PAGE]).toMatchObject({ deleted: false });
    expect(before['brain-health-dedupe-backups-backup-1-json']).toMatchObject({ deleted: false });
    const managed = managedFilesystemRootFor(root)!;
    const head = git(root, 'rev-parse', 'HEAD');
    const paths = [SUB + PAGE + '.md', ...JSON_FILES.map(file => SUB + file)];
    const pages = await readUntrackPageVerdict(engine, managed, root, paths);
    expect(pages).toMatchObject({ slugRoot: 'git-root' });
    for (const run of [() => previewUntrack(root, paths, { untrackPages: pages }), () => commitAndPush({ repo: root, cwd: root, paths, message: 'm', untrack: true, untrackPages: pages })]) {
      const refused = refusalOf(run);
      expect(refused.code).toBe('untrack_not_db_only');
      expect((JSON.parse(refused.detail!) as { paths: string[] }).paths.sort()).toEqual(paths.slice().sort());
      expect(refused.message).toContain('slug ' + SUB + PAGE);
      expect(refused.suggestion).toContain('add ' + SUB + DIR + ' under storage.db_only in ' + SUB + 'gbrain.yml');
      expect(refused.suggestion).toContain('would delete the pages at the next sync');
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    await syncAll(engine);
    expect(await rows(engine)).toEqual(before);
  }, { databaseUrl, setup: subfolderSetup, sourceDir: SUB }), 180_000);

  if (databaseUrl) test('the CLI, run inside a source rooted in a folder of its repository and at the repository top, lists and removes the same files and names the gbrain.yml it read', async () => {
    let brainUrl = '';
    await managedBrain(async ({ engine, root }) => {
      await syncAll(engine);
      const before = await rows(engine);
      const brain = join(root, SUB);
      const run = (cwd: string, args: string[]) => runCli(['git', 'commit-push', '--json', ...args], { home: process.env.GBRAIN_HOME!, cwd, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_DATABASE_URL: brainUrl } });
      const refused = await run(brain, ['--dry-run', '--untrack', '-m', 'm', '--', STRAY.slice(0, -1)]);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'untrack_not_db_only', message: expect.stringContaining('HEAD:' + SUB + 'gbrain.yml') });
      for (const [dir, cwd, rel] of [[DIR, brain, DIR.slice(0, -1)], [DIR2, root, SUB + DIR2.slice(0, -1)]] as const) {
        const dry = await Promise.all([run(brain, ['--dry-run', '--untrack', '-m', 'm', '--', dir.slice(0, -1)]), run(root, ['--dry-run', '--untrack', '-m', 'm', '--', SUB + dir.slice(0, -1)])]);
        for (const r of dry) expect(r.exitCode).toBe(0);
        const [a, b] = dry.map(r => (JSON.parse(r.stdout) as { untracked: string[] }).untracked.slice().sort());
        expect(a).toEqual(b);
        const real = await run(cwd, ['--untrack', '-m', 'untrack ' + dir, '--', rel]);
        expect(real.exitCode).toBe(0);
        expect(changed(root)).toEqual(a!);
      }
      for (const full of [false, true]) {
        const synced = await syncAll(engine, full);
        expect(synced.added).toBe(0);
        expect(synced.deleted).toBe(0);
        expect(await rows(engine)).toEqual(before);
      }
    }, { setup: subfolderSetup, sourceDir: SUB, open: async () => { const opened = await isolatedPersistencePostgres(databaseUrl); brainUrl = opened.databaseUrl; return opened; } });
  }, 180_000);
});

describe('GST-2964: the CLI in a managed worktree reads the brain for every untrack and nothing else', () => {
  let held: PGLiteEngine;
  let heldDir: string;
  beforeAll(async () => {
    heldDir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-gst2964-held-')));
    held = new PGLiteEngine();
    await held.connect({ database_path: join(heldDir, 'held-example.pglite') });
  }, 120_000);
  afterAll(async () => { await held.disconnect(); rmSync(heldDir, { recursive: true, force: true }); });

  test('a plain commit opens no brain; with the brain unreachable a Markdown, CSV or .json untrack refuses, dry or real, and changes nothing', () => managedBrain(async ({ engine, root }) => {
    await syncAll(engine);
    const pg = await countingListener();
    try {
      const run = (args: string[]) => runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home: process.env.GBRAIN_HOME!, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_DATABASE_URL: pg.url } });
      put(root, 'notes/plain-example.json', '{}\n');
      const plain = await run(['-m', 'a plain commit of a code-extension file', '--', 'notes/plain-example.json']);
      expect(plain.exitCode).toBe(0);
      expect(changed(root)).toEqual(['notes/plain-example.json']);
      expect(pg.connections()).toBe(0);
      const head = git(root, 'rev-parse', 'HEAD'), index = git(root, 'ls-files', '-s');
      for (const paths of [[PAGE + '.md', DIR + 'backup-3.csv'], JSON_FILES]) {
        for (const dry of [['--dry-run'], []]) {
          const refused = await run([...dry, '--untrack', '-m', 'm', '--', ...paths]);
          expect(refused.exitCode).toBe(1);
          const doc = JSON.parse(refused.stdout) as { code: string; detail: string; suggestion: string };
          expect(doc.code).toBe('untrack_not_db_only');
          expect((JSON.parse(doc.detail) as { paths: string[] }).paths.sort()).toEqual(paths.slice().sort());
          expect(doc.suggestion).toContain('could not be read to check');
        }
      }
      expect(pg.connections()).toBeGreaterThan(0);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(root, 'ls-files', '-s')).toBe(index);
    } finally { pg.close(); }
  }, { setup: managedSetup }), 180_000);

  test('on PGLite, a Markdown untrack refuses with the stop-and-rerun text while another process holds the brain', () => managedBrain(async ({ engine, root }) => {
    await syncAll(engine);
    const home = process.env.GBRAIN_HOME!;
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(heldDir, 'held-example.pglite') }));
    const head = git(root, 'rev-parse', 'HEAD');
    const refused = await runCli(['git', 'commit-push', '--path', root, '--json', '--untrack', '-m', 'm', '--', PAGE + '.md'], { home, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' } });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'untrack_not_db_only',
      suggestion: expect.stringContaining('If another process holds the brain (on PGLite, a running gbrain serve or a sync), stop it, then rerun the untrack') });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  }, { setup: managedSetup }), 180_000);
});
