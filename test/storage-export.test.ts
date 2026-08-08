/**
 * Tests for export.ts --restore-only resolution chain — step 9 of v0.22.3.
 *
 * D5: --repo → sources.getDefault() → hard error. Never fall through to
 * cwd. Issue #9: bare try/catch removed from storage.ts:37.
 *
 * Tests use PGLite in-memory and a captured-output approach (process.exit
 * is intercepted) to verify the resolution chain produces the right
 * repoPath OR the right error.
 *
 * Also covers per-source scoping of the two sidecar reads in the export loop
 * (tags + raw data), which are keyed by slug and so cross source boundaries
 * unless pinned to the page's own source.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmp: string;
let outDir: string;
let exitCode: number | null;
let originalExit: typeof process.exit;
let originalErr: typeof console.error;
let originalLog: typeof console.log;
let stderr: string[];
let stdout: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-export-test-'));
  outDir = join(tmp, 'out');
  exitCode = null;
  stderr = [];
  stdout = [];
  __resetMissingStorageWarning();

  originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__test_exit__:${code}`);
  }) as typeof process.exit;

  originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };

  // Reset DB state between tests
  const tables = ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'sources'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  // Recreate the default source (the schema seed but truncated above).
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`,
  );
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalErr;
  console.log = originalLog;
  rmSync(tmp, { recursive: true, force: true });
});

async function tryRunExport(args: string[]): Promise<void> {
  try {
    await runExport(engine, args);
  } catch (e) {
    // Swallow only the test-exit sentinel; rethrow others for visibility.
    if (!(e instanceof Error && e.message.startsWith('__test_exit__:'))) {
      throw e;
    }
  }
}

describe('export --restore-only resolution chain (D5)', () => {
  test('hard-errors when --restore-only has no --repo and no default source path', async () => {
    // sources.default has no local_path (the seeded shape).
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/requires --repo|configured default source/);
  });

  test('uses explicit --repo when provided', async () => {
    // Make a brain repo with gbrain.yml that has empty db_only — so we
    // exit through the "0 pages to restore" path without needing real data.
    writeFileSync(
      join(tmp, 'gbrain.yml'),
      `storage:
  db_tracked: []
  db_only: []
`,
    );
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', tmp]);
    expect(exitCode).toBeNull(); // no exit
    expect(stdout.some((line) => line.includes('Restoring 0'))).toBe(true);
  });

  test('falls back to sources default local_path when --repo absent', async () => {
    // Configure default source path, write a real gbrain.yml so the storage
    // config check passes — without gbrain.yml the Codex-P0 guard correctly
    // refuses --restore-only (no storage config to scope to).
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);
    writeFileSync(
      join(tmp, 'gbrain.yml'),
      `storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n`,
    );
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBeNull(); // resolution succeeded
  });

  test('refuses --restore-only when no storage config is present (Codex P0)', async () => {
    // Default source has a path but no gbrain.yml. Without a storage config,
    // --restore-only would silently fall through to a full export — exactly
    // the silent-footgun D5 was supposed to prevent.
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/storage tiering config|gbrain\.yml/);
  });

  test('non-restore export does NOT require --repo (D26)', async () => {
    // Regular export works without --repo since it dumps everything from DB.
    // Pages table is empty → exports 0 pages, no error.
    await tryRunExport(['--dir', outDir]);
    expect(exitCode).toBeNull();
    expect(stdout.some((line) => line.includes('Exporting 0'))).toBe(true);
  });
});

describe('export sidecar reads are scoped to the page owning source', () => {
  // Both fixtures use the SAME slug in two sources — the only shape where a
  // slug-keyed read can cross a boundary, since slugs are unique per source
  // rather than brain-wide.
  const SLUG = 'notes/shared';

  beforeEach(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT DO NOTHING`,
    );
    for (const sourceId of ['default', 'other']) {
      await engine.putPage(
        SLUG,
        { type: 'note', title: `${sourceId} title`, compiled_truth: 'body' },
        { sourceId },
      );
      await engine.addTag(SLUG, `tag-${sourceId}`, { sourceId });
      await engine.putRawData(SLUG, `feed-${sourceId}`, { owner: sourceId }, { sourceId });
    }

    // One slug means one output path, so the two pages overwrite each other
    // and only the last one written survives on disk. Pin the export order
    // (listPages defaults to updated_desc) so `other` is the survivor and the
    // assertions below read a NON-default page — the only page whose sidecars
    // an unscoped, `'default'`-defaulting read would get wrong.
    await engine.executeRaw(
      `UPDATE pages SET updated_at = updated_at + interval '1 hour' WHERE source_id = 'default'`,
    );
  });

  test("a non-default page exports its own tags, not the default source's", async () => {
    await tryRunExport(['--dir', outDir]);
    expect(exitCode).toBeNull();

    const md = readFileSync(join(outDir, SLUG + '.md'), 'utf-8');
    // Guards the ordering assumption itself: if `default` ever wins the race
    // the tag assertions stop discriminating, so fail loudly here instead.
    expect(md).toContain('other title');
    expect(md).toContain('tag-other');
    expect(md).not.toContain('tag-default');
  });

  test('raw-data sidecars carry only the owning source rows', async () => {
    await tryRunExport(['--dir', outDir]);
    expect(exitCode).toBeNull();

    // Unscoped, getRawData applies no source predicate at all: both sources'
    // rows come back and the export loop merges them into a single object
    // keyed by `rd.source`.
    const raw = JSON.parse(readFileSync(join(outDir, 'notes', '.raw', 'shared.json'), 'utf-8'));
    expect(Object.keys(raw)).toEqual(['feed-other']);
    expect(raw['feed-other']).toEqual({ owner: 'other' });
  });
});

describe('export --source (scope to a single source)', () => {
  async function seedTwoSources(): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('src-x', 'Source X'), ('src-y', 'Source Y') ON CONFLICT DO NOTHING`,
    );
    await engine.putPage(
      'notes/x-only',
      { type: 'note', title: 'X only', compiled_truth: 'belongs to src-x', frontmatter: {} },
      { sourceId: 'src-x' },
    );
    await engine.putPage(
      'notes/y-only',
      { type: 'note', title: 'Y only', compiled_truth: 'belongs to src-y', frontmatter: {} },
      { sourceId: 'src-y' },
    );
  }

  test('exports only the named source, omitting pages from other sources', async () => {
    await seedTwoSources();

    await tryRunExport(['--dir', outDir, '--source', 'src-x']);

    expect(exitCode).toBeNull();
    expect(existsSync(join(outDir, 'notes/x-only.md'))).toBe(true);
    expect(existsSync(join(outDir, 'notes/y-only.md'))).toBe(false);
    // The scope is reflected in the count line for operator visibility.
    expect(stdout.some((line) => line.includes("from source 'src-x'"))).toBe(true);
  });

  test('without --source, exports pages from every source (backward compatible)', async () => {
    await seedTwoSources();

    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBeNull();
    expect(existsSync(join(outDir, 'notes/x-only.md'))).toBe(true);
    expect(existsSync(join(outDir, 'notes/y-only.md'))).toBe(true);
  });

  test('an unknown source id is a hard error, not a silent empty export', async () => {
    await seedTwoSources();

    // #1712: the failure mode this guards is `--source src-xx` exporting zero
    // pages and reporting success, which reads as "the brain is empty".
    await expect(runExport(engine, ['--dir', outDir, '--source', 'src-xx'])).rejects.toThrow(
      /not found/i,
    );
    expect(existsSync(join(outDir, 'notes/x-only.md'))).toBe(false);
  });

  test('a malformed source id is rejected before any page query', async () => {
    await seedTwoSources();

    await expect(runExport(engine, ['--dir', outDir, '--source', 'Not A Source'])).rejects.toThrow(
      /Invalid --source/i,
    );
  });

  test('--source __all__ spans every source rather than matching a literal id', async () => {
    await seedTwoSources();

    // The sentinel resolves to ALL_SOURCES, which must clear the filter -
    // passing it through as a source id would match nothing.
    await tryRunExport(['--dir', outDir, '--source', '__all__']);

    expect(exitCode).toBeNull();
    expect(existsSync(join(outDir, 'notes/x-only.md'))).toBe(true);
    expect(existsSync(join(outDir, 'notes/y-only.md'))).toBe(true);
  });

  test('an absent --source does NOT consult GBRAIN_SOURCE (bare export stays brain-wide)', async () => {
    await seedTwoSources();

    // Export output is a backup; letting the env var or a `.gbrain-source`
    // dotfile narrow a bare run silently drops pages from the archive.
    await withEnv({ GBRAIN_SOURCE: 'src-x' }, async () => {
      await tryRunExport(['--dir', outDir]);
    });

    expect(exitCode).toBeNull();
    expect(existsSync(join(outDir, 'notes/y-only.md'))).toBe(true);
  });
});
