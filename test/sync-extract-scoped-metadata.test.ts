/**
 * A16: the post-sync link hook reads page metadata for the changed pages and
 * their link endpoints, not the whole brain. It used to load every page of
 * every source (plus a DISTINCT join over links) on each incremental sync of
 * a single file. A15: post-sync extraction failures are reported, not
 * swallowed.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { extractLinksForSlugs } from '../src/commands/extract.ts';
import { importFromFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', 'sm', '--no-federated']);
  await runSources(engine, ['add', 'other', '--no-federated']);
  await runSources(engine, ['add', 'ae', '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const links = async (sourceId: string) => (await engine.executeRaw<{ f: string; t: string }>(
  `SELECT f.slug f, t.slug t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    WHERE f.source_id = $1 ORDER BY 1, 2`, [sourceId])).map(r => `${r.f}->${r.t}`);

describe('post-sync link hook (A16)', () => {
  test('reads O(changed pages) page rows, and still replaces links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scoped-meta-'));
    mkdirSync(join(dir, 'notes'));
    mkdirSync(join(dir, 'people'));
    const put = async (sourceId: string, rel: string, body: string) => {
      writeFileSync(join(dir, rel), body);
      await importFromFile(engine, join(dir, rel), rel, { noEmbed: true, sourceId });
    };
    await put('sm', 'people/alice-example.md', `---\ntype: person\ntitle: Alice Example\n---\n\nAlice.\n`);
    await put('sm', 'people/bob-example.md', `---\ntype: person\ntitle: Bob Example\n---\n\nBob.\n`);
    for (let i = 0; i < 150; i++) {
      await engine.putPage(`notes/filler-${i}`, { type: 'note', title: `Filler ${i}`, compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: 'sm' });
      await engine.putPage(`notes/filler-${i}`, { type: 'note', title: `Filler ${i}`, compiled_truth: 'x', timeline: '', frontmatter: {} }, { sourceId: 'other' });
    }
    await put('sm', 'notes/a.md', `---\ntype: note\ntitle: A\n---\n\nMet [[people/alice-example]] and [[people/bob-example]].\n`);
    await extractLinksForSlugs(engine, dir, ['notes/a'], { sourceId: 'sm' });
    expect(await links('sm')).toEqual(['notes/a->people/alice-example', 'notes/a->people/bob-example']);

    writeFileSync(join(dir, 'notes/a.md'), `---\ntype: note\ntitle: A\n---\n\nMet [[people/alice-example]].\n`);
    await importFromFile(engine, join(dir, 'notes/a.md'), 'notes/a.md', { noEmbed: true, sourceId: 'sm' });
    const executeRaw = PGLiteEngine.prototype.executeRaw;
    let pageRows = 0;
    // A function (not an arrow) so transaction handles derived from the engine keep their own `this`.
    (engine as unknown as { executeRaw: unknown }).executeRaw = async function (this: PGLiteEngine, sql: string, params?: unknown[]) {
      const rows = await executeRaw.call(this, sql, params);
      if (/FROM pages\b/.test(sql)) pageRows += rows.length;
      return rows;
    };
    try {
      const r = await extractLinksForSlugs(engine, dir, ['notes/a'], { sourceId: 'sm' });
      expect(r.processed).toEqual(['notes/a']);
    } finally {
      delete (engine as unknown as { executeRaw?: unknown }).executeRaw;
    }
    expect(await links('sm')).toEqual(['notes/a->people/alice-example']);
    expect(pageRows).toBeLessThan(20);
  }, 60_000);
});

describe('post-sync extraction errors (A15)', () => {
  test('a failed extraction is logged and reported on the sync result', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'extract-error-'));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
    mkdirSync(join(repo, 'notes'));
    writeFileSync(join(repo, 'notes/seed.md'), `---\ntype: note\ntitle: Seed\n---\n\nSeed.\n`);
    execSync('git add -A && git commit -qm seed', { cwd: repo });
    await performSync(engine, { repoPath: repo, sourceId: 'ae', noPull: true, noEmbed: true });
    writeFileSync(join(repo, 'notes/b.md'), `---\ntype: note\ntitle: B\n---\n\n- **2024-01-01** | something\n`);
    execSync('git add -A && git commit -qm b', { cwd: repo });

    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (engine as unknown as { replaceDerivedLinks: unknown }).replaceDerivedLinks = async () => { throw new Error('graph store offline'); };
    const origError = console.error;
    process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
    let result;
    try {
      result = await performSync(engine, { repoPath: repo, sourceId: 'ae', noPull: true, noEmbed: true });
    } finally {
      process.stderr.write = origWrite;
      console.error = origError;
      delete (engine as unknown as { replaceDerivedLinks?: unknown }).replaceDerivedLinks;
    }
    expect(result.status).toBe('synced');
    expect(result.extract_error).toContain('notes/b');
    expect(result.extract_error).toContain('graph store offline');
    expect(stderr.join('')).toContain('graph store offline');
    const [page] = await engine.executeRaw<{ links_extracted_at: string | null }>(
      `SELECT links_extracted_at FROM pages WHERE source_id = 'ae' AND slug = 'notes/b'`);
    expect(page.links_extracted_at).toBeNull();
  }, 60_000);
});
