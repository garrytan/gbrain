---
name: trading-skills-navigator
description: >-
  Recommend the right trading workflow, skillset, API profile, and setup path
  from a natural-language goal. Use this as the on-ramp when a user expresses a
  trading or investing goal and needs to know which skill/workflow to use, where
  to start, or whether something works without paid API keys — e.g. "where do I
  start", "which skill should I use", "I want to swing trade only when the market
  is favorable", "what works without API keys", "どれを使えばいい", "API キー無しで
  使えるものは". Routes and explains only; it never executes trades or auto-runs
  other skills, and it is honest when no workflow has shipped yet.
---

# Trading Skills Navigator

The interactive on-ramp for this repository. It turns a user's goal into a
concrete recommendation: which **workflow** to run, which **skillset**
(skills-index category) it belongs to, the **API requirement**, and the
**setup path** for Claude Web App or Claude Code.

A new user faces 64 skills + 9 workflows with no router. This skill is that
router. It is **deterministic** — a Python recommender (`scripts/recommend.py`)
consumes the repo metadata; this SKILL.md narrates the result conversationally.

## When to Use

- The user expresses a trading/investing goal and asks where to start or which
  skill/workflow to use ("どれを使えばいい", "where do I start").
- The user asks what works **without paid API keys**.
- The user wants the no-API vs API path separated, or a beginner path.
- The user describes a persona ("part-time swing trader", "dividend investor",
  "I want to short", "I want to backtest ideas") and needs routing.

Do **not** use this skill to execute trades, place orders, or auto-run other
skills. It recommends and explains only.

## Workflow

### Step 1 — Capture the goal and constraints

From the user's message, extract:

- The natural-language **goal** (verbatim is fine).
- Optional constraints: **no-API** only? a daily **time budget**
  (15m/30m/60m/90m)? **experience** level (beginner/intermediate/advanced)?

Ask at most one brief clarifying question only if the goal is empty or has no
discernible intent. Otherwise proceed — the recommender degrades gracefully.

### Step 2 — Run the recommender

```bash
python3 skills/trading-skills-navigator/scripts/recommend.py \
  --query "<the user's goal, verbatim>" \
  --format json
  # optional: --no-api  --time-budget 15m|30m|60m|90m|any
  #           --experience beginner|intermediate|advanced
```

- In **Claude Code** the script reads the repo-root SSoT
  (`skills-index.yaml` + `workflows/*.yaml`) automatically.
- In the **Claude Web App** there is no repo root; the script transparently
  falls back to the bundled `assets/metadata_snapshot.json`. The recommendation
  is byte-identical in both environments — no behavior change for the user.

### Step 3 — Narrate the result conversationally

Parse the JSON and explain, in the user's language:

- **Primary workflow** — `display_name`, `cadence`, `~estimated_minutes`,
  `api_profile`. State plainly what it does and when to run it.
- **Secondary workflows** — if any, how they relate (e.g. "run the regime
  check first, then this when it allows risk").
- **Skillset** — the `skillset.id` (skills-index category).
  `manifest_status: active` means a curated `skillsets/<id>.yaml` bundle ships
  for this category (market-regime, core-portfolio, swing-opportunity,
  trade-memory) — mention it as the install bundle for the recommended
  workflow. `manifest_status: deferred` means no manifest yet (e.g. honest-gap
  categories); the recommendation is workflow-based only.
- **No-API vs API** — read `no_api_path`: `true` → the entire recommended path
  works without paid API keys (state this plainly); `false` → tell the user
  which paid key(s) the path needs; `null` → honest gap, no path. (`no_api` is
  the *request* flag — whether no-API mode was active — not whether the path is
  free; always narrate `no_api_path`.) If a workflow was excluded under
  `--no-api`, surface the `rationale` entry naming the paid integration (e.g.
  "swing-opportunity-daily needs FMP").
- **Honest gap** — if `honest_gap` is true there is **no shipped workflow** for
  this intent. Say so directly, then present `suggested_skills` from the
  relevant category and relay the `note`. Never invent a workflow.
- Always read the `rationale` array and explain *why* this was recommended.

### Step 4 — Explain the setup path

Read `references/setup_paths.md` and walk the user through installing
**`setup_bundle`** — the recommender's deterministic install union over the
primary skillset **and every secondary workflow** (so nothing is dropped for a
multi-workflow recommendation). Enumerate `setup_bundle.required` →
`recommended` → `optional`, cite `setup_bundle.sources` to explain *why* each
skill is needed, and name `skillset.manifest.related_workflows` for *how* the
bundle is run. Narrate `skillset.manifest` (when present) as "what the
recommended skillset is". On an honest gap install `suggested_skills`. Do this
for whichever environment the user is in (Claude Web App `.skill` upload, or
Claude Code folder copy); call out any paid API keys those skills need.

### Step 5 — Point to the learning loop

Close by pointing the user at `trader-memory-core` and the
`trade-memory-loop` / `monthly-performance-review` workflows so every
recommended path feeds the Plan → Trade → Record → Review → Improve loop.

## Output Format

The JSON the recommender emits (stable, idempotent, `sort_keys`):

| Field | Meaning |
|---|---|
| `primary_workflow` | Recommended workflow object, or `null` on an honest gap |
| `secondary_workflows` | Supporting workflows (ordered, time-budget filtered) |
| `skillset` | `{id, source: skills-index.category, manifest_status, manifest}`. `manifest_status` is `active` when `skillsets/<id>.yaml` ships, else `deferred`. `manifest` is the 5-key view `{display_name, required_skills, recommended_skills, optional_skills, related_workflows}` when active, else `null`. Describes the **primary skillset only** — not the install list |
| `setup_bundle` | `{required, recommended, optional, sources}` — the actionable install union over the primary skillset **and every secondary workflow** (deterministic, tier-deduped). **This is what to install.** All-empty on an honest gap (use `suggested_skills`) |
| `suggested_skills` | Skills to use when no workflow shipped (honest gap); else `[]` |
| `no_api` | Request-side: was no-API constraint mode active (flag or persona) |
| `no_api_path` | Path-side: does the **whole** recommendation (primary + every secondary) work without paid API keys? `true`/`false`; `null` on an honest gap. This is the DoD's API-vs-no-API separation — narrate it explicitly |
| `honest_gap` | `true` when no workflow exists for the intent |
| `note` | Plain-language explanation for gaps / unmapped input |
| `rationale` | Ordered list of why-this-was-recommended strings |
| `setup_path_ref` | Pointer to the setup-path reference |

## Resources

- `scripts/recommend.py` — the deterministic recommender (single source of
  truth for routing).
- `scripts/build_snapshot.py` — regenerates `assets/metadata_snapshot.json`
  from the SSoT; `--check` guards drift (pre-commit + CI).
- `references/intent_routing.md` — the persona table, the 10-question contract,
  the `--no-api` credential rule, and scoring tie-breaks.
- `references/setup_paths.md` — Claude Web App vs Claude Code setup steps.
- `assets/metadata_snapshot.json` — generated SSoT digest for the Web App
  fallback. Never edit by hand; run `build_snapshot.py`.

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
