import type { Migration } from './types.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { migrationNotice } from './helpers.ts';

export const v124: Migration = {
  version: 124,
  name: 'page_search_vector_drop_compiled_truth',
  // #2704: a single markdown page whose compiled_truth exceeds Postgres's
  // hard 1,048,575-byte tsvector cap made update_page_search_vector()
  // throw "string is too long for tsvector" INSIDE the pages UPSERT
  // transaction — not a per-file ledger entry, a transaction abort. The
  // whole source's sync checkpoint stayed pinned (Sync BLOCKED) until the
  // oversized file was fixed or manually skipped, even though every
  // OTHER file in the run imported fine.
  //
  // Fix: drop compiled_truth (the unbounded whole-page body) from this
  // trigger. It was already redundant — content_chunks.search_vector
  // (Cathedral II Layer 3, v0.20.0) is the ACTUAL keyword-search source:
  // searchKeyword() in postgres-engine.ts/pglite-engine.ts ranks and
  // queries `cc.search_vector` exclusively; `pages.search_vector` is
  // written by this trigger but never read by any query in this
  // codebase (verified: no `pages.search_vector`/bare `search_vector`
  // appears on either side of a WHERE/ts_rank anywhere outside this
  // trigger's own definition and the reindex/backfill machinery that
  // maintains it). And chunking already bounds each chunk_text well
  // under the tsvector limit (chunkText() targets embedding-sized
  // pieces, several orders of magnitude smaller than 1MB) — the overflow
  // was specific to the whole-page grain this trigger no longer builds.
  //
  // title + timeline (both naturally small — a compiled_truth-sized
  // title or timeline field would be its own bug) stay, so
  // pages.search_vector keeps carrying SOME signal rather than going
  // fully inert; a future PR can drop the column outright once its
  // last non-search consumer (if any turns up) is confirmed gone.
  //
  // No backfill: existing rows keep whatever search_vector they already
  // computed until their next UPDATE (harmless — nothing reads this
  // column, so staleness has zero behavioral effect). The brains that
  // actually hit this bug never successfully wrote a value for the
  // oversized page in the first place, so there's nothing stale to fix
  // for them specifically — the NEXT sync of that exact file is what
  // proves the fix, not a backfill of already-working rows.
  //
  // Function body mirrors reindex-search-vector.ts's recreatePagesFn
  // (documented contract there: keep both in lockstep) and the fresh-
  // install baselines in pglite-schema.ts / schema-embedded.ts — all
  // four updated in the same commit as this migration.
  sql: '',
  handler: async (engine) => {
    const lang = getFtsLanguage();
    await engine.executeRaw(`
        CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
        DECLARE
          timeline_text TEXT;
        BEGIN
          SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
          INTO timeline_text
          FROM timeline_entries
          WHERE page_id = NEW.id;

          NEW.search_vector :=
            setweight(to_tsvector('${lang}', coalesce(NEW.title, '')), 'A') ||
            setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') ||
            setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');

          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `);
    migrationNotice(`  v124: update_page_search_vector() no longer indexes compiled_truth (was overflowing tsvector on large pages, #2704)
`);
  },
};
