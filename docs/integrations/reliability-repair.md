# Reliability repair

Two data-corruption classes can affect a brain on real Postgres or Supabase:
JSONB values stored double-encoded, and markdown bodies truncated at import.
`gbrain doctor` detects both, and the standalone `gbrain repair-jsonb`
command fixes the mechanically fixable class. PGLite brains are not affected
(PGLite parses text to jsonb natively, so the double-encode never happens
there).

## What the checks look for

**JSONB double-encode.** Writing `${JSON.stringify(x)}::jsonb` through
postgres.js stores a JSONB *string literal* instead of an object.
`frontmatter ->> 'key'` returns NULL; GIN indexes are ineffective. Columns
checked: `pages.frontmatter`, `raw_data.data`, `ingest_log.pages_updated`,
`files.metadata`. The write-side rule that prevents it is in
`docs/ENGINES.md` ("JSONB writes: never double-encode").

**Markdown body truncation.** A page whose `compiled_truth` is much shorter
than its `raw_data.data ->> 'content'` lost body content at import time (for
example, when a `---` horizontal rule was treated as a body/timeline
delimiter). Wiki-style pages with multiple `##`/`###` sections are the usual
casualty.

## Detect

```
gbrain doctor
```

Reports two checks:

- `jsonb_integrity` — counts double-encoded rows per table and points you
  at `gbrain repair-jsonb`.
- `markdown_body_completeness` — heuristic for pages whose `compiled_truth`
  is suspiciously short compared to `raw_data.data ->> 'content'`.

## Repair

For JSONB (mechanically fixable):

```
gbrain repair-jsonb
```

Runs `UPDATE <table> SET <col> = (<col>#>>'{}')::jsonb WHERE jsonb_typeof(<col>) = 'string'`
across every affected column. Idempotent. Second run reports 0 rows. Use
`--dry-run` to preview, `--json` for structured output. The `v0_12_2`
version migration runs this automatically on `gbrain upgrade`.

For truncated markdown bodies (source-dependent):

```
gbrain sync --force
# or per-page
gbrain import <slug> --force
```

gbrain cannot recover content that is already lost if you no longer have
the source markdown file. `gbrain doctor` tells you which pages look short;
you decide whether to re-import from source or accept the truncation.

## Verify

```
gbrain doctor
```

All four `jsonb_integrity` rows should read zero. `markdown_body_completeness`
should match your expectations for the corpus.
