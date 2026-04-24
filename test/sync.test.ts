import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { buildSyncManifest, isSyncable, pathToSlug } from '../src/core/sync.ts';

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createSyncMockEngine(configSeed: Record<string, string>) {
  const config = new Map(Object.entries(configSeed));
  const pages = new Map<string, any>();
  const tags = new Map<string, Set<string>>();
  const chunks = new Map<string, any[]>();
  let inTransaction = false;
  let transactionCalls = 0;

  const engine = {
    async getConfig(key: string) {
      return config.get(key) ?? null;
    },
    async setConfig(key: string, value: string) {
      config.set(key, value);
    },
    async getPage(slug: string) {
      return pages.get(slug) ?? null;
    },
    async putPage(slug: string, page: any) {
      const stored = { id: pages.size + 1, slug, ...page };
      pages.set(slug, stored);
      return stored;
    },
    async deletePage(slug: string) {
      pages.delete(slug);
      tags.delete(slug);
      chunks.delete(slug);
    },
    async updateSlug(oldSlug: string, newSlug: string) {
      const page = pages.get(oldSlug);
      if (!page) throw new Error(`missing page: ${oldSlug}`);
      pages.delete(oldSlug);
      pages.set(newSlug, { ...page, slug: newSlug });
    },
    async createVersion() {
      return { id: 1 };
    },
    async getTags(slug: string) {
      return [...(tags.get(slug) ?? new Set<string>())];
    },
    async addTag(slug: string, tag: string) {
      const existing = tags.get(slug) ?? new Set<string>();
      existing.add(tag);
      tags.set(slug, existing);
    },
    async removeTag(slug: string, tag: string) {
      tags.get(slug)?.delete(tag);
    },
    async upsertChunks(slug: string, nextChunks: any[]) {
      chunks.set(slug, nextChunks);
    },
    async deleteChunks(slug: string) {
      chunks.delete(slug);
    },
    async logIngest() {},
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>) {
      if (inTransaction) throw new Error('nested transaction');
      inTransaction = true;
      transactionCalls += 1;
      try {
        return await fn(engine as unknown as BrainEngine);
      } finally {
        inTransaction = false;
      }
    },
    _pages: pages,
    _chunks: chunks,
    get _transactionCalls() {
      return transactionCalls;
    },
  };

  return engine as typeof engine & BrainEngine;
}

describe('buildSyncManifest', () => {
  test('parses A/M/D entries from single commit', () => {
    const output = `A\tpeople/new-person.md\nM\tpeople/existing-person.md\nD\tpeople/deleted-person.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/new-person.md']);
    expect(manifest.modified).toEqual(['people/existing-person.md']);
    expect(manifest.deleted).toEqual(['people/deleted-person.md']);
    expect(manifest.renamed).toEqual([]);
  });

  test('parses R100 rename entries', () => {
    const output = `R100\tpeople/old-name.md\tpeople/new-name.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old-name.md', to: 'people/new-name.md' }]);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
  });

  test('parses partial rename (R075)', () => {
    const output = `R075\tpeople/old.md\tpeople/new.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old.md', to: 'people/new.md' }]);
  });

  test('handles empty diff', () => {
    const manifest = buildSyncManifest('');
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });

  test('handles mixed entries with blank lines', () => {
    const output = `A\tpeople/a.md\n\nM\tpeople/b.md\n\nD\tpeople/c.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
    expect(manifest.deleted).toEqual(['people/c.md']);
  });

  test('skips malformed lines', () => {
    const output = `A\tpeople/a.md\ngarbage line\nM\tpeople/b.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
  });
});

describe('isSyncable', () => {
  test('accepts normal .md files', () => {
    expect(isSyncable('people/pedro-franceschi.md')).toBe(true);
    expect(isSyncable('meetings/2026-04-03-lunch.md')).toBe(true);
    expect(isSyncable('daily/2026-04-05.md')).toBe(true);
    expect(isSyncable('notes.md')).toBe(true);
  });

  test('accepts .mdx files', () => {
    expect(isSyncable('components/hero.mdx')).toBe(true);
    expect(isSyncable('docs/getting-started.mdx')).toBe(true);
  });

  test('rejects non-.md/.mdx files', () => {
    expect(isSyncable('people/photo.jpg')).toBe(false);
    expect(isSyncable('config.json')).toBe(false);
    expect(isSyncable('src/cli.ts')).toBe(false);
  });

  test('rejects files in hidden directories', () => {
    expect(isSyncable('.git/config')).toBe(false);
    expect(isSyncable('.obsidian/plugins.md')).toBe(false);
    expect(isSyncable('people/.hidden/secret.md')).toBe(false);
  });

  test('rejects .raw/ sidecar directories', () => {
    expect(isSyncable('people/pedro.raw/source.md')).toBe(false);
    expect(isSyncable('dir/.raw/notes.md')).toBe(false);
  });

  test('rejects skip-list basenames', () => {
    expect(isSyncable('schema.md')).toBe(false);
    expect(isSyncable('index.md')).toBe(false);
    expect(isSyncable('log.md')).toBe(false);
    expect(isSyncable('README.md')).toBe(false);
    expect(isSyncable('people/README.md')).toBe(false);
  });

  test('rejects ops/ directory', () => {
    expect(isSyncable('ops/deploy-log.md')).toBe(false);
    expect(isSyncable('ops/config.md')).toBe(false);
  });
});

describe('pathToSlug', () => {
  test('strips .md extension and lowercases', () => {
    expect(pathToSlug('people/pedro-franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('normalizes to lowercase', () => {
    expect(pathToSlug('People/Pedro-Franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('strips leading slash', () => {
    expect(pathToSlug('/people/pedro.md')).toBe('people/pedro');
  });

  test('normalizes backslash separators', () => {
    expect(pathToSlug('people\\pedro.md')).toBe('people/pedro');
  });

  test('handles flat files', () => {
    expect(pathToSlug('notes.md')).toBe('notes');
  });

  test('handles nested paths', () => {
    expect(pathToSlug('projects/gbrain/spec.md')).toBe('projects/gbrain/spec');
  });

  test('adds repo prefix when provided', () => {
    expect(pathToSlug('people/pedro.md', 'brain')).toBe('brain/people/pedro');
  });

  test('no prefix when not provided', () => {
    expect(pathToSlug('people/pedro.md')).toBe('people/pedro');
  });

  test('handles empty string', () => {
    expect(pathToSlug('')).toBe('');
  });

  test('handles file with only extension', () => {
    expect(pathToSlug('.md')).toBe('');
  });

  test('slugifies spaces to hyphens', () => {
    expect(pathToSlug('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
  });

  test('strips special characters', () => {
    expect(pathToSlug('notes/meeting (march 2024).md')).toBe('notes/meeting-march-2024');
  });
});

describe('isSyncable edge cases', () => {
  test('rejects uppercase .MD extension', () => {
    // isSyncable checks path.endsWith('.md'), so .MD should fail
    expect(isSyncable('people/someone.MD')).toBe(false);
  });

  test('rejects files with no extension', () => {
    expect(isSyncable('README')).toBe(false);
  });

  test('accepts deeply nested .md files', () => {
    expect(isSyncable('a/b/c/d/e/f/deep.md')).toBe(true);
  });

  test('rejects .md files inside nested hidden dirs', () => {
    expect(isSyncable('docs/.internal/secret.md')).toBe(false);
  });
});

describe('buildSyncManifest edge cases', () => {
  test('handles tab-separated fields correctly', () => {
    const output = "A\tpath/to/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['path/to/file.md']);
  });

  test('handles multiple renames', () => {
    const output = [
      'R100\told/a.md\tnew/a.md',
      'R095\told/b.md\tnew/b.md',
    ].join('\n');
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toHaveLength(2);
    expect(manifest.renamed[0].from).toBe('old/a.md');
    expect(manifest.renamed[1].from).toBe('old/b.md');
  });

  test('ignores unknown status codes', () => {
    const output = "X\tunknown/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });
});

describe('performSync transaction boundaries', () => {
  test('imports batches above ten files without nesting import transactions', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-unit-'));

    try {
      git(repoPath, 'init');
      git(repoPath, 'config', 'user.email', 'test@example.com');
      git(repoPath, 'config', 'user.name', 'Test User');

      writeFileSync(join(repoPath, 'seed.md'), [
        '---',
        'type: concept',
        'title: Seed',
        '---',
        '',
        'Baseline content.',
      ].join('\n'));
      git(repoPath, 'add', '-A');
      git(repoPath, 'commit', '-m', 'seed');
      const baseCommit = git(repoPath, 'rev-parse', 'HEAD');

      mkdirSync(join(repoPath, 'notes'), { recursive: true });
      for (let i = 1; i <= 11; i += 1) {
        writeFileSync(join(repoPath, 'notes', `batch-${i}.md`), [
          '---',
          'type: concept',
          `title: Batch ${i}`,
          'tags: [sync-test]',
          '---',
          '',
          `Batch note ${i} should import during the same incremental sync.`,
        ].join('\n'));
      }
      git(repoPath, 'add', '-A');
      git(repoPath, 'commit', '-m', 'add batch');

      const engine = createSyncMockEngine({ 'sync.last_commit': baseCommit });
      const result = await performSync(engine, {
        repoPath,
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(11);
      expect(result.pagesAffected).toHaveLength(11);
      expect(engine._pages.size).toBe(11);
      expect(engine._chunks.size).toBe(11);
      expect(engine._transactionCalls).toBe(11);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
