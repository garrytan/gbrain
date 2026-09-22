import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';

let engine: PGLiteEngine;
let worktreeId: string;
let home: string;
let root: string;
const sourceId = 'captured-target';
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  // realpath: macOS tmpdir lives under /var -> /private/var; targets are compared post-realpath.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-captured-target-')));
  root = join(home, 'source'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  worktreeId = (await claimWorktree(engine, sourceId, root)).worktree_id;
});
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function fixture(slug: string, sourceUri: string, file: string, sourcePath?: string) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Original captured content' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_uri=$1,source_path=$2 WHERE source_id=$3 AND slug=$4',
    [sourceUri, sourcePath ?? null, sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  return { snapshot, row: { source_id: sourceId, worktree_id: worktreeId, slug } };
}

test('captured file URI resolves inside the registered source, including encoded names', async () => {
  const file = join(root, 'notes', 'Captured Note.md');
  const { row, snapshot } = await fixture('notes/captured', pathToFileURL(file).href, file);
  const prepared = await prepareFileTarget(engine, row, snapshot, 'Replacement');
  expect(prepared?.path).toBe(file);
  expect(prepared?.root).toBe(root);
  expect(prepared?.expectedBeforeHash).toBeString();
});

test('recorded source_path remains preferred over a different contained capture URI', async () => {
  const recorded = 'notes/Recorded Note.md';
  const file = join(root, recorded);
  const { row, snapshot } = await fixture('notes/preferred', pathToFileURL(join(root, 'other.md')).href, file, recorded);
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toBe(file);
});

test('foreign capture URI cannot redirect publication outside the registered source', async () => {
  const outside = join(home, 'foreign.md'); writeFileSync(outside, 'Foreign content');
  const file = join(root, 'notes', 'foreign-uri.md');
  const { row, snapshot } = await fixture('notes/foreign-uri', pathToFileURL(outside).href, file);
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toBe(file);
  expect(readFileSync(outside, 'utf8')).toBe('Foreign content');
});

test('contained capture URI through an escaping symlink is refused', async () => {
  const outside = join(home, 'external'); mkdirSync(outside);
  symlinkSync(outside, join(root, 'escape'), 'dir');
  const file = join(root, 'escape', 'Captured.md');
  const { row, snapshot } = await fixture('notes/symlink-uri', pathToFileURL(file).href, file);
  const before = readFileSync(file, 'utf8');
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('captured file still requires bytes matching the coherent page snapshot', async () => {
  const file = join(root, 'notes', 'Changed Note.md');
  const { row, snapshot } = await fixture('notes/changed-uri', pathToFileURL(file).href, file);
  writeFileSync(file, 'Uncoordinated local edit');
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
  expect(readFileSync(file, 'utf8')).toBe('Uncoordinated local edit');
});

test('a live page that never recorded a canonical artifact does not fail closed on a missing file', async () => {
  // Subagent-sandbox and other database-only publications admit with no
  // worktree, so no .md is ever written and source_path stays null. A later
  // CLI delete_page (write-through authority, worktree bound) must treat the
  // absent file as "nothing to unlink", not as an uncoordinated removal.
  const slug = 'wiki/agents/42/notes/scratch/db-only';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Sandbox content' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_uri=NULL,source_path=NULL WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const row = { source_id: sourceId, worktree_id: worktreeId, slug };
  const prepared = await prepareFileTarget(engine, row, snapshot, null);
  expect(prepared?.path).toBe(join(root, `${slug}.md`));
  expect(prepared?.expectedBeforeHash).toBeNull();
  // First real publication of such a page is a create, not a conflict.
  expect((await prepareFileTarget(engine, row, snapshot, 'First file publication'))?.expectedBeforeHash).toBeNull();
});

test('a live page whose recorded artifact is missing still fails closed', async () => {
  const slug = 'notes/recorded-then-removed';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Was on disk' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [`${slug}.md`, sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const row = { source_id: sourceId, worktree_id: worktreeId, slug };
  await expect(prepareFileTarget(engine, row, snapshot, null)).rejects.toMatchObject({ code: 'source_changed' });
});
