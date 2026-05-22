# Reliability repair (v0.12.2)

If you ran v0.12.0 on real Postgres or Supabase, two bugs may have corrupted
data already in your brain. v0.12.1 fixed the code going forward.
v0.12.2 adds detection in `gbrain doctor` and a standalone `gbrain repair-jsonb`
command for the mechanically fixable class. PGLite users are not affected.

## What got corrupted

**JSONB double-encode.** Four write sites used
`${JSON.stringify(x)}::jsonb` with postgres.js, which stored a JSONB
*string literal* instead of an object. `frontmatter ->> 'key'` returns NULL;
GIN indexes are ineffective. Affected: `pages.frontmatter`,
`raw_data.data`, `ingest_log.pages_updated`, `files.metadata`.

**Markdown body truncation.** `splitBody()` treated `---` horizontal rules
as a body/timeline delimiter, dropping everything after the first rule.
Wiki-style pages with multiple `##`/`###` sections lost the bulk of their
content at import time.

## Detect

```
gbrain doctor
```

Reports two new checks:

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
migration runs this automatically on `gbrain upgrade`.

For truncated markdown bodies (source-dependent):

```
gbrain sync --force
# or per-page
gbrain import <slug> --force
```

v0.12.2 cannot recover content that was already lost if you no longer have
the source markdown file. `gbrain doctor` tells you which pages look short;
you decide whether to re-import from source or accept the truncation.

## Verify

```
gbrain doctor
```

All four `jsonb_integrity` rows should read zero. `markdown_body_completeness`
should match your expectations for the corpus.
