import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import {
  collectImportSummary,
  resolveImportPlan,
  runImportService,
} from '../src/core/services/import-service.ts';
import { runImport } from '../src/commands/import.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runGit(cwd: string, ...args: string[]) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

describe('import service', () => {
  test('collectImportSummary tracks imported, skipped, errors, and unchanged files', () => {
    const summary = collectImportSummary({
      totalFiles: 3,
      events: [
        { type: 'imported', slug: 'notes/a', chunks: 2 },
        { type: 'skipped', reason: 'unchanged' },
        { type: 'error', message: 'bad frontmatter' },
      ],
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.unchanged).toBe(1);
    expect(summary.chunksCreated).toBe(2);
    expect(summary.totalFiles).toBe(3);
  });

  test('resolveImportPlan resumes when checkpoint matches root and file count', () => {
    const allFiles = ['/brain/a.md', '/brain/b.md', '/brain/c.md'];
    const plan = resolveImportPlan({
      rootDir: '/brain',
      allFiles,
      fresh: false,
      checkpoint: {
        dir: '/brain',
        totalFiles: allFiles.length,
        processedIndex: 2,
        timestamp: new Date().toISOString(),
      },
    });

    expect(plan.resumeIndex).toBe(2);
    expect(plan.files).toEqual(['/brain/c.md']);
    expect(plan.resumed).toBe(true);
  });

  test('runImportService preserves checkpoints before failed files so resume retries them', async () => {
    const rootDir = makeTempDir('mbrain-import-root-');
    for (let index = 0; index <= 100; index++) {
      const fileName = `${String(index).padStart(3, '0')}.md`;
      writeFileSync(join(rootDir, fileName), `# note ${index}\n`);
    }

    const checkpointPath = join(rootDir, 'nested', 'state', 'import-checkpoint.json');
    const engine = {
      logIngest: async () => undefined,
      setConfig: async () => undefined,
    } as any;
    const attemptedFilesByRun: string[][] = [[]];
    let runIndex = 0;

    const firstSummary = await runImportService(
      engine,
      { rootDir, workers: 1, checkpointPath },
      {
        createConnectedEngine: async () => {
          throw new Error('not used');
        },
        importFile: async (_engine, filePath) => {
          const relativePath = relative(rootDir, filePath);
          attemptedFilesByRun[runIndex].push(relativePath);
          if (runIndex === 0 && relativePath === '099.md') {
            throw new Error('boom');
          }
          return { slug: filePath, status: 'imported' as const, chunks: 1 };
        },
        loadConfig: () => null,
        supportsParallelWorkers: () => false,
      },
    );

    expect(firstSummary.errors).toBe(1);
    expect(existsSync(checkpointPath)).toBe(true);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    expect(checkpoint.dir).toBe(rootDir);
    expect(checkpoint.totalFiles).toBe(101);
    expect(checkpoint.processedIndex).toBe(99);

    runIndex = 1;
    attemptedFilesByRun.push([]);

    const secondSummary = await runImportService(
      engine,
      { rootDir, workers: 1, checkpointPath },
      {
        createConnectedEngine: async () => {
          throw new Error('not used');
        },
        importFile: async (_engine, filePath) => {
          const relativePath = relative(rootDir, filePath);
          attemptedFilesByRun[runIndex].push(relativePath);
          return { slug: filePath, status: 'imported' as const, chunks: 1 };
        },
        loadConfig: () => null,
        supportsParallelWorkers: () => false,
      },
    );

    expect(secondSummary.errors).toBe(0);
    expect(attemptedFilesByRun[1]).toEqual(['099.md', '100.md']);
    expect(existsSync(checkpointPath)).toBe(false);
  });

  test('runImportService does not advance sync.last_commit when a git-backed import fails', async () => {
    const rootDir = makeTempDir('mbrain-import-git-failure-');
    writeFileSync(join(rootDir, 'note.md'), '# note\n');
    runGit(rootDir, 'init');
    runGit(rootDir, 'config', 'user.email', 'test@example.com');
    runGit(rootDir, 'config', 'user.name', 'Test User');
    runGit(rootDir, 'add', 'note.md');
    runGit(rootDir, 'commit', '-m', 'seed');

    const setConfigCalls: Array<[string, unknown]> = [];
    const engine = {
      setConfig: async (key: string, value: unknown) => {
        setConfigCalls.push([key, value]);
      },
    } as any;

    const summary = await runImportService(
      engine,
      { rootDir, workers: 1 },
      {
        createConnectedEngine: async () => {
          throw new Error('not used');
        },
        importFile: async () => {
          throw new Error('boom');
        },
        loadConfig: () => null,
        supportsParallelWorkers: () => false,
      },
    );

    expect(summary.errors).toBe(1);
    expect(setConfigCalls.some(([key]) => key === 'sync.last_commit')).toBe(false);
    expect(setConfigCalls.some(([key, value]) => key === 'sync.repo_path' && value === rootDir)).toBe(true);
    expect(setConfigCalls.some(([key]) => key === 'sync.last_run')).toBe(true);
  });

  test('runImportService uses staged local concurrency for prepare work but commits in file order', async () => {
    const rootDir = makeTempDir('mbrain-import-staged-');
    for (const name of ['a.md', 'b.md', 'c.md']) {
      writeFileSync(join(rootDir, name), `# ${name}\n`);
    }

    let prepareActive = 0;
    let maxPrepareActive = 0;
    let commitActive = 0;
    let maxCommitActive = 0;
    const commitOrder: string[] = [];

    const summary = await runImportService(
      {
        setConfig: async () => undefined,
      } as any,
      { rootDir, workers: 3 },
      {
        createConnectedEngine: async () => {
          throw new Error('multi-writer engines should not be created for staged local imports');
        },
        importFile: async () => {
          throw new Error('legacy per-file import path should not run for staged local imports');
        },
        loadConfig: () => ({
          engine: 'sqlite',
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
          database_path: join(rootDir, 'brain.db'),
        }),
        supportsParallelWorkers: () => false,
        getEngineCapabilities: () => ({
          rawPostgresAccess: false,
          parallelWorkers: false,
          stagedImportConcurrency: true,
          localVectorPrefilter: 'page-centroid',
        }),
        prepareImportFile: async (filePath: string, relativePath: string) => {
          prepareActive++;
          maxPrepareActive = Math.max(maxPrepareActive, prepareActive);
          const delay = relativePath === 'a.md' ? 30 : relativePath === 'b.md' ? 10 : 0;
          await wait(delay);
          prepareActive--;
          return {
            status: 'ready' as const,
            filePath,
            relativePath,
            slug: relativePath.replace(/\.md$/, ''),
            chunks: [{ chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: relativePath }],
          };
        },
        commitPreparedImport: async (_engine: unknown, prepared: { relativePath: string; slug: string; chunks: unknown[] }) => {
          commitActive++;
          maxCommitActive = Math.max(maxCommitActive, commitActive);
          commitOrder.push(prepared.relativePath);
          await wait(1);
          commitActive--;
          return {
            slug: prepared.slug,
            status: 'imported' as const,
            chunks: prepared.chunks.length,
          };
        },
      } as any,
    );

    expect(summary.imported).toBe(3);
    expect(maxPrepareActive).toBeGreaterThan(1);
    expect(maxCommitActive).toBe(1);
    expect(commitOrder).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('runImportService isolates staged prepare failures and continues committing later files in order', async () => {
    const rootDir = makeTempDir('mbrain-import-staged-prepare-error-');
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      writeFileSync(join(rootDir, name), `# ${name}\n`);
    }

    const commitOrder: string[] = [];

    const summary = await runImportService(
      {
        setConfig: async () => undefined,
      } as any,
      { rootDir, workers: 3 },
      {
        createConnectedEngine: async () => {
          throw new Error('multi-writer engines should not be created for staged local imports');
        },
        importFile: async () => {
          throw new Error('legacy per-file import path should not run for staged local imports');
        },
        loadConfig: () => ({
          engine: 'sqlite',
          offline: true,
          embedding_provider: 'local',
          query_rewrite_provider: 'heuristic',
          database_path: join(rootDir, 'brain.db'),
        }),
        supportsParallelWorkers: () => false,
        getEngineCapabilities: () => ({
          rawPostgresAccess: false,
          parallelWorkers: false,
          stagedImportConcurrency: true,
          localVectorPrefilter: 'page-centroid',
        }),
        prepareImportFile: async (filePath: string, relativePath: string) => {
          if (relativePath === 'b.md') {
            throw new Error('prepare exploded');
          }
          return {
            status: 'ready' as const,
            filePath,
            relativePath,
            slug: relativePath.replace(/\.md$/, ''),
            chunks: [{ chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: relativePath }],
          };
        },
        commitPreparedImport: async (_engine: unknown, prepared: { relativePath: string; slug: string; chunks: unknown[] }) => {
          commitOrder.push(prepared.relativePath);
          return {
            slug: prepared.slug,
            status: 'imported' as const,
            chunks: prepared.chunks.length,
          };
        },
      } as any,
    );

    expect(summary.imported).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(commitOrder).toEqual(['a.md', 'c.md', 'd.md']);
  });

  test('runImport prints the final summary before ingest logging errors surface', async () => {
    const rootDir = makeTempDir('mbrain-import-command-');
    writeFileSync(join(rootDir, 'note.md'), [
      '---',
      'title: Note',
      'type: note',
      '---',
      '',
      'Compiled truth.',
    ].join('\n'));

    const logs: string[] = [];
    const consoleLog = console.log;
    console.log = ((msg?: unknown) => {
      logs.push(String(msg ?? ''));
    }) as typeof console.log;

    const engine = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      initSchema: async () => undefined,
      transaction: async (fn: (tx: any) => Promise<unknown>) => fn(engine),
      getPage: async () => null,
      putPage: async (_slug: string, page: Record<string, unknown>) => ({
        id: 1,
        slug: 'note',
        type: page.type,
        title: page.title,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline ?? '',
        frontmatter: page.frontmatter ?? {},
        content_hash: page.content_hash,
      }),
      deletePage: async () => undefined,
      listPages: async () => [],
      resolveSlugs: async () => [],
      searchKeyword: async () => [],
      searchVector: async () => [],
      upsertChunks: async () => undefined,
      getChunks: async () => [],
      deleteChunks: async () => undefined,
      getPageEmbeddings: async () => [],
      updatePageEmbedding: async () => undefined,
      addLink: async () => undefined,
      removeLink: async () => undefined,
      getLinks: async () => [],
      getBacklinks: async () => [],
      traverseGraph: async () => [],
      addTag: async () => undefined,
      removeTag: async () => undefined,
      getTags: async () => [],
      addTimelineEntry: async () => undefined,
      getTimeline: async () => [],
      putRawData: async () => undefined,
      getRawData: async () => [],
      createVersion: async () => ({ id: 1 }),
      getVersions: async () => [],
      revertToVersion: async () => undefined,
      getStats: async () => ({
        page_count: 0,
        chunk_count: 0,
        embedded_count: 0,
        link_count: 0,
        tag_count: 0,
        timeline_entry_count: 0,
        pages_by_type: {},
      }),
      getHealth: async () => ({
        page_count: 0,
        embed_coverage: 0,
        stale_pages: 0,
        orphan_pages: 0,
        dead_links: 0,
        missing_embeddings: 0,
      }),
      logIngest: async () => {
        throw new Error('ingest logging failed');
      },
      getIngestLog: async () => [],
      upsertNoteManifestEntry: async (input: Record<string, unknown>) => ({
        ...input,
        last_indexed_at: new Date(),
      }),
      getNoteManifestEntry: async () => null,
      listNoteManifestEntries: async () => [],
      deleteNoteManifestEntry: async () => undefined,
      replaceNoteSectionEntries: async () => [],
      updateSlug: async () => undefined,
      rewriteLinks: async () => undefined,
      getConfig: async () => null,
      setConfig: async () => undefined,
      runMigration: async () => undefined,
      getChunksWithEmbeddings: async () => [],
    } as any;

    try {
      await expect(runImport(engine, [rootDir, '--workers', '1'])).rejects.toThrow('ingest logging failed');
    } finally {
      console.log = consoleLog;
    }

    const output = logs.join('\n');
    expect(output).toContain('Import complete');
    expect(output).toContain('1 pages imported');
  });
});
