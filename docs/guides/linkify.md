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
| `ambiguous_unresolved` | Multi-candidate match, no tiebreaker available; mention left unlinked. |
| `auto_stub_excluded_total` | Startup count: how many auto-stub pages were excluded from the candidate index. |
| `stopword_dropped_all_keys` | A person page's name reduced entirely to stopwords; page excluded from index. |
| `malformed_frontmatter` | A person page has a non-string `name` or non-string entries in `linkify_aliases`; page excluded. |
| `concurrent_modification_skipped` | File's mtime changed between read and write; file skipped to avoid clobbering concurrent changes. |
| `icloud_placeholder_skipped` | iCloud Drive placeholder detected; file not materialized locally, skipped. |
| `enoent` | File disappeared between directory enumeration and read; skipped. |

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
