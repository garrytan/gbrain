import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatWatchSyncSummary, performSync } from '../src/commands/sync.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { SUBBRAIN_REGISTRY_CONFIG_KEY } from '../src/core/subbrains.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watch summary reports first_sync page counts', () => {
  const line = formatWatchSyncSummary({
    status: 'first_sync',
    fromCommit: null,
    toCommit: 'abc123',
    added: 2,
    modified: 1,
    deleted: 0,
    renamed: 0,
    chunksCreated: 3,
    pagesAffected: ['concepts/a', 'concepts/b', 'concepts/c'],
  }, new Date('2026-06-14T13:05:00.000Z'));

  expect(line).toBe('[13:05:00] First sync: +2 ~1 -0 R0');
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

function countSqliteRows(engine: SQLiteEngine, sql: string, ...params: unknown[]): number {
  const row = (engine as any).database.query(sql).get(...params) as { count: number };
  return Number(row.count);
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

  test('SQLite incremental sync removes DB state when a syncable file is renamed to an unsyncable path', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      'tags: [friend]',
      '---',
      '',
      'Alice is indexed as a durable page.',
      '',
      '- **2026-06-14** | Alice timeline note.',
    ].join('\n'));
    commitAll(repoPath, 'seed alice');

    await withSqliteEngine(async (engine) => {
      await performSync(engine, { repoPath, noPull: true });

      const originalPage = await engine.getPage('people/alice');
      expect(originalPage).not.toBeNull();
      if (!originalPage) throw new Error('expected people/alice page after initial sync');
      expect((await engine.getChunks('people/alice')).length).toBeGreaterThan(0);
      const originalManifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, 'people/alice');
      expect(originalManifest?.path).toBe('people/alice.md');

      renameSync(join(repoPath, 'people', 'alice.md'), join(repoPath, 'people', 'README.md'));
      const headCommit = commitAll(repoPath, 'rename alice to unsyncable readme');

      const result = await performSync(engine, { repoPath, noPull: true });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(0);
      expect(result.modified).toBe(0);
      expect(result.renamed).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.pagesAffected).toContain('people/alice');
      expect(await engine.getPage('people/alice')).toBeNull();
      expect(await engine.getPage('people/readme')).toBeNull();
      expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, 'people/alice')).toBeNull();
      expect(await engine.getChunks('people/alice')).toEqual([]);
      expect(countSqliteRows(
        engine,
        'SELECT count(*) AS count FROM content_chunks WHERE page_id = ?',
        originalPage.id,
      )).toBe(0);
      expect(countSqliteRows(
        engine,
        'SELECT count(*) AS count FROM note_manifest_entries WHERE scope_id = ? AND slug = ?',
        DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        'people/alice',
      )).toBe(0);
      expect(await engine.getConfig('sync.last_commit')).toBe(headCommit);
    });
  });

  test('SQLite incremental sync deletes the old page when a rename collides with an occupied slug', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice is the original page.',
    ].join('\n'));
    const lastCommit = commitAll(repoPath, 'seed alice');

    renameSync(join(repoPath, 'people', 'alice.md'), join(repoPath, 'people', 'bob.md'));
    const headCommit = commitAll(repoPath, 'rename alice to bob');

    await withSqliteEngine(async (engine) => {
      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Old Alice content.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('people/bob', {
        type: 'person',
        title: 'Existing Bob',
        compiled_truth: 'Existing Bob content.',
        timeline: '',
        frontmatter: {},
      });
      await engine.setConfig('sync.last_commit', lastCommit);

      const result = await performSync(engine, { repoPath, noPull: true });

      expect(result.status).toBe('synced');
      expect(result.renamed).toBe(1);
      expect(result.pagesAffected).toContain('people/alice');
      expect(result.pagesAffected).toContain('people/bob');
      expect(await engine.getPage('people/alice')).toBeNull();
      expect(await engine.getPage('people/bob')).toMatchObject({
        title: 'Alice',
        compiled_truth: 'Alice is the original page.',
      });
      expect(await engine.getConfig('sync.last_commit')).toBe(headCommit);
    });
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

  test('incremental sync imports committed Hangul-named markdown files', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    writeFileSync(join(repoPath, 'concepts', 'seed.md'), '# Seed\n');
    await commitAll(repoPath, 'seed');

    await withSqliteEngine(async (engine) => {
      await performSync(engine, { repoPath, noPull: true });

      writeFileSync(join(repoPath, 'concepts', '한글테스트.md'), '# 한글 테스트\n\n본문입니다.\n');
      const headCommit = commitAll(repoPath, 'add hangul file');

      const result = await performSync(engine, { repoPath, noPull: true });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(1);
      expect(result.pagesAffected).toContain('concepts/한글테스트');
      expect(await engine.getPage('concepts/한글테스트')).not.toBeNull();
      expect(await engine.getConfig('sync.last_commit')).toBe(headCommit);
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

  test('subbrain full sync imports with prefix and records scoped checkpoint', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice belongs to the personal sub-brain.',
    ].join('\n'));
    const headCommit = commitAll(repoPath, 'seed personal alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal', default: true },
        },
      }));

      const result = await performSync(engine, {
        subbrain: 'personal',
        noPull: true,
      });

      expect(result.status).toBe('first_sync');
      expect(await engine.getPage('personal/people/alice')).not.toBeNull();
      expect(await engine.getPage('people/alice')).toBeNull();
      expect(await engine.getConfig('sync.subbrains.personal.last_commit')).toBe(headCommit);
      expect(await engine.getConfig('sync.last_commit')).toBeNull();
      expect(await engine.getConfig('sync.repo_path')).toBeNull();
      expect(await engine.getConfig('markdown.repo_path')).toBeNull();
    });
  });

  test('configured repo path for a registered subbrain syncs with the subbrain prefix', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice belongs to the office sub-brain.',
    ].join('\n'));
    const headCommit = commitAll(repoPath, 'seed office alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig('sync.repo_path', repoPath);
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          office: { id: 'office', path: repoPath, prefix: 'office' },
        },
      }));

      const result = await performSync(engine, { noPull: true });

      expect(result.status).toBe('first_sync');
      expect(await engine.getPage('office/people/alice')).not.toBeNull();
      expect(await engine.getPage('people/alice')).toBeNull();
      expect(await engine.getConfig('sync.subbrains.office.last_commit')).toBe(headCommit);
      expect(await engine.getConfig('sync.last_commit')).toBeNull();
      expect(await engine.getConfig('markdown.repo_path')).toBeNull();
    });
  });

  test('existing legacy checkpoint keeps configured repo path in legacy sync mode', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice was synced before this repo was registered as a sub-brain.',
    ].join('\n'));
    const headCommit = commitAll(repoPath, 'seed legacy alice');

    await withSqliteEngine(async (engine) => {
      await performSync(engine, { repoPath, noPull: true });
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          office: { id: 'office', path: repoPath, prefix: 'office' },
        },
      }));

      const result = await performSync(engine, { noPull: true });

      expect(result.status).toBe('up_to_date');
      expect(await engine.getPage('people/alice')).not.toBeNull();
      expect(await engine.getPage('office/people/alice')).toBeNull();
      expect(await engine.getConfig('sync.last_commit')).toBe(headCommit);
      expect(await engine.getConfig('sync.subbrains.office.last_commit')).toBeNull();
      expect(await engine.getConfig('markdown.repo_path')).toBe(repoPath);
    });
  });

  test('configured repo path fails when multiple subbrains share the same real path', async () => {
    const repoPath = makeRepo();
    writeFileSync(join(repoPath, 'alice.md'), '# Alice\n');
    commitAll(repoPath, 'seed alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig('sync.repo_path', repoPath);
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          alpha: { id: 'alpha', path: repoPath, prefix: 'alpha' },
          beta: { id: 'beta', path: repoPath, prefix: 'beta' },
        },
      }));

      await expect(performSync(engine, { noPull: true }))
        .rejects.toThrow(/multiple sub-brains registered for repo path/i);
    });
  });

  test('all-subbrains sync keeps checkpoints independent', async () => {
    const personalRepo = makeRepo();
    mkdirSync(join(personalRepo, 'people'), { recursive: true });
    writeFileSync(join(personalRepo, 'people', 'alice.md'), '# Alice\n');
    const personalHead = commitAll(personalRepo, 'seed personal');

    const officeRepo = makeRepo();
    mkdirSync(join(officeRepo, 'people'), { recursive: true });
    writeFileSync(join(officeRepo, 'people', 'alice.md'), '# Office Alice\n');
    const officeHead = commitAll(officeRepo, 'seed office');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: personalRepo, prefix: 'personal' },
          office: { id: 'office', path: officeRepo, prefix: 'office' },
        },
      }));

      const result = await performSync(engine, {
        allSubbrains: true,
        noPull: true,
      });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(2);
      expect(result.pagesAffected).toEqual(expect.arrayContaining([
        'personal/people/alice',
        'office/people/alice',
      ]));
      expect(await engine.getConfig('sync.subbrains.personal.last_commit')).toBe(personalHead);
      expect(await engine.getConfig('sync.subbrains.office.last_commit')).toBe(officeHead);
      expect(await engine.getPage('personal/people/alice')).not.toBeNull();
      expect(await engine.getPage('office/people/alice')).not.toBeNull();
    });
  });

  test('all-subbrains sync reports up_to_date when every target is already synced', async () => {
    const personalRepo = makeRepo();
    writeFileSync(join(personalRepo, 'alice.md'), '# Alice\n');
    commitAll(personalRepo, 'seed personal');

    const officeRepo = makeRepo();
    writeFileSync(join(officeRepo, 'alice.md'), '# Office Alice\n');
    commitAll(officeRepo, 'seed office');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: personalRepo, prefix: 'personal' },
          office: { id: 'office', path: officeRepo, prefix: 'office' },
        },
      }));

      await performSync(engine, { allSubbrains: true, noPull: true });
      const result = await performSync(engine, { allSubbrains: true, noPull: true });

      expect(result.status).toBe('up_to_date');
      expect(result.targets?.map(target => [target.id, target.status])).toEqual([
        ['office', 'up_to_date'],
        ['personal', 'up_to_date'],
      ]);
    });
  });

  test('content-identical subbrain renames refresh note manifest path and slug', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    const content = [
      '---',
      'title: Alice',
      '---',
      '',
      'Alice belongs to the personal sub-brain.',
    ].join('\n');
    writeFileSync(join(repoPath, 'people', 'alice.md'), content);
    commitAll(repoPath, 'seed alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal' },
        },
      }));

      await performSync(engine, { subbrain: 'personal', noPull: true });

      renameSync(join(repoPath, 'people', 'alice.md'), join(repoPath, 'people', 'alice-renamed.md'));
      commitAll(repoPath, 'rename alice');

      await performSync(engine, { subbrain: 'personal', noPull: true });

      expect(await engine.getPage('personal/people/alice')).toBeNull();
      expect(await engine.getPage('personal/people/alice-renamed')).not.toBeNull();
      expect(await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, 'personal/people/alice')).toBeNull();
      const manifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, 'personal/people/alice-renamed');
      expect(manifest?.path).toBe('people/alice-renamed.md');
    });
  });

  test('subbrain full sync removes stale pages missing from the repo before advancing checkpoint', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), '# Alice\n');
    commitAll(repoPath, 'seed alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal' },
        },
      }));

      await performSync(engine, { subbrain: 'personal', noPull: true });
      expect(await engine.getPage('personal/people/alice')).not.toBeNull();

      unlinkSync(join(repoPath, 'people', 'alice.md'));
      const headCommit = commitAll(repoPath, 'delete alice');

      const result = await performSync(engine, { subbrain: 'personal', full: true, noPull: true });

      expect(result.deleted).toBe(1);
      expect(result.pagesAffected).toContain('personal/people/alice');
      expect(await engine.getPage('personal/people/alice')).toBeNull();
      expect(await engine.getConfig('sync.subbrains.personal.last_commit')).toBe(headCommit);
    });
  });

  test('incremental subbrain dry-run reports prefixed slugs without advancing checkpoints', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), '# Alice\n');
    const firstCommit = commitAll(repoPath, 'seed alice');

    await withSqliteEngine(async (engine) => {
      await engine.setConfig(SUBBRAIN_REGISTRY_CONFIG_KEY, JSON.stringify({
        subbrains: {
          personal: { id: 'personal', path: repoPath, prefix: 'personal' },
        },
      }));
      await performSync(engine, { subbrain: 'personal', noPull: true });

      writeFileSync(join(repoPath, 'people', 'bob.md'), '# Bob\n');
      commitAll(repoPath, 'add bob');

      const result = await performSync(engine, { subbrain: 'personal', noPull: true, dryRun: true });

      expect(result.status).toBe('dry_run');
      expect(result.pagesAffected).toEqual(['personal/people/bob']);
      expect(await engine.getPage('personal/people/bob')).toBeNull();
      expect(await engine.getConfig('sync.subbrains.personal.last_commit')).toBe(firstCommit);
    });
  });

  test('rejects combining explicit repo path with subbrain target', async () => {
    const repoPath = makeRepo();
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people', 'alice.md'), '# Alice\n');
    commitAll(repoPath, 'seed alice');

    const { engine } = makeSyncEngine({
      config: {
        [SUBBRAIN_REGISTRY_CONFIG_KEY]: JSON.stringify({
          subbrains: {
            personal: { id: 'personal', path: repoPath, prefix: 'personal' },
          },
        }),
      },
    });

    await expect(performSync(engine, {
      repoPath,
      subbrain: 'personal',
      noPull: true,
    })).rejects.toThrow('Cannot combine --repo with --subbrain or --all-subbrains');
  });
});
