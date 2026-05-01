import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performSync } from '../src/commands/sync.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-sync-command-'));
  tempDirs.push(repoPath);
  runGit(repoPath, 'init');
  runGit(repoPath, 'config', 'user.email', 'test@example.com');
  runGit(repoPath, 'config', 'user.name', 'Test User');
  return repoPath;
}

function runGit(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(repoPath: string, message: string): string {
  runGit(repoPath, 'add', '-A');
  runGit(repoPath, 'commit', '-m', message);
  return runGit(repoPath, 'rev-parse', 'HEAD');
}

function makeSyncEngine(input: {
  config?: Record<string, string>;
  pages?: string[];
}) {
  const config = new Map(Object.entries(input.config ?? {}));
  const pages = new Set(input.pages ?? []);
  const setConfigCalls: Array<[string, string]> = [];
  const deletedPages: string[] = [];
  const ingestLogs: unknown[] = [];
  const engine: any = {};

  Object.assign(engine, {
    getConfig: async (key: string) => config.get(key) ?? null,
    setConfig: async (key: string, value: string) => {
      config.set(key, value);
      setConfigCalls.push([key, value]);
    },
    getPage: async (slug: string) => {
      if (!pages.has(slug)) return null;
      return {
        id: 1,
        slug,
        type: 'concept',
        title: slug,
        compiled_truth: '',
        timeline: '',
        frontmatter: {},
        content_hash: 'hash',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    },
    deletePage: async (slug: string) => {
      pages.delete(slug);
      deletedPages.push(slug);
    },
    updateSlug: async (oldSlug: string, newSlug: string) => {
      if (!pages.has(oldSlug)) throw new Error(`missing ${oldSlug}`);
      pages.delete(oldSlug);
      pages.add(newSlug);
    },
    logIngest: async (entry: unknown) => {
      ingestLogs.push(entry);
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(engine),
  });

  return { engine, config, setConfigCalls, deletedPages, ingestLogs };
}

async function withSqliteEngine<T>(fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-sync-sqlite-'));
  tempDirs.push(dir);
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

describe('performSync incremental safety', () => {
  test('does not advance last_commit when a syncable import is skipped with an error', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts', 'seed.md'), '# Seed\n');
    const lastCommit = commitAll(repoPath, 'seed');

    writeFileSync(join(repoPath, 'concepts', 'bad.md'), [
      '---',
      'slug: concepts/wrong',
      'title: Bad Slug',
      '---',
      '',
      'This file should not be accepted under concepts/bad.',
    ].join('\n'));
    const headCommit = commitAll(repoPath, 'add bad slug');

    const { engine, setConfigCalls, ingestLogs } = makeSyncEngine({
      config: { 'sync.last_commit': lastCommit },
    });

    await expect(performSync(engine, { repoPath, noPull: true })).rejects.toThrow(/Sync failed/);
    expect(setConfigCalls).not.toContainEqual(['sync.last_commit', headCommit]);
    expect(ingestLogs).toEqual([]);
  });

  test('deletes the old page when a syncable file is renamed to an unsyncable path', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice is indexed as a durable page.',
    ].join('\n'));
    const lastCommit = commitAll(repoPath, 'seed alice');

    renameSync(join(repoPath, 'people', 'alice.md'), join(repoPath, 'people', 'README.md'));
    const headCommit = commitAll(repoPath, 'rename alice to resolver');

    const { engine, setConfigCalls, deletedPages } = makeSyncEngine({
      config: { 'sync.last_commit': lastCommit },
      pages: ['people/alice'],
    });

    const result = await performSync(engine, { repoPath, noPull: true });

    expect(result.status).toBe('synced');
    expect(result.deleted).toBe(1);
    expect(result.pagesAffected).toContain('people/alice');
    expect(deletedPages).toEqual(['people/alice']);
    expect(setConfigCalls).toContainEqual(['sync.last_commit', headCommit]);
    expect(setConfigCalls).toContainEqual(['markdown.repo_path', repoPath]);
  });

  test('records markdown repo path when the repo is already up to date', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts', 'seed.md'), '# Seed\n');
    const headCommit = commitAll(repoPath, 'seed');

    const { engine, setConfigCalls } = makeSyncEngine({
      config: { 'sync.last_commit': headCommit },
    });

    const result = await performSync(engine, { repoPath, noPull: true });

    expect(result.status).toBe('up_to_date');
    expect(setConfigCalls).toContainEqual(['sync.repo_path', repoPath]);
    expect(setConfigCalls).toContainEqual(['markdown.repo_path', repoPath]);
  });

  test('records markdown repo path when git advanced without syncable changes', async () => {
    const repoPath = makeRepo();
    writeFileSync(join(repoPath, 'README.txt'), 'seed\n');
    const lastCommit = commitAll(repoPath, 'seed');

    writeFileSync(join(repoPath, 'README.txt'), 'unsyncable update\n');
    const headCommit = commitAll(repoPath, 'unsyncable update');

    const { engine, setConfigCalls } = makeSyncEngine({
      config: { 'sync.last_commit': lastCommit },
    });

    const result = await performSync(engine, { repoPath, noPull: true });

    expect(result.status).toBe('up_to_date');
    expect(setConfigCalls).toContainEqual(['sync.last_commit', headCommit]);
    expect(setConfigCalls).toContainEqual(['sync.repo_path', repoPath]);
    expect(setConfigCalls).toContainEqual(['markdown.repo_path', repoPath]);
  });

  test('first sync dry-run does not import pages or advance sync metadata', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts', 'seed.md'), '# Seed\n');
    const headCommit = commitAll(repoPath, 'seed');

    await withSqliteEngine(async (engine) => {
      const result = await performSync(engine, { repoPath, noPull: true, dryRun: true });

      expect(result.status).toBe('dry_run');
      expect(result.fromCommit).toBeNull();
      expect(result.toCommit).toBe(headCommit);
      expect(result.added).toBe(1);
      expect(await engine.listPages({ limit: 10 })).toEqual([]);
      expect(await engine.getConfig('sync.last_commit')).toBeNull();
      expect(await engine.getConfig('markdown.repo_path')).toBeNull();
    });
  });

  test('full sync rejects import errors instead of reporting first_sync success', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts', 'bad.md'), [
      '---',
      'slug: concepts/wrong',
      'title: Bad Slug',
      '---',
      '',
      'This file should not be accepted under concepts/bad.',
    ].join('\n'));
    commitAll(repoPath, 'bad slug');

    await withSqliteEngine(async (engine) => {
      await expect(performSync(engine, { repoPath, noPull: true }))
        .rejects.toThrow(/Full sync failed for 1 file/);
      expect(await engine.listPages({ limit: 10 })).toEqual([]);
      expect(await engine.getConfig('sync.last_commit')).toBeNull();
    });
  });
});
