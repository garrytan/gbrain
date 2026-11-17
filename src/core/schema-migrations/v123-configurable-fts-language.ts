import type { Migration } from './types.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { migrationNotice } from './helpers.ts';

export const v123: Migration = {
  version: 123,
  name: 'configurable_fts_language',
  // Recreate the two search_vector trigger functions using the language
  // configured via GBRAIN_FTS_LANGUAGE (default 'english'). Idempotent:
  // CREATE OR REPLACE swaps the function body atomically; no trigger
  // recreation needed since the trigger references the function by name.
  //
  // Why a handler instead of a static SQL string: Postgres tsvector
  // functions don't accept parameterized config names — the language
  // must be a literal in the SQL. getFtsLanguage() validates the value
  // (lowercase letters/digits/underscores only) before interpolation.
  //
  // Function bodies mirror schema.sql / pglite-schema.ts exactly —
  // INCLUDING the `SET search_path = pg_catalog, public` hardening from
  // v120/#1647 (CREATE OR REPLACE resets proconfig, so omitting it here
  // would silently strip the hardening on every upgraded brain). Only
  // the text-search config name is parameterized. Keep all copies in
  // sync when the trigger logic changes.
  //
  // Backfill: after recreating the functions, re-tokenize existing rows
  // under the new language. Skipped when the configured language is
  // 'english' (trigger output identical — re-tokenizing is wasted I/O).
  // To change language after this migration has run, use
  // `gbrain reindex-search-vector`.
  sql: '',
  handler: async (engine) => {
    const lang = getFtsLanguage();

    const recreatePagesFn = `
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
            setweight(to_tsvector('${lang}', coalesce(NEW.compiled_truth, '')), 'B') ||
            setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') ||
            setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');

          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `;

    const recreateChunksFn = `
        CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER SET search_path = pg_catalog, public AS $fn$
        BEGIN
          NEW.search_vector :=
            setweight(to_tsvector('${lang}', COALESCE(NEW.doc_comment, '')), 'A') ||
            setweight(to_tsvector('${lang}', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
            setweight(to_tsvector('${lang}', COALESCE(NEW.chunk_text, '')), 'B');
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `;

    await engine.executeRaw(recreatePagesFn);
    await engine.executeRaw(recreateChunksFn);

    if (lang === 'english') {
      // stderr, NOT stdout: migrations run lazily inside any command's
      // first DB connect — a console.log here polluted `doctor --json`
      // stdout and broke jq consumers (heavy-tests fm_wallclock).
      migrationNotice(`  v123: trigger functions recreated with language='english' (default — no backfill needed)\n`);
      return;
    }

    // Backfill existing rows under the new tokenizer. UPDATE-to-same-value
    // re-fires the pages trigger; chunks are rewritten directly with the
    // same expression as the trigger.
    await engine.executeRaw(`
        UPDATE pages SET id = id
        WHERE search_vector IS NOT NULL;
      `);

    await engine.executeRaw(`
        UPDATE content_chunks
        SET search_vector =
          setweight(to_tsvector('${lang}', COALESCE(doc_comment, '')), 'A') ||
          setweight(to_tsvector('${lang}', COALESCE(symbol_name_qualified, '')), 'A') ||
          setweight(to_tsvector('${lang}', COALESCE(chunk_text, '')), 'B')
        WHERE search_vector IS NOT NULL;
      `);

    migrationNotice(`  v123: trigger functions recreated with language='${lang}' + backfilled existing rows\n`);
  },
};
