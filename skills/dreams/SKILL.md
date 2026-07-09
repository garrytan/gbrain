---
name: dreams
version: 1.0.0
description: |
  Review GBrain inbox drafts and stop-hook capture candidates before they enter
  curated memory. Use for "$dreams", "review brain inbox", "process auto
  captures", and "promote memory drafts".
triggers:
  - "$dreams"
  - "dreams"
  - "review brain inbox"
  - "process auto captures"
  - "promote memory drafts"
mutating: true
---

# Dreams Review Workflow

Use this skill to review `~/brain/inbox/**` drafts and turn durable, safe
material into curated memory without indexing raw transcripts or operational
logs.

This skill complements `gbrain dream`. The CLI `gbrain dream` runs the database
maintenance cycle. This skill is the agent-facing review workflow for markdown
drafts that need judgment before they become searchable memory.

## Data Boundary

Stop/UserPrompt hooks may write two different artifacts:

- raw local evidence under `~/.gbrain/inbox/auto`;
- a redacted review draft under `~/brain/inbox/auto/YYYY-MM-DD/*.md`.

Review the redacted draft. Do not import raw `~/.gbrain/inbox/**` evidence into
curated pages, the generated `gbrain` index, or normal semantic search. If raw
evidence exists without a matching review draft, report a capture-pipeline issue
instead of promoting from raw local state.

Only curated namespaces should become the searchable memory surface:
`people/`, `companies/`, `projects/`, `decisions/`, `gotchas/`, `concepts/`,
`meetings/`, and `originals/`.

`inbox/`, `archive/`, `raw/`, source snapshots, scripts, ledgers, and local
review state are evidence layers. Keep them out of normal import, sync, and
embedding flows unless the operator intentionally changes their schema.

## Defaults

- Default to review-first local changes.
- Commit only when the operator explicitly asks or the host workflow says so.
- Push only when the operator explicitly asks. The safe default is no push.
- Never force-push or delete evidence as part of this workflow.

## Contract

The workflow is a review boundary, not an ingestion daemon. It must produce a
complete accounting of every draft it touched, preserve source references for
material claims, and keep raw capture artifacts out of normal search.

Before any curated write, the agent must:

1. Read the full draft or copied source snapshot.
2. Classify every important unit of content.
3. Prepare proposed target edits and ledger rows.
4. Apply only the safe, reviewed subset.
5. Report skipped, duplicate, discarded, and blocked content explicitly.

## Classification Contract

Read the full draft or copied source snapshot before classifying it. Do not
classify a long capture from a summary alone.

For each draft, choose one preservation mode:

- `preserve-full`: original thinking or a decision where summarizing would lose
  value.
- `preserve-substantial`: mixed material where key reasoning should survive but
  status noise should be removed.
- `synthesize`: stable fact, decision, project context, or gotcha where concise
  compiled truth is enough.
- `source-note`: useful provenance but not enough for a searchable page.
- `discard`: low-value status, temporary progress, or vague operational noise.
- `duplicate`: already preserved at equal or better fidelity.
- `blocked-safety`: unsafe to promote or archive automatically.

Score each draft before deciding. Record an `importance_score` with:
future retrieval value, durability, specificity, authorship or strategic value,
and fidelity sensitivity.

Long or mixed drafts should be decomposed into `memory_units`. Each unit should
name the claim being evaluated, its source anchor, its preservation mode, its
score, and its target when it creates or updates curated memory. This is the
guardrail that prevents useful content from being flattened into one generic
summary or lost inside operational noise.

## Proposal And Ledger Contract

Before editing curated memory, write proposed final content for each target page
and a proposed review-ledger row. The row should make the decision auditable:

- source path plus content hash or stable source ref;
- decision and preservation mode;
- `importance_score`;
- `memory_units`;
- targets and target actions for curated edits;
- source excerpt summary;
- coverage notes describing represented and discarded content.

Rows that create or update curated memory should include a target timeline
entry with a stable source ref. The future evidence path should be:

```text
curated target slug -> source evidence refs -> review ledger row -> archived draft
```

When the host has a source-evidence lookup layer, make curated rows
discoverable through that layer. In current GBrain, source refs and search
result evidence are provenance aids; search result evidence is not permission
to index `inbox/` or `archive/` as memory.

## Apply Safely

1. Read local brain rules, schema, and target namespace README files.
2. Inventory `~/brain/inbox/**` directly from the filesystem.
3. Review full drafts or copied source snapshots.
4. Classify every draft and every important unit.
5. Write proposal artifacts first.
6. Apply safe curated edits.
7. Append review-ledger rows.
8. Archive handled drafts by copying reviewed source snapshots.
9. Sync curated pages only.
10. Run safety checks and report every draft as promoted, source-note,
    discarded, duplicate, or blocked-safety.

If one draft is unsafe, mark it `blocked-safety` and continue with the rest of
the batch. Do not stop the whole run because one item is bad.

## Stop-Hook Drafts

Stop-hook captures with a `session_id` should be reviewed by session. If a
review draft contains multiple capture segments, reconcile every segment in
order and make each segment auditable through `memory_units` or explicit
discard/duplicate/unsafe notes.

The optional recipe in `recipes/stop-memory-capture/` writes raw local evidence
and redacted review drafts for `UserPromptSubmit`, `Stop`, and `SubagentStop`.
It never promotes pages, runs sync, commits, or pushes.

## Anti-Patterns

- Importing raw transcripts, `~/.gbrain/inbox/**`, or `~/brain/archive/**` as
  normal memory.
- Treating a hook capture as automatically true, durable, or safe.
- Summarizing a long mixed draft without first decomposing it into
  `memory_units`.
- Pushing, force-pushing, deleting, or rewriting evidence as part of review.
- Hiding discarded or blocked content from the final accounting.

## Output Format

Return a concise review report:

```text
Dreams review complete

Reviewed:
- <draft path or session id>: <decision> -> <target or reason>

Promoted targets:
- <curated slug>: <create|update|append timeline>

Blocked or skipped:
- <draft path or session id>: <blocked-safety|duplicate|discarded> because <reason>

Verification:
- <checks run or explicit unverified risk>
```
