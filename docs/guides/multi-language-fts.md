# Multi-language full-text search

GBrain's keyword search arm uses Postgres full-text search (tsvector/tsquery).
The tokenizer language is configurable via the `GBRAIN_FTS_LANGUAGE`
environment variable. Default: `english`.

## How it works

Postgres text-search configurations control stemming and stop-word removal.
`GBRAIN_FTS_LANGUAGE` is read by `src/core/fts-language.ts` and applied on
both sides of the search:

- **Query side** — `websearch_to_tsquery('<lang>', $query)` in both engines
  (Postgres and PGLite).
- **Write side** — the `update_page_search_vector` and
  `update_chunk_search_vector` trigger functions that populate
  `pages.search_vector` and `content_chunks.search_vector`.

The value is validated against `/^[a-z][a-z0-9_]*$/` before it is ever
interpolated into SQL (tsvector functions don't accept parameterized config
names). Invalid values fall back to `english` with a warning.

## Built-in languages

Set the env var to any configuration your Postgres instance ships:

```bash
export GBRAIN_FTS_LANGUAGE=portuguese
export GBRAIN_FTS_LANGUAGE=spanish
export GBRAIN_FTS_LANGUAGE=german
```

List what's available:

```sql
SELECT cfgname FROM pg_ts_config;
```

PGLite (the embedded default engine) ships the same built-in snowball
configurations as stock Postgres.

## First install vs. changing language later

On first install (or upgrade), the `configurable_fts_language` schema
migration reads `GBRAIN_FTS_LANGUAGE` and stamps the trigger functions with
that language. After the migration has run, changing the env var alone does
NOT retokenize existing rows — the migration shows as applied and is skipped.
Use the explicit command:

```bash
export GBRAIN_FTS_LANGUAGE=portuguese
gbrain reindex-search-vector --dry-run    # preview: language + row counts
gbrain reindex-search-vector --yes        # recreate triggers + backfill
```

The command recreates both trigger functions under the new language and
backfills every existing `pages` and `content_chunks` row in batches,
streaming progress to stderr. It is idempotent: re-running with the same
language produces identical vectors. `--json` prints a machine-readable
result envelope but still requires `--yes` (or an interactive confirm).

## Recipe: accent-insensitive Portuguese (`pt_br`)

Brazilian Portuguese content often mixes accented and unaccented spellings
("São Paulo" vs "Sao Paulo"). Build a custom config that folds accents via
the `unaccent` extension, then stems with the portuguese snowball dictionary:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION pt_br (COPY = portuguese);

ALTER TEXT SEARCH CONFIGURATION pt_br
  ALTER MAPPING FOR hword, hword_part, word
  WITH unaccent, portuguese_stem;
```

Then point GBrain at it:

```bash
export GBRAIN_FTS_LANGUAGE=pt_br
gbrain reindex-search-vector --yes
```

Note: custom configurations require a real Postgres instance (e.g. the
Supabase engine). The config must exist BEFORE the migration or the reindex
command runs, or Postgres will reject the trigger recreation with
`text search configuration "pt_br" does not exist`.

## Caveats

- One language per brain: the setting is global to the database, not
  per-source. Mixed-language brains should pick the dominant language (the
  vector-search arm is language-agnostic and covers the rest).
- Keep `GBRAIN_FTS_LANGUAGE` set consistently in every environment that
  writes to the brain (CLI shells, MCP server, cron jobs) — a writer without
  the env var tokenizes new rows in `english` until the next reindex.
