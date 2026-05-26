/**
 * v0.41.13 (#1309) — overlapping-ingest-roots dedup via findDuplicatePage.
 *
 * Bug class (infiniteGameExp): `gbrain import /vault/Subdir/` then
 * `gbrain import /vault/` re-ingested the same files under different
 * slugs. Slug-only dedup at importFromContent missed the duplicate
 * because the slugs differed; the engine wrote both rows, doubling
 * search clutter and inflating backlink counts.
 *
 * Fix (per codex review):
 *   - Identity-based dedup (content_hash + frontmatter.id), not pure
 *     content_hash — two intentional pages with identical text but
 *     different external IDs are NOT duplicates.
 *   - WARN-ALWAYS on content_hash match; SKIP only when frontmatter.id
 *     matches too.
 *   - FAIL CLOSED on lookup error (no silent fallthrough).
 *   - Soft-deleted rows excluded (don't block legitimate re-imports
 *     under a new slug after a tombstone).
 *
 * PGLite hermetic — no real Postgres needed; the Postgres parity test
 * is at test/e2e/import-dedup-postgres.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let tmpRoot: string;

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
  tmpRoot = mkdtempSync(join(tmpdir(), 'gbrain-dedup-fm-'));
});

function makeFile(rel: string, body: string): { path: string; rel: string } {
  const full = join(tmpRoot, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return { path: full, rel };
}

const granolaFrontmatter = (id: string, title = 'Sample meeting') => [
  '---',
  'type: concept',
  `title: ${title}`,
  `id: ${id}`,
  '---',
  '',
  'Sample meeting notes from granola.',
].join('\n');

describe('#1309 — overlapping-ingest-roots dedup', () => {
  test('same content_hash + same frontmatter.id under different slugs: second skips with stderr log', async () => {
    const a = makeFile('subdir/note.md', granolaFrontmatter('granola-uuid-1'));
    const b = makeFile('note.md', granolaFrontmatter('granola-uuid-1'));

    // First ingest under a deeper slug shape.
    const first = await importFromFile(engine, a.path, 'subdir/note.md', { noEmbed: true });
    expect(first.status).toBe('imported');

    // Capture stderr to verify the skip log.
    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof origWrite }).write = (
      chunk: unknown,
      ...rest: unknown[]
    ): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
      captured.push(s);
      return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
    };
    try {
      const second = await importFromFile(engine, b.path, 'note.md', { noEmbed: true });
      // Skipped — second slug matches the existing 'subdir/note' page.
      expect(second.status).toBe('skipped');
      expect(second.slug).toBe('subdir/note');
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    const text = captured.join('');
    expect(text).toContain('[import] skipping');
    expect(text).toContain('granola-uuid-1');

    // IRON RULE: exactly ONE row, not two.
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(rows[0].n).toBe(1);
  });

  test('different frontmatter.id (and therefore different content_hash) imports both, no dedup signal', async () => {
    // gbrain's content_hash includes the frontmatter (minus captured_at /
    // ingested_at). Two pages with different `id:` in frontmatter
    // therefore have DIFFERENT content_hashes regardless of body text,
    // so dedup never matches and both index naturally. This pins that
    // contract — important because earlier plan drafts assumed a
    // body-only hash that would have spuriously deduped these.
    const a = makeFile('templates/daily-1.md', granolaFrontmatter('granola-uuid-A', 'Daily Template'));
    const b = makeFile('templates/daily-2.md', granolaFrontmatter('granola-uuid-B', 'Daily Template'));
    const first = await importFromFile(engine, a.path, 'templates/daily-1.md', { noEmbed: true });
    expect(first.status).toBe('imported');
    const second = await importFromFile(engine, b.path, 'templates/daily-2.md', { noEmbed: true });
    expect(second.status).toBe('imported');
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(rows[0].n).toBe(2);
  });

  test('soft-deleted duplicate does NOT block re-import under new slug', async () => {
    const a = makeFile('old/note.md', granolaFrontmatter('granola-uuid-X'));
    const first = await importFromFile(engine, a.path, 'old/note.md', { noEmbed: true });
    expect(first.status).toBe('imported');

    // Soft-delete the page; a future re-import under a new slug should
    // proceed (not block on the tombstone).
    await engine.softDeletePage('old/note');

    const b = makeFile('new/note.md', granolaFrontmatter('granola-uuid-X'));
    const second = await importFromFile(engine, b.path, 'new/note.md', { noEmbed: true });
    expect(second.status).toBe('imported');

    // Both rows exist: one tombstoned, one live.
    const live = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(live[0].n).toBe(1);
    const all = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages`);
    expect(all[0].n).toBe(2);
  });

  test('no frontmatter.id: skip-decision falls back to content_hash WARNING (not SKIP)', async () => {
    // Bare markdown — no `id:` in frontmatter at all. Two files with
    // identical text but no external identity — must NOT silently dedup.
    const body = '---\ntype: concept\ntitle: Plain\n---\n\nBare markdown body.';
    const a = makeFile('plain-a.md', body);
    const b = makeFile('plain-b.md', body);
    const first = await importFromFile(engine, a.path, 'plain-a.md', { noEmbed: true });
    expect(first.status).toBe('imported');

    const origWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof origWrite }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      const s = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString() : String(chunk);
      captured.push(s);
      return origWrite(chunk as Parameters<typeof origWrite>[0], ...(rest as []));
    };
    try {
      const second = await importFromFile(engine, b.path, 'plain-b.md', { noEmbed: true });
      expect(second.status).toBe('imported');
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }

    const text = captured.join('');
    expect(text).toContain('[import] WARNING');
    expect(text).toContain('shares content_hash');

    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(rows[0].n).toBe(2);
  });

  test('first ingest of a unique file: no dedup fire, status=imported', async () => {
    const a = makeFile('alpha/note.md', granolaFrontmatter('granola-uuid-1'));
    const result = await importFromFile(engine, a.path, 'alpha/note.md', { noEmbed: true });
    expect(result.status).toBe('imported');
  });

  test('--force-rechunk bypasses dedup pre-check', async () => {
    const a = makeFile('subdir/note.md', granolaFrontmatter('granola-uuid-1'));
    const b = makeFile('note.md', granolaFrontmatter('granola-uuid-1'));
    await importFromFile(engine, a.path, 'subdir/note.md', { noEmbed: true });

    // forceRechunk=true → dedup check is skipped → second insert proceeds
    // even though the same external ID is already present at another slug.
    const second = await importFromFile(engine, b.path, 'note.md', { noEmbed: true, forceRechunk: true });
    expect(['imported', 'replaced']).toContain(second.status as string);
  });
});

describe('findDuplicatePage engine method', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('returns null when no row matches', async () => {
    const r = await engine.findDuplicatePage!('default', { hash: 'nonexistent' });
    expect(r).toBeNull();
  });

  test('matches on content_hash', async () => {
    await engine.putPage('alpha/note', {
      type: 'concept',
      title: 'Alpha',
      compiled_truth: 'identical body',
      frontmatter: { type: 'concept' },
      content_hash: 'deadbeef',
    });
    const r = await engine.findDuplicatePage!('default', { hash: 'deadbeef' });
    expect(r?.slug).toBe('alpha/note');
  });

  test('matches on frontmatter.id even when content_hash differs', async () => {
    await engine.putPage('alpha/note', {
      type: 'concept',
      title: 'Alpha',
      compiled_truth: 'body v1',
      frontmatter: { type: 'concept', id: 'external-uuid' },
      content_hash: 'aaa',
    });
    const r = await engine.findDuplicatePage!('default', { hash: 'zzz', frontmatterId: 'external-uuid' });
    expect(r?.slug).toBe('alpha/note');
  });

  test('soft-deleted rows excluded from results', async () => {
    await engine.putPage('alpha/note', {
      type: 'concept',
      title: 'Alpha',
      compiled_truth: 'body',
      frontmatter: { type: 'concept' },
      content_hash: 'cafef00d',
    });
    await engine.softDeletePage('alpha/note');
    const r = await engine.findDuplicatePage!('default', { hash: 'cafef00d' });
    expect(r).toBeNull();
  });

  test('cross-source isolation: hash match in source B is invisible from source A', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('shared', {
      type: 'concept',
      title: 'Beta-only',
      compiled_truth: 'body',
      frontmatter: { type: 'concept' },
      content_hash: 'beef',
    }, { sourceId: 'beta' });
    const fromAlpha = await engine.findDuplicatePage!('alpha', { hash: 'beef' });
    expect(fromAlpha).toBeNull();
    const fromBeta = await engine.findDuplicatePage!('beta', { hash: 'beef' });
    expect(fromBeta?.slug).toBe('shared');
  });
});
