/**
 * frontmatter.id identity dedup must never drop content or delete a live file's page.
 *
 *  - A shared `id:` with DIFFERENT content is a distinct note, not a duplicate:
 *    it imports (template reuse, copy-paste), and editing one of two pages that
 *    already share an id is never frozen by the other page.
 *  - A file that MOVED (its recorded source_path is gone from disk) carries its
 *    page: the row is renamed in place so page id, links and facts survive, and
 *    a full sync's delete-reconcile no longer soft-deletes the only live page.
 *  - Same id + same content while the recorded file still exists stays the
 *    #1309 overlapping-roots skip.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

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
});

const page = (id: string, body: string) => `---\ntype: concept\ntitle: T\nid: ${id}\n---\n\n${body}\n`;

const liveSlugs = async (sourceId = 'default') =>
  (await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [sourceId],
  )).map(r => r.slug);

function gitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
  return repo;
}

describe('frontmatter.id dedup compares content', () => {
  test('different content sharing an id imports as its own page', async () => {
    const a = await importFromContent(engine, 'notes/a', page('tmpl-1', 'Alpha content about widgets.'), { noEmbed: true });
    const b = await importFromContent(engine, 'notes/b', page('tmpl-1', 'Totally different beta content about gadgets.'), { noEmbed: true });
    expect(a.status).toBe('imported');
    expect(b.status).toBe('imported');
    expect(b.slug).toBe('notes/b');
    expect(await liveSlugs()).toEqual(['notes/a', 'notes/b']);
    const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug = 'notes/b'`);
    expect(row.compiled_truth).toContain('beta content about gadgets');
  });

  test('editing the later of two pages that already share an id lands the edit', async () => {
    await importFromContent(engine, 'notes/a', page('shared', 'First page body.'), { noEmbed: true });
    await importFromContent(engine, 'notes/b', page('shared', 'Second page body.'), { noEmbed: true });
    const edit = await importFromContent(engine, 'notes/b', page('shared', 'Second page body, edited.'), { noEmbed: true });
    expect(edit.status).toBe('imported');
    expect(edit.slug).toBe('notes/b');
    const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug = 'notes/b'`);
    expect(row.compiled_truth).toContain('edited');
  });

  test('same id and same content while the recorded file still exists skips', async () => {
    const root = mkdtempSync(join(tmpdir(), 'idmove-dup-'));
    mkdirSync(join(root, 'subdir'), { recursive: true });
    writeFileSync(join(root, 'subdir/note.md'), page('granola-1', 'Meeting notes.'));
    writeFileSync(join(root, 'note.md'), page('granola-1', 'Meeting notes.'));
    const first = await importFromFile(engine, join(root, 'subdir/note.md'), 'subdir/note.md', { noEmbed: true });
    expect(first.status).toBe('imported');
    const second = await importFromFile(engine, join(root, 'note.md'), 'note.md', { noEmbed: true });
    expect(second.status).toBe('skipped');
    expect(second.slug).toBe('subdir/note');
    expect(await liveSlugs()).toEqual(['subdir/note']);
  });

  test('overlapping import roots converge on one page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'idmove-roots-'));
    mkdirSync(join(root, 'subdir'), { recursive: true });
    writeFileSync(join(root, 'subdir/note.md'), page('granola-2', 'Meeting notes.'));
    await importFromFile(engine, join(root, 'subdir/note.md'), 'note.md', { noEmbed: true });
    await importFromFile(engine, join(root, 'subdir/note.md'), 'subdir/note.md', { noEmbed: true });
    expect(await liveSlugs()).toEqual(['subdir/note']);
  });

  test('engine prefers the frontmatter.id match over a content_hash match and excludes the caller slug', async () => {
    await engine.putPage('x/hash-twin', {
      type: 'concept', title: 'X', compiled_truth: 'x', frontmatter: { type: 'concept' }, content_hash: 'h1',
    });
    await engine.putPage('y/id-twin', {
      type: 'concept', title: 'Y', compiled_truth: 'y', frontmatter: { type: 'concept', id: 'ext-1' }, content_hash: 'h2',
    });
    const dup = await engine.findDuplicatePage!('default', { hash: 'h1', frontmatterId: 'ext-1' });
    expect(dup?.slug).toBe('y/id-twin');
    const self = await engine.findDuplicatePage!('default', { hash: 'h2', frontmatterId: 'ext-1', excludeSlug: 'y/id-twin' });
    expect(self).toBeNull();
  });
});

describe('a moved file carries its page', () => {
  test('full sync after moving a file with frontmatter.id keeps exactly one live page at the new path', async () => {
    await runSources(engine, ['add', 'mv-src', '--no-federated']);
    const repo = gitRepo('idmove-sync-');
    mkdirSync(join(repo, 'inbox'), { recursive: true });
    mkdirSync(join(repo, 'meetings'), { recursive: true });
    writeFileSync(join(repo, 'inbox/standup.md'), page('uuid-123', 'Standup notes: ship the widget on Friday.'));
    writeFileSync(join(repo, 'meetings/other.md'), page('uuid-999', 'Unrelated.'));
    execSync('git add -A && git commit -qm init', { cwd: repo });
    await performSync(engine, { repoPath: repo, full: true, sourceId: 'mv-src', noPull: true, noEmbed: true });
    const [before] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = 'mv-src' AND slug = 'inbox/standup'`);

    renameSync(join(repo, 'inbox/standup.md'), join(repo, 'meetings/standup.md'));
    execSync('git add -A && git commit -qm move', { cwd: repo });
    await performSync(engine, { repoPath: repo, full: true, sourceId: 'mv-src', noPull: true, noEmbed: true });

    expect(await liveSlugs('mv-src')).toEqual(['meetings/other', 'meetings/standup']);
    const [after] = await engine.executeRaw<{ id: number; source_path: string }>(
      `SELECT id, source_path FROM pages WHERE source_id = 'mv-src' AND slug = 'meetings/standup'`);
    expect(Number(after.id)).toBe(Number(before.id));
    expect(after.source_path).toBe('meetings/standup.md');
  }, 60_000);

  test('a moved and edited file lands its new content on the carried page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'idmove-edit-'));
    mkdirSync(join(root, 'inbox'), { recursive: true });
    mkdirSync(join(root, 'archive'), { recursive: true });
    writeFileSync(join(root, 'inbox/plan.md'), page('uuid-plan', 'Draft plan.'));
    await importFromFile(engine, join(root, 'inbox/plan.md'), 'inbox/plan.md', { noEmbed: true });
    renameSync(join(root, 'inbox/plan.md'), join(root, 'archive/plan.md'));
    writeFileSync(join(root, 'archive/plan.md'), page('uuid-plan', 'Final plan, approved.'));
    const moved = await importFromFile(engine, join(root, 'archive/plan.md'), 'archive/plan.md', { noEmbed: true });
    expect(moved.status).toBe('imported');
    expect(moved.slug).toBe('archive/plan');
    expect(await liveSlugs()).toEqual(['archive/plan']);
    const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug = 'archive/plan'`);
    expect(row.compiled_truth).toContain('approved');
  });
});
