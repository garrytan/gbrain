# gbrain linkify — Producer Integration Guide

`gbrain linkify` scans a markdown file (or a directory of markdown files) and
rewrites bare person-name mentions into Obsidian wiki-links. It is designed to
run as a post-write step in any producer pipeline.

---

## CLI surface

### Single-file modes

```bash
# Write linkified content to stdout (non-destructive default).
gbrain linkify <file>

# Rewrite the file in place (atomic write via temp-file + rename).
gbrain linkify --in-place <file>

# Write the would-be result to stdout without touching the file.
gbrain linkify --in-place --dry-run <file>
```

### Batch mode

```bash
# Rewrite in place all files under <dir> modified since <ISO8601 timestamp>.
gbrain linkify --dir <dir> --since <ISO8601> [--filename-prefix <prefix>]

# Diagnostics only — no writes anywhere.
gbrain linkify --dir <dir> --dry-run
```

`--filename-prefix` restricts the batch to files whose basename starts with the
given string (e.g. `2026-05-`).

### ABI probe

```bash
gbrain linkify abi-version   # emits: 1
```

### Help

```bash
gbrain linkify --help
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error (bad flags, missing arguments) |
| 3 | Engine unavailable — gbrain cannot reach its database; retry later |

---

## Producer integration patterns

All three patterns below use **array-form invocation** (no shell string
interpolation). This avoids quoting surprises in file paths that contain spaces
or special characters.

### Shell (bash)

```bash
gbrain linkify --in-place "$BRIEFING_PATH" 2>>"$LOG"
case $? in
  0) ;;
  3) echo "[$(date)] linkify: engine unavailable" >>"$LOG" ;;
  *) echo "[$(date)] linkify: failed" >>"$LOG" ;;
esac
```

> **Bash `$?` and `2>>` redirects**: The `2>>"$LOG"` redirect captures
> linkify's stderr into the log file without affecting `$?`. The exit code in
> `$?` is still that of `gbrain linkify`, not the redirect. This is safe.
> By contrast, `gbrain linkify … | tee >>"$LOG"` would clobber `$?` with
> `tee`'s exit code — avoid that pattern.

### Python (subprocess.run with array args, no shell)

```python
import subprocess

r = subprocess.run(
    ['gbrain', 'linkify', '--in-place', briefing_path],
    capture_output=True,
    text=True,
)
if r.returncode == 0:
    pass  # success
elif r.returncode == 3:
    log('linkify: engine unavailable')
else:
    log(f'linkify: failed: {r.stderr}')
```

Pass `briefing_path` as a list element, not via `shell=True`, so spaces and
special characters in the path are safe.

### Node.js (execFile, no shell)

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

try {
  await execFilePromise('gbrain', ['linkify', '--in-place', filePath]);
} catch (e: any) {
  if (e.code === 3) {
    // Engine unavailable — retry next run.
  } else {
    // Unexpected failure — log e.stderr.
  }
}
```

`execFile` never spawns a shell, so `filePath` is passed directly as an
argument without shell-quoting concerns.

---

## ABI compatibility

Producers should call `gbrain linkify abi-version` at startup and refuse to
proceed if the returned integer is less than the version they were built
against. The current ABI version is **1**.

gbrain increments the ABI version when the invocation shape changes
incompatibly (new required flags, removed flags, changed exit-code semantics).
Patch-level fixes and additive flags do not bump it.

Example startup check (bash):

```bash
ABI=$(gbrain linkify abi-version 2>/dev/null) || ABI=0
if [ "$ABI" -lt 1 ]; then
  echo "gbrain linkify ABI too old (got $ABI, need >= 1)" >&2
  exit 1
fi
```

---

## Diagnostics

### Summary line (default)

When linkify runs, it always emits one summary line on stderr:

```
linkify: files=N linked=K ambiguous=M unique_people=P
```

This is emitted even in `--dry-run` mode (files and linked counts reflect
what *would* happen).

### Verbose diagnostics (`--verbose-diagnostics`)

Emits one human-readable line per diagnostic event on stderr:

```
linkify [resolved_by_default_domain] name="Alice Smith" slug="alice-smith" domain="aseva.com"
linkify [ambiguous_unresolved] name="Jordan" candidates=["jordan-lee","jordan-kim"]
```

### JSON diagnostics (`--json-diagnostics`)

Emits one JSON object per line on stderr — suitable for programmatic log
ingestion:

```jsonl
{"kind":"resolved_by_default_domain","name":"Alice Smith","slug":"alice-smith","domain":"aseva.com"}
{"kind":"ambiguous_unresolved","name":"Jordan","candidates":["jordan-lee","jordan-kim"]}
```

### Diagnostic event kinds

| Kind | Meaning |
|------|---------|
| `resolved_by_default_domain` | Multi-candidate match; winner picked by `default_domains` config. |
| `resolved_by_context_keywords` | Multi-candidate match; winner picked by context-keyword scoring (see below). |
| `ambiguous_unresolved` | Multi-candidate match, no tiebreaker available; mention left unlinked. |
| `auto_stub_excluded_total` | Startup count: how many auto-stub pages were excluded from the candidate index. |
| `stopword_dropped_all_keys` | A person page's name reduced entirely to stopwords; page excluded from index. |
| `malformed_frontmatter` | A person page has a non-string `name`, non-string entries in `linkify_aliases`, or non-string entries in `linkify_context_keywords`; page excluded or field ignored. |
| `concurrent_modification_skipped` | File's mtime changed between read and write; file skipped to avoid clobbering concurrent changes. |
| `icloud_placeholder_skipped` | iCloud Drive placeholder detected; file not materialized locally, skipped. |
| `enoent` | File disappeared between directory enumeration and read; skipped. |

---

## Context-keyword disambiguation

When an alias matches multiple candidates and the `default_domains` tiebreaker
does not pick a winner (e.g., two people share the same first name and the same
domain), linkify can use per-page context keywords to resolve the ambiguity.

### Frontmatter field

Add `linkify_context_keywords` to the person page's frontmatter:

```yaml
---
name: Justin Thompson
domain: aseva.com
linkify_context_keywords:
  - network
  - AI
  - BGP
---
```

```yaml
---
name: Justin Worley
domain: aseva.com
linkify_context_keywords:
  - TAC
  - support
  - ticket
---
```

### How it works

When resolving an ambiguous alias, linkify scans a **±500-character window**
around the match position in the source markdown (the original, unmasked text —
skip zones like code blocks are not stripped for this purpose, as the surrounding
prose is what matters for context). For each candidate, it counts
case-insensitive keyword hits of that candidate's `linkify_context_keywords`
within the window.

Keyword matching uses Unicode word boundaries (a keyword must appear as a
standalone token in the window, NOT as a substring of another word). For
example, keyword `AI` matches `AI` as a word but NOT `expl**AI**n` or
`m**AI**n`.

The tiebreaker applies in this order:

1. **Single candidate** — link directly.
2. **`default_domains`** — if exactly one candidate's domain is in
   `default_domains`, link to it.
3. **Context keywords** (this feature) — if exactly one candidate has a
   strictly-higher keyword-hit count (> all others) AND the count is > 0, link
   to that candidate.
4. **`ambiguous_unresolved`** — leave the mention unlinked and emit a
   diagnostic.

### Tie behavior

If two candidates score equally in the context window, or if no keywords appear
in the window at all, the tiebreaker does not pick a winner and the mention
falls through to `ambiguous_unresolved`. A partial keyword advantage (one
candidate scores > 0 while the other scores 0) counts as strictly higher and
resolves the tie.

### Keyword selection guidance

Choose keywords that appear as standalone tokens in your prose. Short keywords
are fine (`AI`, `BGP`, `TAC`) as long as they aren't substrings of common words
you'd write in the same window — those won't false-positive thanks to
word-boundary matching. Multi-word phrases are NOT supported as single keywords
(a phrase like `"service implementation"` should be entered as two separate
keywords `"service"` and `"implementation"`, OR be redesigned to use a unique
token).

### Worked example

Given the two person pages above, linkify processes:

```
BGP convergence issue on the WAN. Justin to investigate.
```

The ±500-char window around "Justin" contains "BGP". Justin Thompson's keywords
include "BGP" (1 hit); Justin Worley's keywords do not match anything in the
window (0 hits). Strictly higher → resolved to Justin Thompson.

```
TAC support ticket escalated. Justin will follow up.
```

The window contains "TAC", "support", and "ticket" — all three match Justin
Worley's keywords (3 hits); Justin Thompson scores 0. Resolved to Justin Worley.

```
Discussed BGP and TAC. Justin will lead.
```

The window contains "BGP" (Thompson: 1) and "TAC" (Worley: 1). Equal scores →
tied → `ambiguous_unresolved`.

### Diagnostic

A successful context-keyword resolution emits a `resolved_by_context_keywords`
diagnostic:

```jsonl
{"kind":"resolved_by_context_keywords","match":"justin","chosen":"people/jthompson-aseva","rejected":["people/jworley-aseva"],"window_hit_count":1,"occurrences":1}
```

The `window_hit_count` field reports the total keyword hits for the winning
candidate in that window. Multiple identical resolutions in the same file
(same match, same chosen, same rejected) are deduplicated into a single
diagnostic with `occurrences` incremented.

---

## Configuration

Add a `linkify` block to `~/.gbrain/config.json`:

```json
{
  "linkify": {
    "default_domains": ["aseva.com"],
    "stopwords": ["will", "may"],
    "first_mention_only": false
  }
}
```

All fields are optional. Defaults:

| Field | Default | Notes |
|-------|---------|-------|
| `default_domains` | `[]` | Domain suffixes used to break ties among multiple candidates with the same name. Order matters — first match wins. |
| `stopwords` | `[]` | Additional words (beyond the built-in list) stripped before name matching. Useful for org-specific filler words. |
| `first_mention_only` | `false` | When `true`, only the first occurrence of each name in a file is linked; subsequent occurrences are left as plain text. |

---

## iCloud Drive caveats

iCloud Drive uses placeholder files to defer downloading content that hasn't
been accessed recently. A placeholder for `foo.md` appears as a dotfile
`.foo.md.icloud` alongside the missing `foo.md`. The real file is absent until
macOS downloads it on demand.

linkify detects this condition and skips the file with an
`icloud_placeholder_skipped` diagnostic rather than attempting to read the
stub. This prevents corrupt or empty writes to files that are only temporarily
unavailable.

If you see a high count of `icloud_placeholder_skipped` events, open Finder
and select "Download Now" on the relevant folder to materialize the files
before running linkify again.

---

## extract-links — promoting wikilinks into graph edges

`gbrain extract-links` is the final step in the producer pipeline. It reads
wikilinks from a markdown file (or a batch of files) and calls `engine.addLink`
to promote those links into the graph database, bypassing sync's git-diff gate.
This means edges are available immediately after `extract-links` runs — you
do not have to wait for the next sync cycle.

### The producer pipeline

```
produce → stamp → linkify → extract-links
```

Each step's contract:

| Step | Responsibility |
|------|---------------|
| `produce` | Writes the markdown file. This is the caller's domain — gbrain has no opinion on how the file is authored. |
| `stamp` | Populates frontmatter via `gbrain frontmatter --file/--dir`. Sets `slug`, `updated_at`, and related fields. |
| `linkify` | Auto-links bare person mentions into Obsidian wikilinks (`[[people/alice-smith]]`). Rewrites the file in place. |
| `extract-links` | Reads the (now-linkified) wikilinks and promotes them into graph edges via `engine.addLink`. |

**Order matters.** Run `linkify` first; `extract-links` second. `extract-links`
reads the `[[people/...]]` wikilinks that `linkify` just inserted. Running
them in the wrong order means the new person links are not yet present in the
file when `extract-links` reads it.

### CLI surface

```bash
# Extract edges from a single file.
gbrain extract-links --path <file>

# Batch mode — process all matching files under <dir> modified since <ts>.
gbrain extract-links --dir <dir> --since <ISO8601> [--filename-prefix <prefix>]

# Dry-run — emit would_create_edge diagnostics, no DB writes.
gbrain extract-links --path <file> --dry-run
gbrain extract-links --dir <dir> --dry-run

# Diagnostics format (same modes as linkify).
gbrain extract-links --path <file> --json-diagnostics
gbrain extract-links --path <file> --verbose-diagnostics

# ABI probe.
gbrain extract-links abi-version   # emits: 1

# Help.
gbrain extract-links --help
```

`--filename-prefix` restricts the batch to files whose basename starts with the
given string (e.g. `2026-05-`).

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error (bad flags, missing arguments) |
| 3 | Engine unavailable — gbrain cannot reach its database; retry later |

### Additive-only contract

`extract-links` calls `engine.addLink`, which is implemented as an upsert.
Running `extract-links` twice on the same file produces no duplicate edges.
Producers can safely call it on every run without tracking whether they have
already processed a given file.

### Producer integration example (bash)

```bash
# Full producer pipeline — run linkify FIRST, extract-links SECOND.
gbrain linkify --in-place "$BRIEFING_PATH" 2>>"$LOG"
case $? in
  0) ;;
  3) echo "[$(date)] linkify: engine unavailable" >>"$LOG" ;;
  *) echo "[$(date)] linkify: failed" >>"$LOG" ;;
esac

gbrain extract-links --path "$BRIEFING_PATH" 2>>"$LOG"
case $? in
  0) ;;
  3) echo "[$(date)] extract-links: engine unavailable" >>"$LOG" ;;
  *) echo "[$(date)] extract-links: failed" >>"$LOG" ;;
esac
```

The `2>>"$LOG"` redirect captures stderr diagnostics into the log without
affecting `$?`. This is the same pattern recommended for `linkify` above.

---

## Auditing name links

`gbrain audit-name-links` is the **fourth and final step** in the producer
pipeline. It scans `[Display](people/Slug)` markdown links and
`[[people/Slug|Display]]` qualified wikilinks already in the file, validates
that Display is a legitimate canonical name for Slug, and emits diagnostics
for mismatches. It exists because LLM-mediated producers hallucinate names —
the slug is right but the display string drifts from any real name on the
person page, or the slug itself is wrong.

The audit reuses the same canonical-name rules linkify uses for its alias map
(`name`, first token, last token, every entry in `linkify_aliases`,
case-folded, apostrophe-variant-expanded). One validator, one source of
truth.

```
produce → stamp → linkify → extract-links → audit-name-links
```

### Mode 1 vs Mode 2

The audit distinguishes two failure modes:

- **Mode 1 — Misnamed link** (right target, wrong display). The producer
  writes `[Calvin Waytek](people/cwaytek-aseva)` for a section that is
  actually about Christopher Waytek. The slug is correct; the display string
  is hallucinated. Auto-fixable: rewrite the display string to the page's
  canonical `name`. Surfaces as the `name_mismatch` diagnostic kind.

- **Mode 2 — Misattributed link** (wrong target). The producer writes
  `[Leedy Allen](people/lallen-aseva)`, fusing two participants. The display
  matches no canonical person and the slug attributes the whole section to
  the wrong human. **Detective-only — never auto-fixed.** Surfaces as
  `unknown_target` (slug not in the brain) or, if the slug exists but no
  display can possibly match, `malformed_target` (the page is missing its
  `name:` frontmatter).

Mode 1 is mechanical: the slug is the producer's "vote" for who this is,
and the canonical name is the lookup answer. Substituting one for the other
is safe.

Mode 2 is a judgement call. The right slug is unknown — could be a typo,
could be a fused attribution, could be a name the LLM invented whole-cloth.
Auto-rewriting Display to match the wrong slug's canonical name would
silently make the section look correct while attributing it to the wrong
person. The audit refuses to guess and leaves Mode 2 for human review.
This is the same posture linkify takes for `ambiguous_unresolved` matches.

### CLI surface

```bash
# Single-file mode.
gbrain audit-name-links --path <file>

# Directory batch (mtime + filename prefix filter).
gbrain audit-name-links --dir <dir> --since <ISO8601> --filename-prefix <prefix>

# Whole-vault scan (no mtime or prefix filter). Required for migration runs.
gbrain audit-name-links --dir <dir> --all

# Auto-fix Mode 1 in place. Mode 2 is never touched.
gbrain audit-name-links --path <file> --fix-display-names

# Preview auto-fixes without writing.
gbrain audit-name-links --path <file> --fix-display-names --dry-run

# CI gate — exit 1 on Mode 1 or unknown_target (not on malformed_target).
gbrain audit-name-links --path <file> --strict

# ABI probe.
gbrain audit-name-links abi-version   # emits: 1

# Help.
gbrain audit-name-links --help
```

### Flag matrix

| Flag | Behavior |
|------|----------|
| `--path <file>` | Scan a single absolute file path. Mutually exclusive with `--dir`. |
| `--dir <dir>` | Scan a directory non-recursively. Requires `--since` + `--filename-prefix` (or `--all`). |
| `--since <ISO8601>` | With `--dir`: only files whose `mtime > since`. |
| `--filename-prefix <prefix>` | With `--dir`: only files whose basename starts with `prefix`. |
| `--all` | With `--dir`: shorthand for `--since 1970-01-01T00:00:00Z --filename-prefix ""`. Used by the migration runbook to sweep an entire vault. Mutually exclusive with explicit `--since` / `--filename-prefix`. |
| `--fix-display-names` | Rewrite Mode-1 (`name_mismatch`) display strings to the page's canonical name. Idempotent. Atomic write via temp-file + rename. Mode 2 is never touched. |
| `--dry-run` | With `--fix-display-names`: emit `display_fixed` diagnostics without writing the file. |
| `--strict` | Exit 1 if any `name_mismatch` or `unknown_target` diagnostic survives the (optional) fix pass. `malformed_target` is always informational and never trips `--strict`. |
| `--json-diagnostics` | One JSON object per diagnostic on stderr, plus a trailing `{"kind":"summary",...}` line. |
| `--verbose-diagnostics` | One human-readable line per diagnostic on stderr. |
| (default) | Counts-only summary line on stderr. |
| `abi-version` | Print `1\n`, exit 0. No engine required. |
| `--help` / `-h` | Print usage, exit 0. |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (clean or mismatches present — mismatches alone do not fail). |
| 1 | `--strict` failure: a `name_mismatch` or `unknown_target` survived the fix pass. |
| 2 | Usage error (bad flags, missing arguments). |
| 3 | Engine unavailable — gbrain cannot reach its database; retry later. |

The default is **detective-only**: mismatches accumulate in the log but
the pipeline keeps running. `--strict` opts in to a hard fail for CI gates
or post-merge checks.

### Diagnostic kinds

| Kind | Meaning |
|------|---------|
| `name_mismatch` | Mode 1. Slug is valid; Display is not in the canonical name set. Fixable with `--fix-display-names`. |
| `unknown_target` | Mode 2. Slug is not a known person page (deleted, never existed, or wrong type). Hand-fix. |
| `malformed_target` | Slug exists but the person page lacks a usable `name:` frontmatter field. Fix the person page, not the briefing. Never trips `--strict`. |
| `display_fixed` | `--fix-display-names` rewrote a Mode-1 display. Emitted both in dry-run and apply mode. |
| `concurrent_modification_skipped` | File's `mtime` changed between read and write; the audit refuses to clobber. Rerun later. |
| `icloud_placeholder_skipped` | iCloud Drive placeholder detected; the file is not materialized locally. |
| `enoent` | File disappeared between directory enumeration and read. |

### Diagnostic format

**Counts-only summary (default):**

```
audit-name-links: files=42 name_mismatch=3 unknown_target=1 malformed_target=0 display_fixed=0 dry_run=false
```

The summary line is always written, even when no mismatches were found.

**`--verbose-diagnostics`:**

```
[name_mismatch] /vault/Briefings/2026-05-11.md:113 [Calvin Waytek](people/cwaytek-aseva) — canonical: [christopher, christopher waytek, chris, waytek] [2x]
[unknown_target] /vault/Briefings/2026-05-11.md:240 [Leedy Allen](people/lallen-aseva) — slug not found [1x]
[display_fixed] /vault/Briefings/2026-05-11.md:113 people/cwaytek-aseva "Calvin Waytek" -> "Christopher Waytek" (markdown)
audit-name-links: files=1 name_mismatch=0 unknown_target=1 malformed_target=0 display_fixed=2 dry_run=false
```

The `[Nx]` suffix is the occurrence count after dedup by
`(file, slug, display)`.

**`--json-diagnostics`:**

```jsonl
{"kind":"name_mismatch","file":"/vault/Briefings/2026-05-11.md","line":113,"slug":"people/cwaytek-aseva","display":"Calvin Waytek","canonicalNames":["chris","christopher","christopher waytek","waytek"],"linkForm":"markdown","occurrences":2}
{"kind":"unknown_target","file":"/vault/Briefings/2026-05-11.md","line":240,"slug":"people/lallen-aseva","display":"Leedy Allen","canonicalNames":[],"linkForm":"markdown","occurrences":1}
{"kind":"display_fixed","file":"/vault/Briefings/2026-05-11.md","line":113,"slug":"people/cwaytek-aseva","oldDisplay":"Calvin Waytek","newDisplay":"Christopher Waytek","linkForm":"markdown"}
{"kind":"summary","filesProcessed":1,"nameMismatch":0,"unknownTarget":1,"malformedTarget":0,"displayFixed":2,"dryRun":false}
```

Diagnostic JSON fields use camelCase (`canonicalNames`, `linkForm`,
`oldDisplay`, `newDisplay`) for consistency with the rest of gbrain's
JSON outputs.

### Producer integration

Both runner shapes used by `linkify` and `extract-links` apply unchanged.
Add one extra step after extract-links.

**Shell (bash):**

```bash
gbrain audit-name-links --path "$BRIEFING_PATH" 2>>"$LOG"
case $? in
  0) ;;
  3) echo "[$(date)] audit-name-links: engine unavailable" >>"$LOG" ;;
  *) echo "[$(date)] audit-name-links: failed" >>"$LOG" ;;
esac
```

Add an ABI assertion at producer startup alongside the existing linkify and
extract-links checks:

```bash
AUDIT_ABI=$(gbrain audit-name-links abi-version 2>/dev/null) || AUDIT_ABI=0
if [ "$AUDIT_ABI" -lt 1 ]; then
  echo "gbrain audit-name-links ABI too old (got $AUDIT_ABI, need >= 1)" >&2
  exit 1
fi
```

**Node.js (`execFile`, no shell):**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

try {
  await execFilePromise('gbrain', ['audit-name-links', '--path', filePath]);
} catch (e: any) {
  if (e.code === 3) {
    // Engine unavailable — retry next run.
  } else {
    // Unexpected failure — log e.stderr.
  }
}
```

Producers that already iterate over a required-subcommand list at startup
(checking the ABI of each one) should add `'audit-name-links'` to the
list. Same shape as the existing checks for `frontmatter`, `linkify`, and
`extract-links`.

### Choosing a mode

| Situation | Recommended invocation |
|-----------|------------------------|
| Producer post-write step, default pipeline | `--path <file>` — detective-only, exit 0, log accumulates patterns. |
| CI gate on a vault PR | `--path <file> --strict` — exit 1 on Mode 1 or `unknown_target`. |
| Operator running scheduled vault sweep | `--dir <dir> --all --verbose-diagnostics 2>/tmp/audit.txt` — capture for review. |
| Operator applying a Mode-1 cleanup pass | `--dir <dir> --all --fix-display-names --dry-run` first, then drop `--dry-run`. |

### Migration runbook for an existing vault

If you are adding `audit-name-links` to a vault that has been accumulating
producer-mediated briefings for months, run the following procedure to
backfill the vault to a clean state. The end state: every
`[X](people/Y)` and `[[people/Y|X]]` has `X` in the canonical name set
for `Y`.

1. **Stop producers** (or pause the runner scripts) so no new files land
   during the migration. The audit's mtime-based filters tolerate concurrent
   writes, but a quiet vault makes step 7 (re-audit) deterministic.

2. **Snapshot the vault.** `git -C "$VAULT" status` to confirm a clean
   baseline. Stash or commit anything in-flight.

3. **Full-vault audit (read-only):**

   ```bash
   gbrain audit-name-links --verbose-diagnostics --dir "$VAULT/Briefings" --all \
     2>/tmp/audit-briefings.txt
   gbrain audit-name-links --verbose-diagnostics --dir "$VAULT/podcasts" --all \
     2>/tmp/audit-podcasts.txt
   # ... repeat per top-level dir that contains producer-mediated content.
   ```

   Inspect each output file. Counts at the bottom tell you how big each
   bucket is before you start.

4. **Categorize** the diagnostics by `kind`:

   - `name_mismatch` → candidates for `--fix-display-names` (step 6).
   - `unknown_target` → orphan link, likely a slug typo or deleted page.
     Hand-fix in step 5.
   - `malformed_target` → the person page itself lacks a `name:` frontmatter
     field. Fix the **person page**, not the briefing.

5. **Hand-fix Mode 2.** For each `unknown_target` or fused-attribution
   case, read the surrounding briefing text and decide the correct slug
   (or whether the link should be removed entirely). The audit cannot do
   this for you — see the Mode 1 vs Mode 2 section above for why.

6. **Preview then apply Mode 1 auto-fix:**

   ```bash
   # Dry-run first — emits display_fixed diagnostics, writes nothing.
   gbrain audit-name-links --fix-display-names --dry-run --dir "$VAULT/Briefings" --all \
     2>/tmp/proposed-display-fixes.txt

   # Review /tmp/proposed-display-fixes.txt. When ready:
   gbrain audit-name-links --fix-display-names --dir "$VAULT/Briefings" --all
   ```

   The fix is idempotent — re-running it on already-fixed files is a
   no-op. Atomic writes preserve mtime semantics so concurrent edits
   surface as `concurrent_modification_skipped` rather than silent
   clobber.

7. **Re-extract links for all changed files (mandatory).** `extract-links`
   stores the surrounding text snippet as the edge's `context` field. After
   `--fix-display-names` rewrites a display string, that stored `context`
   is stale until `extract-links` runs again. Skipping this step leaves
   outdated text in the graph.

   ```bash
   gbrain extract-links --dir "$VAULT/Briefings" --all
   ```

8. **Re-audit until clean:** loop steps 3–7 until `audit-name-links`
   reports zero `name_mismatch` and zero `unknown_target` events. Some
   `malformed_target` diagnostics may persist if the person pages they
   reference legitimately lack a `name:` field (e.g., stubs created for
   conference-room aliases); treat per case.

9. **Commit the vault diff** in logical chunks (per top-level directory)
   so a `git log` reads as readable history rather than one monolithic
   "audit pass" commit.

10. **Restart producers** with the audit step now wired into their
    post-write pipeline (see "Producer integration" above).

### Edge cases

- **Skip zones.** The audit masks frontmatter, fenced code blocks, and
  inline code before scanning — the same logic linkify uses. Code samples
  that contain `[Foo](people/bar)` examples are not flagged.

- **Bare wikilinks `[[people/Y]]`.** Skipped. Obsidian renders the slug
  tail unconditionally; there is no author-chosen display text to validate.

- **Display contains markdown formatting** (`[**Justin**](people/jthompson-aseva)`).
  The display captured is `**Justin**`, which does not match canonical
  `justin`. v1 emits `name_mismatch`; v1.x may strip formatting before
  compare. Hand-fix for now.

- **Cross-source slugs.** `queryPersonsForAudit` is brain-wide and includes
  every non-deleted person page regardless of `source_id`. A link like
  `[Alice](people/alice-fund-a)` validates whether `fund-a` is the default
  source or not.

- **`linkable: false` pages.** Excluded from linkify's alias map but
  **included** in the audit's canonical-name set. Explicit author-supplied
  links to opt-out pages should still validate; the opt-out is about
  auto-creation, not about author-chosen links.

- **iCloud Drive placeholders.** Skipped with
  `icloud_placeholder_skipped`, same as linkify. Materialize via Finder
  "Download Now" and rerun.
