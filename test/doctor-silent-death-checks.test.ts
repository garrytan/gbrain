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
  opts: { sourceId?: string; hash?: string | null; pageKind?: string; type?: string; deleted?: boolean; sourcePath?: string | null } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, deleted_at, source_path)
     VALUES ($1, $2, $7, $3, $1, 'body', '', '{}'::jsonb, $4, $5, $6)`,
    [
      slug,
      opts.sourceId ?? 'default',
      opts.pageKind ?? 'markdown',
      opts.hash === undefined ? `h-${slug}` : opts.hash,
      opts.deleted ? new Date().toISOString() : null,
      opts.sourcePath ?? null,
      opts.type ?? 'concept',
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

  test('#3946: two path-prefixed pages with same hash → warn, listed, NO delete hint', async () => {
    // Pre-#3946 the shape FILTER predicates hid every all-nested duplicate
    // group; now it surfaces, but WITHOUT the bare-slug delete hint (#3942 —
    // either copy may be canonical).
    await addPage('people/alice-example', { hash: 'same' });
    await addPage('archive/people/alice-example', { hash: 'same' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('people/alice-example == archive/people/alice-example');
    expect(c.message).not.toContain('gbrain pages delete');
    expect((c.details as any).pair_count).toBe(0);
    expect((c.details as any).distinct_slug_group_count).toBe(1);
  });

  test('#3946: two distinct bare slugs with same hash → warn without delete hint', async () => {
    await addPage('alice-example', { hash: 'same' });
    await addPage('alice-copy', { hash: 'same' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('alice-copy == alice-example');
    expect(c.message).not.toContain('gbrain pages delete');
    expect((c.details as any).pair_count).toBe(0);
    expect((c.details as any).distinct_slug_group_count).toBe(1);
  });

  test('#3946: mixed brain — wrong-root pair keeps the delete hint, nested group listed beside it', async () => {
    await addPage('people/alice-example', { hash: 'h1' });
    await addPage('alice-example', { hash: 'h1' });
    await addPage('notes/dup-a', { hash: 'h2' });
    await addPage('archive/dup-a', { hash: 'h2' });
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('alice-example <-> people/alice-example');
    expect(c.message).toContain('gbrain pages delete <bare-slug>');
    expect(c.message).toContain('notes/dup-a == archive/dup-a');
    expect((c.details as any).pair_count).toBe(1);
    expect((c.details as any).distinct_slug_group_count).toBe(1);
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

  test('file-backed page without source_path uses its normalized file slug', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'People'), { recursive: true });
    writeFileSync(join(repo, 'People', 'Alice Example.md'), '# Alice');
    await addSource('src-a', repo);
    await addPage('people/alice-example', { sourceId: 'src-a' });

    const c = await checkUndeclaredDbOnlyPages(engine);

    expect(c.status).toBe('ok');
  });

  test('Git-root source_path under a subdirectory local_path → file-backed', async () => {
    const gitRoot = makeRepo();
    mkdirSync(join(gitRoot, '.git'));
    const sourceRoot = join(gitRoot, 'public', 'changelog');
    mkdirSync(join(sourceRoot, 'posts'), { recursive: true });
    writeFileSync(join(sourceRoot, 'posts', '2026-08-18.md'), '# Release');
    await addSource('src-a', sourceRoot);
    await addPage('public/changelog/posts/2026-08-18', {
      sourceId: 'src-a',
      sourcePath: 'public/changelog/posts/2026-08-18.md',
    });

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

  // #3766 — a `storage.db_only` prefix typed with any uppercase (a plausible
  // authoring choice — nothing in gbrain.yml's schema requires lowercase)
  // used to never match, because page slugs are ALWAYS lowercased at write
  // time (pathToSlug/slugifyCodePath) regardless of the host filesystem's
  // case sensitivity, while the declared prefix was compared verbatim. Every
  // page under the declared directory was falsely flagged undeclared.
  test('declared db_only prefix with different case still matches the (always-lowercase) slug', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - Notes/\n');
    await addSource('src-a', repo);
    await addPage('notes/db-resident', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  // False-negative guard for the fix above: a case-insensitive prefix match
  // must not become a blanket "everything is covered" match. A page under an
  // UNRELATED directory in the same source (with the same mixed-case
  // declaration active) must still be flagged exactly as before.
  test('mixed-case declared prefix does not swallow pages under an unrelated directory', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - Notes/\n');
    await addSource('src-a', repo);
    await addPage('notes/db-resident', { sourceId: 'src-a' });
    await addPage('people/ghost-page', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('people/ghost-page');
    expect(c.message).not.toContain('notes/db-resident');
    expect((c.details as any).total).toBe(1);
  });

  // #3766 literal repro check: the reporter's symptom (a code source
  // indexing a Next.js App Router repo — bracketed dynamic-route
  // directories, camelCase filenames — got 225/254 pages falsely flagged).
  // Code pages (`page_kind: 'code'`) use a different, non-lossy slug scheme
  // (`slugifyCodePath`, which — unlike the markdown slugifier — intentionally
  // keeps framework paths like `app/[id]/page.tsx` indexable) and this check
  // scopes its SQL to `page_kind = 'markdown'` only, so no code page can ever
  // reach this check's matching logic in the first place. Locks in current
  // (already-correct) behavior against regression.
  test('#3766 repro: bracket-route + camelCase code page is never considered (page_kind=code out of scope)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'app', 'shop', '[id]'), { recursive: true });
    writeFileSync(join(repo, 'app', 'shop', '[id]', 'page.tsx'), 'export default function Page() {}');
    mkdirSync(join(repo, 'components'), { recursive: true });
    writeFileSync(join(repo, 'components', 'ArchiveButton.tsx'), 'export function ArchiveButton() {}');
    await addSource('src-a', repo);
    // Slugs mirror what slugifyCodePath('app/shop/[id]/page.tsx') /
    // slugifyCodePath('components/ArchiveButton.tsx') actually produce.
    await addPage('app-shop-id-page-tsx', { sourceId: 'src-a', pageKind: 'code' });
    await addPage('components-archivebutton-tsx', { sourceId: 'src-a', pageKind: 'code' });
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

  // #3766 — legacy code rows carry page_kind='markdown' (migration-25
  // backfill never re-stamped type='code'), and the backed set only walked
  // .mdx? files, so every such row false-positived as "DB-only".
  test('#3766: legacy code row (page_kind=markdown, no type stamp) backed by a .tsx file → ok', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'components'), { recursive: true });
    writeFileSync(join(repo, 'components', 'App.tsx'), 'export const App = () => null;\n');
    await addSource('src-a', repo);
    // slugifyCodePath('components/App.tsx') → 'components-app-tsx'; no
    // source_path (the pre-v0.32.7 shape) so the walk-derived set decides.
    await addPage('components-app-tsx', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test("#3766: properly stamped type='code' row is skipped outright", async () => {
    const repo = makeRepo();
    await addSource('src-a', repo);
    await addPage('src-core-thing-ts', { sourceId: 'src-a', type: 'code' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('ok');
  });

  test('#3766: a genuinely DB-only markdown page still warns (no overreach)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'components'), { recursive: true });
    writeFileSync(join(repo, 'components', 'App.tsx'), 'export const App = () => null;\n');
    await addSource('src-a', repo);
    await addPage('people/ghost-page', { sourceId: 'src-a' });
    const c = await checkUndeclaredDbOnlyPages(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('people/ghost-page');
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

  // #3766 — declared prefixes are lowercased before the union, since the
  // only consumer (checkUndeclaredDbOnlyPages) matches them against
  // always-lowercase page slugs. A mixed-case declaration still dedupes
  // against an already-lowercase default/declaration for the same directory.
  test('effectiveDbOnlyDirs lowercases declared dirs (case-insensitive match against always-lowercase slugs)', () => {
    const dirs = effectiveDbOnlyDirs(['Notes/', 'ATOMS/']);
    expect(dirs).toContain('notes/');
    expect(dirs).not.toContain('Notes/');
    // 'ATOMS/' lowercases to 'atoms/', which collides with (dedupes against)
    // the derive-phase default of the same name.
    expect(dirs.filter(d => d === 'atoms/').length).toBe(1);
    expect(dirs).not.toContain('ATOMS/');
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
