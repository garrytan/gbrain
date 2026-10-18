import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { applyInference } from '../src/core/frontmatter-inference.ts';
import { slugifyPath } from '../src/core/sync.ts';

// #5521 / #5635: the coordinated write guard compares the parsed canonical file
// with the stored row. A file with no frontmatter `type:` keeps the stored type
// on import (#1035), and the parser trims titles, so neither can be drift.

let engine: PGLiteEngine;
let worktreeId: string;
let home: string;
let root: string;
const sourceId = 'guard-digest';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-guard-digest-'));
  root = join(home, 'source'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  worktreeId = (await claimWorktree(engine, sourceId, root)).worktree_id;
}, 60000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60000);

async function seed(slug: string, page: { type: string; title: string }, edit: (markdown: string) => string = m => m) {
  await engine.putPage(slug, { ...page, compiled_truth: 'Mirrored body' }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [`${slug}.md`, sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, edit(serializePageToMarkdown(snapshot.page, snapshot.tags)));
  return { snapshot, file, row: { source_id: sourceId, worktree_id: worktreeId, slug } };
}
const withoutType = (markdown: string) => markdown.replace(/^type:.*\n/m, '');

test('#5521 a type-less canonical file does not conflict with a stored non-default type', async () => {
  const { snapshot, row, file } = await seed('raw/mirror/type-less', { type: 'note', title: 'Type less' }, withoutType);
  expect(readFileSync(file, 'utf8')).not.toMatch(/^type:/m);
  expect(parseMarkdown(readFileSync(file, 'utf8'), row.slug).type).not.toBe('note');
  for (const attempt of [1, 2]) {
    expect((await prepareFileTarget(engine, row, snapshot, `Replacement ${attempt}`))?.path).toBe(file);
  }
  expect((await prepareFileTarget(engine, row, snapshot, null))?.path).toBe(file);
});

test('#5521 an explicit frontmatter type that disagrees with the row is still refused', async () => {
  const { snapshot, row, file } = await seed('raw/mirror/explicit-type', { type: 'note', title: 'Explicit' }, withoutType);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^---\n/, '---\ntype: concept\n'));
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
});

test('#5521 a local body edit on a type-less file is still refused', async () => {
  const { snapshot, row, file } = await seed('raw/mirror/body-edit', { type: 'note', title: 'Body edit' }, withoutType);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nUncoordinated local edit\n`);
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
});

test('#5635 a stored title with surrounding whitespace is not an uncoordinated edit', async () => {
  const { snapshot, row, file } = await seed('raw/padded-title', { type: 'note', title: '  Probe Cli 20260928 ' });
  expect(snapshot.page.title).toBe('  Probe Cli 20260928 ');
  expect(parseMarkdown(readFileSync(file, 'utf8'), row.slug).title).toBe('Probe Cli 20260928');
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toBe(file);
  expect((await prepareFileTarget(engine, row, snapshot, null))?.path).toBe(file);
});

test('#5635 a real local title edit is still refused', async () => {
  const { snapshot, row, file } = await seed('raw/title-edit', { type: 'note', title: 'Original Title ' });
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^title:.*$/m, 'title: Renamed Title'));
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed', detail: 'file_database_drift',
    suggestion: expect.stringContaining(`gbrain sources reconcile ${sourceId} raw/title-edit --brain`) });
});

test('#5635 a title humanized from a slug with edge separators is stored trimmed', () => {
  expect(parseMarkdown('Body only, no heading', '__probe_cli_20260928.md').title).toBe('Probe Cli 20260928');
  expect(parseMarkdown('Body only, no heading', 'inbox/sources/micromotion-and-wound-.md').title).toBe('Micromotion And Wound');
  expect(parseMarkdown('Body only, no heading', '---.md').title).toBe('Untitled');
});

test('#5622 a new captured page claims its in-source file only when the bytes are exactly the captured input', async () => {
  const { sha256 } = await import('../src/core/persistence/digest.ts');
  const file = join(root, 'notes', 'captured-race.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x2 observation\n');
  const row = { source_id: sourceId, worktree_id: worktreeId, slug: 'notes/captured-race' };
  await expect(prepareFileTarget(engine, row, null, 'Rendered page', undefined, { capture: { path: 'notes/captured-race.md', hash: sha256('x² observation\n') } }))
    .rejects.toMatchObject({ code: 'source_changed' });
  expect((await prepareFileTarget(engine, row, null, 'Rendered page', undefined, { capture: { path: 'notes/captured-race.md', hash: sha256('x2 observation\n') } }))?.path).toBe(file);
});

// Directory-inferred pages: an importer prepends path-inferred frontmatter (`date`, `source`, tags) to a
// frontmatter-less file before it parses it (applyInference in import-prepare.ts), so the stored row carries those
// fields while the canonical file never does. The guard must read the file the way the importer did.
async function seedInferred(rel: string, body: string, opts: { storedType?: string; bom?: boolean } = {}) {
  const slug = slugifyPath(rel);
  const parsed = parseMarkdown(applyInference(rel, body).content, rel);
  await engine.putPage(slug, { type: (opts.storedType ?? parsed.type) as typeof parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags }, { sourceId });
  for (const tag of parsed.tags) await engine.addTag(slug, tag, { sourceId, tagSource: 'frontmatter' });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [rel, sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${opts.bom ? '\uFEFF' : ''}${body}`);
  return { snapshot, file, row: { source_id: sourceId, worktree_id: worktreeId, slug } };
}
const INFERRED_REL = 'Apple Notes/Ideas/2021-06-20 Packing list.md';

test('a frontmatter-less file under a directory-inference rule is not drift against the row the importer stored', async () => {
  const { snapshot, row, file } = await seedInferred(INFERRED_REL, 'Passport, charger, notebook.\n');
  // The premises: the row holds inferred fields the file cannot carry.
  expect(Object.keys(snapshot.page.frontmatter ?? {}).sort()).toEqual(['date', 'source']);
  expect(snapshot.tags.length).toBeGreaterThan(0);
  expect(readFileSync(file, 'utf8')).not.toMatch(/^---/);
  for (const attempt of [1, 2]) {
    expect((await prepareFileTarget(engine, row, snapshot, `Replacement ${attempt}`))?.path).toBe(file);
  }
  expect((await prepareFileTarget(engine, row, snapshot, null))?.path).toBe(file);
});

test('a real body edit to a directory-inferred file is still refused', async () => {
  const { snapshot, row, file } = await seedInferred('Apple Notes/Ideas/2021-06-21 Edited.md', 'Original text.\n');
  writeFileSync(file, 'Original text.\nUncoordinated local edit.\n');
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed', detail: 'file_database_drift' });
});

test('an explicit frontmatter value that disagrees with the inferred row is still refused', async () => {
  const { snapshot, row, file } = await seedInferred('Apple Notes/Ideas/2021-06-22 Explicit.md', 'Body.\n');
  writeFileSync(file, '---\ndate: 1999-01-01\n---\nBody.\n');
  await expect(prepareFileTarget(engine, row, snapshot, 'Replacement')).rejects.toMatchObject({ code: 'source_changed' });
});

test('an inferred type is not a declared one: a stored type that differs from the path default is kept', async () => {
  const { snapshot, row, file } = await seedInferred('Apple Notes/Ideas/2021-06-23 Retyped.md', 'Body.\n', { storedType: 'note' });
  expect(snapshot.page.type).toBe('note');
  expect(parseMarkdown(applyInference('Apple Notes/Ideas/2021-06-23 Retyped.md', readFileSync(file, 'utf8')).content, row.slug).type).not.toBe('note');
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toBe(file);
});

test('a BOM in front of an inferred heading title does not make an untouched file drift', async () => {
  // runbooks/ takes its title from the first heading; the importer strips the BOM before inferring it.
  const { snapshot, row, file } = await seedInferred('runbooks/restore-db.md', '# Restore the database\n\nSteps.\n', { bom: true });
  expect(snapshot.page.title).toBe('Restore the database');
  expect(readFileSync(file, 'utf8').charCodeAt(0)).toBe(0xFEFF);
  expect((await prepareFileTarget(engine, row, snapshot, 'Replacement'))?.path).toBe(file);
});

// #6605 review: `gbrain reindex` on an unmanaged brain imports with `inferFrontmatter: false`, so its row carries no
// inferred keys. The raw reading of the untouched file still matches it after the brain is managed.
test('a row imported without inference (unmanaged reindex) still matches its untouched frontmatter-less file', async () => {
  const rel = 'Apple Notes/Ideas/2021-06-24 Reindexed.md';
  const slug = slugifyPath(rel);
  const parsed = parseMarkdown('Body without inference.\n', rel);
  await engine.putPage(slug, { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline,
    frontmatter: parsed.frontmatter, tags: parsed.tags }, { sourceId });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE source_id=$2 AND slug=$3', [rel, sourceId, slug]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  expect(snapshot.page.frontmatter ?? {}).toEqual({});
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'Body without inference.\n');
  expect((await prepareFileTarget(engine, { source_id: sourceId, worktree_id: worktreeId, slug }, snapshot, 'Replacement'))?.path).toBe(file);
});
