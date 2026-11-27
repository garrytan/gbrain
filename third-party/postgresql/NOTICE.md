# PostgreSQL 18.6 full-text search and pg_trgm, ported to Rust

The Rust keyword search in `rust/crates/gbrain-store/src/keyword/` is a port of parts of PostgreSQL, release
`REL_18_6` (git commit `724edf9bde9d356724ad384a2e196edc3c9f80f7`, the tag of PostgreSQL 18.6). PostgreSQL is
licensed under the PostgreSQL License. The complete licence text is `LICENSE` in this directory: it is the
`COPYRIGHT` file of that release, byte for byte. This licence applies to the derived files listed below.

The port exists so the Rust engine tokenizes, stems, matches and ranks text exactly as PostgreSQL does. It is
tested against output that PostgreSQL 18.6 produced (see "Test data" below).

## Source files and what was derived from them

Paths under `src/` are paths in the PostgreSQL source tree. Paths under `keyword/` are in
`rust/crates/gbrain-store/src/keyword/`.

| Rust file | Derived from |
|---|---|
| `keyword/parser.rs` | `src/backend/tsearch/wparser_def.c`, the default text search parser, transcribed function by function |
| `keyword/parser/actions.rs` | The `TParserState` enum and the `actionTPS_*` tables of `wparser_def.c`. Generated, not typed: see below |
| `keyword/parser/charclass.rs` | Not copied from PostgreSQL source. It is a measurement of how PostgreSQL 18.6 (as run by PGLite 0.5.16, C.UTF-8) classifies each Unicode character above U+007F: `iswalpha`, `iswspace` and the parser's `p_isspecial` (`wparser_def.c`, the zero-width test and its `strange_letter` table). Generated: see below |
| `keyword/tsearch.rs` | `src/backend/tsearch/to_tsany.c`, `src/backend/tsearch/ts_parse.c`, `src/backend/utils/adt/tsvector_op.c`, `src/backend/utils/adt/tsquery.c`, `src/backend/utils/adt/tsquery_cleanup.c`, `src/backend/utils/adt/tsvector_parser.c` |
| `keyword/rank.rs` | `src/backend/utils/adt/tsrank.c` (`ts_rank`, `ts_rank_cd`) |
| `keyword/stem.rs` | `src/backend/snowball/dict_snowball.c` and the stopword list `src/backend/snowball/stopwords/english.stop`. It also contains a port of Snowball code: see `third-party/snowball/NOTICE.md` |
| `keyword/stem_german.rs` | `src/backend/snowball/dict_snowball.c` and the stopword list `src/backend/snowball/stopwords/german.stop` (the same file on Postgres 16 and on master). It also contains a port of Snowball code: see `third-party/snowball/NOTICE.md` |
| `keyword/trgm.rs` | `contrib/pg_trgm/trgm_op.c` (`similarity`, `word_similarity`, `strict_word_similarity`, `show_trgm`) and PostgreSQL's legacy CRC-32 (`src/include/utils/pg_crc.h` and `src/backend/utils/hash/pg_crc.c`: the `*_LEGACY_CRC32` macros and `pg_crc32_table`) that pg_trgm uses to shorten long trigrams |

The other files in `keyword/` (`arm.rs`, `chunk_search.rs`, `filters.rs`, `page_search.rs`, `title_fuzzy.rs`,
`titles.rs`, `vector_cache.rs`) are GBrain's own code. They call the ported functions above and reproduce the
behaviour of GBrain's SQL statements. They contain no PostgreSQL source.

Each derived Rust file carries a one-line header that points here.

## Generated files

Two of the derived files are produced by scripts, and CI checks that the committed bytes are what the script
produces (job `keyword-goldens` in `.github/workflows/rust-engine.yml`). Run any of these from the repository
root; each exits 1 and prints a message if the committed file differs.

- `keyword/parser/actions.rs`: `bun rust/scripts/gen-parser-actions.ts` (add `--write` to rewrite). It fetches
  `wparser_def.c` at `REL_18_6` from raw.githubusercontent.com and refuses a file whose SHA-256 is not the pinned one.
- `keyword/parser/charclass.rs`: `bun rust/scripts/gen-parser-charclass.ts` (add `--write` to rewrite). It
  installs PGLite 0.5.16 (PostgreSQL 18.6) into a scratch directory and measures every Unicode scalar value.

## Test data

The goldens in `rust/crates/gbrain-store/tests/fixtures/` hold output of PostgreSQL 18.6 (run through PGLite
0.5.16), not output of the Rust code:

- `ts_parse.json`: the token list that `ts_parse('default', input)` returns for 6,172 inputs.
- `tsearch.json`: `to_tsvector`, the tsquery builders, `@@`, `ts_rank` and `ts_rank_cd` results for 148 texts,
  223 queries and 704 ranked documents.
- `english_stem.tsv`: `ts_lexize('english_stem', word)` for 50,477 words. The word list is described in
  `third-party/snowball/NOTICE.md`.

The inputs are hand-written lists and seeded random strings. The script that first produced them was not kept, and
neither were its random seeds, so the inputs cannot be regenerated: they exist only in the committed files.
`rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts` reads the inputs back out of those files and
recomputes every output column on PGLite 0.5.16. `bun rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts`
(add `--write` to rewrite) exits 1 if any committed output differs from what PostgreSQL 18.6 says.
