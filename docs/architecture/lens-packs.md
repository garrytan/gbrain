# Lens packs (v0.41.2.0)

Four bundled schema packs that turn the gbrain dream cycle into a multi-lens
brain. Activate one with `gbrain config set schema_pack <name>` and the cycle
picks up the pack's declared phases on the next `gbrain dream` run.

## The four packs

```
                gbrain-base (shipped v0.38)
                       ▲
                       │ extends
        ┌──────────────┼──────────────────────┐
        │              │                       │
   gbrain-creator  gbrain-investor      gbrain-engineer
   (atom + concept  (deal/thesis/        (learning bridge
    lifecycle)       bet_resolution)      for gstack)
        │              │                       │
        └──────────────┼───────────────────────┘
                       │ extends + borrow chain
                       ▼
              gbrain-everything (meta-pack)
              one brain, three lenses active
```

### gbrain-creator
Atom + concept content-creator lifecycle. Drives two cycle phases:

- `extract_atoms`: per source, the model configured at
  `models.dream.extract_atoms` extracts 1-3 atoms from each
  transcript with the closed 11-value `atom_type` enum (insight,
  anecdote, quote, framework, statistic, story_angle, strategy_angle,
  strategy, endorsement, critique, collection). Writes
  `atoms/{YYYY-MM-DD}/{slug}` pages. The default model is
  `anthropic:claude-haiku-4-5`. The default budget cap is
  $0.30/source/run and can be changed with
  `cycle.extract_atoms.budget_usd`. Phase results report the selected model,
  actual estimated spend, the configured budget, and whether the budget was
  exhausted.
- `synthesize_concepts` — globally aggregates atoms by frontmatter
  `concepts:` ref. Tier by count: T1 ≥10, T2 ≥5, T3 ≥2. T1/T2 get
  Sonnet narratives; T3 falls back to a deterministic stub. Writes
  `concepts/{slug}` pages. Budget cap $1.50/run.

Current `master` does not add `concepts:` labels to newly extracted atoms.
Concept synthesis therefore works only for atoms that already carry those
labels, such as imported or manually tagged atoms. Run `gbrain dream` for the
phases, but do not expect untagged atoms to become concept pages automatically.

The atom drain also stops after a batch that extracts and skips zero atoms.
Pages that produce no atoms are not tombstoned, so they can remain in the
reported backlog and be rediscovered on a later run. Treat `remaining` and
`stopped` as the result. Do not infer that a zero-yield run drained the backlog.

One calibration domain: `concept_themes` / cluster_summary / [concept]
— tier histogram + page count, not Brier (concepts don't have binary
outcomes to score against).

### gbrain-investor
YC / investor lens. Declares 2 net-new page types on top of
gbrain-base's deal/person/company/yc seed:

- `thesis` (NEW) — investment thesis with thesis_text + key_bets[] +
  market_view + vintage. Files at `investing/theses/{slug}`. Extractable
  (the LLM mines claims into facts).
- `bet_resolution_log` (NEW) — outcome record for a thesis's bet. FK
  to a take row via take_id; carries resolved_outcome + resolved_at +
  learned_pattern. Files at `investing/bets/{YYYY-MM}/{slug}`.

No new cycle phases — consumes the existing
extract_facts/propose_takes/grade_takes/calibration_profile loop. Three
calibration domains: `deal_success` (scalar_brier over deal-attached
takes), `founder_evaluation` (scalar_brier over person-attached takes),
`market_call` (weighted_brier over thesis-attached takes; weighted by
conviction so high-stakes misses cost more).

### gbrain-engineer
Bridge-only pack. Declares `learning` page type + reuses base `code`.
No new cycle phases — the daemon-side `gstack-learnings` IngestionSource
(T8) watches `~/.gstack/projects/{repo}/learnings.jsonl` and emits
each JSONL line as a `learning` page when this pack is active. Three
calibration domains: `architecture_calls` (scalar_brier),
`effort_estimates` (weighted_brier), `risk_assessment` (scalar_brier).

Speculative ADR/postmortem/refactor_thesis/tech_debt types deferred
to v0.42+ — they'll ship when a real user authors the first one (D8).

### gbrain-everything
Meta-pack stacking creator + investor + engineer via the v0.38
`extends` + `borrow_from` chain. Single-active-pack constraint
preserved — this IS the active pack; the registry walks extends +
borrow to materialize the merged view.

Activate via `gbrain config set schema_pack gbrain-everything` and
calibration_profile produces all 7 domain scorecards in one JSONB.

## Calibration profile widening (T10)

Before v0.41.2.0, `calibration_profiles.domain_scorecards` was a
`JSON.stringify({})` placeholder. v0.41.2.0 widens it: each declared
domain produces a `{n, brier, accuracy, aggregator, page_types,
extras}` entry. Four aggregator algorithms (closed enum):

- **scalar_brier** — `AVG(POWER(weight - outcome::int, 2))`. Default for
  probabilistic predictions.
- **weighted_brier** — Brier weighted by `ABS(weight - 0.5) * 2`
  (conviction proxy). High-conviction misses cost more.
- **count_based** — simple `SUM(hit) / COUNT(*)` accuracy without
  Brier. Use when probability isn't natural.
- **cluster_summary** — descriptive rollup (page count + tier
  histogram). For domains like `concept_themes` where there's no
  binary outcome.

Pack manifests declare domains with `{name, aggregator, page_types}`.
Domain names are OPEN (third-party packs can declare new domain labels
without a gbrain release). Aggregator algorithms are CLOSED (safe SQL
stays in code, validated at pack-load).

## take_domain_assignments table (T1)

New JOIN table (migration v94):
`take_domain_assignments(take_id BIGINT FK, domain TEXT, pack TEXT,
source TEXT, confidence REAL, assigned_at TIMESTAMPTZ, PK(take_id,
domain))`. Multi-domain assignment honest — a take about "Sequoia's
investment in Anthropic" can land in BOTH `deal_success` AND
`market_call` rather than being force-bucketed.

## What this enables for the user

- **Atom extraction and concept synthesis ship in the binary.** One
  `gbrain dream` schedule can run both phases. Newly extracted atoms do not
  receive concept labels on current `master`, so imported or manual labels are
  still required before concept synthesis can group them.
- **gstack learnings reach gbrain.** Engineer-pack-active brains
  surface every gstack-logged learning as a queryable page within
  seconds of being written.
- **Multi-lens calibration.** Activate gbrain-everything and see how
  often you're wrong on deals AND market calls AND architecture
  AND effort estimates in one `gbrain calibration --json` call.
- **Lossless OpenClaw migration.** The `markdown-greenfield`
  importer (T7, mode='migration') re-ingests existing OpenClaw
  pages with permanent slug-keyed idempotency + per-row JSONL audit
  + the `imported_from` marker so extract_atoms + synthesize_concepts
  don't re-extract already-atomized material.

## v0.41.2.1 follow-ups (filed in plan)

- Per-page-type `frontmatter_validators` on PageTypeSchema so the
  atom_type enum (currently hardcoded in extract_atoms.ts) reads from
  the active pack manifest at runtime per D11.
- 3-check quality gate (truism / punchline / entity-page reject) as
  a multi-pass extract_atoms refinement.
- Embedding-similarity dedup in synthesize_concepts (currently
  exact-string concept ref match only).
- Voice gate integration for T1 Canon narratives.
- op_checkpoint resumability for cross-cycle continuation in both
  phases.
- Parity-baseline eval gates against your OpenClaw's existing 13K atoms
  + 11K concepts on a 500-page sample subset.
