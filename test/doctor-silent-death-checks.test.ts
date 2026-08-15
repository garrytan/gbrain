/**
 * Unit tests for the silent-failure doctor check batch (#2250, #2784, #2788).
 * Hermetic PGLite; temp dirs stand in for source repos. Postgres parity for
 * the same checks is pinned by test/e2e/doctor-silent-death-parity.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  checkContentHashDuplicates,
  checkUndeclaredDbOnlyPages,
  checkDbOnlyCollectorCollision,
} from '../src/commands/doctor.ts';
import {
  DERIVE_PHASE_DB_ONLY_DEFAULTS,
  effectiveDbOnlyDirs,
  findDbOnlyCollisions,
} from '../src/core/storage-config.ts';

let engine: PGLiteEngine;
const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-'));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function addSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, localPath],
  );
}

async function addPage(
  slug: string,
  opts: { sourceId?: string; hash?: string | null; pageKind?: string; deleted?: boolean } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, deleted_at)
     VALUES ($1, $2, 'concept', $3, $1, 'body', '', '{}'::jsonb, $4, $5)`,
    [
      slug,
      opts.sourceId ?? 'default',
      opts.pageKind ?? 'markdown',
      opts.hash === undefined ? `h-${slug}` : opts.hash,
      opts.deleted ? new Date().toISOString() : null,
    ],
  );
}

describe('content_hash_duplicates (#2250)', () => {
  test('distinct hashes → ok', async () => {
    await addPage('people/alice-example');
    await addPage('projects/widget-co');
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });

  test('bare + path-prefixed twins with same hash → warn with pair + remediation', async () => {
    await addPage('people/alice-example', { hash: 'same' });
    await addPage('alice-example', { hash: 'same' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('alice-example <-> people/alice-example');
    expect(c.message).toContain('gbrain pages delete <bare-slug>');
    expect(c.message).toContain('gbrain pages purge-deleted --older-than 0');
    expect((c.details as any).pair_count).toBe(1);
  });

  test('multiple wrong-root pairs all counted', async () => {
    await addPage('people/alice-example', { hash: 'h1' });
    await addPage('alice-example', { hash: 'h1' });
    await addPage('projects/my-project', { hash: 'h2' });
    await addPage('my-project', { hash: 'h2' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect((c.details as any).pair_count).toBe(2);
    expect(c.message).toContain('my-project <-> projects/my-project');
  });

  test('two path-prefixed pages with same hash → ok (not the wrong-root pattern)', async () => {
    await addPage('people/alice-example', { hash: 'same' });
    await addPage('archive/people/alice-example', { hash: 'same' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });

  test('soft-deleted twin is ignored', async () => {
    await addPage('people/alice-example', { hash: 'same' });
    await addPage('alice-example', { hash: 'same', deleted: true });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });

  test('NULL / empty content_hash never groups', async () => {
    await addPage('people/alice-example', { hash: null });
    await addPage('alice-example', { hash: null });
    await addPage('people/bob-example', { hash: '' });
    await addPage('bob-example', { hash: '' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });

  test('same hash across DIFFERENT sources is not flagged (per-source grouping)', async () => {
    await addSource('other', null);
    await addPage('people/alice-example', { hash: 'same', sourceId: 'default' });
    await addPage('alice-example', { hash: 'same', sourceId: 'other' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });
});

describe('undeclared_db_only_pages (#2784)', () => {
  test('no sources with local_path → ok (not applicable)', async () => {
    await addPage('floating/page');
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Not applicable');
  });

  test('file-backed page → ok', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(join(repo, 'people', 'alice-example.md'), '# Alice');
    await addSource('src-a', repo);
    await addPage('people/alice-example', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test('file-backed page under a canonical hidden directory → ok', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.archive', 'people'), { recursive: true });
    writeFileSync(join(repo, '.archive', 'people', 'alice-example.md'), '# Alice');
    await addSource('src-a', repo);
    await addPage('.archive/people/alice-example', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test('derive-phase default prefixes are implicitly declared', async () => {
    const repo = makeRepo();
    await addSource('src-a', repo);
    for (const prefix of DERIVE_PHASE_DB_ONLY_DEFAULTS) {
      await addPage(`${prefix}page-1`, { sourceId: 'src-a' });
    }
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('life/events/');
  });

  test('declared db_only prefix in gbrain.yml keeps the check quiet', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - notes/\n');
    await addSource('src-a', repo);
    await addPage('notes/db-resident', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test('page with no backing file outside every db_only path → warn with sample + fix', async () => {
    const repo = makeRepo();
    await addSource('src-a', repo);
    await addPage('people/ghost-page', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('people/ghost-page');
    expect(c.message).toContain('storage.db_only');
    expect((c.details as any).total).toBe(1);
    expect((c.details as any).per_source['src-a']).toBe(1);
  });

  test('code pages are excluded (different slug scheme)', async () => {
    const repo = makeRepo();
    await addSource('src-a', repo);
    await addPage('src-core-thing-ts', { sourceId: 'src-a', pageKind: 'code' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test('source whose local_path is missing on this host is skipped', async () => {
    await addSource('src-gone', '/nonexistent/gbrain-test-path');
    await addPage('people/ghost-page', { sourceId: 'src-gone' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Not applicable');
  });

  test('effectiveDbOnlyDirs unions declared + defaults, deduped', () => {
    const dirs = effectiveDbOnlyDirs(['notes/', 'atoms/']);
    expect(dirs.filter(d => d === 'atoms/').length).toBe(1);
    expect(dirs).toContain('notes/');
    for (const d of DERIVE_PHASE_DB_ONLY_DEFAULTS) expect(dirs).toContain(d);
  });
});

describe('db_only_collector_collision (#2788)', () => {
  test('no collectors declare output paths → ok', async () => {
    const c = await checkDbOnlyCollectorCollision(engine, { collectors: [] });
    expect(c.status).toBe('ok');
  });

  test('collector output inside a db_only path → warn naming collector, path, and fix', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - daily/\n');
    await addSource('src-a', repo);
    const c = await checkDbOnlyCollectorCollision(engine, {
      collectors: [{ id: 'calendar-to-brain', output_path: 'daily/calendar/' }],
    });
    expect(c.status).toBe('warn');
    expect(c.message).toContain("collector 'calendar-to-brain'");
    expect(c.message).toContain("'daily/calendar/'");
    expect(c.message).toContain("db_only path 'daily/'");
    expect(c.message).toContain('silently skip');
    expect(c.message).toContain('storage.db_only');
  });

  test('exact-match db_only dir also collides', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - daily/calendar/\n');
    await addSource('src-a', repo);
    const c = await checkDbOnlyCollectorCollision(engine, {
      collectors: [{ id: 'calendar-to-brain', output_path: 'daily/calendar/' }],
    });
    expect(c.status).toBe('warn');
  });

  test('db_only elsewhere → ok', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - media/x/\n');
    await addSource('src-a', repo);
    const c = await checkDbOnlyCollectorCollision(engine, {
      collectors: [{ id: 'calendar-to-brain', output_path: 'daily/calendar/' }],
    });
    expect(c.status).toBe('ok');
  });

  test('sibling prefix does NOT collide (daily/calendar-x vs daily/calendar/)', () => {
    const hits = findDbOnlyCollisions(
      [{ id: 'x', output_path: 'daily/calendar-extra/' }],
      ['daily/calendar/'],
    );
    expect(hits.length).toBe(0);
  });

  test('findDbOnlyCollisions tolerates missing trailing slashes', () => {
    const hits = findDbOnlyCollisions(
      [{ id: 'x', output_path: 'daily/calendar' }],
      ['daily'],
    );
    expect(hits.length).toBe(1);
    expect(hits[0].db_only_dir).toBe('daily');
  });
});
