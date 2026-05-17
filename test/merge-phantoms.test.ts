import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

  itHomed('cross-directory ambiguity: phantom that matches in multiple dirs skips as ambiguous', async () => {
    // codex round-4 P1 + round-6 P2 #1 resolution. The phantom's own
    // `type` field is unreliable because pre-fix `stubEntityPage`
    // defaulted to `concept` for unprefixed slugs (round-6 finding).
    // So we can't constrain by phantom.type. Instead, we search every
    // directory and refuse to auto-pick when MORE THAN ONE directory
    // has a candidate — the operator decides manually.
    await seedPage('acme', 'company');                  // phantom (type=company)
    await seedPage('people/acme-example', 'person');    // candidate in people/
    await seedChunks('people/acme-example', 100);
    await seedPage('companies/acme-example', 'company');// candidate in companies/
    await seedChunks('companies/acme-example', 3);
    await seedFact('acme', 'Acme raised a Series B.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('ambiguous');
    expect(result.skipped[0].ambiguous_candidates).toBeDefined();
    expect(result.skipped[0].ambiguous_candidates!.sort()).toEqual([
      'companies/acme-example',
      'people/acme-example',
    ]);

    // Phantom and its fact are untouched — operator can resolve manually.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'acme' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).toBeNull();
    const facts = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT entity_slug FROM facts WHERE entity_slug = 'acme'`,
      [],
    );
    expect(facts.length).toBe(1);
  });

  itHomed('pre-fix phantom with type=concept still resolves to the right people/ canonical', async () => {
    // Codex round-6 P2 #1: pre-fix `stubEntityPage` defaulted ALL
    // unprefixed entity stubs to `type: concept`. A phantom `alice`
    // really represents a person but has the wrong stored type. The
    // merge must still find `people/alice-example` and route facts
    // there, NOT skip as no_canonical because it only searched
    // `concepts/`.
    await seedPage('alice', 'concept');                 // phantom with wrong type
    await seedPage('people/alice-example', 'person');   // correct canonical (different dir)
    await seedChunks('people/alice-example', 5);
    await seedFact('alice', 'Alice fact pre-fix.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('people/alice-example');
    expect(result.merged[0].facts_moved).toBe(1);

    // Facts repointed to the canonical.
    const onCanonical = await engine.executeRaw<{ source_markdown_slug: string }>(
      `SELECT source_markdown_slug FROM facts WHERE entity_slug = 'people/alice-example'`,
      [],
    );
    expect(onCanonical.length).toBe(1);
    expect(onCanonical[0].source_markdown_slug).toBe('people/alice-example');
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

  itHomed('fact-bearing phantom with REAL gbrain:facts markers still migrates (round-9 P1 #1)', async () => {
    // Codex round-9 P1 #1: the stubBodyChars regex must match the
    // actual fence markers used by writeFactsToFence —
    // `<!--- gbrain:facts:begin -->` / `<!--- gbrain:facts:end -->`.
    // Previously the regex used the fictional `<!-- facts -->` shape
    // which never matched real fences, so fact-bearing phantoms
    // exceeded the 50-char body threshold and got skipped as
    // not_a_stub. Pin the marker shape so a renaming refactor is
    // forced to update both sides.
    const realFenceStub = [
      '# Alice Real Fence',
      '',
      '## Facts',
      '',
      '<!--- gbrain:facts:begin -->',
      '| row | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|-----|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      '| 1 | Alice plays chess. | fact | 1.0 | private | medium | 2026-05-01 | | test | |',
      '| 2 | Alice attended YC W26. | fact | 1.0 | private | medium | 2026-05-01 | | test | |',
      '<!--- gbrain:facts:end -->',
      '',
    ].join('\n');
    expect(realFenceStub.length).toBeGreaterThan(200);

    await engine.putPage(
      'alice-real-fence',
      {
        type: 'concept' as any,
        title: 'Alice Real Fence',
        compiled_truth: realFenceStub,
        frontmatter: { type: 'concept', title: 'Alice Real Fence', slug: 'alice-real-fence' },
      },
      { sourceId: 'default' },
    );
    await seedPage('people/alice-real-fence-example', 'person');
    await seedChunks('people/alice-real-fence-example', 3);
    await seedFact('alice-real-fence', 'A fact about Alice.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('people/alice-real-fence-example');

    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice-real-fence' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).not.toBeNull();
  });

  itHomed('preserves canonical body when the .md file is missing on disk (round-17 P2)', async () => {
    // Codex round-17 P2: when canonical exists in DB only (e.g.
    // created via MCP put_page on a source with local_path but
    // never synced to disk), merge-phantoms must NOT stub-create the
    // file with just a title — that would lose the DB body when the
    // post-fence importFromFile overwrites it.
    const realCanonicalBody =
      'Real canonical body content. '.repeat(20) + 'This must survive the merge intact.';
    await engine.putPage(
      'people/db-only-canonical-example',
      {
        type: 'person' as any,
        title: 'DB Only Canonical Example',
        compiled_truth: realCanonicalBody,
        frontmatter: {
          type: 'person',
          title: 'DB Only Canonical Example',
          slug: 'people/db-only-canonical-example',
        },
      },
      { sourceId: 'default' },
    );
    // Sanity: file must not exist before merge.
    const filePath = join(brainDir, 'people/db-only-canonical-example.md');
    expect(existsSync(filePath)).toBe(false);

    // Seed the phantom.
    await seedPage('db-only-canonical', 'person');
    await seedFact('db-only-canonical', 'A fact about the canonical.');

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('people/db-only-canonical-example');

    // Canonical's body survived the merge.
    const surviving = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE slug = 'people/db-only-canonical-example' AND source_id = 'default'`,
      [],
    );
    expect(surviving[0].compiled_truth).toContain('Real canonical body content.');
    expect(surviving[0].compiled_truth).toContain('This must survive the merge intact.');

    // The fence on disk has the migrated fact appended to the real body.
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).toContain('Real canonical body content.');
    expect(onDisk).toContain('A fact about the canonical.');
  });

  itHomed('preserves valid_until on time-bounded facts during migration (round-10 P2)', async () => {
    // Codex round-10 P2: when a phantom fact has an explicit
    // `valid_until` (e.g. "alice will be on sabbatical until
    // 2026-08-31"), the merge must carry that date through to the
    // canonical's fence. Pre-fix the FenceInputFact API dropped
    // valid_until entirely, so time-bound facts became indefinitely
    // active after migration.
    await seedPage('alice-bounded', 'concept');
    await seedPage('people/alice-bounded-example', 'person');
    await seedChunks('people/alice-bounded-example', 3);

    // Insert a fact with an explicit valid_until via raw SQL so we
    // bypass the seedFact helper (which doesn't take valid_until).
    const validUntil = '2026-08-31';
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, valid_from, valid_until)
       VALUES ('default', 'alice-bounded', 'Alice is on sabbatical.', 'fact', 'private', 'medium', 'test', '2026-05-01', $1)`,
      [validUntil],
    );

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('people/alice-bounded-example');

    // Canonical row should preserve valid_until from the phantom.
    const canonical = await engine.executeRaw<{ valid_until: Date | null; fact: string }>(
      `SELECT valid_until, fact
         FROM facts
        WHERE source_id = 'default' AND entity_slug = 'people/alice-bounded-example'`,
      [],
    );
    expect(canonical.length).toBe(1);
    expect(canonical[0].fact).toBe('Alice is on sabbatical.');
    expect(canonical[0].valid_until).not.toBeNull();
    // The DB may return a Date or string depending on driver; coerce.
    const iso = canonical[0].valid_until instanceof Date
      ? canonical[0].valid_until.toISOString().slice(0, 10)
      : String(canonical[0].valid_until).slice(0, 10);
    expect(iso).toBe(validUntil);
  });

  itHomed('migrates ALL phantom facts even when count exceeds MAX_SEARCH_LIMIT (round-9 P1 #2)', async () => {
    // Codex round-9 P1 #2: listFactsByEntity clamps `limit` at
    // MAX_SEARCH_LIMIT (100). The old merge implementation used
    // listFactsByEntity(..., { limit: 10_000 }) which silently
    // returned only 100 rows. The merge then re-fenced those 100,
    // deleted ALL phantom rows, soft-deleted the page — overflow
    // facts permanently lost. The fix bypasses the listing API with
    // a raw SQL select.
    //
    // Seed 150 facts on the phantom (above the 100 clamp) and verify
    // all of them land on the canonical after merge.
    await seedPage('alice-many-facts', 'concept');
    await seedPage('people/alice-many-facts-example', 'person');
    await seedChunks('people/alice-many-facts-example', 3);
    const FACT_COUNT = 150;
    for (let i = 0; i < FACT_COUNT; i++) {
      await seedFact('alice-many-facts', `Fact #${i} about Alice.`);
    }

    // Sanity: the phantom has all 150 rows.
    const beforeCount = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = 'default' AND entity_slug = 'alice-many-facts'`,
      [],
    );
    expect(beforeCount[0].n).toBe(FACT_COUNT);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].facts_moved).toBe(FACT_COUNT);

    // ALL facts landed on the canonical (no overflow loss).
    const onCanonical = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM facts
        WHERE source_id = 'default'
          AND entity_slug = 'people/alice-many-facts-example'`,
      [],
    );
    expect(onCanonical[0].n).toBe(FACT_COUNT);

    // No phantom rows remain.
    const afterPhantom = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM facts WHERE source_id = 'default' AND entity_slug = 'alice-many-facts'`,
      [],
    );
    expect(afterPhantom[0].n).toBe(0);
  });

  // Round-6's "fact-bearing phantom (fictional fence markers)" test was
  // removed when round-9 P1 #1 fixed the marker mismatch — the
  // round-9 "fact-bearing phantom with REAL gbrain:facts markers" test
  // above supersedes it with the correct fence shape.

  itHomed('skips a top-level page with prose under a non-machine ## Facts heading (round-8 P2 #1)', async () => {
    // Codex round-8 P2 #1: a page with a normal `## Facts` heading
    // (NOT the auto-generated `<!-- facts -->` ... `<!-- /facts -->`
    // fence) followed by user-authored prose must trip not_a_stub.
    // The stub-detector strips only the canonical fence markers, not
    // the bare heading.
    const userAuthoredFacts = [
      '# Alice Profile',
      '',
      '## Facts',
      '',
      'Alice is a hypothetical software engineer who has been working ',
      'on distributed systems for over a decade. Her published papers ',
      'on Byzantine consensus algorithms have been cited extensively ',
      'across the field. The content below is intentional user prose, ',
      'not the machine-generated fence the migration command targets.',
      '',
    ].join('\n');
    expect(userAuthoredFacts).not.toContain('<!-- facts -->');
    expect(userAuthoredFacts.length).toBeGreaterThan(200);

    await engine.putPage(
      'alice-real-profile',
      {
        type: 'person' as any,
        title: 'Alice Profile',
        compiled_truth: userAuthoredFacts,
        frontmatter: { type: 'person', title: 'Alice Profile', slug: 'alice-real-profile' },
      },
      { sourceId: 'default' },
    );
    // Seed a canonical so prefix expansion would otherwise route here.
    await seedPage('people/alice-real-profile-example', 'person');
    await seedChunks('people/alice-real-profile-example', 3);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('not_a_stub');

    // Page survives with prose intact.
    const surviving = await engine.executeRaw<{ deleted_at: Date | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE slug = 'alice-real-profile' AND source_id = 'default'`,
      [],
    );
    expect(surviving[0].deleted_at).toBeNull();
    expect(surviving[0].compiled_truth).toContain('Byzantine consensus algorithms');
  });

  itHomed('skips a page whose only content lives in the pages.timeline column (round-16 P2 #1)', async () => {
    // Codex round-16 P2 #1: pages.timeline is a SEPARATE DB column
    // from pages.compiled_truth. A phantom-shaped compiled_truth +
    // populated timeline column would slip past the body-only gate.
    // Seed via raw SQL because engine.putPage may not let us set the
    // timeline column directly through the API.
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
       VALUES ('default', 'alice-tl-col', 'person', 'markdown', 'Alice TL Col', '# Alice TL Col',
               '- 2026-04-01: First meeting\n- 2026-05-01: Investment decision',
               $1::jsonb, 'hash-test', now())
       ON CONFLICT (source_id, slug) DO UPDATE SET timeline = EXCLUDED.timeline`,
      [JSON.stringify({ type: 'person', title: 'Alice TL Col', slug: 'alice-tl-col' })],
    );
    await seedPage('people/alice-tl-col-example', 'person');
    await seedChunks('people/alice-tl-col-example', 3);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('not_a_stub');

    // Page survives with its timeline column intact.
    const surviving = await engine.executeRaw<{ deleted_at: Date | null; timeline: string }>(
      `SELECT deleted_at, timeline FROM pages WHERE slug = 'alice-tl-col' AND source_id = 'default'`,
      [],
    );
    expect(surviving[0].deleted_at).toBeNull();
    expect(surviving[0].timeline).toContain('Investment decision');
  });

  itHomed('skips a top-level page with substantial Timeline content (round-7 P2)', async () => {
    // Codex round-7 P2 #2: a page with a populated ## Timeline fence
    // is not a stub — merge-phantoms only migrates facts, so the
    // timeline would be lost if the page were soft-deleted. The
    // not_a_stub gate must include Timeline content (Timeline does
    // NOT get stripped from stubBodyChars).
    const timelinePage = [
      '# Alice Timeline',
      '',
      '## Timeline',
      '<!-- timeline -->',
      '- 2026-04-01: First meeting',
      '- 2026-04-15: Second meeting',
      '- 2026-05-01: Third meeting',
      '- 2026-05-15: Investment decision',
      '<!-- /timeline -->',
      '',
    ].join('\n');
    await engine.putPage(
      'alice-with-timeline',
      {
        type: 'person' as any,
        title: 'Alice With Timeline',
        compiled_truth: timelinePage,
        frontmatter: { type: 'person', title: 'Alice With Timeline', slug: 'alice-with-timeline' },
      },
      { sourceId: 'default' },
    );
    // Seed a canonical that prefix-expansion would otherwise match.
    await seedPage('people/alice-with-timeline-example', 'person');
    await seedChunks('people/alice-with-timeline-example', 3);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('not_a_stub');

    // Page survives with its Timeline intact.
    const surviving = await engine.executeRaw<{ deleted_at: Date | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE slug = 'alice-with-timeline' AND source_id = 'default'`,
      [],
    );
    expect(surviving[0].deleted_at).toBeNull();
    expect(surviving[0].compiled_truth).toContain('Investment decision');
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

  itHomed('preserves a phantom whose .md file was edited but not re-imported (round-21 P2)', async () => {
    // Codex round-21 P2: the operator may have edited the phantom
    // alice.md on disk (adding prose) but not yet run `gbrain sync`.
    // pages.compiled_truth is stale (still stub-shaped) while the
    // .md file on disk has real content. The merge previously trusted
    // the DB and would unlink the edited file. Now we ALSO read the
    // file and apply the stub check to disk content.
    await seedPage('alice-edited-on-disk', 'person');
    await seedPage('people/alice-edited-on-disk-example', 'person');
    await seedChunks('people/alice-edited-on-disk-example', 3);
    await seedFact('alice-edited-on-disk', 'A fact.');

    // Write a non-stub .md on disk while leaving the DB body stubby.
    const phantomFile = join(brainDir, 'alice-edited-on-disk.md');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dirname(phantomFile), { recursive: true });
    writeFileSync(
      phantomFile,
      '---\ntype: person\ntitle: Alice Edited\nslug: alice-edited-on-disk\n---\n\n# Alice Edited\n\nThe user added a substantial paragraph on disk but never ran sync. This content must survive the merge.',
      'utf-8',
    );

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].skipped).toBe('not_a_stub');

    // Disk file untouched.
    expect(existsSync(phantomFile)).toBe(true);
    const onDisk = readFileSync(phantomFile, 'utf-8');
    expect(onDisk).toContain('substantial paragraph on disk');
  });

  itHomed('removes the phantom .md file from disk on soft-delete (round-19 P2)', async () => {
    // Codex round-19 P2: when the phantom page also exists on disk
    // (e.g. `alice.md` created by the v0.34.5-era writeFactsToFence
    // path), soft-deleting only the DB row leaves the file behind.
    // The next `gbrain sync` would re-import the file and resurrect
    // the phantom DB row after autopilot's purge phase deletes it.
    // The merge must remove the file alongside the soft-delete.
    await seedPage('alice-with-file', 'person');
    await seedPage('people/alice-with-file-example', 'person');
    await seedChunks('people/alice-with-file-example', 3);
    await seedFact('alice-with-file', 'A fact for the file-backed phantom.');

    // Write the phantom .md to the brainDir so the merge has a file
    // to clean up.
    const phantomFile = join(brainDir, 'alice-with-file.md');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(dirname(phantomFile), { recursive: true });
    writeFileSync(
      phantomFile,
      '---\ntype: person\ntitle: alice-with-file\nslug: alice-with-file\n---\n\n# alice-with-file\n',
      'utf-8',
    );
    expect(existsSync(phantomFile)).toBe(true);

    const result = await runMergePhantomsCore(engine as unknown as BrainEngine, {
      sourceId: 'default',
      dryRun: false,
    });

    expect(result.merged.length).toBe(1);
    expect(result.merged[0].canonical).toBe('people/alice-with-file-example');

    // Phantom file is gone from disk.
    expect(existsSync(phantomFile)).toBe(false);

    // Phantom DB row soft-deleted.
    const phantomPage = await engine.executeRaw<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'alice-with-file' AND source_id = 'default'`,
      [],
    );
    expect(phantomPage[0].deleted_at).not.toBeNull();
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
