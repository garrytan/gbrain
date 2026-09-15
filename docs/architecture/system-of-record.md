# System of record

**Canonical Markdown and frontmatter are the system of record for file-backed
knowledge. Their database indexes can be rebuilt from those files. DB-only
knowledge and operational state still need a separate backup.**

This document is the canonical reference for that contract. Every code
path that writes user-knowledge state should match the pattern
described here. The CI gate at `scripts/check-system-of-record.sh`
enforces it programmatically.

## Why this matters

The DB is a derived index over the markdown content. It exists to make
search fast, to dedup embedding-similar claims, to materialize the
cross-page graph. `gbrain sync && gbrain extract all` rebuilds the indexes
represented by intact Markdown; it does not recover DB-only knowledge,
credentials, or page revision history.

This means:

- **Disaster recovery is a short, boring sequence.** If your DB volume
  corrupts, if Postgres eats itself, if PGLite's WASM lock wedges — you
  first verify your backups and which state exists only in the database.
  After preserving that state, you can wipe derived tables (on PGLite,
  `gbrain reinit-pglite` wipes the whole embedded DB), re-import from
  your brain repo with `gbrain sync`, and `gbrain extract all`
  regenerates the derived state. See "Disaster recovery" below for the
  exact commands.
- **Multi-machine sync is git.** Your brain is a repo. Push from one
  machine, pull from another, and the second machine's DB rebuilds on
  its next sync. This does not transfer DB-only state or gitignored files.
- **Privacy is in your hands.** Sensitive entity pages can be
  gitignored (via `gbrain.yml` `db_only` paths or per-page) and they
  stay on disk but not in git. The fence respects whatever git
  tracking choice you make at the page level.
- **Cross-agent collaboration is possible.** Multiple agents can write
  to the same brain because the fence is the merge point, not the DB.
  Git handles concurrent edits the way git handles concurrent edits.

## The three categories

Use these categories to distinguish reconstructible file-backed records
from state that needs a database backup. A table can contain both: the
facts table, for example, also holds unresolved facts without a fence.

### FS-canonical (markdown is the source of truth)

For knowledge preserved in canonical files, the DB row is a derived index
over the Markdown. Reconciliation rebuilds the represented fields; it does
not promise identical database rows or recover records absent from the files.
The CI gate constrains direct DB writes to the documented paths.

| Category | How it's stored in markdown | Derived DB table | Reconciler |
|---|---|---|---|
| **Takes** (incl. hunches, bets) | `## Takes` fenced table between `<!--- gbrain:takes:begin -->` / `:end -->` markers | `takes` | `extract takes` |
| **Facts** | `## Facts` fenced table between `<!--- gbrain:facts:begin -->` / `:end -->` markers | `facts` | `extract_facts` cycle phase |
| **Links** | Inline `[text](slug)` / `[[slug]]` in markdown body + frontmatter `direction: incoming` | `links` | `extract links` |
| **Timeline** | Dated markers anywhere in the page body — compiled truth AND the `## Timeline` section: `- **YYYY-MM-DD** \| Source — Summary` bullets, `### YYYY-MM-DD — Title` headers (FS extract), and inline `[Source: <text>, YYYY-MM-DD]` citations (one row per citation, dated by the citation, summary = the bullet/paragraph it sits in). The `<!-- timeline -->` sentinel only splits compiled_truth from timeline for storage; it does not scope extraction | `timeline_entries` | `extract timeline` + `put_page`'s `auto_timeline` |
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

These hold runtime or infrastructure state intentionally kept outside the
repo. This list does not cover every DB-only record: pages and facts can
also contain knowledge absent from canonical files and must be backed up.

| Category | Why it's OK to be DB-only |
|---|---|
| `raw_data` | Webhook/transcript sidecars; not user-authored knowledge. |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | Runtime job state. Replay-only, not persistent knowledge. |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | Credentials. Not in source control by definition. |
| `mcp_request_log` | Audit trail. Volatile by design. |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | Job queue. Restarts re-enqueue or drop. |
| `eval_candidates` / `eval_capture_failures` | Contributor-mode dev loop; opt-in capture. |
| `dream_verdicts` | Scored triage cache (salience score, quotes, entities, judging model + prompt version). Rows carry a 30-day `expires_at` TTL: reads treat expired rows as misses and the synthesize phase sweeps them, so nothing lives forever. Rebuildable via `gbrain dream retriage --force`. |
| `gbrain_cycle_locks` / migration ledger | Infrastructure. |
| `op_checkpoint_paths` | Sync-resume checkpoint. Append-only progress banking; a completed sync makes it irrelevant. |
| `config` (some keys) | Site-local routing config (e.g. `sync.repo_path`). |

A new derived table that holds user-knowledge MUST land FS-first.
If you're tempted to add one as "DB-only for now," the structural
question is: does it belong in this DB-only-by-design list? If not,
it's FS-canonical and needs a fence (or frontmatter field) plus a
reconciler.

## Page-write persistence boundary

For a file-backed `put_page`, the root worktree lock is acquired before importing
the revision. If that acquisition times out, `storage_busy` means the write was
not applied and was not queued. Canonical Markdown is staged with fsync and
renamed inside the import's database transaction, after required source-path
bookkeeping. Ordinary filesystem rejection rolls back the imported page, tags,
chunks, and version snapshot.

This is not a distributed transaction between the filesystem and database. A
crash or database COMMIT failure after rename can leave the Markdown ahead of
the index. It is also not a durable write queue or a caller-supplied revision
precondition. The page operation releases its own worktree lock before optional
embedding, so a slow provider does not block other writes to the same worktree.
Embedding is page-scoped, rejects superseded page/chunk generations, and reports
failure separately without undoing a saved page or exposing provider exception
text. A lock owned by a surrounding caller remains that caller's responsibility.

The rebuild contract above applies only to knowledge actually preserved in
canonical files. DB-only pages, unresolved facts not written to a fence, audit
history, and site-local credentials are not recoverable from Markdown alone.
Keep an appropriate database backup before any destructive recovery, and do
not delete historical unmatched facts or generate empty pages to make them
appear file-backed.

## The privacy boundary

Private knowledge in a fence still lives in the markdown file. If the
user commits the page to git, the private data lands in git too. This
is the existing operational model — we don't infer git policy.

For untrusted readers (remote MCP, subagent), gbrain applies a 3-layer
strip:

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

This example is only for a database whose affected facts, takes, links and
timeline entries have been verified to exist in canonical files. Before running
the destructive commands, stop writers and verify a restorable database backup
plus source-file backups. Do not use this recipe on unresolved DB-only facts or
assume a repository backup covers gitignored files.

```bash
# File-backed state only: verify restorable DB + source backups before proceeding.
# Record counts for comparison; this is not a backup.
gbrain stats > /tmp/before.txt

# Wipe and rebuild — delete the derived tables (pages + content_chunks
# survive the CASCADE-safe design), then re-derive from the repo.
# On PGLite, `gbrain reinit-pglite` wipes the whole embedded DB instead.
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
gbrain sync
gbrain extract all

# Compare file-backed counts and investigate differences; full DB parity is not promised.
gbrain stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

The invariant E2E test at `test/e2e/system-of-record-invariant.test.ts`
proves reconstruction of its file-backed facts/takes fixture. It does not prove
recovery of DB-only knowledge, operational state, or every production database.

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

- `skills/migrations/v0.32.2.md` — the agent-facing migration guide
- `CHANGELOG.md` — release history
- `scripts/check-system-of-record.sh` — the CI gate that enforces
  the rule
