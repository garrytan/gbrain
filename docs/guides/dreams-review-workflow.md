# Dreams Review Workflow

GBrain already has `gbrain dream`: the maintenance cycle that syncs, extracts,
synthesizes, embeds, and checks the brain. This guide describes a separate
agent-facing workflow for reviewable memory drafts.

The problem it solves is simple: useful context often appears as a side effect
of agent sessions, but raw transcripts are not safe memory. They contain tool
logs, local paths, temporary guesses, and sometimes sensitive content. The
review workflow keeps the convenience of ambient capture while preserving a
clear boundary between evidence and memory.

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
anchor, preservation mode, and reason. This is what prevents a valuable idea
from disappearing inside a generic summary of an operational session.

Use an `importance_score` to separate durable context from temporary state:
future retrieval value, durability, specificity, authorship or strategic value,
and fidelity sensitivity.

## Evidence Drilldown

Curated pages should remain the searchable answer. Reviewed drafts and archives
should remain evidence. When a future agent needs provenance, the preferred
path is:

```text
curated target slug -> source evidence refs -> review ledger row -> archived draft
```

In current GBrain, the durable primitives are curated page refs, page
provenance fields, and search result evidence. If a deployment adds a dedicated
source-evidence lookup, it should hydrate the same provenance chain without
making raw archives or inbox drafts part of semantic search.

## Optional Stop-Hook Recipe

`recipes/stop-memory-capture/` contains a small Bun hook script for agent
platforms that can invoke commands on `UserPromptSubmit`, `Stop`, and
`SubagentStop`.

The recipe writes:

- raw local evidence under `~/.gbrain/inbox/auto`;
- a redacted review draft under `~/brain/inbox/auto/YYYY-MM-DD`.

It does not write curated pages, run sync, commit, or push. `$dreams` or an
equivalent operator-approved review workflow is the promotion boundary.
