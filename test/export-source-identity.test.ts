/**
 * #5532 -- `gbrain export` keys pages on (source_id, slug), not slug.
 *
 * Slugs are unique per source, not brain-wide, and export writes every page
 * to `<dir>/<slug>.md`. Pinned here:
 *  1. Two sources holding one slug refuse the export before any file is
 *     written (the old behaviour kept whichever page was written last and
 *     still reported every page as exported).
 *  2. `--source <id>` scopes the export (the flag was parsed and ignored),
 *     and an unknown or invalid id fails without writing anything.
 *  3. The page set is read in full, however many batches it takes (a single
 *     `limit: 100000` read truncated larger brains silently).
 *  4. `--restore-only` dedups on (source_id, slug) and refuses the same
 *     collisions, since it writes to the same `<dir>/<slug>.md` paths.
 *
 * Real PGLite, synthetic pages only.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import type { PageFilters } from '../src/core/types.ts';

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
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-export-identity-'));
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
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  originalLog = console.log;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };

  const tables = ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'sources'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('default', 'Default'), ('connector-a', 'Connector A')
     ON CONFLICT DO NOTHING`,
  );
});

afterEach(() => {
  delete (engine as unknown as { listPages?: unknown }).listPages; // back to the prototype method
  process.exit = originalExit;
  console.error = originalErr;
  console.log = originalLog;
  rmSync(tmp, { recursive: true, force: true });
});

async function tryRunExport(args: string[]): Promise<void> {
  try {
    await runExport(engine, args);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('__test_exit__:'))) throw e;
  }
}

async function put(sourceId: string, slug: string, body: string): Promise<void> {
  await engine.putPage(
    slug,
    { type: 'note', title: slug, compiled_truth: body, timeline: '' },
    { sourceId },
  );
}

/** The export fixture from the report: one slug in two sources, one unique page. */
async function seedCollision(): Promise<void> {
  await put('connector-a', 'people/alice-example', 'body from connector-a');
  await put('default', 'people/alice-example', 'body from default');
  await put('connector-a', 'notes/only-connector', 'connector-only body');
}

/**
 * Cap every listPages read at `max` rows, the way an engine LIMIT caps an
 * oversized request. A reader that trusts one call to return everything
 * loses the rest; a paging reader still sees the whole set.
 */
function clampListPages(max: number): Array<PageFilters | undefined> {
  const calls: Array<PageFilters | undefined> = [];
  const real = PGLiteEngine.prototype.listPages;
  (engine as unknown as { listPages: unknown }).listPages = async (filters?: PageFilters) => {
    calls.push(filters);
    return real.call(engine, { ...filters, limit: Math.min(filters?.limit ?? 100, max) });
  };
  return calls;
}

function readOut(slug: string): string {
  return readFileSync(join(outDir, slug + '.md'), 'utf-8');
}

describe('export refuses slugs shared by two sources', () => {
  test('names the slug and its sources, exits non-zero, writes nothing', async () => {
    await seedCollision();
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('people/alice-example');
    expect(err).toContain('connector-a');
    expect(err).toContain('default');
    expect(err).toContain('--source');
    expect(err).not.toContain('notes/only-connector');
    expect(existsSync(outDir)).toBe(false);
    expect(stdout.some((l) => l.startsWith('Exported'))).toBe(false);
  });

  test('bounds the listed collisions and counts the rest', async () => {
    for (let i = 0; i < 23; i++) {
      const slug = `notes/shared-${String(i).padStart(2, '0')}`;
      await put('default', slug, 'default body');
      await put('connector-a', slug, 'connector-a body');
    }
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('23');
    expect(err).toContain('notes/shared-00');
    expect(err).toContain('notes/shared-19');
    expect(err).not.toContain('notes/shared-20');
    expect(err).toContain('and 3 more');
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export --source scopes the page set', () => {
  test.each([
    {
      source: 'connector-a',
      files: { 'people/alice-example': 'body from connector-a', 'notes/only-connector': 'connector-only body' },
      absent: [] as string[],
    },
    {
      source: 'default',
      files: { 'people/alice-example': 'body from default' },
      absent: ['notes/only-connector'],
    },
  ])('--source $source exports only that source', async ({ source, files, absent }) => {
    await seedCollision();
    await tryRunExport(['--dir', outDir, '--source', source]);

    expect(exitCode).toBeNull();
    expect(stderr.join('\n')).toBe('');
    for (const [slug, body] of Object.entries(files)) {
      expect(readOut(slug)).toContain(body);
    }
    for (const slug of absent) {
      expect(existsSync(join(outDir, slug + '.md'))).toBe(false);
    }
    expect(stdout).toContain(`Exported ${Object.keys(files).length} pages to ${outDir}/`);
  });

  test.each([
    { name: 'unknown source', args: ['--source', 'no-such-source'], mentions: 'no-such-source' },
    { name: 'invalid source id', args: ['--source', 'Bad_Id'], mentions: 'Bad_Id' },
    { name: 'missing value', args: ['--source'], mentions: '--source' },
    { name: 'flag as value', args: ['--source', '--type'], mentions: '--source' },
  ])('$name fails and writes nothing', async ({ args, mentions }) => {
    await seedCollision();
    await tryRunExport(['--dir', outDir, ...args]);

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain(mentions);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export without --source keeps exporting every source', () => {
  test('distinct slugs across sources all export', async () => {
    await put('default', 'notes/from-default', 'default body');
    await put('connector-a', 'notes/from-connector', 'connector body');
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBeNull();
    expect(readOut('notes/from-default')).toContain('default body');
    expect(readOut('notes/from-connector')).toContain('connector body');
    expect(stdout).toContain(`Exported 2 pages to ${outDir}/`);
  });
});

describe('export reads the whole page set', () => {
  test('every page exports when the engine returns fewer rows than asked for', async () => {
    const slugs = ['notes/p1', 'notes/p2', 'notes/p3', 'notes/p4', 'notes/p5'];
    for (const [i, slug] of slugs.entries()) await put(i % 2 ? 'connector-a' : 'default', slug, `body ${slug}`);
    const calls = clampListPages(2);

    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBeNull();
    for (const slug of slugs) expect(readOut(slug)).toContain(`body ${slug}`);
    expect(stdout).toContain(`Exported 5 pages to ${outDir}/`);
    expect(calls.length).toBeGreaterThan(1);
  });
});

describe('export --restore-only keys pages on (source_id, slug)', () => {
  let repo: string;

  beforeEach(() => {
    repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    // Overlapping tiers: a page under media/x/ matches both, and must still
    // restore once.
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/\n    - media/x/\n');
  });

  test('a db_only slug in two sources refuses and writes nothing', async () => {
    await put('default', 'media/x/clip', 'default clip');
    await put('connector-a', 'media/x/clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('media/x/clip');
    expect(err).toContain('connector-a');
    expect(err).toContain('--source');
    expect(existsSync(outDir)).toBe(false);
  });

  test.each(['default', 'connector-a'])('--source %s restores that source page, once', async (source) => {
    await put('default', 'media/x/clip', 'default clip');
    await put('connector-a', 'media/x/clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo, '--source', source]);

    expect(exitCode).toBeNull();
    expect(readOut('media/x/clip')).toContain(`${source} clip`);
    expect(stdout).toContain(`Restoring 1 db_only pages to ${outDir}/`);
    expect(stdout).toContain(`Restored 1 pages to ${outDir}/`);
  });
});
