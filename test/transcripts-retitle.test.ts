/**
 * A retitled conversation (ChatGPT/Claude rename, or Claude.ai naming a
 * thread after its first exchange) keeps its existing page and slug, and the
 * messages added since the last import land. Real PGLite, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { Database } from 'bun:sqlite';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'gb-retitle-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function exportFile(name: string, title: string, grown: boolean): string {
  const message = (role: string, t: number, text: string) => ({ author: { role }, create_time: t, content: { content_type: 'text', parts: [text] } });
  const mapping: Record<string, unknown> = {
    root: { id: 'root', parent: null, children: ['n1'], message: null },
    n1: { id: 'n1', parent: 'root', children: ['n2'], message: message('user', 1786080005, 'First question about acme-example.') },
    n2: { id: 'n2', parent: 'n1', children: grown ? ['n3'] : [], message: message('assistant', 1786080015, 'First answer.') },
  };
  if (grown) {
    mapping.n3 = { id: 'n3', parent: 'n2', children: ['n4'], message: message('user', 1786090005, 'FOLLOWUP-MARKER new question') };
    mapping.n4 = { id: 'n4', parent: 'n3', children: [], message: message('assistant', 1786090015, 'Follow-up answer.') };
  }
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify([{ title, create_time: 1786080000, update_time: grown ? 1786090015 : 1786080015,
    conversation_id: 'cgpt-retitle-1', current_node: grown ? 'n4' : 'n2', mapping }]));
  return path;
}

async function livePages(): Promise<Array<{ slug: string; title: string; has_new: boolean }>> {
  return engine.executeRaw(`SELECT slug, title, compiled_truth LIKE '%FOLLOWUP-MARKER%' AS has_new
    FROM pages WHERE deleted_at IS NULL AND slug LIKE 'conversations/%' ORDER BY slug`);
}

describe('retitled conversation', () => {
  test('rename + new messages update the existing page in place', async () => {
    await runTranscriptsIngest(engine, { paths: [exportFile('a.json', 'Original title', false)], sourceId: 'default', format: 'chatgpt' });
    const [first] = await livePages();
    expect(first.slug).toContain('original-title');

    const second = await runTranscriptsIngest(engine, { paths: [exportFile('b.json', 'Renamed by user', true)], sourceId: 'default', format: 'chatgpt' });

    expect(second.pages.imported).toBe(1);
    expect(second.pages.skipped).toBe(0);
    const pages = await livePages();
    expect(pages).toHaveLength(1);
    expect(pages[0].slug).toBe(first.slug);
    expect(pages[0].has_new).toBe(true);
    expect(pages[0].title).toBe('Renamed by user');
  });

  test('re-importing the renamed export after the update is a clean skip', async () => {
    await runTranscriptsIngest(engine, { paths: [exportFile('a.json', 'Original title', false)], sourceId: 'default', format: 'chatgpt' });
    const b = exportFile('b.json', 'Renamed by user', true);
    await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    const again = await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    expect(again.pages).toMatchObject({ imported: 0, skipped: 1 });
    expect(await livePages()).toHaveLength(1);
  });
});

describe('re-ingest keeps frontmatter it does not render (#5431)', () => {
  test('a key another tool added survives a changed session; collector keys are replaced', async () => {
    await runTranscriptsIngest(engine, { paths: [exportFile('a.json', 'Original title', false)], sourceId: 'default', format: 'chatgpt' });
    const [first] = await livePages();
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"reviewed": true}'::jsonb WHERE slug = $1`, [first.slug]);

    const b = exportFile('b.json', 'Renamed by user', true);
    const second = await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    expect(second.pages.imported).toBe(1);
    const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; title: string; has_new: boolean }>(
      `SELECT frontmatter, title, compiled_truth LIKE '%FOLLOWUP-MARKER%' AS has_new FROM pages WHERE slug = $1`, [first.slug]);
    expect(row.frontmatter.reviewed).toBe(true);
    expect(row.title).toBe('Renamed by user');
    expect(row.has_new).toBe(true);

    const again = await runTranscriptsIngest(engine, { paths: [b], sourceId: 'default', format: 'chatgpt' });
    expect(again.pages).toMatchObject({ imported: 0, skipped: 1 });
  });
});

describe('message cutover preserves prior archives', () => {
  // Existing rename coverage exercises a full replacement. This checks the
  // opposite boundary: a cutoff view must never reuse that full archive's
  // identity, replace its text, or stale-delete its parts. Real persistence
  // and an unchanged rerun exercise the production identity and hash gates.
  test('full Hermes parts survive cutoff ingest, and the independent view rerun skips', async () => {
    const path = buildHermesFixture(dir);
    const db = new Database(path);
    try {
      const insert = db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < 12; i++) insert.run('hermes-fixture-1', i % 2 ? 'assistant' : 'user',
        'ARCHIVE-BEFORE-MARKER '.repeat(450), 1785916806);
    } finally { db.close(); }
    const options = { paths: [path], sourceId: 'default', format: 'hermes' as const,
      sessionSources: ['cli'], userPatternsPath: join(dir, 'no-private-patterns.txt') };
    const full = await runTranscriptsIngest(engine, options);
    expect(full.pages.imported).toBeGreaterThan(1);
    const before = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
      'SELECT slug, compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug', ['default']);
    const viewOptions = { ...options, messagesSinceIso: '2026-08-05T08:00:07Z' };
    const view = await runTranscriptsIngest(engine, viewOptions);
    expect(view.pages.imported).toBe(1);
    expect(view.partsDeleted).toBe(0);
    const viewSlug = view.files[0].sessions[0].baseSlug;
    expect(before.some(row => row.slug === viewSlug)).toBe(false);
    const after = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
      'SELECT slug, compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug', ['default']);
    expect(after.filter(row => row.slug !== viewSlug)).toEqual(before);
    const page = after.find(row => row.slug === viewSlug)!;
    expect(page.compiled_truth).toContain('Launch checklist drafted');
    expect(page.compiled_truth).not.toContain('ARCHIVE-BEFORE-MARKER');
    const rerun = await runTranscriptsIngest(engine, viewOptions);
    expect(rerun.pages).toMatchObject({ imported: 0, skipped: 1 });
    expect(rerun.partsDeleted).toBe(0);
    expect(await engine.executeRaw('SELECT slug, compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug', ['default'])).toEqual(after);
  });
});
