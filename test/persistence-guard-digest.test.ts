import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';

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
