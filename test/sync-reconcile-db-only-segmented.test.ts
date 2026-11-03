/**
 * GBRA-287: a full sync's DB-only reconcile (#2426) re-exports a page stored in segments.
 *
 * 1. Protects: a stale page whose file Git never committed, stored in segments (`pages.segmented_storage`), is re-exported
 *    to the working tree by streaming its body through the staging writer the withdrawal mirror and restore_page use:
 *    the file holds the bytes `gbrain export` writes for the page, at 2 MiB and above the 24 MiB single-string ceiling,
 *    is left uncommitted for Git's own door, and leaves no staging file behind. A page whose re-export fails is listed
 *    (`reexport_failures`) and the run still completes and advances. A plain directory (repo-less) source re-exports
 *    nothing and keeps the page.
 * 2. Fails when: the reconcile refuses a segmented page (`page_body_segmented`), writes bytes that differ from the export,
 *    leaves a staging file, or one bad page stops the run or goes unreported.
 * 3. PGLite.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { gitExec } from './helpers/git-exec.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { readPageBodyPolicy, SEGMENT_MAX_BYTES } from '../src/core/page-body/limits.ts';
import { largeFileWork } from '../src/core/persistence/large-file.ts';
import { PAGE_MAX_BYTES, PUSH_SCAN_MAX_FILE_BYTES } from '../src/core/page-size-policy.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { writePageThrough } from '../src/core/write-through.ts';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import { writeDerivedPageThrough } from '../src/core/cycle/derived-write-through.ts';

let engine: PGLiteEngine;
let dir: string;
let repoPath: string;

const line = (i: number) => '- ' + String(i).padStart(9, '0') + ' acme-example journal line with enough text to fill a segment quickly\n';
const page = (title: string, bytes: number) => '---\ntype: concept\ntitle: ' + title + '\n---\n\n# ' + title + '\n\n'
  + Array.from({ length: Math.ceil(bytes / line(0).length) }, (_, i) => line(i)).join('') + '\n<!-- timeline -->\n- **2026-10-01** | manual — first entry\n';

/** A page stored in segments whose source_path names a file Git never committed and the checkout lacks. */
async function dbOnlySegmented(slug: string, bytes: number, sourceId = 'default'): Promise<void> {
  const parsed = parseMarkdown(page('Example ' + slug, bytes), slug + '.md');
  const outside = join(dir, 'outside', slug + '.md');
  mkdirSync(join(outside, '..'), { recursive: true });
  writeFileSync(outside, serializePageToMarkdown(parsed as never, parsed.tags));
  expect(await importFromFile(engine, outside, slug + '.md', { sourceId, noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
  const [row] = await engine.executeRaw<{ body_storage: string; source_path: string }>('SELECT body_storage, source_path FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]);
  expect(row).toEqual({ body_storage: 'segmented', source_path: slug + '.md' });
}

async function exportedBytes(slug: string): Promise<Buffer> {
  const { runExport } = await import('../src/commands/export.ts');
  const out = mkdtempSync(join(dir, 'export-'));
  rmSync(out, { recursive: true, force: true });
  await runExport(engine, ['--dir', out, '--source', 'default', '--slug-prefix', slug]);
  return readFileSync(join(out, slug + '.md'));
}

const stagingLeft = (root: string): string[] => readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => /\.tmp\.|\.streaming$/.test(name));

async function fullSync() {
  const { performSync } = await import('../src/commands/sync.ts');
  return performSync(engine, { repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-seg-'));
  repoPath = join(dir, 'repo');
  mkdirSync(join(repoPath, 'topics'), { recursive: true });
  gitExec('git init -q', repoPath);
  gitExec('git config user.email "t@t.t"', repoPath);
  gitExec('git config user.name "T"', repoPath);
  writeFileSync(join(repoPath, 'topics/keep.md'), '---\ntype: concept\ntitle: Keep\n---\n\nstill here\n');
  gitExec('git add -A && git commit -q -m initial', repoPath);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('GBRA-287: full-sync re-export of a DB-only page stored in segments', () => {
  test('a 2 MiB segmented page is streamed to its file with the export bytes, left for Git to commit', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/big', 2 * 1024 * 1024);
    const result = await fullSync();
    expect(result.status).toBe('first_sync');
    expect(result.reexport_failures).toBeUndefined();
    const file = join(repoPath, 'memories/big.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(await exportedBytes('memories/big'))).toBe(true);
    expect(stagingLeft(repoPath)).toEqual([]);
    expect(gitExec('git status --porcelain --untracked-files=all', repoPath)).toContain('?? memories/big.md');
    expect(await engine.getPage('memories/big')).not.toBeNull();
  }, 180_000);

  test('a segmented page over the 24 MiB single-string ceiling is streamed, never rendered whole', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/huge', PAGE_MAX_BYTES + 256 * 1024);
    const [row] = await engine.executeRaw<{ body_bytes: number }>("SELECT body_bytes FROM pages WHERE slug='memories/huge'");
    expect(Number(row!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
    Object.assign(largeFileWork, { bytesWritten: 0, largestPiece: 0 });
    const result = await fullSync();
    expect(result.status).toBe('first_sync');
    expect(result.reexport_failures).toBeUndefined();
    const file = join(repoPath, 'memories/huge.md');
    expect(readFileSync(file).equals(await exportedBytes('memories/huge'))).toBe(true);
    expect(largeFileWork.bytesWritten).toBe(readFileSync(file).length);
    expect(largeFileWork.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
    expect(stagingLeft(repoPath)).toEqual([]);
  }, 600_000);

  test('one page whose re-export fails is listed; the run completes, advances and re-exports the rest', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/good', 2 * 1024 * 1024);
    await dbOnlySegmented('memories/bad', 2 * 1024 * 1024);
    mkdirSync(join(repoPath, 'memories/bad.md'), { recursive: true });
    const result = await fullSync();
    expect(result.status).toBe('first_sync');
    expect(readFileSync(join(repoPath, 'memories/good.md')).equals(await exportedBytes('memories/good'))).toBe(true);
    expect(result.reexport_failures).toEqual([expect.objectContaining({ slug: 'memories/bad', path: 'memories/bad.md' })]);
    expect(result.reexport_failures![0]!.fix).toContain('gbrain');
    const head = gitExec('git rev-parse HEAD', repoPath).trim();
    const [source] = await engine.executeRaw<{ last_commit: string }>("SELECT last_commit FROM sources WHERE id='default'");
    expect(source!.last_commit).toBe(head);
    expect(await engine.getPage('memories/bad')).not.toBeNull();
    expect(stagingLeft(repoPath)).toEqual([]);
  }, 300_000);

  test('a caller inside a transaction (an owner repair) writes the file of a segmented page, keeping its mode', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/big', 2 * 1024 * 1024);
    await fullSync();
    const file = join(repoPath, 'memories/big.md');
    chmodSync(file, 0o600);
    const result = await engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1');
      return writePageThrough(tx, 'memories/big', { sourceId: 'default' });
    });
    expect(result).toMatchObject({ written: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file).equals(await exportedBytes('memories/big'))).toBe(true);
    const snapshot = await engine.readPageSnapshot('memories/big', { sourceId: 'default' });
    expect(await fileMatchesSnapshot(engine, 'memories/big', readFileSync(file, 'utf8'), snapshot!, 'memories/big.md')).toBe(true);
    expect(stagingLeft(repoPath)).toEqual([]);
  }, 180_000);

  test('write-through of a segmented page with frontmatter overrides returns an error and writes nothing', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/big', 2 * 1024 * 1024);
    const result = await writePageThrough(engine, 'memories/big', { sourceId: 'default', frontmatterOverrides: { provenance: 'example' } });
    expect(result).toMatchObject({ written: false });
    expect(result.error).toContain('stored in segments');
    expect(existsSync(join(repoPath, 'memories/big.md'))).toBe(false);
    expect(stagingLeft(repoPath)).toEqual([]);
  }, 180_000);

  test('a segmented page whose file would pass the pre-push scan cap is skipped before its source_path is bound', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('memories/huger', PUSH_SCAN_MAX_FILE_BYTES + 256 * 1024);
    await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE slug='memories/huger'");
    expect(await writePageThrough(engine, 'memories/huger', { sourceId: 'default' })).toEqual({ written: false, skipped: 'over_push_scan_cap' });
    const [row] = await engine.executeRaw<{ source_path: string | null }>("SELECT source_path FROM pages WHERE slug='memories/huger'");
    expect(row!.source_path).toBeNull();
    expect(existsSync(join(repoPath, 'memories/huger.md'))).toBe(false);
    expect(stagingLeft(repoPath)).toEqual([]);
    await engine.executeRaw("UPDATE pages SET source_path='memories/huger.md' WHERE slug='memories/huger'");
    const result = await fullSync();
    expect(result.reexport_failures).toEqual([expect.objectContaining({ slug: 'memories/huger', code: 'over_push_scan_cap' })]);
    expect(result.reexport_failures![0]!.fix).not.toContain('--full');
    expect(existsSync(join(repoPath, 'memories/huger.md'))).toBe(false);
  }, 600_000);

  test('the derived writer skips a generated page stored in segments instead of writing a file its rollback cannot compare', async () => {
    expect(['first_sync', 'synced']).toContain((await fullSync()).status);
    await dbOnlySegmented('concepts/big', 2 * 1024 * 1024);
    await engine.executeRaw("UPDATE pages SET source_path=NULL WHERE slug='concepts/big'");
    expect(await writeDerivedPageThrough(engine, 'concepts/big', 'default')).toEqual({ written: false, skipped: 'segmented_page' });
    expect(existsSync(join(repoPath, 'concepts/big.md'))).toBe(false);
  }, 180_000);

  test('a repo-less (plain directory) source re-exports nothing and keeps the page', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(join(plain, 'topics'), { recursive: true });
    writeFileSync(join(plain, 'topics/keep.md'), '---\ntype: concept\ntitle: Keep\n---\n\nstill here\n');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('plain','plain',$1)", [plain]);
    await dbOnlySegmented('memories/big', 2 * 1024 * 1024, 'plain');
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, { sourceId: 'plain', noPull: true, noEmbed: true, noExtract: true });
    expect(result.status).not.toBe('blocked_by_failures');
    expect(existsSync(join(plain, 'memories/big.md'))).toBe(false);
    const [row] = await engine.executeRaw<{ deleted_at: string | null; body_storage: string }>("SELECT deleted_at, body_storage FROM pages WHERE slug='memories/big' AND source_id='plain'");
    expect(row).toEqual({ deleted_at: null, body_storage: 'segmented' });
  }, 180_000);
});
