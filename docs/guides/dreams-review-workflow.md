# Dreams Review Workflow

GBrain already has `gbrain dream`: the maintenance cycle that syncs, extracts,
synthesizes, embeds, and checks the brain. The `$dreams` skill is a separate
agent-facing review workflow for markdown drafts that need judgment before they
become searchable memory.

The problem it solves is simple: useful context often appears as a side effect
of agent sessions, but raw transcripts are not safe memory. They contain tool
logs, local paths, temporary guesses, credentials, and sometimes sensitive
content. The review workflow keeps the convenience of ambient capture while
preserving a clear boundary between evidence and memory.

## Data Flow

```text
agent hook event
  -> raw local evidence in ~/.gbrain/inbox/auto
  -> redacted review draft in ~/brain/inbox/auto/YYYY-MM-DD
  -> Dreams review skill
  -> curated namespaces
  -> normal gbrain sync/embed
```

The raw file is local evidence. The redacted review draft is a queue item. The
curated namespaces are the searchable memory surface.

Do not import or embed `~/.gbrain/inbox/**`, `~/brain/inbox/**`, or
`~/brain/archive/**` as normal memory. Archives and ledgers are provenance.
They are useful when a future agent needs to explain where a curated memory
came from, but they are not the retrieval surface.

## Curated Namespaces

The review workflow assumes these curated namespaces are eligible for normal
search and embeddings:

- `people/`
- `companies/`
- `projects/`
- `decisions/`
- `gotchas/`
- `concepts/`
- `meetings/`
- `originals/`

Other folders are either workflow state, raw evidence, source snapshots, or
operator-specific repository structure.

## Default Run

A plain `$dreams` invocation is a full unattended review run inside the target
brain repo. It inventories drafts, reviews full sources, writes proposal
mirrors, applies safe curated edits, archives handled drafts, updates ledger and
evidence lookup state, syncs/embeds reviewed pages, stamps `indexed_at`, runs
retrieval smokes, commits, and pushes unless the operator requests a safer mode
such as `--dry-run`, `--no-sync`, `--no-commit`, or `--no-push`.

That default is intentionally stronger than a documentation-only suggestion.
It is the deterministic promotion boundary for reviewable draft candidates.

## Review Contract

Every reviewed draft should receive a concrete decision:

- `promoted`
- `low-confidence-promoted`
- `source-note`
- `discarded`
- `duplicate`
- `blocked-safety`

For long or mixed drafts, decompose the content into `memory_units` before
choosing the draft-level decision. Each unit should describe the claim, source
anchor, preservation mode, importance score, and reason. This is what prevents
a valuable idea from disappearing inside a generic summary of an operational
session.

Use an `importance_score` to separate durable context from temporary state:
future retrieval value, durability, specificity, authorship or strategic value,
and fidelity sensitivity.

## Proposal And Ledger Contract

Curated edits should be proposed before they are applied. A run that changes
curated memory should have full-file proposal mirrors under session state, not
only a review-ledger row. Ledger rows should bind every source path and hash to
the exact decision, memory units, target actions, coverage, archived path, and
target timeline source ref.

Stop-hook captures with a `session_id` should be reviewed by session. If a
session draft contains multiple capture segments, every `segment-N` must appear
in coverage and be backed by durable, duplicate, unsafe, or non-durable memory
units.

## Evidence Drilldown

Curated pages should remain the searchable answer. Reviewed drafts and archives
should remain evidence. When a future agent needs provenance, the preferred
path is:

```text
curated target slug -> source evidence refs -> review ledger row -> archived draft
```

When a deployment has a dedicated source-evidence lookup, reviewed rows should
be indexed by target slug and source ref so a future agent can hydrate
provenance without searching archive or inbox content. If the deployment only
has page provenance and search-result evidence, keep the same source refs in
the curated timeline and review ledger so a later evidence index can backfill
the chain.

## Temporal Metadata

Curated pages should distinguish:

- `formed_at`: when the source fact, idea, decision, or event happened;
- `recorded_at`: when the review run wrote the curated page;
- `indexed_at`: when the reviewed page was actually synced/embedded.

After stamping `indexed_at`, run sync/embed again so the timestamp itself is
searchable.

## Optional Stop-Hook Recipe

`recipes/stop-memory-capture/` contains a small Bun hook script for agent
platforms that can invoke commands on `UserPromptSubmit`, `Stop`, and
`SubagentStop`.

The recipe writes:

- raw local evidence under `~/.gbrain/inbox/auto`;
- a redacted review draft under `~/brain/inbox/auto/YYYY-MM-DD`.

It writes files with owner-only permissions. Its redaction is a first-pass
guard, not a proof that a draft is safe to promote. It does not write curated
pages, run sync, commit, or push. `$dreams` or an equivalent
operator-approved review workflow is the promotion boundary.
