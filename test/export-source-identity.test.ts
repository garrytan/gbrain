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
import { getDefaultSourcePath } from '../src/core/source-resolver.ts';
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
  await engine.executeRaw(`DELETE FROM config WHERE key IN ('sync.repo_path', 'sources.default')`);
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
    expect(err).toContain('gbrain export --source <id> --dir');
    expect(err).not.toContain('notes/only-connector');
    expect(existsSync(outDir)).toBe(false);
    expect(stdout.some((l) => l.startsWith('Exported'))).toBe(false);
  });

  test.each([
    { count: 20, more: null },
    { count: 23, more: 'and 3 more' },
  ])('lists at most 20 of $count collisions', async ({ count, more }) => {
    for (let i = 0; i < count; i++) {
      const slug = `notes/shared-${String(i).padStart(2, '0')}`;
      await put('default', slug, 'default body');
      await put('connector-a', slug, 'connector-a body');
    }
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain(`${count} slug(s)`);
    expect(err).toContain('notes/shared-00');
    expect(err).toContain('notes/shared-19');
    expect(err).not.toContain('notes/shared-20');
    if (more) expect(err).toContain(more);
    else expect(err).not.toMatch(/and \d+ more/);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export --source scopes the page set', () => {
  test.each([
    {
      flag: ['--source', 'connector-a'],
      files: { 'people/alice-example': 'body from connector-a', 'notes/only-connector': 'connector-only body' },
      absent: [] as string[],
    },
    {
      flag: ['--source', 'default'],
      files: { 'people/alice-example': 'body from default' },
      absent: ['notes/only-connector'],
    },
    {
      flag: ['--source=connector-a'],
      files: { 'people/alice-example': 'body from connector-a', 'notes/only-connector': 'connector-only body' },
      absent: [] as string[],
    },
  ])('$flag exports only that source', async ({ flag, files, absent }) => {
    await seedCollision();
    await tryRunExport(['--dir', outDir, ...flag]);

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
    { name: 'unknown source after =', args: ['--source=no-such-source'], mentions: 'no-such-source' },
    { name: 'invalid source id', args: ['--source', 'Bad_Id'], mentions: 'Bad_Id' },
    { name: 'missing value', args: ['--source'], mentions: '--source requires a source id' },
    { name: 'flag as value', args: ['--source', '--type'], mentions: '--source requires a source id' },
    { name: 'empty value after =', args: ['--source='], mentions: '--source requires a source id' },
  ])('$name fails and writes nothing', async ({ args, mentions }) => {
    await seedCollision();
    await tryRunExport(['--dir', outDir, ...args]);

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain(mentions);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export refuses slugs that differ only in case across sources', () => {
  // Case- and normalization-insensitive filesystems (APFS; NTFS for case)
  // put both spellings on one file. putPage normalizes new slugs, so the
  // variant is keyed in SQL.
  const variants = [
    { name: 'case', stored: 'notes/foo', variant: 'Notes/Foo' },
    { name: 'NFC vs NFD', stored: 'notes/caf\u00e9', variant: 'notes/cafe\u0301' },
  ];

  async function seedVariant(stored: string, variant: string, sourceForVariant: string): Promise<void> {
    await put('default', stored, 'stored body');
    await put(sourceForVariant, 'notes/variant-tmp', 'variant body');
    await engine.executeRaw(
      `UPDATE pages SET slug = $1 WHERE slug = 'notes/variant-tmp' AND source_id = $2`,
      [variant, sourceForVariant],
    );
  }

  test.each(variants)('$name: two sources refuse and both spellings are named', async ({ stored, variant }) => {
    await seedVariant(stored, variant, 'connector-a');
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain(`${[stored, variant].sort().join(', ')} (sources: connector-a, default)`);
    expect(existsSync(outDir)).toBe(false);
  });

  test('one source holding both case spellings is out of scope and exports', async () => {
    await seedVariant('notes/foo', 'Notes/Foo', 'default');
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBeNull();
    expect(stdout).toContain(`Exported 2 pages to ${outDir}/`);
  });
});

describe('export refusal names archived sources', () => {
  test('a colliding archived source gets a sources restore hint', async () => {
    await seedCollision();
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'connector-a'`);
    await tryRunExport(['--dir', outDir]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('gbrain sources restore connector-a');
    expect(err).not.toContain('gbrain sources restore default');
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export --source __all__ spans every source', () => {
  test('still refuses a cross-source collision', async () => {
    await seedCollision();
    await tryRunExport(['--dir', outDir, '--source', '__all__']);

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('people/alice-example');
    expect(existsSync(outDir)).toBe(false);
  });

  test('exports distinct slugs from both sources', async () => {
    await put('default', 'notes/from-default', 'default body');
    await put('connector-a', 'notes/from-connector', 'connector body');
    await tryRunExport(['--dir', outDir, '--source', '__all__']);

    expect(exitCode).toBeNull();
    expect(readOut('notes/from-default')).toContain('default body');
    expect(readOut('notes/from-connector')).toContain('connector body');
    expect(stdout).toContain(`Exported 2 pages to ${outDir}/`);
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
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo, '--source', '__all__']);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('media/x/clip');
    expect(err).toContain('connector-a');
    // Restore writes to --dir, not --repo: the per-source hint names both.
    expect(err).toMatch(/gbrain export --restore-only --source <id> --repo \S.* --dir \S/);
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

describe('export --restore-only restores into the source that owns the repo', () => {
  let repoDefault: string;
  let repoConnector: string;

  beforeEach(async () => {
    repoDefault = join(tmp, 'repo-default');
    repoConnector = join(tmp, 'repo-connector');
    for (const repo of [repoDefault, repoConnector]) {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only:\n    - media/\n');
    }
  });

  async function registerRepos(opts: { connector: boolean }): Promise<void> {
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [repoDefault]);
    if (opts.connector) {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'connector-a'`, [repoConnector]);
    }
  }

  test('--repo on a registered source restores only that source pages', async () => {
    await registerRepos({ connector: true });
    await put('default', 'media/default-clip', 'default clip');
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repoDefault]);

    expect(exitCode).toBeNull();
    expect(readOut('media/default-clip')).toContain('default clip');
    expect(existsSync(join(outDir, 'media/connector-clip.md'))).toBe(false);
    expect(stdout).toContain(`Restoring 1 db_only pages to ${outDir}/`);
  });

  test('--source without --repo reads that source own repo, not the default one', async () => {
    await registerRepos({ connector: true });
    // Only connector-a's repo tiers this page as db_only: read against the
    // default repo it would restore nothing.
    writeFileSync(join(repoDefault, 'gbrain.yml'), 'storage:\n  db_tracked: []\n  db_only: []\n');
    // A non-empty default source keeps the resolver's sole-non-default
    // convenience tier from routing the default repo lookup to connector-a.
    await put('default', 'notes/default-note', 'default note');
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--source', 'connector-a']);

    expect(exitCode).toBeNull();
    expect(readOut('media/connector-clip')).toContain('connector-a clip');
    expect(stdout).toContain(`Restoring 1 db_only pages to ${outDir}/`);
  });

  test('--source without --repo refuses when that source has no local_path', async () => {
    await registerRepos({ connector: false });
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--source', 'connector-a']);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('connector-a');
    expect(err).toContain('--repo');
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('export --restore-only picks the owning source by registered local_path', () => {
  const yml = 'storage:\n  db_tracked: []\n  db_only:\n    - media/\n';
  let repo: string;

  beforeEach(() => {
    repo = join(tmp, 'brain', 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'gbrain.yml'), yml);
  });

  async function seedBothSources(): Promise<void> {
    await put('default', 'media/default-clip', 'default clip');
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
  }

  test('an ancestor .gbrain-source does not override the local_path owner', async () => {
    writeFileSync(join(tmp, '.gbrain-source'), 'default\n');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'connector-a'`, [repo]);
    await seedBothSources();
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo]);

    expect(exitCode).toBeNull();
    expect(readOut('media/connector-clip')).toContain('connector-a clip');
    expect(existsSync(join(outDir, 'media/default-clip.md'))).toBe(false);
  });

  test.each([
    { name: 'same path', archivedPath: () => repo },
    { name: 'deeper archived path', archivedPath: () => repo, activePath: () => join(tmp, 'brain') },
  ])('an active source wins over an archived one at the $name', async ({ archivedPath, activePath }) => {
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1, archived = true WHERE id = 'default'`,
      [archivedPath()],
    );
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'connector-a'`,
      [(activePath ?? archivedPath)()],
    );
    await seedBothSources();
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo]);

    expect(exitCode).toBeNull();
    expect(readOut('media/connector-clip')).toContain('connector-a clip');
    expect(existsSync(join(outDir, 'media/default-clip.md'))).toBe(false);
  });

  test('legacy sync.repo_path brain: --repo with two sources and no --source refuses', async () => {
    await engine.setConfig('sync.repo_path', repo);
    await seedBothSources();
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo]);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('--source <id>');
    expect(err).toContain('--source __all__');
    expect(existsSync(outDir)).toBe(false);
  });

  test('legacy sync.repo_path brain: no --repo scopes to the resolved default source', async () => {
    await engine.setConfig('sync.repo_path', repo);
    await seedBothSources();
    await tryRunExport(['--dir', outDir, '--restore-only']);

    expect(exitCode).toBeNull();
    expect(readOut('media/default-clip')).toContain('default clip');
    expect(existsSync(join(outDir, 'media/connector-clip.md'))).toBe(false);
  });

  test('single-source brain: an unregistered --repo restores that source', async () => {
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'connector-a'`);
    await put('default', 'media/default-clip', 'default clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo]);

    expect(exitCode).toBeNull();
    expect(readOut('media/default-clip')).toContain('default clip');
    expect(stdout).toContain(`Restored 1 pages to ${outDir}/`);
  });
});

describe('export --restore-only intersects --slug-prefix with the db_only tiers', () => {
  test.each([
    { name: 'prefix narrower than the tier', tier: 'media/', prefix: 'media/x/' },
    { name: 'prefix wider than the tier', tier: 'media/x/', prefix: 'media/' },
  ])('$name restores only pages under both', async ({ tier, prefix }) => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'gbrain.yml'), `storage:\n  db_tracked: []\n  db_only:\n    - ${tier}\n`);
    await put('default', 'media/x/clip', 'clip under both');
    await put('default', 'media/y/other', 'outside the narrower of the two');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', repo, '--source', 'default', '--slug-prefix', prefix]);

    expect(exitCode).toBeNull();
    expect(readOut('media/x/clip')).toContain('clip under both');
    expect(existsSync(join(outDir, 'media/y/other.md'))).toBe(false);
    expect(stdout).toContain(`Restored 1 pages to ${outDir}/`);
  });
});

describe('export --restore-only: legacy repo path and the sole-source fallback', () => {
  const yml = 'storage:\n  db_tracked: []\n  db_only:\n    - media/\n';

  function makeRepo(name: string): string {
    const repo = join(tmp, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'gbrain.yml'), yml);
    return repo;
  }

  test('the legacy sync.repo_path belongs to default, not to another resolved source', async () => {
    const legacy = makeRepo('legacy');
    await engine.setConfig('sync.repo_path', legacy);
    await engine.setConfig('sources.default', 'connector-a');
    await put('default', 'media/default-clip', 'default clip');
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only']);

    expect(exitCode).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('connector-a');
    expect(err).toContain('--repo');
    expect(existsSync(outDir)).toBe(false);
    // getDefaultSourcePath's other callers (sync, extract) keep the unbound fallback.
    expect(await getDefaultSourcePath(engine)).toBe(legacy);
  });

  test('an empty default does not count against the only other active source', async () => {
    const registered = makeRepo('a');
    const freshClone = makeRepo('b');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'connector-a'`, [registered]);
    await put('connector-a', 'media/connector-clip', 'connector-a clip');
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', freshClone]);

    expect(exitCode).toBeNull();
    expect(readOut('media/connector-clip')).toContain('connector-a clip');
  });
});
