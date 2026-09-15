/**
 * #4588 — the import SKIP path refreshes `pages.source_path`.
 *
 * A row whose slug moved before the sync rename repair existed keeps a
 * source_path naming the OLD file. Write-through prefers source_path, so every
 * later write recreates the old directory, and the full-sync reconcile reads
 * the stale path as "file removed". The changed-content import path already
 * heals this through putPage's COALESCE; the unchanged-content skip (the
 * common case on every re-sync) used to discard the real path handed in by
 * importFile. Both skip branches — the canonical hash short-circuit and the
 * #3694 legacy-hash reconcile — must now write it.
 *
 * Pre-landing review (performance): the heal must NOT cost a statement per
 * UNCHANGED file. A 20k-file tree re-synced with nothing changed used to issue
 * 20k zero-row UPDATEs (each still firing the statement-level generation-clock
 * trigger). getPage now projects `source_path`, so the skip path compares the
 * stored path first and only issues the UPDATE when it actually differs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHashLegacy } from '../src/core/utils.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

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
});

const SLUG = 'people/alpha';
const REAL_PATH = 'people/alpha.md';
const STALE_PATH = 'people/old.md';
const BODY = ['---', 'type: person', 'title: Alpha', '---', '', 'Alpha is a person.'].join('\n');

type ImportOpts = Parameters<typeof importFromContent>[3];

async function sourcePathOf(slug: string, sourceId = 'default'): Promise<string | null> {
  const rows = await engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path FROM pages WHERE source_id = $2 AND slug = $1 AND deleted_at IS NULL`,
    [slug, sourceId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].source_path;
}

async function driftTo(slug: string, stalePath: string, sourceId = 'default'): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET source_path = $1 WHERE source_id = $3 AND slug = $2`,
    [stalePath, slug, sourceId],
  );
  expect(await sourcePathOf(slug, sourceId)).toBe(stalePath);
}

/**
 * Run one import while counting the skip path's `UPDATE pages SET source_path`
 * statements. The spy shadows the prototype method on the instance for the
 * duration of the call only, so the drift/readback helpers above never count.
 */
async function importCountingRefreshes(slug: string, body: string, opts: ImportOpts) {
  const orig = engine.executeRaw.bind(engine);
  const updates: string[] = [];
  Object.defineProperty(engine, 'executeRaw', {
    configurable: true,
    value: (sql: string, params?: unknown[]) => {
      if (/UPDATE pages SET source_path/.test(sql)) updates.push(sql);
      return orig(sql, params);
    },
  });
  try {
    const result = await importFromContent(engine, slug, body, opts);
    return { result, updates };
  } finally {
    Reflect.deleteProperty(engine, 'executeRaw');
  }
}

function legacyHashOf(body: string, slug: string): string {
  const parsed = parseMarkdown(body, `${slug}.md`);
  return contentHashLegacy({
    title: parsed.title,
    type: parsed.type as never,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  });
}

describe('#4588 import skip path refreshes a drifted source_path', () => {
  test('hash-equal skip rewrites source_path to the path the file really lives at', async () => {
    const first = await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(first.status).toBe('imported');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);

    await driftTo(SLUG, STALE_PATH);

    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    // pre-fix: still 'people/old.md' — the skip returned before any write.
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
    // A real drift costs exactly one statement.
    expect(updates).toHaveLength(1);
  });

  test('#3694 legacy-hash skip rewrites source_path too', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const legacy = legacyHashOf(BODY, SLUG);
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE source_id = 'default' AND slug = $2`,
      [legacy, SLUG],
    );
    await driftTo(SLUG, STALE_PATH);

    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
    expect(updates).toHaveLength(1);
    // The legacy branch still reconciled the hash (fast path next time).
    const row = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(row!.content_hash).not.toBe(legacy);
  });

  test('a skip without sourcePath (put_page / capture lane) leaves source_path alone', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true });
    expect(again.status).toBe('skipped');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
    expect(updates).toHaveLength(0);
  });
});

describe('the refresh is skipped entirely when the stored source_path already matches (pre-landing review)', () => {
  test('hash-equal skip of an unchanged file issues NO source_path UPDATE', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });

    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    // pre-fix: one zero-row UPDATE per unchanged file (20k statements on a
    // 20k-file unchanged tree, each firing the generation-clock trigger).
    expect(updates).toHaveLength(0);
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
  });

  test('#3694 legacy-hash skip of an unchanged file issues NO source_path UPDATE', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const legacy = legacyHashOf(BODY, SLUG);
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE source_id = 'default' AND slug = $2`,
      [legacy, SLUG],
    );

    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    expect(updates).toHaveLength(0);
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
  });

  test('same slug in two sources: re-importing default never touches the other source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`);
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH, sourceId: 'other' });
    // Drift ONLY the other source's row.
    await driftTo(SLUG, STALE_PATH, 'other');

    const { result: again, updates } = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    // default already matches → no statement; other is out of scope → untouched.
    expect(updates).toHaveLength(0);
    expect(await sourcePathOf(SLUG, 'default')).toBe(REAL_PATH);
    expect(await sourcePathOf(SLUG, 'other')).toBe(STALE_PATH);

    // The other source heals on ITS OWN import, still without touching default.
    const other = await importCountingRefreshes(SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH, sourceId: 'other' });
    expect(other.result.status).toBe('skipped');
    expect(other.updates).toHaveLength(1);
    expect(await sourcePathOf(SLUG, 'other')).toBe(REAL_PATH);
    expect(await sourcePathOf(SLUG, 'default')).toBe(REAL_PATH);
  });

  test('getPage projects source_path (the short-circuit input) — PGLite', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(page!.source_path).toBe(REAL_PATH);

    // Three-state read: a row written without a path reads back null, not undefined.
    await importFromContent(engine, 'people/beta', BODY.replace('Alpha', 'Beta'), { noEmbed: true });
    const beta = await engine.getPage('people/beta', { sourceId: 'default' });
    expect(beta!.source_path).toBeNull();
  });
});
