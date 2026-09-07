/**
 * Migration v147 (strip_markdown_extension_slugs) — #4807 follow-up.
 *
 * validateSlug strips a trailing `.md`/`.mdx` on every write and the ops layer
 * normalizes the caller's slug the same way on read/delete/restore, so a row
 * whose STORED slug still ends in `.md` (written by a pre-#4807 put_page with a
 * filename-shaped slug) is unreachable by any key and forks: the next
 * put_page('x.md') creates a sibling 'x' while the old 'x.md' row lingers as a
 * stale near-duplicate that get_page can never return again.
 *
 * Pinned contracts:
 * 1. v147 exists in MIGRATIONS (canonical name, idempotent, handler-only).
 * 2. Upgrade: live AND soft-deleted `.md` rows are renamed to the stripped slug
 *    in their own source; the ledger advances; a re-run applies nothing.
 * 3. Collision: when the stripped slug already exists in the same source, the
 *    extension-bearing twin is soft-deleted (not renamed, not left live) so
 *    exactly one live row answers to the key. Re-running is a no-op.
 * 4. A row whose strip would leave an empty segment is skipped, not renamed
 *    into a malformed slug, and does not abort the migration.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

const v147 = MIGRATIONS.find(m => m.version === 147);

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

/** Seed a row the way a pre-#4807 putPage left it: stored slug carries the extension. */
async function seedRaw(slug: string, body: string, opts: { sourceId?: string; deleted?: boolean } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, content_hash, deleted_at)
     VALUES ($1, $2, 'note', $3, $4, '', md5($4), $5::timestamptz)`,
    [opts.sourceId ?? 'default', slug, slug, body, opts.deleted ? new Date().toISOString() : null],
  );
}

async function slugsLike(prefix: string): Promise<Array<{ slug: string; source_id: string; deleted: boolean }>> {
  return engine.executeRaw<{ slug: string; source_id: string; deleted: boolean }>(
    `SELECT slug, source_id, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug LIKE $1 ORDER BY source_id, slug`,
    [`${prefix}%`],
  );
}

describe('migration v147 — structure', () => {
  test('exists with canonical name, idempotent flag, handler-only', () => {
    expect(v147).toBeDefined();
    expect(v147?.name).toBe('strip_markdown_extension_slugs');
    expect(v147?.idempotent).toBe(true);
    expect(v147?.sql).toBe('');
    expect(typeof v147?.handler).toBe('function');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(147);
  });
});

describe('migration v147 — upgrade from a pre-#4807 brain (PGLite)', () => {
  test('renames live + soft-deleted .md rows per source; ledger advances; re-run applies nothing', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedRaw('legacy/report.md', 'OLD BODY');
    await seedRaw('legacy/report.md', 'OTHER SOURCE BODY', { sourceId: 'other' });
    await seedRaw('legacy/gone.MDX', 'gone body', { deleted: true });
    await seedRaw('legacy/plain', 'untouched');

    await engine.setConfig('version', '146');
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    expect(await slugsLike('legacy/')).toEqual([
      { slug: 'legacy/gone', source_id: 'default', deleted: true },
      { slug: 'legacy/plain', source_id: 'default', deleted: false },
      { slug: 'legacy/report', source_id: 'default', deleted: false },
      { slug: 'legacy/report', source_id: 'other', deleted: false },
    ]);
    expect((await engine.getPage('legacy/report', { sourceId: 'default' }))?.compiled_truth).toBe('OLD BODY');
    expect((await engine.getPage('legacy/report', { sourceId: 'other' }))?.compiled_truth).toBe('OTHER SOURCE BODY');
    // The renamed row is what the write path now targets: no fork on the next put.
    await engine.putPage('legacy/report.md', { type: 'note', title: 'r', compiled_truth: 'NEW BODY', timeline: '' });
    const after = await slugsLike('legacy/report');
    expect(after.filter(r => r.source_id === 'default')).toEqual([{ slug: 'legacy/report', source_id: 'default', deleted: false }]);
    expect((await engine.getPage('legacy/report', { sourceId: 'default' }))?.compiled_truth).toBe('NEW BODY');

    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);
  });

  test('collision: the .md twin of an existing canonical row is soft-deleted, the canonical keeps its body; idempotent', async () => {
    await seedRaw('ops/tasks.md', 'OLD LIST');
    await engine.putPage('ops/tasks', { type: 'note', title: 't', compiled_truth: 'NEW LIST', timeline: '' });

    await v147!.handler!(engine);
    expect(await slugsLike('ops/tasks')).toEqual([
      { slug: 'ops/tasks', source_id: 'default', deleted: false },
      { slug: 'ops/tasks.md', source_id: 'default', deleted: true },
    ]);
    expect((await engine.getPage('ops/tasks'))?.compiled_truth).toBe('NEW LIST');

    // Re-run: the retired twin is left alone (still exactly one live row).
    await v147!.handler!(engine);
    expect(await slugsLike('ops/tasks')).toEqual([
      { slug: 'ops/tasks', source_id: 'default', deleted: false },
      { slug: 'ops/tasks.md', source_id: 'default', deleted: true },
    ]);
  });

  test('a slug whose strip leaves an empty segment is skipped, not renamed into a malformed key', async () => {
    await seedRaw('legacy/.md', 'odd');
    await seedRaw('legacy/ok.md', 'fine');
    await v147!.handler!(engine);
    expect(await slugsLike('legacy/')).toEqual([
      { slug: 'legacy/.md', source_id: 'default', deleted: false },
      { slug: 'legacy/ok', source_id: 'default', deleted: false },
    ]);
  });
});
