# Progress events

Canonical reference for the JSONL progress stream that `gbrain` writes to
`stderr` when a bulk command runs with `--progress-json`. Stable from
v0.15.2. Additive changes only; no renames or removals without a major
version bump.

Most humans won't read this page. Agents parsing progress will.

## When do I get these events?

Any of these commands stream events when `--progress-json` is set:

- `gbrain doctor` (DB checks, JSONB integrity, markdown body completeness,
  integrity sample)
- `gbrain orphans`
- `gbrain embed`
- `gbrain files sync`
- `gbrain export`
- `gbrain extract [links|timeline|all]` (fs or db source)
- `gbrain import`
- `gbrain sync`
- `gbrain migrate --to …`
- `gbrain repair-jsonb`
- `gbrain check-backlinks`
- `gbrain lint`
- `gbrain integrity auto`
- `gbrain eval`
- `gbrain apply-migrations` (the orchestrator + every child command)

Non-bulk commands (`stats`, `graph-query`, `get`, `put`, etc.) don't emit
events — they return in under a second.

## Channel

- Progress events: **`stderr`**, one JSON object per line, `\n`-terminated.
- Data results (`--json` payloads from each command): **`stdout`**.
- Final human summaries: **`stdout`**.

Agents can safely capture stdout for their result parsing and read stderr
separately for progress.

## Flags

| Flag | Behavior |
|---|---|
| *(none)* | Auto. TTY: `\r`-rewriting single line. Non-TTY: plain line-per-event on stderr. |
| `--progress-json` | Force JSON-lines mode on stderr (this doc). |
| `--quiet` | Suppress progress entirely. Warnings and final output still print. |
| `--progress-interval=<ms>` | Override the minimum interval between tick emits (default 1000). |

Global flags: parsed by `src/core/cli-options.ts` before command dispatch,
so `gbrain --progress-json doctor` works the same as
`gbrain doctor --progress-json` (the latter also works — per-command
parsers see the flag via the shared `CliOptions` singleton).

## Event types

Every event is a single-line JSON object with these common fields:

| Field | Type | Notes |
|---|---|---|
| `event` | string | One of: `start`, `tick`, `heartbeat`, `finish`, `abort`. |
| `phase` | string | Machine-stable snake_case, dot-separated. See "Phase names" below. |
| `ts` | ISO 8601 UTC string | Event emission time. |
| `elapsed_ms` | number | Ms since the phase started. Present on `tick`/`heartbeat`/`finish`/`abort`. |

### `start`

Emitted when a phase begins.

```json
{"event":"start","phase":"doctor.db_checks","ts":"2026-04-20T12:34:56.789Z"}
{"event":"start","phase":"import.files","total":52000,"ts":"2026-04-20T12:34:56.789Z"}
```

Optional fields:

- `total` — the total item count if known at start.

### `tick`

Emitted periodically during iteration. Time- and item-gated: the reporter
won't emit more often than `minIntervalMs` (default 1000) and
`minItems` (default `max(10, ceil(total/100))`).

```json
{"event":"tick","phase":"orphans.scan","done":15000,"total":52000,"pct":28.8,"elapsed_ms":4200,"eta_ms":10300,"ts":"..."}
```

Fields:

- `done` — items completed in this phase.
- `total` — total items, if known. Omitted when the scan doesn't have a
  total up front (e.g. a streaming iterator).
- `pct` — `done/total * 100`, one decimal. Omitted when `total` is unknown.
- `eta_ms` — projected ms until `done === total`, from the observed rate.
  Omitted when `total` is unknown.
- `note` — optional string with the current item (e.g. a slug or filename).

### `heartbeat`

Emitted for long-running single operations that don't iterate
(e.g. `SELECT` against a 50K-row table). No `done`, no `total` — just a
signal that work is still happening.

```json
{"event":"heartbeat","phase":"doctor.markdown_body_completeness","note":"scanning pages for truncation…","elapsed_ms":1000,"ts":"..."}
```

### `finish`

Emitted when a phase completes normally.

```json
{"event":"finish","phase":"import.files","done":52000,"total":52000,"elapsed_ms":187000,"ts":"..."}
```

### `abort`

Emitted by a single process-level SIGINT/SIGTERM handler that tracks every
live phase. After `abort`, no further events emit for that phase.

```json
{"event":"abort","phase":"doctor.markdown_body_completeness","reason":"SIGINT","elapsed_ms":5300,"ts":"..."}
```

## Phase names

Phases use `snake_case.dot.path` naming. A fresh reporter starts at the
root; `child()` composition appends to the parent's current phase, so a
sync that calls import emits `sync.import.<file>`, not `import.<file>`.

Stable phase names shipped in v0.15.2:

- `doctor.db_checks` (umbrella for all DB-side doctor checks)
- `orphans.scan`
- `embed.pages`
- `extract.links_fs`, `extract.timeline_fs`, `extract.links_db`, `extract.timeline_db`
- `import.files`
- `sync.deletes`, `sync.renames`, `sync.imports`
- `migrate.copy_pages`, `migrate.copy_links`
- `repair_jsonb.run`, `repair_jsonb.<table>.<column>`
- `backlinks.scan`
- `lint.pages`
- `integrity.auto`
- `eval.single`, `eval.ab`
- `export.pages`
- `files.sync`

Sub-phases exposed via `child()`:

- `sync.import.files` — nested inside a sync
- `apply_migrations.v0_12_2.jsonb_repair` — nested inside the orchestrator

## Subprocess inheritance

When a parent CLI spawns `gbrain …` child processes (mostly in
`src/commands/migrations/*`), global flags (`--quiet`, `--progress-json`,
`--progress-interval`) are propagated to the child's argv via the
`childGlobalFlags()` helper in `src/core/cli-options.ts`. Child stderr
passes straight through `stdio: 'inherit'` so the event stream is one
merged JSONL feed on the parent's stderr.

One exception: the orchestrator phase in `migrations/v0_12_2.ts` that
captures child stdout (`repair-jsonb --dry-run --json` for verification)
does not pass `--progress-json` to avoid any risk of stdout pollution
breaking the orchestrator's `JSON.parse`. Its stdio is explicit:
`['ignore', 'pipe', 'inherit']` so stderr still flows through.

## Minion jobs

`gbrain jobs work` (the Minion worker daemon) keeps progress in the DB,
not on stderr. Each Minion handler that runs a bulk core (embed, sync,
extract, import, backlinks) calls `job.updateProgress({done, total,
…})` per iteration. Agents read per-job progress via the
`get_job_progress` MCP operation or `gbrain jobs get <id>`.

The `jobs work` daemon itself emits coarse one-line-per-job stderr output
for liveness only. Per-page detail lives in the DB.

## Compatibility

- **Added**: only. A new event type, a new field, a new phase name — all
  safe. Agents must ignore unknown fields and unknown event types.
- **Removed/renamed**: never without a major version bump.
- **Schema changes**: announced in `CHANGELOG.md` and in
  `skills/migrations/v<next>.md`.

If your agent depends on this schema and something surprises you, open
an issue with the event you received and what you expected.
