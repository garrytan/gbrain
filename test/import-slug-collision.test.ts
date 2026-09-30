/**
 * Two files that slugify to the same slug must not overwrite each other.
 *
 * `notes/Foo Bar.md` and `notes/foo-bar.md` both map to `notes/foo-bar`. The
 * file named exactly like the slug owns it (the file the link extractor reads
 * for that slug); between two other files the one that already owns the row
 * keeps it. The other file is skipped with skip_reason 'slug_collision' and a
 * warning naming both paths, on every sync, so an edit to either file never
 * flips the page to the other body.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', 'co', '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const rows = () => engine.executeRaw<{ slug: string; title: string; source_path: string; compiled_truth: string }>(
  `SELECT slug, title, source_path, compiled_truth FROM pages WHERE source_id = 'co' AND deleted_at IS NULL ORDER BY slug`,
);

describe('slug collisions', () => {
  test('the owning file keeps the page across syncs and edits to either file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'collide-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes/Foo Bar.md'), `---\ntitle: One\n---\nFirst note about apples.\n`);
    writeFileSync(join(repo, 'notes/foo-bar.md'), `---\ntitle: Two\n---\nSecond note about oranges.\n`);
    execSync('git add -A && git commit -qm init', { cwd: repo });
    const sync = () => performSync(engine, { repoPath: repo, sourceId: 'co', noPull: true, noEmbed: true });

    await sync();
    const first = await rows();
    expect(first).toHaveLength(1);
    const owner = first[0].source_path;
    const ownerTitle = first[0].title;

    const other = owner === 'notes/Foo Bar.md' ? 'notes/foo-bar.md' : 'notes/Foo Bar.md';
    appendFileSync(join(repo, other), 'an edit to the file that does not own the page\n');
    execSync('git commit -qam edit', { cwd: repo });
    await sync();
    const second = await rows();
    expect(second).toHaveLength(1);
    expect(second[0].source_path).toBe(owner);
    expect(second[0].title).toBe(ownerTitle);
  }, 60_000);

  test('the losing file reports a slug_collision skip and the slug-named file keeps the page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collide-direct-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/baz-qux.md'), `---\ntitle: Owner\n---\nOwner body.\n`);
    writeFileSync(join(root, 'notes/Baz Qux.md'), `---\ntitle: Loser\n---\nLoser body.\n`);
    const a = await importFromFile(engine, join(root, 'notes/baz-qux.md'), 'notes/baz-qux.md', { noEmbed: true });
    expect(a.status).toBe('imported');
    const b = await importFromFile(engine, join(root, 'notes/Baz Qux.md'), 'notes/Baz Qux.md', { noEmbed: true });
    expect(b.status).toBe('skipped');
    expect(b.skip_reason).toBe('slug_collision');
    const [page] = await engine.executeRaw<{ title: string }>(`SELECT title FROM pages WHERE slug = 'notes/baz-qux' AND source_id = 'default'`);
    expect(page.title).toBe('Owner');
  });

  test('between two other spellings the file that owns the row keeps it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collide-owner-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/Quux Note.md'), `---\ntitle: Owner\n---\nOwner body.\n`);
    writeFileSync(join(root, 'notes/QUUX NOTE.md'), `---\ntitle: Loser\n---\nLoser body.\n`);
    await importFromFile(engine, join(root, 'notes/Quux Note.md'), 'notes/Quux Note.md', { noEmbed: true });
    const b = await importFromFile(engine, join(root, 'notes/QUUX NOTE.md'), 'notes/QUUX NOTE.md', { noEmbed: true });
    expect(b.skip_reason).toBe('slug_collision');
    const [page] = await engine.executeRaw<{ title: string }>(`SELECT title FROM pages WHERE slug = 'notes/quux-note' AND source_id = 'default'`);
    expect(page.title).toBe('Owner');
  });

  test('a file whose recorded owner path is gone takes the page over', async () => {
    const root = mkdtempSync(join(tmpdir(), 'collide-gone-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/Zed Note.md'), `---\ntitle: Old\n---\nOld body.\n`);
    await importFromFile(engine, join(root, 'notes/Zed Note.md'), 'notes/Zed Note.md', { noEmbed: true });
    renameSync(join(root, 'notes/Zed Note.md'), join(root, 'notes/zed-note.md'));
    writeFileSync(join(root, 'notes/zed-note.md'), `---\ntitle: New\n---\nNew body.\n`);
    const r = await importFromFile(engine, join(root, 'notes/zed-note.md'), 'notes/zed-note.md', { noEmbed: true });
    expect(r.status).toBe('imported');
    const [page] = await engine.executeRaw<{ title: string; source_path: string }>(
      `SELECT title, source_path FROM pages WHERE slug = 'notes/zed-note' AND source_id = 'default'`);
    expect(page.title).toBe('New');
    expect(page.source_path).toBe('notes/zed-note.md');
  });
});
