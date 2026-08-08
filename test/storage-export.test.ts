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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';

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
