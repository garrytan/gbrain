# GBrain Doctor and project-dirty remediation — 2026-07-04

This note records the verified closeout state for the HANILSERVER GBrain remediation that reduced the operational Doctor backlog and separated committed code indexing from remote working-tree WIP.

## Scope

- Host: `HANILSERVER`
- GBrain version observed: `0.42.53.0`
- Primary repo: `C:/Users/HANILSERVER/gbrain`
- Project sources reviewed:
  - `code-yolo`
  - `code-trade-hanil8`
  - `code-codex-memories`
  - `code-hermes-fleet-knowledge`
  - `code-codex-memories-ip7`

## Final operational evidence

| Surface | Result | Evidence |
| --- | --- | --- |
| Qwen embedding endpoint | OK | `/health=200`, `/v1/models=200`, `/v1/embeddings=200`, dimension `1024`, model `text-embedding-qwen3-embedding-0.6b` |
| Live embed processes | OK | No live `gbrain.exe` / `bun.exe` process with `embed --stale` after finalizer exit |
| Sync failures | OK | `unacknowledged_failures=0` |
| Embedding backlog | OK | Whole-brain `chunks_unembedded` sum `0` |
| Queue | OK | `active=0`, `waiting=0`, `failed=0`, `dead=0`, `completed=85` at closeout |
| `code-hermes-fleet-knowledge` | OK | `last_commit=9ccb4ff0d783eaff3dd8a059935c27515b55e0bc`, `chunks_unembedded=0`, coverage `100%`, `fresh` |
| `code-codex-memories-ip7` | OK | `last_commit=a025a6e6710f55464ddc23c9ac6e322ed4ba0305`, `chunks_unembedded=0`, coverage `100%`, `fresh` |
| `code-codex-memories` | OK | `last_commit=6312540ea299c8db47e5f2be7ec899e0751fefd1`, `chunks_unembedded=0`, coverage `100%`, `fresh` |
| `code-yolo` | OK | `last_commit=f87efbe941c87c0a151647417e493d16d59d7bdc`, `chunks_unembedded=0`, coverage `100%`, `fresh` |
| `code-trade-hanil8` | OK | Re-pinned to committed head `f70586285bef6f0ebb57e1b5700a116ac8a184fe`, `chunks_unembedded=0`, coverage `100%`, `fresh` |

## Doctor status after remediation

Full local Doctor still reported `status=warnings`, `health_score=55`, `brain_checks_score=55`. These remaining warnings were classified as content-quality or opt-in policy warnings, not operational blockers:

- `conversation_format_coverage`
- `brain_score`
- `oversized_pages`
- `content_sanity_audit_recent`
- `flagged_pages`
- `frontmatter_integrity`
- `entity_link_coverage`
- `timeline_coverage`
- `takes_count`

Operational blockers that were cleared or verified healthy:

- sync failure backlog
- embedding backlog
- source freshness for the targeted sources
- stale source embeddings after cycle/fanout work
- queue active/waiting/failed/dead health
- Qwen embedding endpoint health

## Project-dirty interpretation

GBrain code-source sync indexes committed Git state only. Remote working-tree WIP must be treated as long-term project memory, not as committed code-index content.

At closeout, the following WIP snapshots were captured as GBrain current-state notes under the default source:

| Project | Captured committed head | Remote dirty count | Meaning |
| --- | --- | ---: | --- |
| `code-yolo` | `f87efbe941c87c0a151647417e493d16d59d7bdc` | `4` | GBrain code index is fresh for committed HEAD; remote uncommitted paths remain operator-review WIP |
| `code-trade-hanil8` | `f70586285bef6f0ebb57e1b5700a116ac8a184fe` | `1` | GBrain code index is fresh for committed HEAD; remote `AGENTS.md` WIP remains outside committed index |

Do not report a dirty remote working tree as a GBrain code-index failure unless the committed source HEAD and GBrain `sources.last_commit` diverge or stale embeddings remain.

## Commands that proved/fixed the state

Use a clean environment so stale shell credentials or Python paths do not override the live GBrain configuration:

```bash
cd 'C:/Users/HANILSERVER/gbrain'

# Clear inherited DB/Python overrides in the shell or wrapper before every command.
unset GBRAIN_DATABASE_URL DATABASE_URL PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGPASSFILE
export PYTHONPATH= PYTHONHOME= VIRTUAL_ENV=
export GBRAIN_EMBED_CONCURRENCY=1
export GBRAIN_AI_EMBED_TIMEOUT_MS=300000
```

For source re-pin after a committed project HEAD moved:

```bash
gbrain sync \
  --source code-trade-hanil8 \
  --repo 'C:/Users/HANILSERVER/.gbrain/clones/code/trade-hanil8' \
  --no-pull --full --workers 1 --yes --json \
  --strategy code --no-embed --no-extract

gbrain embed --stale --source code-trade-hanil8 --batch-size 4 --catch-up
gbrain embed --stale --source code-trade-hanil8 --batch-size 4 --dry-run
gbrain extract --stale --json
gbrain status --json
gbrain doctor --json
```

Expected source completion criteria:

- `sources.last_commit == git -C <source repo> rev-parse HEAD`
- `staleness_class == fresh`
- `chunks_unembedded == 0`
- post-source dry-run says `Would embed 0 chunks (0 stale found)`
- no live `gbrain.exe` / `bun.exe` process still running `embed --stale`

## Operational pitfalls from this run

- Foreground terminal timeouts can leave a descendant `gbrain embed --stale` process alive. Do not start a competing catch-up until process command lines and source-scoped stale dry-runs prove the previous one is done.
- For large source catch-ups, prefer a background finalizer that watches the original PID, polls dry-run stale counts, runs a remainder catch-up only after the original exits, then runs `extract --stale`, `status`, and `doctor`.
- On Windows/Git Bash, `git status --short` can show many phantom `M` rows while `git diff --name-only` is empty. Do not bulk commit those. Stage only explicit intended paths.
- `takes_count` remains an opt-in warning while `takes.bootstrap_enabled=false`; do not enable it as part of an unrelated operational landing.
- `frontmatter_integrity` can time out on very large sources. Fix only inspected, source-owned frontmatter issues; avoid broad `--fix` over SkillHub or generated corpora without a separate review.

## Follow-up if this regresses

1. Re-run `gbrain status --json` and check `unacknowledged_failures`, `chunks_unembedded`, per-source `last_commit`, and queue counts.
2. For a dirty project, compare three lanes separately:
   - remote working tree status,
   - server mirror committed HEAD,
   - GBrain `sources.last_commit` and embedding coverage.
3. If only remote WIP exists, refresh the project current-state note and do not call it a code-index failure.
4. If committed HEAD changed, re-run source-scoped sync with `--strategy code`, then source-scoped embed catch-up and extract.
5. Rerun Doctor and classify remaining warnings as operational blockers vs content-quality warnings.
