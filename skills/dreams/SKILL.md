---
name: dreams
description: "Use only when the operator explicitly invokes literal '$dreams' or gives an equally explicit full-run Dreams approval. This runs the Dreams memory cycle: review, consolidate, promote, archive, sync, commit, and push ~/brain/inbox memory drafts, especially stop-hook auto captures under ~/brain/inbox/auto. A plain '$dreams' invocation is an unattended full-run approval for ~/brain only: inventory, classify, dedupe, resolve conflicts by policy, promote safe durable facts into curated pages, archive handled drafts, run redaction/gitleaks checks, sync gbrain, commit, and push. Non-literal mentions such as review-brain requests do not authorize mutation; require literal '$dreams' or run a non-mutating dry-run/no-commit/no-push review if explicitly requested. Never ask the user mid-run after literal '$dreams'; make the conservative autonomous decision instead."
---

# Dreams

Autonomously review `~/brain/inbox` drafts and turn useful material into clean long-term memory without polluting curated pages.

The only supported invocation is `$dreams`.

`~/brain` is source of truth. `gbrain` is only the generated index. `inbox/auto` is filesystem evidence, not authority. Fresh auto-drafts are not assumed to be searchable until this skill runs the controlled sync step.

Raw capture and draft review are separate stages. Stop/UserPrompt hooks own the
raw-to-draft intake path: they write raw local evidence under
`~/.gbrain/inbox/auto` and a redacted review candidate under
`~/brain/inbox/auto/YYYY-MM-DD/*.md`. `$dreams` inventories and reviews the
redacted `~/brain/inbox/**` draft candidates. It must not import raw
`~/.gbrain/inbox/**` files directly into curated memory or the generated
`gbrain` index. If raw evidence exists without a matching redacted candidate,
record that as a capture-pipeline issue instead of promoting from raw local
state.

The generated `gbrain` index is allowlisted. Only reviewed or sanitized memory
surfaces may be imported/embedded: `people/`, `companies/`, `projects/`,
`decisions/`, `gotchas/`, `concepts/`, `meetings/`, and `originals/`.
`sources/`, `inbox/`, `archive/`, `raw/`, `_templates/`, repo docs, scripts,
ledgers, and review state are filesystem/git evidence only. They must never be
imported, searched, or embedded by `gbrain`.

The agent, not the operator, owns the preserve-vs-summarize decision during `$dreams`.
Explicit markers such as `memory_intent: preserve-full` are optional overrides
for manual drafts, not required input. If the operator says a note should be
"fully in memory", "save this fully", or a draft has `memory_intent:
preserve-full` / `preserve: full`, that means:
create or update an allowlisted curated page with the sanitized substance
preserved in the page body. It does not mean indexing the raw draft, archive
copy, transcript dump, or `sources/` note.

## Unattended Contract

A plain `$dreams` invocation is the operator's standing approval to run the full memory maintenance cycle for `~/brain`:

- promote safe durable memory into curated pages;
- append/update review ledger entries;
- archive handled drafts out of `inbox`;
- run redaction and gitleaks gates;
- run `gbrain` sync/embed;
- commit and push `~/brain`.

This invocation is the normal deterministic sync boundary for memory. Do not assume a scheduled cron sync has indexed fresh drafts before the run.

This approval applies only inside `~/brain`. It does not authorize unrelated repos, destructive git operations, force pushes, package changes, or deleting evidence.

Do not ask the user questions during the run. If something requires judgment, resolve it by the policy below and record the decision in the report.

## Modes

- Default: unattended full run. Equivalent to `--apply --sync --commit --push`.
- `--dry-run`: create proposals only under `~/brain/.dreams/<session-id>/`; do not write curated pages, archive drafts, commit, or push.
- `--no-sync`: skip `gbrain` sync after writes.
- `--no-commit`: do not create a git commit.
- `--no-push`: do not push to origin.
- `--include-reviewed`: include drafts already present in `review-ledger.jsonl`.

If flags conflict, choose the safer lower-mutation mode and record the reason in `reports/SUMMARY.md`.

## Non-Negotiable Rules

- Read `~/brain/README.md`, `~/brain/AGENTS.md`, `~/brain/schema.md`, and `~/brain/RESOLVER.md` before classifying drafts.
- Read `~/brain/inbox/README.md` and `~/brain/inbox/auto/README.md` before handling auto captures.
- Read the target directory `README.md` before proposing or writing any curated page.
- Never promote raw chat dumps, unsourced claims, secrets, credentials, raw connection strings, private keys, or unredacted local/private data.
- Never copy stop-hook-only metadata such as `transcript_path`, raw local paths, or raw `git_remote` into curated pages unless sanitized and genuinely useful.
- Curated memory is English-only. This is a hard gate, not a style preference.
  If source material is Russian or mixed-language, translate the durable
  substance, headings, aliases, summaries, preserved passages, timeline
  entries, and search anchors into English before promotion. Do not put
  Russian text into allowlisted indexed pages or future retrieval phrases.
- Batch summaries/clusters are triage only. Never turn the whole inbox into one synthesized summary, and never classify/apply a draft from a cluster summary alone; read the full draft or copied source snapshot first.
- Stop-hook captures with `session_id` are reviewed by session, not as isolated
  unrelated files. `inventory.json.session_groups[]` is the routing unit for
  stop-hook work. A session group may contain one aggregate draft or legacy
  multiple drafts; either way, classify it as one conversation context and
  reconcile every capture segment before finalizing.
- Preserve operator-authored thinking. If a draft contains the operator's own thesis, opinion, mental model, business idea, or distinctive wording, do not flatten it into a generic summary. Route it to `originals/` when it deserves a durable authored page, or `source-note` when it is useful provenance but not ready for a curated page. Preserve the essential authored claim/wording after safety redaction; do not rewrite `originals/` through an LLM unless explicitly requested.
- Assign a memory handling mode for every draft: `preserve-full`, `preserve-substantial`, `synthesize`, `source-note`, `discard`, `duplicate`, or `blocked-safety`. Do this autonomously from the full draft content and evidence; do not push this classification work back to the operator.
- Treat explicit full-preserve intent as a high-priority routing signal. Also infer full/substantial preservation without markers when the draft contains original thinking, reusable strategy, decisions with rationale, important personal/company/project context, or wording whose value would be lost in a summary. Do not downgrade such drafts to generic summaries or discard them just because they are long.
- If uncertain, choose the conservative autonomous outcome: low-confidence curated note, sanitized source note, discard, duplicate, or `blocked-safety`. Do not ask the user.
- Every final report must reconcile every considered draft: `promoted`, `low-confidence-promoted`, `source-note`, `discarded`, `duplicate`, or `blocked-safety`.
- Do not stop the whole batch because one draft is bad. Skip the bad draft, record the blocker, and continue.
- Never sync or embed raw source drafts. After moving handled drafts to
  `archive/inbox-reviewed`, only allowlisted curated/sanitized pages may enter
  the generated `gbrain` index. If active DB pages/chunks outside the allowlist
  are detected, treat that as an index bug, clean only those generated rows, and
  leave the markdown/filesystem evidence intact.

## Temporal Contract

Do not collapse source time, curation time, and vector-index time. They answer
different questions and future agents rely on the distinction.

- `formed_at`: when the memory/fact was discussed, decided, observed, or
  captured in source context. For stop-hook drafts, default to source
  frontmatter `created_at`; override only when the draft proves an earlier real
  event/decision time.
- `date` / `event_date`: the calendar date derived from `formed_at` that powers
  `gbrain query --since ... --until ...` via `pages.effective_date`. Use
  `event_date` for meetings/events; otherwise use `date`.
- `recorded_at`: when this `$dreams` run wrote the reviewed markdown into
  a curated page.
- `indexed_at`: when the reviewed page was successfully synced/embedded into
  the `gbrain` vector index. Set this only after a successful sync/embed pass.

Every promoted curated page and every material timeline entry must include
these temporal anchors where available. If a source date is approximate, use the
best day-level date in `date` and state the precision in `confidence.notes` or
the timeline entry. This is what makes prompts like "find what we discussed
last month" or "what memory was formed on May 15" work.

Also write the same anchors into a short body section named
`## Temporal Metadata`. Frontmatter is the machine layer; the body section makes
the dates visible when an agent reads the retrieved page and searchable by
ordinary text retrieval.

## Language Contract

The searchable memory surface and every `gbrain` retrieval phrase are
English-only.

- All allowlisted indexed pages (`people/`, `companies/`, `projects/`,
  `decisions/`, `gotchas/`, `concepts/`, `meetings/`, and `originals/`) must be
  written in English: frontmatter titles and aliases, headings, compiled truth,
  preserved notes, timeline entries, temporal metadata, source brackets, and
  search-oriented anchors.
- Natural-language aliases, headings, examples, preserved passages,
  `source_anchor` values, quality reasons, coverage text, report search terms,
  and timeline/source brackets must be English. A Russian phrase is invalid in
  curated/indexed memory even when it would help match the raw source.
- When a source draft is Russian or mixed-language, translate the meaning into
  precise English during curation. Preserve commands, code identifiers, issue
  IDs, URLs, slugs, and file names exactly only when they are not
  natural-language prose. For non-English person, company, product, or project
  names, use the English/transliterated canonical form used by curated pages;
  keep raw non-English spelling only in archived source evidence. Do not
  preserve Russian wording in indexed memory.
- For `originals/`, preserve operator-authored substance and distinctive reasoning
  as faithful English translation. Do not store the Russian original in the
  curated page; the archived source snapshot remains the evidence layer.
- Ledger `memory_units.summary`, `source_anchor`, `quality_reason`, coverage
  fields, and `target_actions.reason` should also be English so future review
  reports and diagnostics point agents at English retrieval terms. Source paths,
  content hashes, and immutable provenance identifiers stay exact.
- translate all non-English natural-language anchors to English before any gbrain retrieval call; keep immutable identifiers exact; use English/transliterated canonical forms for non-English people, companies, products, and projects.
- Every natural-language phrase passed to `gbrain query`, `gbrain search`,
  `query_scan`, temporal search, salience search, recall, or takes search must
  be English. This applies during target resolution, dedupe checks, quality
  assurance, final smoke tests, and future memory lookup. Commands, code
  identifiers, issue IDs, URLs, slugs, and file paths stay exact. Non-English
  person, company, product, or project names are searched by their
  English/transliterated canonical form, not by raw source spelling.
- `rg` or source-snapshot searches may use exact non-English source text only
  for forensic source review. Anything promoted, indexed, written to the
  ledger/report as a future search term, or used as a `gbrain` retrieval phrase
  must be English.

## Autonomous Resolution Policy

Use this policy instead of asking the user:

1. **Safety beats recall.** If a draft contains secrets, raw private data, credentials, or unredactable sensitive material, do not promote it. If the durable lesson can be safely generalized, promote only the sanitized lesson; otherwise mark `blocked-safety` and leave the source draft unarchived for manual forensic recovery only.
2. **Evidence hierarchy.** Prefer current verified repo files/docs/runtime evidence over curated brain pages; prefer curated timeline evidence over repeated auto-captures; prefer repeated auto-captures over a single auto-capture; treat single auto-captures as `low` confidence unless verified.
3. **Contradictions are resolved, not escalated.** Pick the best-supported current understanding, update the compiled truth, and append a timeline entry noting the conflicting evidence. If no side is clearly stronger but the topic is durable, write a low-confidence current understanding with an `Open Questions` bullet.
4. **Routing is deterministic.** Use `repo_name` / git remote basename first, then `mentioned_projects`, then `cwd` basename. If still unclear and the item is not strong enough for a curated namespace, record it as ledger/source-only evidence instead of inventing a searchable memory home.
5. **Canonical pages win.** Search existing pages before creating new ones. Update the canonical page and add aliases/related links rather than making duplicates.
6. **Weak but useful facts can still be memory.** If a fact is safe, durable, and likely useful but weakly sourced, promote it with `confidence.value: low` and a timeline source pointer. Do not leave a user-facing review queue.
7. **Low-value chatter is discarded.** Pure progress updates, temporary debugging guesses, and vague claims are recorded in the ledger as `discarded` and archived; they are not preserved for the user to decide later.
8. **Importance controls preservation depth.** Preserve more when future agents would need the actual reasoning or wording; synthesize when the stable lesson is enough; discard when only momentary task state remains.
9. **Memory self-updates.** New drafts may revise old memory. When new evidence changes, narrows, supersedes, or adds an important exception to an existing page, update the current compiled truth above the timeline and append a new timeline entry. Do not leave stale top-level truth just because the old page already exists.

## Importance Scorecard

Score every draft before choosing a preservation mode. Record the score and
1-line rationale in the ledger/report. Do not rely on vibe words like
"interesting" or "maybe useful" without scores.

Use 0-3 for each dimension:

- **Future retrieval value**: 0 no future use; 1 weak lead; 2 likely useful in a
  named future task; 3 likely to change future agent behavior or decisions.
- **Durability**: 0 momentary task state; 1 useful for days; 2 useful for
  weeks/months; 3 stable preference, decision, context, or idea.
- **Specificity / anchors**: 0 vague; 1 broad theme; 2 named person/company/
  project/command; 3 exact phrase, issue, artifact, decision, or reproducible
  gotcha.
- **Authorship / strategic value**: 0 assistant chatter; 1 minor user
  preference; 2 decision/rationale/lesson; 3 operator-authored thesis, business
  idea, strategy, mental model, or distinctive wording.
- **Fidelity sensitivity**: 0 exact wording irrelevant; 1 examples helpful but
  optional; 2 reasoning/examples should survive; 3 summary would materially
  damage the value.

Evidence quality is separate from importance:

- `high`: directly verified in current files/runtime/source, or repeated strong
  evidence.
- `medium`: credible source draft or repeated captures, not freshly verified.
- `low`: single weak auto-capture or useful but uncertain lead.

Safety is a gate, not a score. Secrets, raw private data, credentials,
unredacted paths, or unredactable sensitive material block promotion regardless
of importance.

Ledger rows must make the classification auditable:

- `reviewed_at`: current review timestamp.
- `source_path` plus `content_hash` / `dedupe_key` / `sha256`: enough identity
  to reconcile the row back to the exact `inventory.json` draft and the
  archived source. Hash-only reconciliation is invalid; each inventoried draft
  needs a ledger row with a matching source path and matching hash.
  Extra ledger rows for the session are invalid: every row must map back to one
  and only one draft in `inventory.json`.
- `decision`: `promoted`, `low-confidence-promoted`, `source-note`,
  `discarded`, `duplicate`, or `blocked-safety`.
- `preservation_mode`: the memory handling mode chosen below.
- `targets`: required and non-empty for `preserve-full`,
  `preserve-substantial`, and `synthesize`; for `duplicate`, include the
  existing target when known. Targets must be unique allowlisted curated
  markdown paths. If a row has multiple targets, each curated `memory_units[]`
  item must specify its exact target.
- `target_actions`: required for curated-memory rows. Each item records
  `{path, action, compiled_truth_changed, supporting_units, reason}`. `path`
  must be an allowlisted curated markdown file and must also appear in
  `targets`. `supporting_units` is a non-empty array of `memory_units[]`
  indexes that support this exact target edit. Use `create`, `update`, or
  `supersede` with `compiled_truth_changed: true` when the searchable top truth
  is new or changed. Use `append-timeline` with
  `compiled_truth_changed: false` only when the current compiled truth remains
  valid and the new source merely adds evidence/provenance. Do not use
  `no-change-duplicate` on promoted rows; it is only for duplicate rows that
  reference an existing target without changing it.
  Do not put two `target_actions[]` entries for the same path in one row.
- `archived_path`: required for every non-`blocked-safety` row after apply.
  It must be a repo-relative `archive/inbox-reviewed/YYYY-MM/*.md` path for
  the exact reviewed source snapshot, archived by
  `archive-reviewed-sources.rb` from `inventory.json.source_snapshot`, not by
  moving a live inbox file that may have changed after inventory. This path is
  provenance, not a searchable memory surface. The tracked
  `archive/dreams-session-audits/<session>/archive-manifest.json` must prove the
  archive was copied from the reviewed snapshot before any later redaction.
- `target_timeline_entry`: required for rows whose mode creates or updates
  curated memory (`preserve-full`, `preserve-substantial`, `synthesize`). It
  must contain the curated target and a `source_hash`, `content_hash`, or
  `source_ref` matching the row's `content_hash` / `dedupe_key` / `sha256`.
  Future agents use this source hash to drill down from a curated timeline
  entry into review-ledger and archive evidence.
- `source_excerpt_summary`: required for every non-`blocked-safety` row after
  apply. Keep it English, bounded, and specific enough that `gbrain evidence`
  can show what kind of archived source was reviewed without embedding or
  semantic-searching the archive.
- `session_owner_report`: required for rows whose inventory draft has
  `session_id` when `session-owner/assignments.json` exists. It records
  `{session_id, agent_id, report_path, report_sha256, covered_review_units}` and
  must match the validated session-owner assignment/report artifact. Store
  `report_path` as a repo-relative path such as
  `.dreams/<session>/session-owner/reports/<session-id>.json`; absolute local
  paths make the ledger fail redaction. This binds the ledger row back to the
  concrete subagent report instead of allowing a chat-only or ignored
  session-owner pass.
- `quality_reason`: concrete reason tied to future retrieval value, durability,
  fidelity, evidence, or safety. Generic reasons such as "useful" or
  "interesting" are invalid.
- `coverage`: required assessment that prevents both loss and hallucinated
  additions:
  `{source_read, durable_content, discarded_content, unsupported_additions,
  loss_risk}`. `source_read` must be `full-draft`, `source-snapshot`, or
  `full-draft-and-snapshot`. `durable_content` states what source material is
  represented in `memory_units` / targets. `discarded_content` states what was
  intentionally treated as noise, duplicate, unsafe, or non-durable.
  Use `discarded_content: none` only when there are no non-durable/noise/
  duplicate/safety units. If discarded content is described, at least one
  corresponding `memory_units[]` item must record it as `status-noise`,
  `duplicate`, `unsafe`, `other-ephemeral`, or a discard/duplicate/blocked
  mode. `unsupported_additions` must be `none`; if the curator wants to add a
  claim not supported by a source unit, the ledger row is invalid. `loss_risk`
  is `low`, `medium`, or `high`; high loss risk must become `blocked-safety`,
  not a finalized promoted/discarded row.
  For multi-segment stop-hook session drafts, `coverage.session_coverage` is
  mandatory and must reconcile the exact `inventory.json` segment manifest:
  `{session_id, capture_segment_count, review_strategy, segments}`. Each
  `segments[]` item must include `{segment_id, source_anchor, status, summary,
  memory_unit_indexes}`. Segment ids use `segment-N`, status is `reviewed`,
  `discarded`, `duplicate`, `unsafe`, or `blocked`, and
  `memory_unit_indexes` must point to the row's `memory_units[]`. Missing,
  duplicate, or out-of-range segments make the row invalid. If a segment has no
  durable content, still create a non-durable `memory_units[]` item explaining
  what was discarded so the segment is auditable.
- `memory_units`: non-empty decomposition of the draft into evaluated pieces.
  This is what prevents a long mixed auto-capture from being summarized or
  discarded as one blob.

Each `memory_units[]` item must contain:

- `kind`: one of `authored-thinking`, `business-idea`, `strategy`,
  `decision`, `preference`, `project-fact`, `gotcha`, `person-context`,
  `company-context`, `meeting-event`, `operational-evidence`,
  `source-evidence`, `status-noise`, `duplicate`, `unsafe`,
  `other-durable`, or `other-ephemeral`.
- `summary`: the specific claim/passage being evaluated, not a generic topic.
- `source_anchor`: a short sanitized phrase, heading, message label, or source
  snapshot section that ties the unit back to the reviewed draft. It must be
  specific enough to distinguish this unit from invented additions, but not a
  raw transcript dump or secret-bearing excerpt. For multi-segment stop-hook
  session drafts, every unit source anchor must include the relevant `segment-N`
  id from `inventory.json.segment_manifest`.
- `importance_score`: the same 0-3 scorecard.
- `preservation_mode`: handling mode for that unit.
- `reason`: concrete reason for that unit's mode.
- `anti_summary_reason`: required when `fidelity >= 2` or mode is
  `preserve-full` / `preserve-substantial`; explain what would be lost if this
  were reduced to a generic summary.
- `target`: required for units that create/update curated memory unless the row
  has shared `targets`.

Every `target_actions[]` item on a promoted row must be supported by at least
one curated `memory_units[]` item for the same target, either through the unit's
explicit `target` or the row's single shared target. This is what prevents a
curated page edit from adding claims that were not traced back to a source
unit.

## Evidence Drilldown Contract

Curated pages are the searchable answer. Reviewed drafts, archive files, and
ledger rows are a separate provenance layer.

Do not import, embed, or semantic-search `inbox/`, `archive/`, raw source
snapshots, or review-ledger state. When a future agent finds a curated memory
page but needs the reviewed source trail, the first drilldown should be by
curated target slug:

```bash
gbrain call get_evidence '{"target_slug":"projects/example","limit":5}'
```

If the caller has an exact timeline/source hash instead of a target page, resolve
evidence by exact source ref:

```bash
gbrain evidence <source_hash_or_content_hash> --source <source_id>
```

When the full archived draft body is actually needed and the caller is on the
trusted local brain host, use:

```bash
gbrain evidence <source_hash_or_content_hash> --source <source_id> --full-source
```

`--full-source` is local provenance hydration only. It must not become a normal
retrieval mode, and it must not be used to justify semantic indexing of
`archive/` or `inbox/`.

The drilldown paths are:

```text
curated target slug -> source-evidence target refs -> review-ledger rows -> archived draft files
curated timeline source_hash -> review-ledger row -> archived draft file
```

For this to work at scale, every applied non-safety row must carry direct
provenance fields: `archived_path`, `source_excerpt_summary`, and, for curated
memory rows, `target_timeline_entry` with a source ref matching the row hash.
After the ledger row and archive move exist, index the lookup layer into
Postgres:

```bash
gbrain evidence index-ledger --brain-repo ~/brain --source <source_id> --session "$session" --include-archive-excerpts
```

This mutates only the `source_evidence` lookup tables. It does not add archive
or inbox content to `pages`, `content_chunks`, embeddings, or normal retrieval.
The indexer must store target refs for each allowlisted `targets[]` /
`target_actions[].path` value, so old and future reviewed rows can be found by
`get_evidence({target_slug})` even when the caller does not know the original
source hash.

## Memory Handling Modes

Choose one for every draft before writing proposals:

- `preserve-full`: safe, durable operator-authored thinking, original thesis,
  mental model, business idea, strategy note, important preference/context, or
  explicit full-preserve signal. Promote to an allowlisted curated page, usually
  `originals/`, with `## Preserved Note` carrying the sanitized substance as
  completely as safety allows.
- `preserve-substantial`: mixed material where important reasoning/examples
  should survive, but raw transcript/status noise should not. Preserve the key
  authored passages, examples, and rationale; remove duplicate chatter,
  tool-log noise, raw paths, and secrets.
- `synthesize`: project facts, decisions, gotchas, people/company context, or
  technical lessons where future value is the stable conclusion, not exact
  wording. Write concise compiled truth plus timeline provenance.
- `source-note`: useful evidence or provenance, but not enough for a searchable
  memory page. Record it in the ledger/report and archive the source; do not
  create an indexed page.
- `discard`: low-value status, temporary debugging guesses, repeated progress
  updates, or material with no durable future use.
- `duplicate`: the same durable claim already exists at equal or better
  fidelity; link the existing target when known.
- `blocked-safety`: unsafe to promote/archive automatically.

Importance signals for full/substantial preservation include: the operator says "I
think", "my thesis", "remember this", "idea", "business", "strategy",
"principle", "important", "best decision", "why this matters"; the draft
contains a reusable mental model, non-obvious tradeoff, personal/company
context, product direction, market insight, or distinctive phrasing; or the
content would be materially worse if reduced to one bullet.

Default mapping:

- Safety issue that cannot be cleanly redacted -> `blocked-safety`.
- Same durable claim already exists at equal or better fidelity -> `duplicate`.
- Total score 0-3 -> `discard`, unless safety/provenance requires leaving it
  unarchived.
- Total score 4-6 -> `source-note` when provenance is useful but searchable
  memory would be weak.
- Total score 7-10 with fidelity sensitivity 0-1 -> `synthesize`.
- Total score 7-10 with fidelity sensitivity >=2, or authorship/strategic value
  >=2 -> `preserve-substantial`.
- Total score >=11 and fidelity sensitivity >=2, or authorship/strategic value
  =3, or explicit full-preserve signal -> `preserve-full`.

Escalate one level when the draft contains multiple independent durable ideas;
split into multiple target pages when one page would mix unrelated entities.
Downgrade one level when a canonical curated page already preserves the same
idea better, but still append a timeline entry if the new source materially
improves evidence.

Before discarding, run this self-check: "Would a future agent be worse if this
vanished from search and only remained as archived evidence?" If yes, do not
discard.

## Session State

Create one local session per run:

```bash
session="$HOME/brain/.dreams/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$session"/{sources,proposals,reports}
```

Use these artifacts:

- `state.json`: current phase, mode flags, counts, post-inventory inbox audit,
  unresolved blockers.
- `inventory.json` / `inventory.md`: deterministic draft listing.
- `sources/`: optional copied source snapshots for stable review.
- `proposals/`: proposed curated page full-file mirrors, plus optional patches.
  This must not contain only `review-ledger.jsonl` when the run creates or
  updates curated memory; every changed curated target needs a matching proposed
  final-content artifact before apply.
- `reports/SUMMARY.md`: final reconciliation.

These artifacts are local review state and must stay ignored by git.

Session-owner report evidence must still survive the local `.dreams/` boundary
without committing raw source snapshots. For runs that create
`session-owner/assignments.json`, also write and commit
`archive/dreams-session-audits/<session-id>/session-owner-audit.json`. This
tracked bundle preserves assignment ids, report hashes, covered review units,
memory units, and ledger bindings with repo-relative/sanitized paths only.

Terminal `state.json` must be auditable: `active=false`, `phase=done`,
`completed_at`, mode flags, `counts.inventory_total`,
`counts.handled_total`, `counts.by_decision`,
`counts.by_preservation_mode`, and `counts.score_bands`. The three count maps
must include every allowed bucket with zeroes where needed and each map must
sum to `inventory.total`.

`reports/SUMMARY.md` is not a loose prose recap. Its `## Counts` section must
start with a fenced `json` block that exactly matches the terminal
`state.counts` fields. Its `## Post-Inventory Inbox Audit` section must start
with a fenced `json` block that exactly matches
`state.post_inventory_inbox_audit.counts`. Use `templates/session-counts.json`
as the exact bucket reference and fill the numbers from the terminal session
state:

```json
{
  "inventory_total": 0,
  "handled_total": 0,
  "by_decision": {
    "promoted": 0,
    "low-confidence-promoted": 0,
    "source-note": 0,
    "discarded": 0,
    "duplicate": 0,
    "blocked-safety": 0
  },
  "by_preservation_mode": {
    "preserve-full": 0,
    "preserve-substantial": 0,
    "synthesize": 0,
    "source-note": 0,
    "discard": 0,
    "duplicate": 0,
    "blocked-safety": 0
  },
  "score_bands": {
    "0-3": 0,
    "4-6": 0,
    "7-10": 0,
    "11+": 0
  }
}
```

The validator compares this JSON against `state.json`, `inventory.json`, the
session ledger row count, and the ledger's actual decision/mode/score
aggregates. If any number differs, the run is not complete.

The post-inventory audit separates inbox leftovers by cause. Do not collapse
them into a generic "untracked paths" line:

- `current_session_blocked_safety`: reviewed in this run and intentionally left
  in inbox because it is unsafe to archive/promote automatically;
- `previous_blocked_safety`: already ledgered blocked-safety drafts from older
  runs that still remain in inbox;
- `new_pending_after_inventory`: fresh drafts captured after this run's
  `inventory.json.generated_at`, including drafts created or modified while the
  run was still executing or immediately after it completed; these belong to
  the next `$dreams` run and do not invalidate the completed inventory. Use the
  later of draft frontmatter time and filesystem `mtime` for this classification
  so a newly written file with an older source `created_at` is still treated as
  post-inventory work. If an inventoried path still exists but its current
  `sha256` differs from the inventory `sha256` and its timestamp is after
  `inventory.json.generated_at`, treat the current file as same-path pending
  work for the next run, not as a failure to archive the reviewed snapshot;
- `unledgered_not_in_inventory`: pre-existing drafts that were not in this
  inventory and have no ledger row; this is a hard blocker to investigate;
- `ledgered_nonblocked_left_in_inbox`: non-safety handled drafts that should
  have been archived but are still in inbox; this is a hard blocker;
- `inventory_unhandled_left_in_inbox`: inventoried drafts with no session ledger
  row; this is a hard blocker;
- `dry_run_inventory_left_in_inbox`: dry-run sources intentionally left in
  place.

`validate-session-state.rb` recomputes this audit up to the recorded
`checked_at` timestamp. Drafts created or modified after `checked_at` are
expected pending work for a later run and must be reported separately when
discussing overall inbox state.

`finalize-session-state.rb` also owns the final `## Proposal Audit` section.
Do not leave hand-written placeholders such as `none` or `0/0` after a session
that touched curated memory. The finalizer recomputes curated target paths from
the session ledger, counts full-file proposal mirrors under
`proposals/curated/`, lists the target namespace README files, and refuses to
finalize if any curated target lacks a proposal mirror. `validate-session-state.rb`
recomputes the same audit and rejects stale or hand-edited summary values.

## Workflow

1. **Initialize**
   - Parse mode flags from the user request.
   - Create session state with the helper script; do not hand-write a Ruby
     one-liner for `state.json`:

     ```bash
     init_json="$(ruby skills/dreams/scripts/init-session-state.rb --brain ~/brain)"
     session="$(printf '%s' "$init_json" | ruby -rjson -e 'puts JSON.parse(STDIN.read).fetch("session")')"
     ```

     Add `--session <path>`, `--dry-run`, `--no-sync`, `--no-commit`, or
     `--no-push` to the init command when those modes apply. The script creates
     `sources/`, `proposals/`, `reports/`, and a valid ISO8601 `state.json`.
   - Confirm `~/brain` exists and read the required brain docs listed above.
   - Run `git -C ~/brain status --short`. If there are unrelated dirty files, do not overwrite them. Work around them when possible and record them in the report.
   - Do not rely on the `gbrain` index for fresh `inbox/auto` drafts. Inventory the filesystem directly first; the final sync updates the generated index after review/archive/apply.
   - If resuming an interrupted session, validate any existing ledger rows for
     that session before continuing. Old rows without `decision`,
     `importance_score`, `preservation_mode`, `evidence_quality`,
     `quality_reason`, and required `targets` are not acceptable completion
     evidence; reclassify/enrich them from the full source snapshots or start a
     fresh session and record why the old local state was superseded.

2. **Inventory**
   - Run:

     ```bash
     ruby skills/dreams/scripts/inventory.rb --brain ~/brain --session "$session" --copy-sources
     ruby skills/dreams/scripts/prepare-session-owner-tasks.rb --session "$session" --inventory "$session/inventory.json"
     ```

   - Add `--include-reviewed` only when the user requested it.
   - This must scan recursively, including `~/brain/inbox/auto/YYYY-MM-DD/*.md`.
   - Treat `inventory.json.generated_at` as the snapshot cutoff, recorded before
     the filesystem scan. Draft files created or modified after that cutoff are
     excluded from the inventory even if their frontmatter `created_at` is old;
     they must remain pending for the next `$dreams` run.
   - Use `~/brain/inbox/review-ledger.jsonl` when present to avoid reprocessing already-reviewed content hashes.
   - Inspect `inventory.json.session_groups[]` before classification. For each
     stop-hook group with a `session_id`, treat the whole group as one source
     conversation. Use `segment_manifest[]` to plan the review, and block or
     mark high loss risk if `segment_parse_errors[]` is non-empty.
   - Session-capture `dedupe_key` values are derived from the live file hash,
     not only frontmatter `content_hash`, because an aggregate session draft can
     be appended after the original hash was written. Ledger rows for session
     captures must include the inventory `dedupe_key` or `sha256` so already
     reviewed sessions do not resurface after append/review cycles.
   - `prepare-session-owner-tasks.rb` writes
     `"$session/session-owner/assignments.json"` plus one JSON task and one
     prompt file per `session_id` group. This artifact is the authoritative
     checklist for per-session owner work; do not rely on a mental list.

3. **Assign Session Owners**
   - Read `"$session/session-owner/assignments.json"`.
   - Compute owner-task and segment/review-unit counts from the assignment
     artifact, not by hand. Use a machine count such as:

     ```bash
     ruby -rjson -e 'j=JSON.parse(File.read(ARGV[0])); puts JSON.generate({tasks:j.fetch("tasks").size, expected_review_units:j.fetch("tasks").sum{|t| Array(t["expected_review_units"]).size}})' "$session/session-owner/assignments.json"
     ```

     Any user-facing segment count must come from `expected_review_units` or
     `inventory.json.session_groups[].segment_manifest`, not from a status-line
     estimate.
   - For every task in `tasks[]`, spawn exactly one session-owner subagent when
     the current Codex session has subagent tools available. Every
     session-owner spawn must request `reasoning effort: xhigh`. When using
     `multi_agent_v1.spawn_agent`, pass `reasoning_effort: "xhigh"` and omit
     `model` unless the user explicitly requested a model change. If another
     spawn surface exposes model/effort controls, set the strongest available
     reasoning effort and do not accept `medium`; if it does not expose those
     controls, include `reasoning effort: xhigh` literally in the brief. The
     brief is the task's generated prompt file plus the source-boundary
     contract. This is mandatory for stop-hook sessions; "I reviewed it
     locally" is not equivalent when subagent tools are available.
   - Spawn session owners as a bounded rolling queue: at most 6 session-owner subagents may be live at once.
     Start up to six, then wait for a report to be written and accepted before opening the next owner.
     Never spawn all pending owner tasks at once, even when `assignments.json`
     contains more than six tasks; this avoids the live
     runtime cap that otherwise turns a large `$dreams` run into a
     session/thread-limit failure.
   - Immediately after each spawn, record the real returned subagent id:

     ```bash
     ruby skills/dreams/scripts/record-session-owner-assignment.rb --session "$session" --session-id "<session_id>" --agent-id "<agent_id>"
     ```

   - Then send that same subagent a short follow-up containing its exact
     `agent_id` and reminding it that `report.agent_id` must match the recorded
     assignment. The generated prompt cannot know the returned id before spawn.

   - Each session owner must write its JSON report to the task's `report_path`.
     Do not accept a chat-only summary as completion. The report is the handoff
     artifact used by validation and by the Lead's ledger row construction.
   - If subagent tools are unavailable, record the run as blocked for session
     processing; do not silently downgrade to local-only review and do not claim
     full session coverage.
   - Before writing ledger rows from session captures, run:

     ```bash
     ruby skills/dreams/scripts/validate-session-owner-reports.rb --session "$session" --inventory "$session/inventory.json"
     ```

     This gate fails if any `session_id` group has no task, no recorded
     `agent_id`, no report file, a report from the wrong agent, or incomplete
     segment/draft-unit coverage.

4. **Classify**
   - For each non-session draft, read the full draft or copied source snapshot.
     For each stop-hook `session_group`, read every draft/snapshot in that group
     as one session context. A one-file aggregate session draft is still a
     session, not a generic long note.
   - For multi-segment session drafts, review by deterministic segment order
     from `segment_manifest[]`. Never classify a huge session from only the
     beginning, end, recent excerpt, or an LLM-written batch summary. If the
     file is too large for one context window, split it into deterministic
     segment windows and keep one session owner responsible for reconciling all
     windows back into one ledger row.
   - Decompose the draft into `memory_units` before assigning the draft-level
     decision. Separate durable ideas, user-authored reasoning, project facts,
     gotchas, people/company context, source evidence, duplicates, safety issues,
     and pure status noise. A draft can have multiple units with different
     modes; do not let low-value chatter hide a high-value idea.
   - For multi-segment session drafts, every capture segment must be represented
     in `coverage.session_coverage.segments[]`. Durable segment content must be
     represented by durable `memory_units[]`; non-durable segment content must
     be represented by `status-noise`, `duplicate`, `unsafe`, or
     `other-ephemeral` units. Every unit `source_anchor` must include the
     segment id, for example `segment-4: decision about stop-hook aggregation`.
  - First check explicit preservation signals in frontmatter or body:
    `memory_intent: preserve-full`, `preserve: full`, `target_namespace:
    originals`, "fully in memory", or "save this fully". These signals override
    normal summarization pressure but not safety and dedupe rules.
   - Then assign the memory handling mode from `## Memory Handling Modes`, even when
     there is no explicit marker. Auto-captures and messaging/source extractions
     must be judged by content importance, not by whether the operator pre-tagged them.
   - Calculate the `## Importance Scorecard` values. Ledger/report entries must
     include `decision`, `importance_score`, `preservation_mode`,
     `evidence_quality`, `quality_reason`, `coverage`, `memory_units`, and
     `targets` when the mode creates or updates a curated page. Multi-segment
     session rows must include `coverage.session_coverage`.
     Use this JSON shape in ledger rows:
     `importance_score: {future_retrieval, durability, specificity, authorship, fidelity, total}`.
     The draft-level score must be at least as strong as its strongest
     `memory_units[]` score; the draft-level mode must not be weaker than the
     strongest unit mode unless the row is `duplicate` or `blocked-safety`.
     A `duplicate` row must not hide non-duplicate units; a `blocked-safety`
     row must identify the unsafe/blocked unit.
   - Classify:
     - `duplicate`: same `content_hash` or same durable claim already handled.
     - `discard`: safe but not durable, pure status chatter, too vague, or no useful provenance.
     - `source-note`: useful provenance but not strong enough for a curated entity page; record it in the ledger/report or a local source snapshot, but do not create a searchable memory page for it.
     - `low-confidence-promoted`: safe, durable, useful, but weak or conflicting evidence; promote with `confidence.value: low`.
     - `promoted`: durable, sourced enough, and safe enough to become curated memory.
     - `blocked-safety`: unsafe to promote/archive automatically; record reason and continue.
   - When a draft mixes status chatter with operator-authored ideas, discard only the chatter; preserve the idea as `originals/`, `low-confidence-promoted`, or `source-note` according to evidence strength and namespace fit.

5. **Resolve Target**
   - Use `RESOLVER.md` to choose the primary namespace.
   - Before writing or proposing any curated target, read the target namespace
     `README.md` for each namespace you will touch, for example
     `~/brain/projects/README.md` before `projects/*.md` and
     `~/brain/decisions/README.md` before `decisions/*.md`. Do this even when
     updating an existing page. If a target directory has no `README.md`, record
     that absence in the session report and continue conservatively.
   - Search existing pages before proposing a new one. Use English
     natural-language anchors. Keep commands, code identifiers, issue IDs,
     URLs, slugs, and file paths unchanged; use English/transliterated
     canonical forms for non-English person, company, product, or project
     names:

     ```bash
     rg -n "<English entity-or-key-phrase or exact identifier>" ~/brain/{people,companies,projects,decisions,gotchas,concepts,meetings,originals}
     ```

   - If source review needs a non-English raw phrase, search it only in source
     snapshots or archived evidence. Do not turn that phrase into an alias,
     `source_anchor`, target name, report search term, or `gbrain` query.

   - Prefer updating an existing canonical page over creating duplicates.
   - If the new draft changes the existing understanding, mark the row
     `target_actions[].action = "update"` with
     `compiled_truth_changed: true`, and edit both the compiled truth and the
     timeline. Use `append-timeline` only when the current truth stays valid and
     the new source merely adds evidence/provenance.

6. **Write Proposals**
   - Always write proposed final content to `"$session/proposals"` first, before
     editing the live curated page. For each curated target path, mirror the
     exact proposed final markdown under
     `"$session/proposals/curated/<target-relative-path>"`, for example
    `"$session/proposals/curated/projects/example-project.md"`. A ledger
     row alone is not a proposal for page content.
   - Patch artifacts under `"$session/proposals/patches/"` may be added for
     review convenience, but they do not replace the full-file mirror. Do not
     proceed with apply if `proposals/` contains only `review-ledger.jsonl` or
     if any curated target is missing its full proposed final-content artifact.
   - Also write proposed ledger rows to
     `"$session/proposals/review-ledger.jsonl"` before applying anything. This
     file uses the same row shape as `~/brain/inbox/review-ledger.jsonl`.
   - Use the existing Dreams helper scripts for standard mechanics. Do not
     create one-off session-local scripts for validation, session state,
     proposal-audit, redaction convergence, gitleaks diagnostics, archiving, or
     evidence indexing. A temporary script under `.dreams/<session>/` is allowed
     only for one-off content synthesis when the source batch is too large for
     manual shell commands; it must stay uncommitted, and all of its outputs
     still have to pass the proposal/ledger validators. If the same mechanical
     step would be useful in future runs, add a tested helper under this skill
     instead of recreating it in every session.
   - Validate proposed rows before applying or finishing a dry run:

     ```bash
     ruby skills/dreams/scripts/validate-review-ledger.rb --brain ~/brain --session "$session" --ledger "$session/proposals/review-ledger.jsonl" --inventory "$session/inventory.json" --require-proposal-artifacts
     ```

     If this fails, reclassify the affected drafts; do not apply or report a
     successful dry run.
   - Verify proposal coverage before applying: every non-duplicate curated
     target listed in the proposed ledger must have a corresponding proposed
     full-file artifact. Missing artifacts mean the run is still in
     proposal-writing, not apply-ready.
   - Use `~/brain/schema.md` frontmatter and compiled-truth + timeline shape.
   - Enforce the `## Language Contract`: proposal pages and proposed ledger rows
     use English for all durable memory, summaries, headings, aliases, preserved
     passages, source anchors, timeline entries, quality reasons, coverage text,
     and future retrieval phrases. Translate Russian source material instead of
     copying it.
   - Fill temporal metadata:
     - `formed_at` from source draft `created_at` or stronger event evidence.
     - `date` or `event_date` from the formed/event calendar day.
     - `recorded_at` as the current review run date.
     - `indexed_at` as empty or `pending-sync` until the sync step succeeds.
     - timeline entries include `formed`, `recorded`, `indexed`, and
       `confidence` fields in the source bracket when possible.
     - body includes `## Temporal Metadata` with Effective date, Formed at,
       Recorded at, and Indexed at.
   - Keep current understanding concise and sourced by timeline entries.
   - Use conservative confidence:
     - `low`: auto-capture only or weak evidence.
     - `medium`: credible draft plus repeated evidence or local file verification.
     - `high`: directly verified in current sources.
   - Curated pages must contain English synthesis, not transcript dumps.
   - For `originals/`, preserve the core authored claim and notable phrasing as
     faithful English translation instead of normalizing it into project/status
     prose.
   - For `preserve-full` items, use an indexed curated page shape:
     `## Preserved Note` (sanitized authored text, kept as complete as safety
     allows), optional `## Context` / `## Why It Matters`, then timeline. Keep
     source/provenance and temporal metadata, but do not include raw transcripts,
     secrets, unredacted paths, credentials, or local-only metadata.
   - For `preserve-substantial`, include `## Key Preserved Passages` or
     equivalent, then a short synthesis. Keep the parts whose wording/reasoning
     matters; do not keep whole raw logs.
   - For `synthesize`, preserve enough source-specific anchors that future
     agents can find the memory by project/person/command/error/phrase, not just
     by a generic topic.

7. **Apply**
   - In default mode, apply safe proposals without asking.
   - In `--dry-run`, stop after writing proposals and final report.
   - Apply only from validated proposal artifacts. Do not edit live curated pages
     first and backfill proposal state afterward; that hides review mistakes and
     makes the session unauditable.
   - Write curated files under the selected namespace. Update existing canonical pages when that is the right home.
   - Before appending each validated proposed ledger row, compute the final
     archive destination (`archive/inbox-reviewed/YYYY-MM/<file>.md`) and fill
     `archived_path`. Curated-memory rows must also include
     `target_timeline_entry` with a source ref matching the row hash and
     `source_excerpt_summary`.
   - Append the validated proposed ledger rows to
     `~/brain/inbox/review-ledger.jsonl`.
     Each row for this session must include `reviewed_at`, source identity
     (`source_path` plus `content_hash` / `dedupe_key` / `sha256`), `decision`,
     `importance_score`, `preservation_mode`, `evidence_quality`, and a
     concrete `quality_reason`, `coverage`, plus non-empty `memory_units`.
     Rows that create or update curated memory must include non-empty `targets` and
     `target_actions`. Each target must be covered by a `target_actions[]`
     entry with a concrete reason; `create`, `update`, and `supersede` require
     `compiled_truth_changed: true`.
     Use `templates/review-ledger-row.json` as the exact row shape example when
     constructing rows.
   - Do not permanently delete drafts.
   - Archive handled source drafts through the reusable helper, never with an
     ad-hoc `FileUtils.mv` of the live inbox path:

     ```bash
     ruby skills/dreams/scripts/archive-reviewed-sources.rb --brain ~/brain --session "$session"
     ```

     The helper copies the frozen `inventory.json.source_snapshot` into
     `~/brain/archive/inbox-reviewed/YYYY-MM/`, writes the tracked archive
     manifest under `archive/dreams-session-audits/<session>/`, removes the live
     inbox source only when its current `sha256` still matches inventory, and
     leaves same-path changed files in inbox as `new_pending_after_inventory` for
     the next run. If rerun after staged redaction changed an archived evidence
     file, the helper must preserve the redacted archive when the existing
     manifest already proves it was originally archived from the reviewed
     snapshot.
   - Archive handled source drafts for `promoted`, `low-confidence-promoted`, `source-note`, `discarded`, and `duplicate`.
   - Leave only `blocked-safety` drafts in `inbox`, because moving them could hide material that failed safety checks.
   - For session-owner runs, export the sanitized tracked audit bundle after
     ledger rows exist and before final safety/commit gates:

     ```bash
     ruby skills/dreams/scripts/export-session-audit.rb --brain ~/brain --session "$session"
     ```

     Commit the generated
     `archive/dreams-session-audits/<session-id>/session-owner-audit.json`
     together with the reviewed memory. Do not commit `.dreams/` source
     snapshots, task prompts, or raw session state.
   - The archive and inbox are not memory surfaces. Do not run a sync/import
     path that indexes `~/brain/archive/**`, `~/brain/inbox/**`,
     `~/brain/raw/**`, or other non-allowlisted paths; they are git/filesystem
     evidence only.
   - After archive moves are complete, update the Postgres evidence lookup
     layer for this session:

     ```bash
     gbrain evidence index-ledger --brain-repo ~/brain --source <source_id> --session "$session" --include-archive-excerpts
     ```

     This is the only supported archive drilldown indexing path. Do not replace
     it with `gbrain sync`, `gbrain import`, or semantic search over archive
     files.
   - The evidence index is complete only if target-based lookup works for
     curated rows. Each allowlisted `targets[]` / `target_actions[].path` value
     written in the session ledger must become discoverable through
     `get_evidence({target_slug})`; source-note rows without a curated target may
     remain ref/hash-only.

8. **Safety Verification**
   - For every proposed, applied, archived, or ledger markdown/jsonl/json file,
     run the redactor through a temp file and compare bytes. Do not compare
     Ruby/Bash strings; encoding differences can produce false failures on
     large captures:

     ```bash
     tmp="$(mktemp "${TMPDIR:-/tmp}/brain-redacted-check.XXXXXX")"
     ruby ~/brain/.scripts/redact_ai_source.rb <file> > "$tmp"
     cmp -s <file> "$tmp"
     rm -f "$tmp"
     ```

   - If `cmp` differs, block that file from promotion/archive and continue with the rest.
   - Before commit, stage intended files and run:

     ```bash
     cd ~/brain
     ruby skills/dreams/scripts/sync-temporal-metadata.rb --brain ~/brain
     ruby skills/dreams/scripts/validate-session-owner-reports.rb --session "$session" --inventory "$session/inventory.json"
     ruby skills/dreams/scripts/validate-review-ledger.rb --brain ~/brain --session "$session" --require-target-diff --require-proposal-current-match --require-evidence-drilldown
     ruby skills/dreams/scripts/validate-curated-pages.rb --brain ~/brain --allow-pending-index
     ruby skills/dreams/scripts/check-index-allowlist.rb
     ruby skills/dreams/scripts/test-archive-reviewed-sources.rb
     ruby skills/dreams/scripts/test-check-index-allowlist.rb
     ruby skills/dreams/scripts/test-export-session-audit.rb
     ruby skills/dreams/scripts/test-init-session-state.rb
     ruby skills/dreams/scripts/test-validate-curated-pages.rb
     ruby skills/dreams/scripts/test-sync-temporal-metadata.rb
     ruby skills/dreams/scripts/test-finalize-session-state.rb
     ruby skills/dreams/scripts/test-inventory.rb
     ruby skills/dreams/scripts/test-skill-contract.rb
     ruby skills/dreams/scripts/test-session-owner-workflow.rb
     ruby skills/dreams/scripts/test-validate-session-state.rb
     ruby skills/dreams/scripts/test-validate-review-ledger.rb
     ruby skills/dreams/scripts/test-stamp-indexed-at.rb
     ruby skills/dreams/scripts/test-review-session-counts.rb
     ruby skills/dreams/scripts/test-redact-staged-artifacts.rb
     for f in skills/dreams/templates/*.json; do ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$f"; done
     ruby skills/dreams/scripts/redact-staged-artifacts.rb --brain ~/brain --apply
     ./.scripts/pre-commit-brain-guard.sh
     git status --short
     ```

   - If ledger validation fails, fix the classification rows, proposal mirrors,
     or applied curated pages, or reclassify the affected drafts. Do not bypass
     the validator.
   - Before sync or commit, inspect the session proposal artifacts. A session
     that changed curated memory but left only
     `"$session/proposals/review-ledger.jsonl"` is incomplete even if the live
     curated pages and ledger currently validate. Add the missing proposed
     final-content artifacts, then re-run proposal and ledger checks.
   - The validator also checks that every draft in the session inventory has a
     ledger row. A run is not complete if any inventoried draft is missing from
     reconciliation, even when the missing item looked like obvious noise.
   - The validator also checks multi-segment stop-hook sessions: every expected
     segment from `inventory.json.segment_manifest` must appear in
     `coverage.session_coverage.segments[]`, every segment must reference
     audited `memory_units[]`, and session rows must carry the live inventory
     `dedupe_key` or `sha256` rather than only a stale frontmatter
     `content_hash`.
   - With `--require-target-diff`, promoted rows must also match the actual git
     diff: `create` / `update` / `supersede` must change the compiled-truth
     section, while `append-timeline` must leave compiled truth unchanged and
     change only timeline/provenance.
   - The diff gate also rejects any changed curated markdown file that has no
     `target_actions[]` entry for the active session. Body/frontmatter temporal
     stamps such as `Indexed at` do not count as compiled-truth changes.
   - Untracked curated markdown files fail the diff gate. Stage intended new
     pages before validation, or remove accidental files; do not let untracked
     pages sit outside ledger reconciliation.
   - `sync-temporal-metadata.rb` rewrites the body `## Temporal Metadata`
     section from frontmatter for changed or untracked curated pages before
     validation. It is a normalizer, not a validator; still run
     `validate-curated-pages.rb`.
   - `validate-curated-pages.rb` checks changed or untracked curated pages for
     schema basics, temporal metadata, body/frontmatter temporal consistency,
     final `indexed_at` stamping, timeline presence, and raw stop-hook metadata
     markers.

   The guard must stay staged-scope. Do not run broad secret scans over
   skill install directories, `$HOME`, `.gbrain`, `.dreams/sources`, archive history, or full
   large repositories from this skill; if broader forensics are needed, stop and
   record that they require explicit user approval. Do not run ad hoc
   `gitleaks protect --staged --verbose` as a diagnostic on large staged
   archives; use `./.scripts/pre-commit-brain-guard.sh`, inspect its bounded
   redacted output, and use
   `ruby skills/dreams/scripts/redact-staged-artifacts.rb --brain ~/brain --apply`
   when the staged redactor byte-compare would otherwise fail one archive file
   at a time.

9. **Sync / Commit / Push**
   - Ensure all intended curated pages, ledger rows, archive snapshot files,
     `archive-manifest.json`, and report updates are staged before the first
     sync/embed pass. This lets
     `stamp-indexed-at.rb` discover both modified tracked files and newly
     created curated pages through `git diff HEAD`.
   - Run `~/brain/.scripts/gbrain-sync.sh` unless `--no-sync` or `--dry-run`.
   - Before and after sync, verify that the active generated index has no
     active pages outside the allowlisted prefixes. If it does, clean only those
     generated index rows and rerun the check; do not delete markdown evidence.
     Use:

     ```bash
     ruby skills/dreams/scripts/check-index-allowlist.rb
     ```
   - After successful sync/embed, stamp every newly promoted or materially
     updated curated page with `indexed_at: <sync completion ISO timestamp>` and
     update matching new timeline source brackets from `indexed: pending-sync`
     to the same timestamp:

     ```bash
     indexed_at="$(date -Iseconds)"
     ruby skills/dreams/scripts/stamp-indexed-at.rb --brain ~/brain --timestamp "$indexed_at"
     ruby skills/dreams/scripts/sync-temporal-metadata.rb --brain ~/brain
     ```

     Then run `~/brain/.scripts/gbrain-sync.sh` once more so the indexed
     timestamp itself is present in `gbrain`. If this second sync fails, do not
     claim the memory is indexed; leave the run uncommitted unless `--no-commit`
     was requested and record the failure.
   - After the second sync, rerun the final gates that require completed
     indexing state:

     ```bash
     ruby skills/dreams/scripts/validate-curated-pages.rb --brain ~/brain --all-curated
     ruby skills/dreams/scripts/validate-review-ledger.rb --brain ~/brain --session "$session" --require-target-diff --require-proposal-current-match --require-evidence-drilldown
     ruby skills/dreams/scripts/check-index-allowlist.rb
     ```

   - Run targeted retrieval smoke checks for representative newly promoted or
     materially updated targets. Use English retrieval phrases only. Cover the
     situation, not every page:
     - `gbrain call get_evidence '{"target_slug":"<target-slug>","limit":5}'`
       for one changed curated target that had a non-safety ledger row, verifying
       that reviewed provenance is reachable by target slug without searching
       `inbox/` or `archive/`. If only source-note rows changed, smoke the exact
       ref/hash instead with `gbrain evidence <ref> --json`.
     - `query` with `include_meta=true` for one semantic/context target, then
       inspect whether vector search ran and which embedding column was used;
       if the active Codex MCP schema does not expose `include_meta`, run the
       same smoke through the local raw op instead:
       `gbrain call query '{"query":"<English target>","limit":5,"detail":"low","source_id":"__all__","include_meta":true}'`;
     - `query_scan` with `page_size` and `type`/`types` for one "find all"
       target, verifying `has_more` / `next_cursor` behavior when present;
     - `temporal_search` with `date_kind=indexed` for the sync day, and
       `date_kind=formed` when the promoted memory is date-sensitive.
     If a smoke result supports the final report, read the full page by slug
     before relying on the excerpt. If a smoke query is empty but the page was
     synced, treat it as an index/retrieval defect and resolve it before
     commit.

   - Re-stage the stamped curated pages and any generated report/ledger changes
     before committing. Do not assume files staged before the stamp still
     contain the final `indexed_at` edits.
   - After re-staging final stamped content, rerun the staged-scope guard before
     commit:

     ```bash
     ruby skills/dreams/scripts/redact-staged-artifacts.rb --brain ~/brain --apply
     ./.scripts/pre-commit-brain-guard.sh
     git status --short
     ```

   - This applies equally to newly created pages and updated existing pages:
     `gbrain sync --full --no-embed` imports changed allowlisted pages, and
     `gbrain embed --stale` refreshes stale chunks for changed content.
   - Commit unless `--no-commit` or `--dry-run`.
   - Push unless `--no-push`, `--no-commit`, or `--dry-run`.
   - Use a concise commit such as `chore(memory): review brain drafts`.
   - If there are no file changes after review, do not create an empty commit; still write the session report.

10. **Finish**
   - Finalize terminal state and report counts from the session ledger instead
     of hand-counting or retyping numbers:

     ```bash
     ruby skills/dreams/scripts/finalize-session-state.rb --brain ~/brain --session "$session"
     ```

     This marks `state.json` as `active=false`, `phase=done`, stamps
     `completed_at`, calculates decision/mode/score count maps from ledger
     rows, writes the same canonical `## Counts` JSON block into
     `reports/SUMMARY.md`, and writes `state.post_inventory_inbox_audit` plus
     the matching `## Post-Inventory Inbox Audit` section. It refuses to
     finalize non-empty sessions unless `validate-review-ledger.rb` accepts the
     same ledger against the session inventory.
   - Run `validate-session-state.rb` only after finalization, and fix any
     mismatch before reporting completion:

     ```bash
     ruby skills/dreams/scripts/validate-session-state.rb --brain ~/brain --session "$session"
     ```

   - Report counts by classification, memory-handling-mode counts, score bands
     (`0-3`, `4-6`, `7-10`, `11+`), full/substantial-preserve drafts and their
     target curated files, files applied/archived, safety checks run,
     sync/commit/push status, and unresolved blockers.
   - Report the post-inventory inbox audit explicitly. Separate:
     current-session `blocked-safety` drafts, previous blocked-safety leftovers,
     new pending drafts captured after this run's inventory, non-safety handled
     drafts that incorrectly remained in inbox, and pre-existing unledgered
     drafts not in inventory. Never summarize these as only "remaining
     untracked paths"; that hides whether the completed run is valid or whether
     the next `$dreams` run has new work waiting.
   - Report the proposal audit explicitly: which target namespace READMEs were
     read, how many curated targets had proposed final-content artifacts, and
     whether any curated edit was applied without a proposal artifact. If any
     curated edit lacks such an artifact, say the run is
     procedurally incomplete even when the final markdown validates. Do not
     hand-count this section; use the `finalize-session-state.rb` generated
     `## Proposal Audit` section, and treat a stale placeholder value as a
     failed run state.
     Use a dedicated `## Proposal Audit` section with at least these bullets:
     `Target namespace READMEs read: ...`, `Curated targets with proposed
     final-content artifacts: N/N`, and `Curated edits without proposal
     artifact: none|...`.
   - Include a quality-audit sample of at least 10 handled drafts, or all drafts
     if fewer than 10. The sample must include every `preserve-full`,
     `preserve-substantial`, and `blocked-safety` item, plus representative
     `synthesize`, `source-note`, and `discard` items with score, reason, and
     anti-summary rationale for every full/substantial preserve item.
   - The run is successful if safe items were processed and ambiguous/conflicting items were resolved by policy without blocking the batch.

## Session Owners And Subagents

For stop-hook `session_id` groups, session-owner subagents are mandatory when
the current Codex session has subagent tools available. For non-session drafts,
use subagents only when the user explicitly asks for parallel agents or the
current Codex policy allows delegation for this run.

Good split for large batches:

- session owner: one owner per `inventory.json.session_groups[]` item with a
  `session_id`. The owner reads the full copied session snapshot(s), follows the
  segment manifest in order, and returns one session-level classification report
  with complete `coverage.session_coverage`.
- classifier: classify non-session drafts and detect duplicates.
- curator: write proposal pages from approved source/session reports.
- safety reviewer: check redaction, provenance, schema risks, and segment
  coverage parity.

For huge stop-hook sessions, spawn one session owner per session group when
delegation is available. Do not split one session across unrelated agents that
cannot reconcile the whole conversation. If the session exceeds a worker's
context, the session owner must split it into deterministic segment windows
(`segment-1..segment-N`) and produce one merged coverage matrix before handing
results back to the Lead.

Session owner output schema:

```json
{
  "session_id": "019...",
  "agent_id": "spawned-session-owner-agent-id",
  "source_paths": ["inbox/auto/YYYY-MM-DD/file.md"],
  "source_snapshot_paths": [".dreams/<session>/sources/<hash>-file.md"],
  "expected_review_units": ["segment-1", "segment-2"],
  "covered_review_units": [
    {
      "unit_id": "segment-1",
      "status": "reviewed",
      "source_sha256": "<segment/source hash from review_unit_manifest when present>",
      "summary": "English summary of durable and discarded material in this segment",
      "memory_unit_indexes": [0]
    }
  ],
  "memory_units": [],
  "draft_decision": "promoted|low-confidence-promoted|source-note|discarded|duplicate|blocked-safety",
  "preservation_mode": "preserve-full|preserve-substantial|synthesize|source-note|discard|duplicate|blocked-safety",
  "target_recommendations": [],
  "coverage_notes": "All expected review units reconciled; no unit skipped.",
  "written_at": "<ISO8601>"
}
```

The Lead converts the session owner report into exactly one ledger row per
inventoried session draft/source path, with `coverage.session_coverage` and
segment-anchored `memory_units[]`. The Lead still checks proposals, target
diffs, evidence drilldown, validators, final report, commit, and push.

Every subagent brief must restate the relevant source boundary and evidence
contract: read reviewed `~/brain/inbox/**` drafts or copied session snapshots,
never promote from raw `~/.gbrain/inbox/**`, never index `inbox/` or `archive/`,
make curated rows discoverable by future `get_evidence({target_slug})`
lookups through `targets[]`, `target_actions[]`, and stable source refs, and
for stop-hook sessions include the full `session_id`, expected segment ids,
segment manifest hashes, and copied source snapshot paths. A subagent may
report classifications or proposal text; Lead still validates and indexes the
evidence layer.

Lead still owns final synthesis, filesystem writes, verification, commit, and push decisions.
