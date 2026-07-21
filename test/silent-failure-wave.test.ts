/**
 * Regression tests for the silent-failure cleanup wave (post-#2375).
 *
 *  - #2251  updateSourceConfig array-branch guard (jsonb_each on a non-object)
 *  - #2330  getStats vs getHealth page-count parity (both exclude soft-deleted)
 *  - #2297  files upload-raw persistence helpers (page-namespaced, no clobber)
 *
 * Hermetic in-memory PGLite; Postgres parity covered by the e2e suite. The
 * #2251 + #2330 fixes also land in postgres-engine.ts in lockstep.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resolveRepoRoot, lookupPageBySlug, insertFileRow, namespacedStoragePath } from '../src/commands/files.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

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

async function seedSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, id, localPath],
  );
}

async function seedPage(slug: string, opts: { deleted?: boolean; sourceId?: string } = {}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, deleted_at)
     VALUES ($1, $2, 'note', $2, ${opts.deleted ? 'NOW()' : 'NULL'})
     RETURNING id`,
    [opts.sourceId ?? 'default', slug],
  );
  return rows[0].id;
}

describe('#2251 — updateSourceConfig array-branch guard', () => {
  test('coerces a corrupted array config (with a non-object element) instead of throwing', async () => {
    await seedSource('corrupt-arr', '/tmp/corrupt-arr');
    // Force the historical bad shape: a JSONB ARRAY whose elements include a
    // non-object scalar. Pre-fix, the array branch ran jsonb_each() on the
    // string element and the whole UPDATE aborted with
    // "cannot call jsonb_each on a non-object".
    await engine.executeRaw(
      `UPDATE sources SET config = '["stray-string", {"federated": true}]'::jsonb WHERE id = $1`,
      ['corrupt-arr'],
    );

    // Must NOT throw, and must return true (row matched).
    const ok = await engine.updateSourceConfig('corrupt-arr', { tracked_branch: 'main' });
    expect(ok).toBe(true);

    const rows = await engine.executeRaw<{ typ: string; cfg: Record<string, unknown> }>(
      `SELECT jsonb_typeof(config) AS typ, config AS cfg FROM sources WHERE id = $1`,
      ['corrupt-arr'],
    );
    expect(rows[0].typ).toBe('object');
    // Object element flattened, scalar element skipped, patch merged.
    expect(rows[0].cfg.federated).toBe(true);
    expect(rows[0].cfg.tracked_branch).toBe('main');
  });

  test('still coerces a double-encoded string config', async () => {
    await seedSource('corrupt-str', '/tmp/corrupt-str');
    await engine.executeRaw(
      `UPDATE sources SET config = to_jsonb('{"github_repo":"a/b"}'::text) WHERE id = $1`,
      ['corrupt-str'],
    );
    const ok = await engine.updateSourceConfig('corrupt-str', { federated: false });
    expect(ok).toBe(true);
    const rows = await engine.executeRaw<{ typ: string; cfg: Record<string, unknown> }>(
      `SELECT jsonb_typeof(config) AS typ, config AS cfg FROM sources WHERE id = $1`,
      ['corrupt-str'],
    );
    expect(rows[0].typ).toBe('object');
    expect(rows[0].cfg.github_repo).toBe('a/b');
    expect(rows[0].cfg.federated).toBe(false);
  });
});

describe('#2330 — skill_surface check is categorized as skill (not vacuous meta)', () => {
  test('the focused-doctor skill_surface check lands in the skill category', () => {
    // Without this wiring the explicit skill_surface check would fall through to
    // meta, leaving category_scores.skill a vacuous 100 — the exact dishonesty
    // #2330 reports. categorizeCheck must map it to skill.
    expect(categorizeCheck('skill_surface')).toBe('skill');
  });
});

describe('#2330 — getStats and getHealth agree on page_count (both exclude soft-deleted)', () => {
  test('soft-deleted pages are excluded from BOTH surfaces', async () => {
    await seedPage('live/one');
    await seedPage('live/two');
    await seedPage('gone/three', { deleted: true });

    const stats = await engine.getStats();
    const health = await engine.getHealth();

    expect(stats.page_count).toBe(2);
    expect(health.page_count).toBe(2);
    expect(health.page_count).toBe(stats.page_count);
  });
});

describe('#2297 — upload-raw persistence helpers', () => {
  test('resolveRepoRoot prefers source.local_path, falls back to sync.repo_path', async () => {
    await seedSource('teamco', '/repos/teamco');
    expect(await resolveRepoRoot(engine, 'teamco')).toBe('/repos/teamco');

    await engine.setConfig('sync.repo_path', '/repos/default');
    expect(await resolveRepoRoot(engine, 'default')).toBe('/repos/default');
    expect(await resolveRepoRoot(engine, null)).toBe('/repos/default');
  });

  test('lookupPageBySlug returns the live page id + source, honoring the source hint', async () => {
    const id = await seedPage('people/alice-example');
    const found = await lookupPageBySlug(engine, 'people/alice-example');
    expect(found?.id).toBe(id);
    expect(found?.source_id).toBe('default');
    expect(await lookupPageBySlug(engine, 'people/nobody')).toBeNull();

    // Same slug in a second source → the hint disambiguates (#2297).
    await seedSource('teamco', '/repos/teamco');
    const teamId = await seedPage('people/alice-example', { sourceId: 'teamco' });
    const hinted = await lookupPageBySlug(engine, 'people/alice-example', 'teamco');
    expect(hinted?.id).toBe(teamId);
    expect(hinted?.source_id).toBe('teamco');

    // Explicit --source is STRICT: a scoped miss returns null even though the
    // slug exists in `default` — no silent cross-source fallback.
    expect(await lookupPageBySlug(engine, 'people/alice-example', 'no-such-source')).toBeNull();
  });

  test('namespacedStoragePath keeps default-source paths but isolates other sources (#2297)', async () => {
    // Default source: byte-identical to the historical path.
    expect(namespacedStoragePath('default', 'people/alice/.raw/cv.pdf')).toBe('people/alice/.raw/cv.pdf');
    expect(namespacedStoragePath(null, 'people/alice/.raw/cv.pdf')).toBe('people/alice/.raw/cv.pdf');
    // Non-default source: prefixed so the same slug+filename can't collide on
    // the globally-UNIQUE storage_path.
    expect(namespacedStoragePath('teamco', 'people/alice/.raw/cv.pdf')).toBe('teamco/people/alice/.raw/cv.pdf');

    // End to end: two sources, same slug+filename → two distinct rows.
    await seedSource('src-a', '/repos/a');
    await seedSource('src-b', '/repos/b');
    const aId = await seedPage('shared/slug', { sourceId: 'src-a' });
    const bId = await seedPage('shared/slug', { sourceId: 'src-b' });
    await insertFileRow(engine, {
      sourceId: 'src-a', pageId: aId, pageSlug: 'shared/slug', filename: 'f.pdf',
      storagePath: namespacedStoragePath('src-a', 'shared/slug/.raw/f.pdf'),
      mimeType: 'application/pdf', size: 1, contentHash: 'sha256:a', metadata: {},
    });
    await insertFileRow(engine, {
      sourceId: 'src-b', pageId: bId, pageSlug: 'shared/slug', filename: 'f.pdf',
      storagePath: namespacedStoragePath('src-b', 'shared/slug/.raw/f.pdf'),
      mimeType: 'application/pdf', size: 2, contentHash: 'sha256:b', metadata: {},
    });
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM files`);
    expect(rows[0].n).toBe(2);
  });

  test('insertFileRow persists a row; page-namespaced paths do not clobber across pages', async () => {
    const aliceId = await seedPage('people/alice-example');
    const bobId = await seedPage('people/bob-example');

    // Same filename, different page → page-namespaced storage_path keeps both.
    await insertFileRow(engine, {
      sourceId: 'default', pageId: aliceId, pageSlug: 'people/alice-example',
      filename: 'resume.pdf', storagePath: 'people/alice-example/.raw/resume.pdf',
      mimeType: 'application/pdf', size: 10, contentHash: 'sha256:a', metadata: { upload_method: 'git' },
    });
    await insertFileRow(engine, {
      sourceId: 'default', pageId: bobId, pageSlug: 'people/bob-example',
      filename: 'resume.pdf', storagePath: 'people/bob-example/.raw/resume.pdf',
      mimeType: 'application/pdf', size: 20, contentHash: 'sha256:b', metadata: { upload_method: 'git' },
    });

    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM files`);
    expect(rows[0].n).toBe(2);

    // Re-uploading the SAME storage_path upserts (no duplicate), and metadata
    // round-trips as a real JSONB object (not a double-encoded string).
    await insertFileRow(engine, {
      sourceId: 'default', pageId: aliceId, pageSlug: 'people/alice-example',
      filename: 'resume.pdf', storagePath: 'people/alice-example/.raw/resume.pdf',
      mimeType: 'application/pdf', size: 99, contentHash: 'sha256:a2', metadata: { upload_method: 'git', type: 'cv' },
    });
    const after = await engine.executeRaw<{ n: number; size_bytes: number; meta_typ: string }>(
      `SELECT count(*)::int AS n,
              max(size_bytes) AS size_bytes,
              jsonb_typeof((SELECT metadata FROM files WHERE storage_path = 'people/alice-example/.raw/resume.pdf')) AS meta_typ
         FROM files`,
    );
    expect(after[0].n).toBe(2);              // upsert, not insert
    expect(Number(after[0].size_bytes)).toBe(99); // updated row
    expect(after[0].meta_typ).toBe('object');     // metadata is a real object
  });
});
