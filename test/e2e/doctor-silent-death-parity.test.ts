/**
 * E2E for the silent-failure doctor batch (#2250 / #2784 / #2788).
 *
 * Part 1 (always runs, PGLite): constructs the REAL #2250 failure condition —
 * the same files imported through the actual import path twice, once with
 * relative paths computed from the correct brain root and once from a root
 * one level too deep (which drops the path prefix from every slug) — then
 * asserts `content_hash_duplicates` fires with the remediation text.
 *
 * Part 2 (gated by DATABASE_URL): engine parity. Identical seeds on PGLite
 * and real Postgres, identical check results — pins the GROUP BY / FILTER /
 * string_agg SQL shape on both engines.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import {
  checkContentHashDuplicates,
  checkUndeclaredDbOnlyPages,
  checkDbOnlyCollectorCollision,
} from '../../src/commands/doctor.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';

const SKIP_PG = !hasDatabase();
const describePg = SKIP_PG ? describe.skip : describe;

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('wrong-root import produces content_hash_duplicates (#2250, PGLite)', () => {
  let engine: PGLiteEngine;
  let brainRoot: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // A brain with path-prefixed content dirs.
    brainRoot = makeDir('gbrain-wrongroot-');
    mkdirSync(join(brainRoot, 'people'), { recursive: true });
    mkdirSync(join(brainRoot, 'projects'), { recursive: true });
    // Explicit frontmatter (like real brain files) so the path-based
    // frontmatter inference doesn't run — the two import roots must produce
    // byte-identical content, hence identical content hashes.
    writeFileSync(
      join(brainRoot, 'people', 'alice-example.md'),
      '---\ntype: person\ndate: 2026-01-01\n---\n# Alice Example\n\nA founder the brain tracks across meetings and deals.\n',
    );
    writeFileSync(
      join(brainRoot, 'projects', 'widget-co.md'),
      '---\ntype: project\ndate: 2026-01-01\n---\n# Widget Co\n\nSeed-stage project notes with enough body to chunk.\n',
    );
  }, 120_000);

  afterAll(async () => {
    if (engine) {
      await disposePersistenceConsumer(engine);
      await engine.disconnect();
    }
  }, 60_000);

  test('correct-root import alone → check is ok', async () => {
    for (const rel of ['people/alice-example.md', 'projects/widget-co.md']) {
      const res = await importFromFile(engine, join(brainRoot, rel), rel, { noEmbed: true });
      expect(res.status).not.toBe('error');
    }
    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('ok');
  });

  test('re-import from a root one level too deep → warn with pairs + delete remediation', async () => {
    // The wrong-root mistake: import rooted inside people/ and projects/, so
    // the relative path (and therefore the slug) loses its directory prefix.
    for (const rel of ['people/alice-example.md', 'projects/widget-co.md']) {
      const abs = join(brainRoot, rel);
      const wrongRoot = join(brainRoot, rel.split('/')[0]); // one level too deep
      const wrongRel = relative(wrongRoot, abs); // "alice-example.md" — prefix dropped
      const res = await importFromFile(engine, abs, wrongRel, { noEmbed: true });
      expect(res.status).not.toBe('error');
    }

    const c = await checkContentHashDuplicates(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('alice-example <-> people/alice-example');
    expect(c.message).toContain('widget-co <-> projects/widget-co');
    expect(c.message).toContain('Fix: GBRAIN_SOURCE=default gbrain delete <bare-slug> --force for each pair.');
    expect(c.message).not.toContain('purge-deleted');
    expect((c.details as any).pair_count).toBe(2);
  });

  // #3697 class 3 / #5018: a remediation that names a command which then
  // fails. Follow the printed fix LITERALLY: parse `GBRAIN_SOURCE=<id> gbrain
  // <verb> <bare-slug> <flags>` out of the rendered message, resolve the verb
  // through the ops' CLI names, map the env pin to the active source and the
  // flags to params, and run it for every bare slug. Page writes are
  // revisioned, so a delete naming neither --force nor --expected-revision is
  // refused with revision_conflict, and `gbrain pages delete` does not exist.
  // The fix must soft-delete only the duplicates: an unrelated tombstone in
  // the brain survives (no hard purge of every tombstone).
  test('following the remediation literally soft-deletes the duplicates and keeps an unrelated tombstone', async () => {
    const home = makeDir('gbrain-dup-remediation-home-');
    const ctx = (sourceId: string) => ({ engine, config: { engine: 'pglite', embedding_disabled: true },
      logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId }) as any;
    const run = (op: (typeof operations)[number], sourceId: string, params: Record<string, unknown>) =>
      withEnv({ GBRAIN_HOME: home }, () => op.handler(ctx(sourceId), params)) as Promise<Record<string, any>>;
    const byCliName = (verb: string) => operations.find(o => (o.cliHints?.name ?? o.name) === verb);

    await engine.putPage('notes/unrelated-example', { type: 'note', title: 'Unrelated', compiled_truth: 'An unrelated page deleted earlier.' }, { sourceId: 'default' });
    expect((await run(byCliName('delete')!, 'default', { slug: 'notes/unrelated-example', force: true })).state).toBe('committed');

    const c = await checkContentHashDuplicates(engine);
    const printed = String(c.message).match(/Fix: GBRAIN_SOURCE=([a-z0-9-]+) gbrain ([a-z-]+) <bare-slug>((?: --[a-z-]+)*) for each pair\./);
    expect(printed).not.toBeNull();
    const [, sourceId, verb, flagText] = printed!;
    const op = byCliName(verb!);
    expect(op?.name).toBe('delete_page');
    const flags = flagText!.trim().split(/\s+/).filter(Boolean);
    const bareSlugs = ((c.details as any).sample_pairs as string[]).map(p => p.split(' <-> ')[0]);
    expect(bareSlugs.sort()).toEqual(['alice-example', 'widget-co']);
    for (const slug of bareSlugs) {
      const params: Record<string, unknown> = { slug };
      for (const flag of flags) params[flag.slice(2).replace(/-/g, '_')] = true;
      expect((await run(op!, sourceId!, params)).state).toBe('committed');
    }

    expect((await checkContentHashDuplicates(engine)).status).toBe('ok');
    const rows = await engine.executeRaw<{ slug: string; deleted: boolean }>(
      `SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id = 'default' ORDER BY slug`);
    expect(rows).toEqual([
      { slug: 'alice-example', deleted: true },
      { slug: 'notes/unrelated-example', deleted: true },
      { slug: 'people/alice-example', deleted: false },
      { slug: 'projects/widget-co', deleted: false },
      { slug: 'widget-co', deleted: true },
    ]);
  });
});

/**
 * Shared seed + assertions for engine parity. Raw SQL only (both engines
 * accept the identical statements — that is the point).
 */
async function seedAndRunAllChecks(engine: BrainEngine, repo: string) {
  // Shared test DBs can carry leftover sources from other e2e files; blank
  // their local_path so only the parity source contributes to the checks.
  await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id <> 'parity-src'`);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ('parity-src', 'parity-src', $1, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [repo],
  );
  const addPage = (slug: string, hash: string, sourceId = 'parity-src') =>
    engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash)
       VALUES ($1, $2, 'concept', 'markdown', $1, 'body', '', '{}'::jsonb, $3)`,
      [slug, sourceId, hash],
    );
  // #2250 shape: one bare/prefixed twin pair + one innocent page.
  await addPage('people/alice-example', 'dup-hash');
  await addPage('alice-example', 'dup-hash');
  await addPage('projects/clean-page', 'clean-hash');
  // #2784 shape: a ghost page with no backing file, plus a file-backed one
  // and a derive-phase default one.
  await addPage('people/ghost-page', 'ghost-hash');
  await addPage('life/events/derived-1', 'derived-hash');

  const dup = await checkContentHashDuplicates(engine);
  const undeclared = await checkUndeclaredDbOnlyPages(engine);
  const collision = await checkDbOnlyCollectorCollision(engine, {
    collectors: [{ id: 'calendar-to-brain', output_path: 'daily/calendar/' }],
  });
  return { dup, undeclared, collision };
}

describePg('engine parity: identical seeds, identical check results (PGLite vs Postgres)', () => {
  let pglite: PGLiteEngine;
  let repo: string;

  beforeAll(async () => {
    repo = makeDir('gbrain-parity-');
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(join(repo, 'people', 'alice-example.md'), '# Alice');
    // The bare-slug twin also gets a root-level file so only the deliberate
    // ghost page (people/ghost-page) counts as undeclared.
    writeFileSync(join(repo, 'alice-example.md'), '# Alice (bare twin)');
    mkdirSync(join(repo, 'projects'), { recursive: true });
    writeFileSync(join(repo, 'projects', 'clean-page.md'), '# Clean');
    writeFileSync(join(repo, 'gbrain.yml'), 'storage:\n  db_only:\n    - daily/\n');

    pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await setupDB();
  }, 180_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  }, 60_000);

  test('negative: clean engines → content_hash_duplicates ok on both', async () => {
    for (const engine of [pglite as BrainEngine, getEngine() as BrainEngine]) {
      const c = await checkContentHashDuplicates(engine);
      expect(c.status).toBe('ok');
    }
  }, 60_000);

  test('all three checks agree across engines', async () => {
    const a = await seedAndRunAllChecks(pglite, repo);
    const b = await seedAndRunAllChecks(getEngine(), repo);

    for (const r of [a, b]) {
      expect(r.dup.status).toBe('warn');
      expect((r.dup.details as any).pair_count).toBe(1);
      expect(r.dup.message).toContain('alice-example <-> people/alice-example');

      expect(r.undeclared.status).toBe('warn');
      expect((r.undeclared.details as any).total).toBe(1);
      expect(r.undeclared.message).toContain('people/ghost-page');

      expect(r.collision.status).toBe('warn');
      expect(r.collision.message).toContain("db_only path 'daily/'");
    }

    // Byte-identical verdicts across engines.
    expect(a.dup.message).toBe(b.dup.message);
    expect(a.undeclared.details).toEqual(b.undeclared.details);
    expect(a.collision.message).toBe(b.collision.message);
  }, 120_000);
});
