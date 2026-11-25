# The brain store: CLI search and graph reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the read-command statements that the ops layer ran through `executeRaw`
(the `executeRaw` map in the Rust engine branch's research notes; it is not on master):
`search_exact`, `whois`, `rank_entities` and `extraction_pending`, plus the two remote-caller reads around them:
`rank_entities`' per-source coverage and the chunks `search_exact` reads again to take out held fence rows. PGLite and
Postgres run the same SQL as before (`src/core/engine-sql/cli-reads-ops.ts`, `exact-identity.ts`, `graph-rank.ts` and
`src/core/search/exact-scan.ts`; the remote-read statements are pinned by `test/remote-read-statements-golden.test.ts`).
The store answers from its page, chunk, link, extraction, wanted-link and source records
(`crates/gbrain-store/src/cli_reads/reads.rs` and `remote_reads.rs`) and has no keys of its own. The TypeScript side is `src/core/rust-engine/store-members/cli-reads-ops.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.scanExactBatch({ words, longest, caseSensitive, sourceId, sourceIds, types, slugPrefix, excludeSlugPrefixes, after, batchPages })` | `null` for no words; else the next `batchPages` pages in scope after page id `after`, in id order: `{ page_id, slug, source_id, title, type, matching_chunks, snippets, gap }` | `scanExactBatch` |
| `brain.nextLivePageAfter(afterPageId)` | the first live page with a larger id, in any source (archived ones too): `{ id, slug, source_id }`, or `null` | `nextLivePageAfter` |
| `brain.listExactIdentityCandidates({ probes, sourceIds, types, remote, emailsOnly, limit })` | live pages in `sourceIds` whose title, slug basename, page alias, frontmatter email or phone digits equal a probe, by `(source_id, slug)` in byte order: `{ slug, source_id, title, type, email, emails, phone, phones, aliases }` | `listExactIdentityCandidates` |
| `brain.rankEntities({ direction, types, sourceIds, linkType, includeMentions, limit, foldedCap, remote })` | pages ranked by distinct in-scope edges, retired pages folded in: `{ slug, title, type, source_id, inbound, outbound, neighbors, folded_total, folded }` | `rankEntities` |
| `brain.readRankCoverage({ sourceId, versionTs, mentionTypes, excludePrivate })` | over the pages of the source the caller may read: `{ link_behind, mention_due }` | `readRankCoverage` |
| `brain.readExactSnippetChunks({ keys, excludePrivate })` | per `{ pageId, chunkIndex, snippet }` key, its visible chunk when the chunk holds the snippet, in key order: `{ i, chunk_text }` (`i` from 1) | `readExactSnippetChunks` |
| `brain.listExactRescanChunks({ pageIds, excludePrivate })` | the visible chunks of the safe-fenced pages, by page id then chunk index: `{ page_id, chunk_index, chunk_source, chunk_text }` | `listExactRescanChunks` |
| `brain.listExtractionPendingPages({ sourceIds, sourceId, limit, offset })` | unverified auto-extracted pages in scope, newest first: `{ slug, title, type, source_id, extracted_from, created_at }` | `listExtractionPendingPages` |

The TypeScript member of `scanExactBatch` splits the phrase into words as `phrasePattern` does (JavaScript `trim` and
`\s+`) and passes the longest word. The store matches the words joined by one or more `[[:space:]]` characters. A
negative `LIMIT` or `OFFSET` is an `invalid_argument` error, as Postgres rejects it.

## How each read follows the SQL

- **scanExactBatch.** The batch is the live pages after `after` with no `quarantine` or `pinned_question` key, in a
  source that exists and is not archived, in the scope (`sourceIds` when non-empty, else `sourceId`), of `types` when
  non-empty, under `slugPrefix`, and under no non-empty `excludeSlugPrefixes` entry. For each page, a chunk is a hit
  when the projection is served, the chunk is visible at the page's segment generation, the chunk text contains the
  longest word (`LIKE`, or `ILIKE`) and the phrase matches. `matching_chunks` counts the hits. `snippets` holds the
  first three hits by `chunk_index`: `{ chunk_index, chunk_source, text }`. `text` is the leftmost match of
  `.{0,80}<phrase>.{0,80}`, longest at that start (Postgres regular expressions take the greediness of the first
  quantifier). A page with no hit has `matching_chunks` and `snippets` `null` and `gap` `projection_pending` (projection
  not served), `unchunked` (no visible chunk and a body) or `null`.
- **listExactIdentityCandidates.** A page matches when `lower(title)` equals `lower(titleRaw)` or is in `titleKeys`,
  when the part of the slug after the last `/` is in `basenames`, when a `page_aliases` row of its source and slug (any
  origin) has an `alias_norm` in `aliasKeys`, or when the frontmatter `email` or `emails` is a probe string or an array
  that holds it. A number or other value never matches an email probe. A page also matches when it has a `phone` or
  `phones` key and an element of that value (a scalar counts as one element, written as Postgres
  `jsonb_array_elements_text` writes it) reduced to its digits is in `phones`. The title arm runs only when `titleKeys`
  or `titleRaw` is not empty. `emailsOnly` drops the title and phone arms; the basename, alias and email arms still
  run. A probe or source id with a NUL byte is refused
  (`invalid_argument`), as Postgres refuses it in a text parameter. Then: live, the source exists
  and is not archived, the type passes the entity type filter (the first `per_source` entry for the page's source, else
  `types`), and for a remote caller no `quarantine` key. With `remote.excludePrivate`, the member sends the caller's page
  policy (`storePagePolicy` over `privatePagesFilterForCaller('p')`, with the caller's readers) as `remote.policy`, and
  the store drops each page `page_hidden` hides before the limit. `email`, `emails`, `phone`, `phones` and `aliases` are the frontmatter
  values, or `null`.
- **rankEntities.** A readable page is live and in `sourceIds` (all sources when absent, none when empty). For a remote
  caller it also has no `quarantine` key and its source exists and is not archived. A retired page
  (`retiredPageSql`: `canonical` false or no, a non-blank `superseded_by` or `merged_into`, or a `status` that names
  alias, redirect or redirected) folds into the first page its redirect chain reaches in at most five hops that is
  readable, not retired and not the start. The redirect target follows `REDIRECT_TARGET_SQL`: `[[` and `]]` stripped,
  the part before `|`, a trailing `.md` (any case) and leading `/` removed. An edge is one distinct
  `(folded from, folded to, link_type)` over links between two readable pages that are not the same page, not of type
  `amends`, not from `mentions` unless `includeMentions`, of `linkType` when given, and for a remote caller with no
  origin page or a readable one. `inbound` and `outbound` count edges; `neighbors` counts distinct other ends. Rows
  pass the type filter, have a key (`in`, `out` or both summed) above zero and sort by key descending, then slug and
  source id in byte order. `folded_total` counts the pages folded in; `folded` lists up to `foldedCap` of them by slug,
  `{ slug, reason }`, or is `null` when it would be empty.
- **listExtractionPendingPages.** Frontmatter `provenance` is `auto-extracted` and `status` is `unverified` (as text);
  the page is live, served, has no `quarantine` or `pinned_question` key, is in scope and its source exists and is not
  archived. `extracted_from` is frontmatter `source` as `->>` reads it. `created_at` is `timestamptz::text` in UTC.

- **readRankCoverage.** A readable page is live, in `sourceId`, has no `quarantine` key, its source exists and is not
  archived, and the caller's page policy (when sent) does not hide it. `link_behind` is true when a readable page outside
  a guest source owes link extraction (`staleForExtractionSql`): no extraction stamp, a stamp older than `versionTs` or
  than the page, or a wanted-link target that changed after the page last resolved it; and its attendance marker is not
  at its knowledge revision. `mention_due` needs `mentionTypes`.
- **readExactSnippetChunks.** A key at position `i` gives a row when its page exists, serves its text projection, the
  caller's policy does not hide it, and the chunk at `chunkIndex` is visible at the page's segment generation and holds
  `snippet` (`strpos > 0`). The safe-chunk fence is not checked, as the SQL does not check it.
- **listExactRescanChunks.** Each named page (duplicates once, by id) that exists, serves its projection, is at the
  safe-chunk fence and is not hidden, gives each of its visible chunks.

## Text semantics

The store reproduces how PGLite (PostgreSQL 18.6, libc provider, ctype `C.UTF-8`, time zone UTC) evaluates text
(`crates/gbrain-store/src/cli_reads/pg_text.rs`).

- **Case.** `lower()` and `upper()` map one character at a time with PGLite's own table (`pg_case.rs`, 2,742 entries,
  generated by the SQL in its header). Rust's `char::to_lowercase` and `to_uppercase` differ from that table on 316
  code points (for example `upper('ß')` is U+1E9E in PGLite, and the circled letters have no lower case), so the store
  never uses them.
- **`ILIKE`.** Both sides lowered per character, then a plain substring test.
- **`~*`.** A pattern character `c` matches a text character `t` when `t` is `lower(c)` or `upper(c)`; the text is not
  folded. So the phrase `kelvin` does not match the Kelvin sign U+212A, although `ILIKE` does, and the four title-case
  digraphs (U+01C5, U+01C8, U+01CB, U+01F2) do not match themselves.
- **`[[:space:]]`.** Characters 9 to 13, 32, U+0085, U+2000 to U+2006, U+2008 to U+200A, U+2028, U+2029, U+205F and
  U+3000. Unlike JavaScript `\s` it does not hold U+00A0, U+1680, U+2007, U+202F or U+FEFF.
- **`btrim`.** Strips U+0020 only. The redirect target therefore keeps a tab or newline at its ends, where the
  TypeScript `redirectSlug` (`.trim()`) strips them. The store follows the SQL.
- **`->>` and jsonb text.** A string reads as itself; `null` or a missing key reads `null`; any other value reads as
  jsonb's text form (keys ordered by length then bytes, `", "` and `": "` separators).
- **`timestamptz::text`.** `YYYY-MM-DD HH:MM:SS[.ffffff]+00`, trailing zeros of the fraction dropped.

## What the store does not keep

Each answer below is what Postgres gives for a brain that never wrote the missing data, or a typed refusal
(`engine_capability_missing`) where no such answer is exact.

- **Private visibility.** `listExactIdentityCandidates` and `rankEntities` with `remote.excludePrivate` read
  `remote.policy`, the caller's page policy (`storePagePolicy` with caller readers), and leave out each page it hides.
  `rankEntities` drops a hidden page from the ranked set and from every edge count. With `excludePrivate` and no
  policy the store method rejects the call with `invalid_argument`. `scanExactBatch` with `excludePrivate` reads the
  same policy as `excludePrivate` and leaves hidden pages out of the batch.
  `readRankCoverage`, `readExactSnippetChunks` and `listExactRescanChunks` with `excludePrivate` read the same policy.
- **Mention-pass state.** `readRankCoverage` reads the stored per-page mention state. With `mentionTypes`, `mention_due`
  is true only when a readable page owes a mention pass under `mentionVersion` (no state, or state behind the page's
  knowledge revision or the version), or a readable page of one of those types owes an alias refresh under `aliasVersion`.
- **Held link extraction.** The store keeps no `links_extract_failure`, so no page is held and `readRankCoverage` counts
  every stale page.
- **Trust tiers.** `scanExactBatch` with `minTrust` refuses.
- **The safe-chunk fence.** `scanExactBatch` with `remote: true` matches only chunks of a page whose
  `chunker_version` is at the fence (4) or above, and reports a page below it with no match as `unsealed`. A record
  with no version is below the fence, as Postgres stores 1 for it.
- **Body storage.** The store has no `body_storage` or `body_bytes`. A page has a body when `compiled_truth` or
  `timeline` is non-empty, which is the Postgres answer for an inline body.
- **Page aliases.** The alias probe (`aliasKeys`) reads the stored page-alias rows (`alias_row_slugs`) and matches a
  page by the alias row's source and slug.
- **Equal `created_at`.** PGLite orders `listExtractionPendingPages` by `created_at` only and leaves ties open. The store
  breaks a tie by page id, newest first.
