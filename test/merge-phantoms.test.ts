import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  runMergePhantomsCore,
  listPhantomEntityPages,
  formatMergePhantomsText,
  type MergePhantomsResult,
} from '../src/commands/merge-phantoms.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * v0.34.5 — operator cleanup of pre-fix phantom unprefixed entity pages.
 *
 * `gbrain merge-phantoms` walks the pile of pre-v0.34.5 phantom slugs
 * (unprefixed person/company/deal/topic/concept pages spawned by the
 * old resolver fallthrough), runs the new prefix-expansion resolver on
 * each, re-fences the phantom's active facts into the canonical page's
 * `## Facts` fence (codex P2 — source_markdown_slug + row_num must
 * point at the canonical, not the soft-deleted phantom), and
 * soft-deletes the phantom.
 *
 * Coverage matrix per plan mossy-popping-crown.md D7 + D9 (codex P2):
 *   - dry-run reports without mutating
 *   - phantom with single canonical → re-fence + soft-delete
 *   - phantom with NO canonical → skip
 *   - phantom whose canonical doesn't exist → skip
 *   - source-id scoping
 *   - idempotency
 *   - re-fenced rows have proper source_markdown_slug + row_num
 *   - canonical's markdown fence file is updated on disk
 *   - --json envelope shape stable
 */

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-merge-phantoms-'));
  // Codex round-5 P2: isolate GBRAIN_HOME so page-locks (acquired by
  // writeFactsToFence under gbrainPath('page-locks')) land in a tempdir
  // instead of the developer / CI user's real ~/.gbrain.
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-merge-home-'));
  // Wire local_path on the default source so the re-fence path
  // has a brain dir to write to.
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
  rmSync(gbrainHome, { recursive: true, force: true });
});

/**
 * Wraps a test body in `withEnv({ GBRAIN_HOME })` so any
 * `gbrainPath('page-locks')` call (writeFactsToFence does this) lands
 * inside the test's tempdir instead of the developer's real
 * `~/.gbrain`. Mirrors the with-env pattern from CLAUDE.md's test
 * isolation rules (R1) without forcing the file to `.serial.test.ts`.
 */
async function withTestHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: gbrainHome }, fn);
}

/**
 * `it` wrapper that runs each test body under the test's GBRAIN_HOME
 * tempdir. Use this instead of `it` for every test that touches
 * runMergePhantomsCore or writeFactsToFence so page-locks stay
 * hermetic across the file.
 */
function itHomed(name: string, body: () => Promise<void>): void {
  it(name, async () => {
    await withTestHome(body);
  });
}

// Wipe the test surface between cases. Pages + facts + chunks get
// reset; sources keep their local_path so each test inherits the
// brain dir setup from beforeAll.
beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts`, []);
  await engine.executeRaw(`DELETE FROM content_chunks`, []);
  await engine.executeRaw(`DELETE FROM links`, []);
  await engine.executeRaw(`DELETE FROM pages`, []);
  await engine.executeRaw(`DELETE FROM sources WHERE id NOT IN ('default')`, []);
  // Reset default's local_path in case a prior test wiped it.
  await engine.executeRaw(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

async function seedPage(slug: string, type: string, sourceId = 'default'): Promise<number> {
  await engine.putPage(
    slug,
    {
      type: type as any,
      title: slug,
      compiled_truth: `# ${slug}`,
      frontmatter: { type, title: slug, slug },
    },
    { sourceId },
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  return rows[0].id;
}

async function seedChunks(slug: string, count: number, sourceId = 'default'): Promise<void> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  if (rows.length === 0) return;
  const pid = rows[0].id;
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       VALUES ($1, $2, $3) ON CONFLICT (page_id, chunk_index) DO NOTHING`,
      [pid, i, `Chunk ${i} about ${slug}`],
    );
  }
}

async function seedFact(entitySlug: string, body: string, sourceId = 'default'): Promise<number> {
  const result = await (engine as unknown as BrainEngine).insertFact(
    {
      fact: body,
      kind: 'fact' as const,
      entity_slug: entitySlug,
      visibility: 'private' as const,
      notability: 'medium' as const,
      source: 'test:merge-phantoms',
      source_session: null,
      embedding: null,
    },
    { source_id: sourceId },
  );
  return result.id;
}

describe('merge-phantoms — listPhantomEntityPages', () => {
  it('returns unprefixed entity-type rows only', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedPage('docs/notes', 'concept'); // prefixed → excluded
    await seedPage('random', 'guide');       // wrong type → excluded
    await seedPage('bob', 'company');        // unprefixed company → included

    const phantoms = await listPhantomEntityPages(engine as unknown as BrainEngine, 'default');
    expect(phantoms.map(p => p.slug).sort()).toEqual(['alice', 'bob']);
  });
});

describe('merge-phantoms — runMergePhantomsCore', () => {
  itHomed('dry-run reports the would-merge count without mutating', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Alice likes integration tests.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.merged.length).toBe(1);
    expect(result.merged[0]).toEqual({
      phantom: 'alice',
      canonical: 'people/alice-example',
      facts_moved: 1,
    });

    // Nothing actually moved.
    const stillPhantom = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE entity_slug = $1`,
      ['alice'],
    );
    expect(stillPhantom.length).toBe(1);

    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['alice'],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
  });

  itHomed('re-fences facts into the canonical and soft-deletes the phantom', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Fact one about Alice.');
    await seedFact('alice', 'Fact two about Alice.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].facts_moved).toBe(2);

    // Old phantom rows are gone (both source_markdown_slug=phantom AND
    // source_markdown_slug NULL paths).
    const onPhantom = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE entity_slug = 'alice'`,
      [],
    );
    expect(onPhantom[0].n).toBe(0);

    // New canonical-bound rows exist with proper source_markdown_slug + row_num.
    const onCanonical = await engine.executeRaw<{
      fact: string;
      entity_slug: string;
      source_markdown_slug: string;
      row_num: number;
    }>(
      `SELECT fact, entity_slug, source_markdown_slug, row_num
         FROM facts
        WHERE source_id = 'default' AND entity_slug = 'people/alice-example'
        ORDER BY row_num ASC`,
      [],
    );
    expect(onCanonical.length).toBe(2);
    for (const r of onCanonical) {
      expect(r.source_markdown_slug).toBe('people/alice-example');
      expect(r.row_num).toBeGreaterThan(0);
    }

    // Phantom soft-deleted.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).not.toBeNull();

    // The canonical's markdown file on disk contains the migrated facts
    // in its ## Facts fence.
    const canonicalMd = join(brainDir, 'people/alice-example.md');
    expect(existsSync(canonicalMd)).toBe(true);
    const body = readFileSync(canonicalMd, 'utf-8');
    expect(body).toContain('Fact one about Alice.');
    expect(body).toContain('Fact two about Alice.');
  });

  itHomed('soft-deletes a phantom even when it has no facts attached', async () => {
    await seedPage('emptyperson', 'person');
    await seedPage('people/emptyperson-example', 'person');
    await seedChunks('people/emptyperson-example', 5);
    // No facts seeded.

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].facts_moved).toBe(0);

    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = $1 AND source_id = 'default'`,
      ['emptyperson'],
    );
    expect(phantomPage[0].deleted_at).not.toBeNull();
  });

  itHomed('skips a phantom with no matching canonical (prefix expansion finds nothing)', async () => {
    await seedPage('zoolander', 'person');
    await seedFact('zoolander', 'Sample fact about Zoolander.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_canonical');

    // Phantom still alive, fact still on phantom.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'zoolander' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
    const factRow = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts`,
      [],
    );
    expect(factRow[0].entity_slug).toBe('zoolander');
  });

  itHomed('skips a phantom whose canonical target is soft-deleted', async () => {
    await seedPage('beth', 'person');
    await seedPage('people/beth-example', 'person');
    await seedChunks('people/beth-example', 3);
    await seedFact('beth', 'Beth fact pre-delete.');
    await engine.softDeletePage('people/beth-example', { sourceId: 'default' });

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_canonical');

    // Phantom still alive.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'beth' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
  });

  itHomed('skips re-fence when source has no local_path (thin-client) without losing fact', async () => {
    // Wipe local_path so re-fence can't run.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`, []);
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'A thin-client fact.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_local_path');

    // Fact still on the phantom (no move happened).
    const onPhantom = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE entity_slug = 'alice'`,
      [],
    );
    expect(onPhantom[0].n).toBe(1);
    // Phantom NOT soft-deleted.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
  });

  itHomed('does not create legacy-shape rows (row_num NULL + entity_slug NOT NULL)', async () => {
    // codex P1 + P2 regression: the merge must not leave behind rows
    // that trip the v0.32.2 extract_facts reconciliation guard.
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'No legacy shape after merge.');

    await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    const legacy = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM facts
        WHERE source_id = 'default'
          AND row_num IS NULL
          AND entity_slug IS NOT NULL`,
      [],
    );
    expect(legacy[0].n).toBe(0);
  });

  itHomed('scopes merge to the requested source_id', async () => {
    // Seed phantom 'alice' + canonical in TWO sources.
    const otherBrainDir = mkdtempSync(join(tmpdir(), 'gbrain-merge-other-'));
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('src-a', 'src-a', $1, '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [brainDir],
      );
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('src-b', 'src-b', $1, '{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [otherBrainDir],
      );
      await seedPage('alice', 'person', 'src-a');
      await seedPage('people/alice-example', 'person', 'src-a');
      await seedChunks('people/alice-example', 5, 'src-a');
      await seedFact('alice', 'Fact in src-a.', 'src-a');

      await seedPage('alice', 'person', 'src-b');
      await seedPage('people/alice-example', 'person', 'src-b');
      await seedChunks('people/alice-example', 5, 'src-b');
      await seedFact('alice', 'Fact in src-b (should NOT move).', 'src-b');

      const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
        sourceId: 'src-a',
        dryRun: false,
      });

      expect(result.source_id).toBe('src-a');
      expect(result.merged.length).toBe(1);

      // src-a phantom soft-deleted, src-b phantom intact.
      const aDel = await engine.executeRaw<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'src-a'`,
        [],
      );
      expect(aDel[0].deleted_at).not.toBeNull();
      const bDel = await engine.executeRaw<{ deleted_at: Date | null }>(
        `SELECT deleted_at FROM pages WHERE slug = 'alice' AND source_id = 'src-b'`,
        [],
      );
      expect(bDel[0].deleted_at).toBeNull();

      // src-a fact re-fenced (entity_slug=canonical, source_markdown_slug=canonical).
      const aFacts = await engine.executeRaw<{ entity_slug: string; source_markdown_slug: string }>(
        `SELECT entity_slug, source_markdown_slug FROM facts WHERE source_id = 'src-a'`,
        [],
      );
      expect(aFacts.length).toBe(1);
      expect(aFacts[0].entity_slug).toBe('people/alice-example');
      expect(aFacts[0].source_markdown_slug).toBe('people/alice-example');

      // src-b fact untouched.
      const bFacts = await engine.executeRaw<{ entity_slug: string }>(
        `SELECT entity_slug FROM facts WHERE source_id = 'src-b'`,
        [],
      );
      expect(bFacts[0].entity_slug).toBe('alice');
    } finally {
      rmSync(otherBrainDir, { recursive: true, force: true });
    }
  });

  itHomed('constrains merge to phantom entity type — cross-type collision routes to correct canonical', async () => {
    // codex round-4 P1: phantom 'acme' of type=company must merge to
    // companies/acme-example, NOT to people/acme-example, even though
    // people/ is checked first in DEFAULT_PREFIX_EXPANSION_DIRS. The
    // fix passes a type-constrained dir list to tryPrefixExpansion.
    await seedPage('acme', 'company');                  // phantom (type=company)
    await seedPage('people/acme-example', 'person');    // wrong-type canonical (tempting)
    await seedChunks('people/acme-example', 100);       // higher chunk count to bait the wrong path
    await seedPage('companies/acme-example', 'company');// correct-type canonical
    await seedChunks('companies/acme-example', 3);
    await seedFact('acme', 'Acme raised a Series B.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('companies/acme-example');

    // The fact landed on the company page, NOT the person page.
    const onCompany = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE entity_slug = 'companies/acme-example'`,
      [],
    );
    expect(onCompany.length).toBe(1);
    const onPerson = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE entity_slug = 'people/acme-example'`,
      [],
    );
    expect(onPerson[0].n).toBe(0);
  });

  itHomed('dry-run honors no_local_path skip (codex round-4 P2)', async () => {
    // Dry-run must report what an actual run would do. A source with
    // local_path=NULL skips with no_local_path in real mode; the
    // preview must match.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`, []);
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Dry-run feasibility test.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('no_local_path');
  });

  itHomed('skips a top-level page that has real content (not a stub)', async () => {
    // Codex round-5 P2: a legitimate `rag.md` or imported `alice.md`
    // page with a real body must NOT be soft-deleted by the merge.
    // Seed a long-bodied page at the top level and assert the merge
    // skips with `not_a_stub` rather than re-fencing + soft-deleting.
    const longBody = '# RAG\n\nRetrieval-augmented generation is a technique that combines '.repeat(20);
    await engine.putPage(
      'rag',
      {
        type: 'concept' as any,
        title: 'RAG',
        compiled_truth: longBody,
        frontmatter: { type: 'concept', title: 'RAG', slug: 'rag' },
      },
      { sourceId: 'default' },
    );
    // Also seed a canonical that prefix-expansion WOULD match if we
    // got past the content gate.
    await seedPage('concepts/rag-example', 'concept');
    await seedChunks('concepts/rag-example', 3);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('not_a_stub');

    // Top-level page survives intact.
    const surviving = await engine.executeRaw<{ deleted_at: Date | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE slug = 'rag' AND source_id = 'default'`,
      [],
    );
    expect(surviving[0].deleted_at).toBeNull();
    expect(surviving[0].compiled_truth.length).toBeGreaterThan(200);
  });

  itHomed('is idempotent — second run produces zero merges', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'One fact about Alice.');

    const first = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });
    expect(first.merged.length).toBe(1);

    const second = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });
    expect(second.merged.length).toBe(0);
    expect(second.total_scanned).toBe(0);
  });
});

describe('merge-phantoms — output shape', () => {
  itHomed('returns a stable result envelope (suitable for --json)', async () => {
    await seedPage('alice', 'person');
    await seedPage('people/alice-example', 'person');
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Stable envelope test.');

    const result: MergePhantomsResult = await runMergePhantomsCore(
      engine as unknown as BrainEngine,
      { sourceId: 'default', dryRun: true },
    );

    expect(result).toMatchObject({
      dry_run: true,
      source_id: 'default',
      total_scanned: 1,
    });
    expect(Array.isArray(result.merged)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    for (const m of result.merged) {
      expect(typeof m.phantom).toBe('string');
      expect(typeof m.canonical).toBe('string');
      expect(typeof m.facts_moved).toBe('number');
    }
  });

  it('formats text output with merged + skipped sections', async () => {
    const result: MergePhantomsResult = {
      merged: [{ phantom: 'alice', canonical: 'people/alice-example', facts_moved: 2 }],
      skipped: [{ phantom: 'beth', canonical: 'beth', skipped: 'no_canonical' }],
      total_scanned: 2,
      dry_run: false,
      source_id: 'default',
    };
    const out = formatMergePhantomsText(result);
    expect(out).toContain('scanned 2');
    expect(out).toContain('MERGED:');
    expect(out).toContain('alice  →  people/alice-example');
    expect(out).toContain('SKIPPED:');
    expect(out).toContain('no_canonical');
  });
});
