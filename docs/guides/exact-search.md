# Exact search

`foresights search --exact "<phrase>"` (MCP tool `search_exact`) finds every page
that contains a literal phrase or identifier. Use it where you would otherwise
run `grep` over the brain's files. Ranked search returns the best few pages and
can miss a rare phrase; exact search is unranked and exhaustive, and it tells you
whether the scan covered everything.

```bash
foresights search --exact "INV-2024-0042"
foresights search --exact "quarterly board pack" --slug-prefix meetings/ --json
foresights search --exact "Acme Example" --case-sensitive --types company,person
```

## What matches

The phrase's words, in order, with any run of whitespace between them: a phrase
that wraps onto the next line still matches. It is a substring match, so
`board pack` also matches `board packs`. Matching is case-insensitive unless
you pass `--case-sensitive` (`case_sensitive: true`). Nothing else is
normalized: there is no stemming, and punctuation, accents and quote styles are
literal. Ranked `search` is different: there, quotes mean a stemmed phrase.

The scan reads the text index (`content_chunks`), every chunk of every page in
your scope, including keyword-only pages and pages held from embedding, as long
as they are chunked. An image page's indexed text is its OCR text. Neighboring
chunks overlap by roughly 25 to 50 words (none after a chunk shorter than
that), so a phrase that crosses a chunk boundary is still found unless it is
longer than the overlap or begins in a very short paragraph. Credential values
are masked in the index, so a secret never matches.

## The result

- `matches`: every matching page in page order, each with `matching_chunks`,
  up to three snippets, and its trust label (`trust_tier`, `origin`).
- `complete`: `true` only when every page in your scope was scanned and none of
  them had text the scan could not read. `complete: true` with no matches means
  the phrase is not in any page you can read.
- `incomplete_reasons` when `complete` is `false`:
  - `limit`: more pages matched than `--limit` (default 100, max 1000).
  - `deadline`: the scan ran out of time (`--max-seconds`, default 30, max 120).
  - `unreadable_pages`: some pages in scope have text the index can't serve
    yet. They are counted under `unreadable.by_reason` and the first 20 are
    listed under `unreadable.sample`:
    - `unchunked`: the page has body text but no chunks (for example a page
      held from chunking). `foresights embed --stale` chunks it.
    - `projection_pending`: the page's text index is behind its latest edit.
    - `unsealed` (remote callers only): the page was indexed before the
      safe-chunk fence, so it is withheld from remote reads until
      `foresights repair safe-chunks` reseals it.
    - `scan_timeout`: one page alone did not finish within the statement
      deadline.
- `resume_after`: after `limit` or `deadline`, pass it back as `--after`
  (`after`) to continue from where the scan stopped. The CLI prints the exact
  command.

`excluded_slug_prefixes` lists the prefixes ranked search also hides
(`test/`, `attachments/`, `.raw/`, plus `GBRAIN_SEARCH_EXCLUDE`). Pages under
them are out of scope and do not make the scan incomplete.

## Scope and privacy

`--source` / `source_id`, `--types` and `--slug-prefix` narrow the scope.
A remote (MCP) caller gets the same visibility as ranked search: only sources in
its grant, no private pages, no quarantined pages, pages at or above its trust
floor, and safe chunks only, so fenced facts and takes never match. Pages a
caller cannot read are never counted or listed.

## How it runs

The scan walks pages in id order in batches of up to 2,000, one statement per
batch. On Postgres a batch that hits the statement deadline is retried at half
the size; a single page that still times out is reported as `scan_timeout`.
