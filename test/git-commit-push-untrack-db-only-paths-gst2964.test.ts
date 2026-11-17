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
 *   - The sync note for pages kept from the working tree no longer tells a database-only page to be committed.
 * Repo-less: commit-push needs a checkout; GST-2519's test covers the refusal outside one.
 * Seams: none; real repositories, the real CLI for the classic checkout, managed sync on PGLite and Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { commitAndPush, previewUntrack, untrackAdmitted, untrackPageCandidates } from '../src/core/git/commit-push.ts';
import { readUntrackPageVerdict, type UntrackPageVerdict } from '../src/core/git/untrack-admission.ts';
import { untrackPageVerdict } from '../src/commands/git.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
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
/** The brain's answer for a source whose sync strategy imports no code: every code-extension file is admitted by path. */
const NO_CODE: UntrackPageVerdict = { importsCode: false, live: new Set() };

describe('GST-2964: untrackAdmitted matches a file by its path under the declared folder', () => {
  test('every tracked file under a declared, ignored folder is admitted, whatever its extension', () => {
    const root = declaredCheckout();
    expect(untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), NO_CODE).sort()).toEqual(INSIDE);
    expect(untrackAdmitted(root, [`${DIR}backup-1.json`], managedAt(root), NO_CODE)).toEqual([`${DIR}backup-1.json`]);
    expect(untrackAdmitted(root, ['sources/Spaced Example/data.json'], managedAt(root), NO_CODE)).toEqual(['sources/Spaced Example/data.json']);
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
    const managed = managedAt(join(root, 'brain'));
    expect(untrackAdmitted(root, [`brain/${DIR.slice(0, -1)}`], managed, NO_CODE)).toEqual([`brain/${DIR}backup-1.json`]);
    expect(refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`], managed, NO_CODE)).code).toBe('untrack_not_db_only');
  });

  test('a file outside every declared folder refuses, and its fix says to declare the folder', () => {
    const root = declaredCheckout();
    for (const path of ['notes/plain.json', 'undeclared/x.json']) {
      const refused = refusalOf(() => untrackAdmitted(root, [path], managedAt(root), NO_CODE));
      expect(refused.code).toBe('untrack_not_db_only');
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [path] });
      expect(refused.suggestion).toContain('add it under storage.db_only in gbrain.yml');
    }
  });

  test('a declared folder .gitignore does not ignore refuses, and its fix names .gitignore, not the declaration', () => {
    const root = declaredCheckout();
    const refused = refusalOf(() => untrackAdmitted(root, ['logs/run-example'], managedAt(root), NO_CODE));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: ['logs/run-example/a.json'] });
    expect(refused.suggestion).toContain('.gitignore');
    expect(refused.suggestion).not.toContain('add it under storage.db_only');
  });

  test('a sibling folder that shares the declared name as a string prefix refuses', () => {
    const root = declaredCheckout();
    expect(refusalOf(() => untrackAdmitted(root, ['health/dedupe-backups-old'], managedAt(root), NO_CODE)).code).toBe('untrack_not_db_only');
    const mixed = refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`, 'health/dedupe-backups-old/backup-0.json'], managedAt(root), NO_CODE));
    expect(JSON.parse(mixed.detail!)).toEqual({ paths: ['health/dedupe-backups-old/backup-0.json'] });
  });

  test('a path that climbs out of the folder with .. refuses', () => {
    const root = declaredCheckout();
    for (const path of [`${DIR}../dedupe-backups-old/backup-0.json`, `${DIR}../../notes/plain.json`, `${DIR}..`]) {
      expect(['untrack_not_db_only', 'commit_paths_invalid']).toContain(refusalOf(() => untrackAdmitted(root, [path], managedAt(root), NO_CODE)).code ?? '');
    }
  });

  test('a tracked symlink pointing out of the folder refuses; one pointing inside it is admitted', () => {
    const root = declaredCheckout();
    symlinkSync('../../notes/plain.json', join(root, `${DIR}escape.json`));
    symlinkSync('backup-1.json', join(root, `${DIR}alias.json`));
    git(root, 'add', '-f', `${DIR}escape.json`, `${DIR}alias.json`); git(root, 'commit', '-qm', 'links');
    const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), NO_CODE));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: [`${DIR}escape.json`] });
    expect(refused.suggestion).toContain('symbolic link');
    expect(untrackAdmitted(root, [`${DIR}alias.json`], managedAt(root), NO_CODE)).toEqual([`${DIR}alias.json`]);
  });

  test('a declared folder that is a symlink on disk to a directory outside the checkout refuses', () => {
    const root = declaredCheckout();
    const elsewhere = join(scratch('elsewhere'), 'backups');
    renameSync(join(root, DIR), elsewhere);
    symlinkSync(elsewhere, join(root, DIR.slice(0, -1)));
    const refused = refusalOf(() => untrackAdmitted(root, [`${DIR}backup-1.json`], managedAt(root), NO_CODE));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(refused.suggestion).toContain('symbolic link');
  });

  test('a page file whose slug falls outside the declared spelling still refuses, with a fix about the slug spelling', () => {
    const root = declaredCheckout();
    const refused = refusalOf(() => untrackAdmitted(root, ['sources/Spaced Example'], managedAt(root), NO_CODE));
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
    expect(untrackPageCandidates(root, [DIR.slice(0, -1)], managedAt(root))).toEqual([
      { file: json, slug: 'health-dedupe-backups-backup-1-json', sourcePath: json },
      { file: ts, slug: 'health-dedupe-backups-tool-example-ts', sourcePath: ts },
    ]);
    expect(untrackPageCandidates(root, [`${DIR}notes-example.md`, `${DIR}backup-2.csv`], managedAt(root))).toEqual([]);
    expect(untrackPageCandidates(root, ['missing-example'], managedAt(root))).toEqual([]);
  });

  test('on a source that imports code, a file with no live page is admitted and one with a live page refuses, saying why', () => {
    const root = declaredCheckout();
    expect(untrackAdmitted(root, [json], managedAt(root), { importsCode: true, live: new Set() })).toEqual([json]);
    const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), { importsCode: true, live: new Set([json]) }));
    expect(refused.code).toBe('untrack_not_db_only');
    expect(JSON.parse(refused.detail!)).toEqual({ paths: [json] });
    expect(refused.suggestion).toContain('pages on this source and untracking them would delete the pages at the next sync');
  });

  test('with no answer from the brain, or an unreadable one, a code-extension file refuses (fail closed); Markdown and CSV do not need one', () => {
    const root = declaredCheckout();
    for (const pages of [undefined, { unreadable: 'pglite_busy' }]) {
      const refused = refusalOf(() => untrackAdmitted(root, [DIR.slice(0, -1)], managedAt(root), pages));
      expect(JSON.parse(refused.detail!)).toEqual({ paths: [json, ts] });
      expect(refused.suggestion).toContain('could not be read to check');
      expect(refused.suggestion).toContain('retry when it is free');
    }
    expect(untrackAdmitted(root, [`${DIR}notes-example.md`, `${DIR}backup-2.csv`], managedAt(root))).toEqual([`${DIR}notes-example.md`, `${DIR}backup-2.csv`]);
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
    await brain.executeRaw(`UPDATE sources SET local_path=$1, config = config || '{"strategy":"auto"}'::jsonb WHERE id='default'`, [join(home, 'content')]);
    await brain.disconnect();
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
  }, 120_000);
  afterAll(async () => { await brain.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('reads the source strategy and live pages from an on-disk brain, by source id or bound path, and reports a missing brain as unreadable', async () => {
    const candidates = [{ file: `${DIR}backup-1.json`, slug: 'health-dedupe-backups-backup-1-json', sourcePath: `${DIR}backup-1.json` }];
    const managed = { root: join(home, 'content'), sourceId: 'default', evidence: 'test' };
    await withEnv({ GBRAIN_HOME: join(home, 'empty'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(await untrackPageVerdict(managed, candidates)).toEqual({ unreadable: 'no brain is configured on this machine' });
    });
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(await untrackPageVerdict(managed, candidates)).toEqual({ importsCode: true, live: new Set() });
      expect(await untrackPageVerdict({ ...managed, sourceId: undefined }, candidates)).toEqual({ importsCode: true, live: new Set() });
    });
  }, 120_000);
});

describe('GST-2964: a classic checkout', () => {
  test('--dry-run --untrack lists exactly the files the real run removes, non-Markdown files included', async () => {
    const root = declaredCheckout();
    const home = scratch('home');
    const run = (args: string[]) => runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' } });
    const preview = await run(['--dry-run', '--untrack', '-m', 'm', '--', DIR.slice(0, -1)]);
    expect(preview.exitCode).toBe(0);
    const previewed = JSON.parse(preview.stdout) as { untracked: string[] };
    const real = await run(['--untrack', '-m', 'untrack backups', '--', DIR.slice(0, -1)]);
    expect(real.exitCode).toBe(0);
    expect(changed(root)).toEqual(INSIDE);
    expect(previewed.untracked.slice().sort()).toEqual(changed(root));
    for (const path of INSIDE) expect(readFileSync(join(root, path), 'utf8')).toBe(`${path}\n`);
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
const untrackWithBrain = async (engine: BrainEngine, root: string, paths: string[], opts: { dryRun?: boolean } = {}) => {
  const managed = { root, sourceId: 'default', evidence: 'test' };
  const untrackPages = await readUntrackPageVerdict(engine, managed, untrackPageCandidates(root, paths, managed));
  return opts.dryRun ? previewUntrack(root, paths, { untrackPages }) : commitAndPush({ repo: root, cwd: root, paths, message: 'untrack the backups', untrack: true, untrackPages });
};

for (const backend of testBackends()) describe(`[${backend}] GST-2964: --untrack in a managed canonical worktree`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a code-importing source whose tracked, ignored .json files have no pages: the untrack is admitted, the dry run lists the same files, and the next sync creates and deletes nothing', () => managedBrain(async ({ engine, root }) => {
    git(root, 'rm', '-q', '--cached', ...JSON_FILES); git(root, 'commit', '-qm', 'the backups arrive after the first import');
    await strategy(engine, 'auto');
    await syncAll(engine);
    git(root, 'add', '-f', ...JSON_FILES); git(root, 'commit', '-qm', 'backups committed under the ignored folder');
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

  test('the CLI opens no brain for a plain commit or a Markdown and CSV untrack, and fails closed on a .json untrack when it cannot read one', () => managedBrain(async ({ engine, root }) => {
    await syncAll(engine);
    const home = process.env.GBRAIN_HOME!;
    const run = (args: string[]) => runCli(['git', 'commit-push', '--path', root, '--json', ...args], { home, env: { GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' } });
    const head = git(root, 'rev-parse', 'HEAD');
    for (const args of [['--dry-run', '--untrack', '-m', 'm', '--', ...JSON_FILES], ['--untrack', '-m', 'm', '--', ...JSON_FILES]]) {
      const refused = await run(args);
      expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'untrack_not_db_only', suggestion: expect.stringContaining('could not be read to check') });
      expect(refused.exitCode).toBe(1);
    }
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    const md = await run(['--untrack', '-m', 'untrack markdown and csv', '--', `${PAGE}.md`, `${DIR}backup-3.csv`]);
    expect(md.exitCode).toBe(0);
    expect(changed(root)).toEqual([`${DIR}backup-3.csv`, `${PAGE}.md`]);
    put(root, 'notes/plain-example.json', '{}\n');
    const plain = await run(['-m', 'a plain commit of a code-extension file', '--', 'notes/plain-example.json']);
    expect(plain.exitCode).toBe(0);
    expect(changed(root)).toEqual(['notes/plain-example.json']);
  }, { databaseUrl, setup: managedSetup }), 180_000);
});
