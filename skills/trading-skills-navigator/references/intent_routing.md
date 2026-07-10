# Intent Routing Rubric

`scripts/recommend.py` is the **single source of truth** for routing. This
document explains the engine; it does not re-implement it (no drift test in
Phase 1 — the script's golden suite is the contract).

## Engine overview

1. Normalize the query (lowercase, collapse whitespace). **Bilingual** — every
   persona carries both English and Japanese trigger terms, so the recommender
   routes a JA goal (e.g. 「配当株を探したい」「APIキー無しで使えるもの」「スイング
   トレードをしたい」) the same as its English equivalent. (`.lower()` leaves
   Japanese unchanged; mixed-case "API" folds to "api", which the JA no-API
   terms account for.)
2. Walk the **ordered persona table**. The **first** matching persona wins.
3. A persona either names a `primary` workflow (+ optional `secondary`), or an
   `gap_category` (honest gap — no workflow shipped).
4. Apply constraint filters (`--no-api`, `--time-budget`, `--experience`).
5. Emit a stable JSON recommendation, including `no_api_path` (see below).

If **no** persona matches, the input is treated as unmapped → a graceful
**beginner default** (`market-regime-daily`, `honest_gap: false`) with a
`note` asking the user to rephrase. This is distinct from an *honest gap*
(personas #7/#10), which is a recognized intent with no shipped workflow.

## Persona table (order matters)

Evaluated top-to-bottom; first match wins. Order encodes precedence:

| # | Persona | Trigger gist | Result |
|---|---|---|---|
| 1 | `short-strategy-trader` | "short strategies / shorting / parabolic short" | honest gap → `advanced-satellite` |
| 2 | `strategy-researcher` | "backtest / research a strategy / strategy ideas" | honest gap → `strategy-research` |
| 3 | `no-api-path` | "without API / no API keys / no subscription" | `market-regime-daily` + {`trade-memory-loop`, `monthly-performance-review`}, force `no_api` |
| 4 | `part-time-swing-trader-regime-gated` | "swing" **AND** regime-conditional ("only when", "favorable", "when the market") | `market-regime-daily` + `swing-opportunity-daily` |
| 5 | `morning-risk-check` | "15 min each morning / can I take risk today" | `market-regime-daily` |
| 6 | `separate-core-satellite` | "separate / split long-term from short-term risk" (not "dividend") | `market-regime-daily` + `core-portfolio-weekly` |
| 7 | `dividend-long-term-investor` | "dividend / holdings / rebalance / long-term investor" | `core-portfolio-weekly` |
| 8 | `swing-trader` | "swing / breakout" (no regime gate) | `swing-opportunity-daily` |
| 9 | `beginner-onramp` | "beginner / where do I start / getting started" | `market-regime-daily` |
| 10 | `trade-journaler` | "journal / postmortem / closed trade / lessons learned" | `trade-memory-loop` |
| 11 | `monthly-reviewer` | "monthly review / end of month / performance review" | `monthly-performance-review` |

**Critical orderings**

- #1/#2 (honest gaps) before everything so "short strategies" / "backtest" are
  not swallowed by accidental keyword overlap.
- #1 triggers only on short-**selling** phrases ("short strateg", "shorting",
  "go short", "short position"…) — it deliberately does **not** match
  "short-term", so #6 ("separate long-term holdings from short-term risk")
  still routes to the regime layer.
- #4 (swing **and** regime-conditional) before #8 (generic swing): Q1
  ("swing trade only when the market is favorable") → regime first; Q5
  ("do swing trading") → swing directly.
- #6 before #7 and excludes "dividend": "separate long-term holdings from
  short-term risk" → regime/core split, not the dividend bucket.

## The 10-Question Contract

`PROJECT_VISION.md` §12 lists 9 example questions and a DoD of "10". Q1–Q9 are
verbatim; **Q10 is authored** to complete the executable contract. Each row is
a golden test in `tests/test_recommend.py` (the hard Phase-1 gate).

| # | Question | Primary | Secondary | Skillset | no-API | honest-gap |
|---|---|---|---|---|---|---|
| 1 | invest long term but swing trade only when market favorable | `market-regime-daily` | `swing-opportunity-daily` | market-regime | no | no |
| 2 | 15 min each morning, can I take risk today | `market-regime-daily` | — | market-regime | yes | no |
| 3 | separate long-term holdings from short-term risk | `market-regime-daily` | `core-portfolio-weekly` | market-regime | no | no |
| 4 | review holdings and dividend candidates this week | `core-portfolio-weekly` | — | core-portfolio | no | no |
| 5 | do swing trading | `swing-opportunity-daily` | — | swing-opportunity | no | no |
| 6 | find dividend stocks | `core-portfolio-weekly` | — | core-portfolio | no | no |
| 7 | use short strategies | **null** | — | advanced-satellite | — | **yes** |
| 8 | what works without API keys | `market-regime-daily` | `trade-memory-loop`, `monthly-performance-review` | market-regime | yes | no |
| 9 | beginner-friendly starting path | `market-regime-daily` | — | market-regime | yes | no |
| 10 | research and backtest new strategy ideas *(authored)* | **null** | — | strategy-research | — | **yes** |

Q8 honors the single-`primary_workflow` schema: primary is
`market-regime-daily`; the rest of the no-API set are `secondary_workflows`;
`skillset` is the primary's category (`market-regime`).

## Skillset rule

`skillset.id` = the skills-index **category of the workflow's first required
skill** (manifest order). Not "most common category": e.g.
`swing-opportunity-daily`'s required skills span swing-opportunity /
trade-planning / trade-memory; only the first (`vcp-screener` →
`swing-opportunity`) yields the contract-correct skillset. `source` is always
`skills-index.category`.

`manifest_status` (PR-N2): `active` iff a `skillsets/<skillset.id>.yaml`
manifest ships (the manifest `id` == the skills-index category, so the lookup
is a direct match — carried as the `skillsets` list in the SSoT / bundled
snapshot). Today the shipped set is `market-regime`, `core-portfolio`,
`swing-opportunity`, `trade-memory` → those report `active`. Categories with no
manifest — including every honest-gap category (`advanced-satellite` for #7,
`strategy-research` for #10) — report `deferred`. The skillset object shape is
unchanged (`{id, source, manifest_status}`); only the status value reflects
manifest presence.

`skillset.manifest` (PR-N3): always present in the `skillset` object — a 5-key
view `{display_name, required_skills, recommended_skills, optional_skills,
related_workflows}` when `manifest_status == active`, else `null`. It describes
the **primary (dominant-category) skillset only** — it is *not* the install
list.

`setup_bundle` (PR-N3, top-level): the actionable install union over the
primary skillset/workflow **plus every secondary workflow**'s
required/optional, deterministically ordered (primary first, then secondaries
in `secondary_workflows` order) and tier-deduped (required > recommended >
optional). `sources` records each contributor (`skillset:<id>` /
`workflow:<id>`). This exists because a single skillset cannot cover a
multi-workflow recommendation — e.g. Q1's `market-regime` skillset alone would
drop `swing-opportunity-daily`'s `vcp-screener`. Honest gap → all-empty
(`suggested_skills` is the install list there). `setup_bundle` is what
`setup_paths.md` / `SKILL.md` Step 4 instruct the user to install.

## The `--no-api` credential rule

A workflow needs a paid key if **either**:

- `api_profile ∈ {fmp-required, finviz-required, alpaca-required}`, **or**
- any entry in its `required_skills` has an integration with
  `id ∈ {fmp, finviz, alpaca}` **and** `requirement == required`.

`api_profile: mixed` is **never** trusted on its own — the required-skill
credentials are always inspected. Consequences:

- `core-portfolio-weekly` is `mixed` but its required `portfolio-manager`
  needs Alpaca (`required`) → excluded under `--no-api`.
- `swing-opportunity-daily` is `fmp-required` → excluded.
- `market-regime-daily` is `no-api-basic`; its required skills use
  `public_csv` at `required` — **not a paid key** → kept.
- `trade-memory-loop` / `monthly-performance-review` are `no-api-basic`;
  `trader-memory-core` has FMP at `optional` (not required) → kept.

When `--no-api` removes the persona's primary, the engine falls back to the
universal no-API on-ramp (`market-regime-daily`) and records the exclusion
reason in `rationale`. Honest gaps are unaffected (they have no primary).

## `no_api` vs `no_api_path` (the DoD's API-vs-no-API separation)

Two distinct booleans — narrate `no_api_path`, not `no_api`:

- **`no_api`** — *request-side*: was no-API constraint mode active (the
  `--no-api` flag, or the `no-api-path` persona forcing it). It says nothing
  about whether the result actually needs keys.
- **`no_api_path`** — *path-side*: does the **entire** recommendation (primary
  **and every** secondary) work without paid API keys?
  `workflow_paid_api_reason(primary) is None and all(... for secondary)`.
  `null` on an honest gap (no path). This is the 10-Question Contract's
  "no-API" column.

This is why Q1 and Q2 both recommend `market-regime-daily` yet differ: Q2 has
no secondary → `no_api_path: true`; Q1 also pulls in `fmp-required`
`swing-opportunity-daily` → `no_api_path: false`. A bare
`market-regime-daily`/`trade-memory-loop`/`monthly-performance-review` path is
`true` even without `--no-api`, which is exactly the DoD's "separate API-key
and no-API paths".

## Tie-breaks

- **`--time-budget`** (`15m/30m/60m/90m/any`): secondary workflows whose
  `estimated_minutes` exceed the budget are dropped (primary is never dropped —
  it stays as the best intent match, with a `rationale` note if it is over
  budget).
- **`--experience`**: `beginner` sorts beginner-difficulty secondaries first.
- Secondary order is otherwise deterministic: `(beginner_first,
  estimated_minutes, id)`.

## Honest gap output

For personas #1/#7 (`advanced-satellite`) and #2/#10 (`strategy-research`):
`primary_workflow: null`, `secondary_workflows: []`, `skillset.id` = the gap
category, `suggested_skills` = that category's non-deprecated skills
(id-sorted, `{id, display_name, category}`), `honest_gap: true`, and a `note`
stating the workflow manifest is deferred. Exit code is still `0` — an honest
gap is a successful, honest recommendation.
