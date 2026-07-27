---
name: frontmatter-guard
version: 1.0.0
description: |
  Validate and auto-repair YAML frontmatter on brain pages. Catches malformed
  pages before they enter the brain (missing closing ---, nested quotes, slug
  mismatches, null bytes, empty frontmatter, YAML parse failures). Wraps the
  `gbrain frontmatter` CLI for agent-driven workflows.
triggers:
  - "validate frontmatter"
  - "check frontmatter"
  - "fix frontmatter"
  - "frontmatter audit"
  - "brain lint"
tools:
  - exec
mutating: true
---

# Frontmatter Guard Skill

> **Convention:** see `skills/conventions/quality.md` for citation rules; this skill is structural validation, not citation auditing.

## Contract

This skill guarantees:
- Every brain page is scanned against the eight canonical frontmatter validation classes
- Mechanical errors (nested quotes, missing closing `---`, null bytes, slug mismatch) are auto-repairable on demand with `.bak` backups
- Validation logic is shared with `gbrain doctor`'s `frontmatter_integrity` subcheck — single source of truth
- Reports per source (gbrain is multi-source since v0.18.0); never silently audits the wrong root

## Why This Exists

Brain pages pile up over months. Agents write them with malformed frontmatter:
- Missing closing `---` (entity detector bugs)
- Unstructured YAML in meeting pages (ingestion bugs)
- Slug mismatches (path renames not propagated)
- Null bytes (binary corruption from copy-paste accidents)
- Nested double quotes in titles (`title: "Phil "Nick" Last"`)

Without a guard, these accumulate silently until `gbrain sync` chokes or search returns garbage. The guard makes the failure visible at audit time and trivially fixable.

## Validation classes

| Code | Meaning | Auto-fixable? |
|------|---------|---------------|
| `MISSING_OPEN` | File doesn't start with `---` | No (needs human) |
| `MISSING_CLOSE` | No closing `---` before first heading | Yes |
| `YAML_PARSE` | YAML failed to parse | Sometimes (depends on cause) |
| `SLUG_MISMATCH` | Frontmatter `slug:` differs from path-derived slug | Yes (removes the field) |
| `NULL_BYTES` | Binary corruption (`\x00`) | Yes |
| `NESTED_QUOTES` | `title: "outer "inner" outer"` shape | Yes |
| `NON_STRING_FIELD` | `title`/`type`/`slug` is an unquoted non-string scalar (e.g. `title: 123`, `slug: 2024-06-01`) | No (quote the value) |
| `EMPTY_FRONTMATTER` | Open + close present but nothing between | No (needs human) |

## Phases

### Phase 1: Audit

Run a read-only scan across all registered sources (or one with `--source <id>`).

```bash
gbrain frontmatter audit --json
```

Reports:
- Per-source counts grouped by error code
- Sample of up to 20 affected pages per source
- Total count
- Scan timestamp

Output is JSON; agents parse `errors_by_code` and `per_source` to decide next steps.

### Phase 2: Validate one path

Validate a single file or directory (does not require source registration):

```bash
gbrain frontmatter validate <path> --json
```

Exit code 0 = clean; 1 = errors found. Use this in CI pipelines or pre-commit hooks.

### Phase 3: Fix

When issues are found:

```bash
gbrain frontmatter validate <path> --fix
```

`--fix` writes `<file>.bak` for every modified file before mutating. The backup is the safety contract — works whether the brain is a git repo or a plain directory.

`--dry-run` previews without writing. Use this before applying fixes in batch.

### Phase 4: Pre-commit hook (optional)

For brain repos that ARE git repos, install the pre-commit hook to block malformed pages from being committed in the first place:

```bash
gbrain frontmatter install-hook [--source <id>]
```

The hook runs `gbrain frontmatter validate` against staged `.md`/`.mdx` files. Bypass with `git commit --no-verify`.

## Trigger words

When the user says any of these, route here:
- "validate frontmatter"
- "check frontmatter"
- "fix frontmatter"
- "frontmatter audit"
- "brain lint"

## Output rules

- Always run `gbrain frontmatter audit --json` first; never assume a brain is clean.
- Surface counts to the user in plain language; do not dump raw JSON.
- For `--fix` operations: state how many files will be modified BEFORE running, then confirm.
- `SLUG_MISMATCH` fixes remove the frontmatter `slug:` field — gbrain derives slug from path. Mention this when the user's title is intentionally renamed.
- Never auto-fix `MISSING_OPEN` or `EMPTY_FRONTMATTER` without explicit user input — these usually mean a human author started a page and didn't finish.

## Chains with

- `gbrain doctor` — the `frontmatter_integrity` subcheck reports the same counts as `audit`.
- `skills/maintain/SKILL.md` — broader brain health audit; chain after this skill if other classes of issue are suspected.
- `skills/lint/SKILL.md` (via `gbrain lint`) — overlapping rules for skill-file lint; the `frontmatter-*` rule names in lint output come from this skill's validation surface.

## Output Format

Audit summary (terse, agent-friendly):

```
Frontmatter audit — 17 issue(s) across 1 source(s)

[default] /Users/me/brain
  17 issue(s)
    MISSING_CLOSE: 8
    NESTED_QUOTES: 5
    NULL_BYTES: 4
  sample:
    people/jane.md — MISSING_CLOSE
    companies/acme.md — NESTED_QUOTES
    (+ 12 more)

Fix with: gbrain frontmatter validate /Users/me/brain --fix
```

JSON envelope (when `--json` is passed):

```json
{
  "ok": false,
  "total": 17,
  "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
  "per_source": [
    {
      "source_id": "default",
      "source_path": "/Users/me/brain",
      "total": 17,
      "errors_by_code": { "MISSING_CLOSE": 8, "NESTED_QUOTES": 5, "NULL_BYTES": 4 },
      "sample": [{ "path": "people/jane.md", "codes": ["MISSING_CLOSE"] }]
    }
  ],
  "scanned_at": "2026-04-25T22:30:00.000Z"
}
```

`gbrain frontmatter validate <path> --json` returns a similar envelope keyed on per-file results instead of per-source.

## Prevention — Writing Valid Frontmatter

**This is the most important section.** Fixing broken frontmatter is good. Not writing broken frontmatter in the first place is better.

### YAML arrays (the historical #1 error source)

```yaml
# Correct: single-quoted YAML flow (canonical form gbrain emits)
tags: ['yc', 'w2025', 'ai']

# Correct: unquoted scalars (fine when values have no special chars)
tags: [yc, w2025, ai]

# Correct: block style
tags:
  - yc
  - w2025

# Tolerated post-v0.37.5.0 but non-canonical: JSON-style double quotes
tags: ["yc", "w2025"]

# Broken: mixed JSON objects and strings (invalid YAML)
tags: [{"name": "sports"}, "posterous"]
```

**Why this used to break:** before v0.37.5.0, the validator counted unescaped `"` characters and flagged any line with 3+. A flow sequence like `tags: ["yc", "w2025"]` has 4 unescaped `"` by design — it's valid YAML, but the dumb counter flagged it anyway. One brain saw 6,981 of these on a single doctor run. v0.37.5.0 parses suspicious values with `js-yaml.safeLoad` before flagging, so JSON-style arrays no longer trigger NESTED_QUOTES.

**Why you should still write the canonical form:** the auto-fix engine (`gbrain frontmatter validate --fix`) and the inferred-frontmatter serializer both emit single-quoted YAML for `tags:` / `aliases:`. Writing the canonical form in new content keeps the source files stylistically consistent and makes diffs against `--fix` runs empty.

**The classic LLM trap:** code like `tags: [${items.map(t => JSON.stringify(t)).join(', ')}]` produces `tags: ["yc", "w2025"]`. Use single quotes with an apostrophe fallback: `tags: [${items.map(t => t.includes("'") ? JSON.stringify(t) : "'" + t + "'").join(', ')}]`. Or use a YAML library that knows how to emit canonical YAML.

### Quoted scalars

```yaml
# Correct: single quotes for values with special chars
title: 'My "Quoted" Title'

# Correct: double quotes when value has apostrophes
title: "Men's Fashion Guide"

# Broken: double quotes wrapping inner double quotes
title: "My "Quoted" Title"
```

### When to quote at all

- **Unquoted** is fine for simple values: `type: person`, `batch: w2025`
- **Quote** when the value contains `: " ' # [ ] { } | > & * ! ? ,` or starts with `@`
- **Single quotes** are the default safe choice
- **Double quotes** only when the value itself contains apostrophes

## Anti-Patterns

**Don't auto-fix `MISSING_OPEN` or `EMPTY_FRONTMATTER` without user input.** These usually mean a human author started a page and didn't finish — silently inserting `---` markers around an unfinished draft is wrong.

**Don't use `--fix` to "make doctor green" without reading the audit first.** SLUG_MISMATCH cases are surfaced for manual review specifically because gbrain derives the slug from path. A mismatch usually means the user renamed a file intentionally; auto-removing the slug field is the right outcome only when you've confirmed the rename was deliberate.

**Don't skip the `.bak` backups.** The `.bak` is the safety contract for non-git brain repos. If `.bak` files accumulate after a fix run, that's a feature, not a bug — the user can review the diffs and delete the backups when satisfied.

**Don't run `audit` on a brain where sources aren't registered.** The CLI returns "no registered sources to audit" gracefully, but the migration emits a `skipped: no_sources` phase result. Don't paper over this with a manual path-walk; the right fix is to register the source via `gbrain sources add`.

**Don't install the pre-commit hook on non-git brain dirs.** The install-hook command skips them automatically with a one-line note. If you see "skipped — not a git repo" and want validation at write time anyway, use the `audit` command on a cron schedule.
