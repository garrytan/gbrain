# System of record

**The GitHub repo (markdown + frontmatter) is the system of record.
The Postgres/PGLite database is a derived cache. We do not back up
the database — we rebuild it from the repo.**

This document is the canonical reference for that contract. Every code
path that writes user-knowledge state should match the pattern
described here. The CI gate at `scripts/check-system-of-record.sh`
enforces it programmatically.

## Why this matters

The DB is a derived index over the markdown content. It exists to make
search fast, to dedup embedding-similar claims, and to materialize the
cross-page graph. Source-backed knowledge is recoverable from clean,
versioned markdown, but recovery is a phased reconciliation: importing pages
alone does not prove facts, takes, links, timeline, embeddings, or reader
readiness.

This means:

- **Disaster recovery is a disposable-target drill.** If a DB volume
  corrupts, rebuild into an isolated target, reconcile every FS-canonical
  category, converge retrieval state, and compare strict snapshots before
  any separately authorized cutover. This head intentionally has no
  destructive `gbrain rebuild` one-liner.
- **Multi-machine sync is git.** Your brain is a repo. Push from one
  machine, pull from another, and the second machine's DB rebuilds on
  its next sync. No "back up the database" step.
- **Privacy is in your hands.** Sensitive entity pages can be
  gitignored (via `gbrain.yml` `db_only` paths or per-page) and they
  stay on disk but not in git. The fence respects whatever git
  tracking choice you make at the page level.
- **Cross-agent collaboration is possible.** Multiple agents can write
  to the same brain because the fence is the merge point, not the DB.
  Git handles concurrent edits the way git handles concurrent edits.

## The three categories

Every table in the gbrain schema belongs to exactly one of three
categories. The category determines how it gets rebuilt during
disaster recovery.

### FS-canonical (markdown is the source of truth)

These are user-authored knowledge. The DB row is a derived index over
the markdown — wipe the table and `gbrain extract` rebuilds it
identically. The CI gate keeps direct DB writes from drifting away
from the markdown contract.

| Category | How it's stored in markdown | Derived DB table | Reconciler |
|---|---|---|---|
| **Takes** (incl. hunches, bets) | `## Takes` fenced table between `<!--- gbrain:takes:begin -->` / `:end -->` markers | `takes` | `extract takes` |
| **Facts** | `## Facts` fenced table between `<!--- gbrain:facts:begin -->` / `:end -->` markers | `facts` | `extract_facts` cycle phase |
| **Links** | Inline `[text](slug)` / `[[slug]]` in markdown body + frontmatter `direction: incoming` | `links` | `extract links` |
| **Timeline** | `## Timeline` section after `<!-- timeline -->` sentinel | `timeline_entries` | `extract timeline` |
| **Tags** | Frontmatter `tags:` YAML array | `tags` | `importFromFile` (reconciles per-page on import) |
| **emotional_weight** | Recomputed from takes + tags | `pages.emotional_weight` (signal column) | `recompute_emotional_weight` cycle phase |
| **synthesis_evidence** | FK into `takes` rows (`slug#N`) inside synthesis pages | `synthesis_evidence` | `extract takes` (transitively) |

### Derived from FS but not user-authored

These hold derived state that's automatically reconstructible from the
markdown but not directly authored as markdown by the user. The
chunker + embedder rebuild these on import.

| Table | Source | Notes |
|---|---|---|
| `pages` | The markdown file as a whole | One row per file; `compiled_truth` + `frontmatter` come from parse |
| `content_chunks` | `pages.compiled_truth` after chunker strip | Re-chunked on content_hash change; embedded via configured model |
| `page_versions` | Each `pages` UPDATE | Audit history; rebuildable in principle but not in practice |

### DB-only by design (named exceptions)

These hold runtime / infrastructure state that's intentionally not in
the repo. The architectural rule still holds — these aren't
"user knowledge" — but they're DB-only by design.

| Category | Why it's OK to be DB-only |
|---|---|
| `raw_data` | Webhook/transcript sidecars; not user-authored knowledge. |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | Runtime job state. Replay-only, not persistent knowledge. |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | Credentials. Not in source control by definition. |
| `mcp_request_log` | Audit trail. Volatile by design. |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | Job queue. Restarts re-enqueue or drop. |
| `eval_candidates` / `eval_capture_failures` | Contributor-mode dev loop; opt-in capture. |
| `dream_verdicts` | Cheap verdict cache. Rebuildable by re-running Haiku. |
| `gbrain_cycle_locks` / migration ledger | Infrastructure. |
| `config` (some keys) | Site-local routing config (e.g. `sync.repo_path`). |

A new derived table that holds user-knowledge MUST land FS-first.
If you're tempted to add one as "DB-only for now," the structural
question is: does it belong in this DB-only-by-design list? If not,
it's FS-canonical and needs a fence (or frontmatter field) plus a
reconciler.

## The privacy boundary

Private knowledge in a fence still lives in the markdown file. If the
user commits the page to git, the private data lands in git too. This
is the existing operational model — we don't infer git policy.

For untrusted readers (remote MCP, subagent), the v0.32.2 release ships
a 3-layer strip:

1. **Layer A (chunker):** `src/core/chunkers/recursive.ts` calls
   `stripFactsFence({keepVisibility: ['world']})` + `stripTakesFence`
   before chunking. Private fact text never reaches
   `content_chunks.chunk_text`, embeddings, or search results.
2. **Layer B (get_page):** when `ctx.remote === true`, the response
   body has both fences stripped (private rows from facts; entire
   takes fence). Local CLI (`ctx.remote === false`) sees the full
   fence.
3. **Layer C (git tracking):** the user decides whether to commit the
   entity page. `gbrain.yml` `db_only` paths are gitignored
   automatically; per-page choices via the user's normal git workflow.

For universally-private entities (a friend's name, an investor's
internal notes), mark the entity page's directory as `db_only` in
`gbrain.yml`. The file stays on disk but never lands in git.

## The forget contract

`gbrain forget <id>` and the MCP `forget_fact` op rewrite the fence
row with strikethrough + `valid_until = today` + `context: "forgotten:
<reason>"`. The DB's `expired_at = valid_until + now()` derivation
reconstructs the forget state on every rebuild because the fence is
canonical.

Strikethrough has two semantics distinguished by context:

- `~~claim~~` + `context: "superseded by #N"` → row was replaced by
  a newer row in the same fence
- `~~claim~~` + `context: "forgotten: <reason>"` → row was retracted
  via the forget op

Both encodings keep the row in the markdown for audit history. To
permanently delete a fact, edit the fence directly in markdown and
remove the row. The next `extract_facts` cycle wipes the DB row.

## Disaster recovery

Recovery at this head is deliberately not a destructive command and not raw
SQL. The supported sequence uses an isolated GBrain home and a dedicated
disposable target, registers the clean markdown source, syncs pages, reconciles
links/timeline and facts/takes, converges embedding/backfill state, and then
compares strict `gbrain recovery snapshot --brain <id> --source <id> --json`
artifacts. The target stays isolated until disposable CLI/MCP reader checks and
an independently authorized cutover.

`recovery snapshot` is all-or-nothing and read-only. It reports FS-canonical
knowledge separately from runtime DB-only categories, binds schema/pack/source
and retrieval identities, and refuses stale schema or incomplete reads. It is
not the tolerant operational `status` command and does not repair anything.

See [`docs/guides/rebuild-from-markdown.md`](../guides/rebuild-from-markdown.md)
for the exact phased runbook and its veto conditions. `gbrain migrate`,
`export --restore-only`, direct SQL, and a nonexistent `gbrain rebuild` are not
recovery inputs.

The invariant E2E test at `test/e2e/system-of-record-invariant.test.ts`
continues to prove the FS-canonical category contract. The recovery snapshot
parity tests separately prove strict PGLite/Postgres snapshot behavior.

## Rule for new code

When you add a new user-knowledge category:

1. **Define the markdown shape.** Fence (`<!--- gbrain:NAME:begin
   --> ... :end -->` table) or frontmatter field.
2. **Build a parser** that produces structured data from markdown.
   See `src/core/fence-shared.ts` for the shared primitives.
3. **Build a writer** that round-trips: parse + edit + render produces
   byte-identical markdown for identical input.
4. **Add the engine method** that takes parsed data and stamps a
   derived table. The method gets an entry in the CI gate's
   banned-direct-call list.
5. **Add a reconciler:** a cycle phase that walks pages, parses the
   fence, and rebuilds the derived table from scratch. The reconciler
   is the only legitimate call site for the engine method;
   `// gbrain-allow-direct-insert: <reason>` annotates it explicitly.
6. **Add a round-trip test** in `test/e2e/system-of-record-invariant.test.ts`
   that proves DELETE + reconcile rebuilds the table byte-identically.

The CI gate at `scripts/check-system-of-record.sh` fails any PR that
adds a new direct call to a derived-table writer outside the
reconciler / migration layer without the explicit allow-list comment.

## Related

- `~/.claude/plans/system-instruction-you-are-working-expressive-pony.md`
  — the v0.32.2 design plan (decisions D1-D22 + Q1-Q8, Codex round 1
  and round 2 finds)
- `skills/migrations/v0.32.2.md` — the agent-facing migration guide
- `CHANGELOG.md` v0.32.2 entry — the release manifesto
- `scripts/check-system-of-record.sh` — the CI gate that enforces
  the rule
