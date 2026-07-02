/**
 * BrainBench fixture seeding — fail-fast (decision 12).
 *
 * Hermetic: pages import with noEmbed (no gateway), facts insert with a NULL
 * embedding (the PGLite insertFact path stores NULL without touching any
 * provider). Keyword/alias-arm retrieval carries the bench in CI; the vector
 * path is a documented non-goal of hermetic mode (decision 2).
 *
 * `importFromContent` returns status 'imported' | 'skipped' | 'error' — never
 * 'success' (prior learning importFromContent-status-vocabulary). Anything
 * other than 'imported' means the fixture's brain is WRONG, and every metric
 * scored against it would be silent garbage — so seeding throws, the harness
 * marks the fixture seed_failed, and the run exits 2.
 */

import { importFromContent } from '../../core/import-file.ts';
import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { BrainBenchFixture } from './types.ts';

export class SeedError extends Error {
  constructor(
    public readonly fixtureId: string,
    public readonly slug: string,
    message: string,
  ) {
    super(`seed failed for fixture ${fixtureId} at ${slug}: ${message}`);
    this.name = 'SeedError';
  }
}

export interface SeedOutcome {
  /**
   * slug → set of source_ids the slug was seeded into (cross-source violation
   * detection, decision 14). A Set because multi-source fixtures deliberately
   * seed the SAME slug into two sources; a slug is a violation only when its
   * set does NOT include the fixture's active source.
   */
  slugSource: Map<string, Set<string>>;
  pages: number;
  facts: number;
}

const DEFAULT_SOURCE = 'default';

/** Idempotent: creates any non-default sources the fixture declares. */
async function ensureSources(engine: PGLiteEngine, fixture: BrainBenchFixture): Promise<void> {
  const wanted = new Set<string>();
  for (const s of fixture.sources ?? []) wanted.add(s);
  if (fixture.active_source && fixture.active_source !== DEFAULT_SOURCE) {
    wanted.add(fixture.active_source);
  }
  for (const p of fixture.seed_pages ?? []) {
    if (p.source_id && p.source_id !== DEFAULT_SOURCE) wanted.add(p.source_id);
  }
  for (const f of fixture.seed_facts ?? []) {
    if (f.source_id && f.source_id !== DEFAULT_SOURCE) wanted.add(f.source_id);
  }
  for (const id of wanted) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, `bench source ${id}`],
    );
  }
}

export async function seedBrain(engine: PGLiteEngine, fixture: BrainBenchFixture): Promise<SeedOutcome> {
  await ensureSources(engine, fixture);

  const slugSource = new Map<string, Set<string>>();
  let pages = 0;
  let facts = 0;

  for (const page of fixture.seed_pages ?? []) {
    const sourceId = page.source_id ?? DEFAULT_SOURCE;
    let result;
    try {
      result = await importFromContent(engine, page.slug, page.content, {
        noEmbed: true,
        sourceId,
      });
    } catch (err) {
      throw new SeedError(fixture.fixture_id, page.slug, (err as Error).message);
    }
    if (result.status !== 'imported') {
      throw new SeedError(
        fixture.fixture_id,
        page.slug,
        `importFromContent status=${result.status}${result.error ? ` (${result.error})` : ''}`,
      );
    }
    const set = slugSource.get(page.slug) ?? new Set<string>();
    set.add(sourceId);
    slugSource.set(page.slug, set);
    pages++;
  }

  for (const sf of fixture.seed_facts ?? []) {
    const sourceId = sf.source_id ?? DEFAULT_SOURCE;
    try {
      await engine.insertFact( // gbrain-allow-direct-insert: benchmark seeding into a throwaway in-memory brain — no fence exists, the fixture is the source of truth
        {
          fact: sf.fact,
          entity_slug: sf.entity_slug ?? null,
          source: sf.source ?? 'bench:seed',
          source_session: sf.source_session ?? null,
          // NULL embedding: hermetic mode never touches an embedding provider.
          embedding: null,
        },
        { source_id: sourceId },
      );
      facts++;
    } catch (err) {
      throw new SeedError(
        fixture.fixture_id,
        sf.entity_slug ?? '(no-entity fact)',
        `insertFact failed: ${(err as Error).message}`,
      );
    }
  }

  return { slugSource, pages, facts };
}
