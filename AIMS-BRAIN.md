# AIMS Brain — Charter

**AIMS Brain** is the iTradeAIMS network's **owned** semantic-memory + code-intelligence
engine: a pull-only derived index over the iTradeAIMS repo network plus MQL/C++
code-intelligence, queried by the coding-agent fleet and the AIMS MCP. We built a product
on upstream's ~94k-line engine — the same relationship Postgres has to a SaaS built on it:
we own and operate **our** product (AIMS Brain), the engine keeps coming from upstream
(`garrytan/gbrain`), and we merge it INBOUND. AIMS Brain is an owned iTradeAIMS asset in
the portfolio sense (like the indicators, EAs, DLMS, TM Pro) — not a commercialised
standalone venture, and not Garry's personal "billion-user" brain.

**Layer terminology** (use these exactly):

| Layer | Name | What it is |
|---|---|---|
| Product / identity | **AIMS Brain** | The served brain over the repo network — the thing the fleet talks to. |
| Engine repo | **`itradeaims-brain`** | This repository — the maintained fork. |
| Served instance | **`gbrain-immy`** | The Fly app (lhr) running the engine; reached over MCP as `mcp__gbrain__*`. |
| Upstream | **`garrytan/gbrain`** | The engine we fork; source of inbound merges. |

Governance: **ADR-0041** (in `itradeaims-agent-workflows`) — the AIMS Brain owned-product-fork
decision. ADR-0041 supersedes ADR-0037 Decision 2's outbound-contribution clause and
preserves the rest.

## The owned-fork relationship

- **Inbound-only.** We merge `garrytan/gbrain` INBOUND for engine improvements and
  security fixes. We do **not** contribute outbound. The `upstream` remote stays wired
  for **fetch**; `upstream` **push is DISABLED**. Never sever git lineage and never
  hard-reset onto upstream.
- **"Keep ours" merge zones.** On every inbound merge, keep OUR version of:
  - `README.md` (the AIMS Brain public face)
  - `AGENTS.md` (our agent operating contract)
  - the `CLAUDE.md` AIMS-Brain header block (marked
    `<!-- AIMS-BRAIN-HEADER:keep-ours-on-merge -->`)

  Everything else merges from upstream normally.
- **How to merge upstream:**
  ```bash
  git fetch upstream
  git merge upstream/master
  # On conflicts in README.md / AGENTS.md / the CLAUDE.md header → keep OURS.
  # Everything else: take the merge as normal, then run gbrain's CI before shipping.
  ```
  Ship the merged result through `/ship` (it does the VERSION 5-file sync + CHANGELOG
  + the CI version-gate the engine requires).

## Boundaries

- **Separate semantic-memory authority** (ADR-0031 / ADR-0034). The AIMS MCP control
  plane governs *around* AIMS Brain; it never merges with it. AIMS Brain is not a second
  MCP authority.
- **Pull-only derived index** (ADR-0038). Producers author and push to their own repos;
  AIMS Brain pulls and re-derives. `put_page` write-through is forbidden (it caused the
  152-commit wedge + content "brain spill").
- **No routine graph-destructive ops** (ADR-0039). Do not run source remove + re-add
  ("denoise") on the live brain — it cascade-wipes the derived graph.
- **Governance is owned by the control plane** (ADR-0030 D4 / ADR-0037 D4). Network and
  identity decisions live in `itradeaims-agent-workflows`, not here.

## What AIMS Brain is NOT

- NOT a personal knowledge brain, NOT a Telegram/OpenClaw agent, NOT a "billion-user"
  product.
- Do NOT optimise for `brain_score` / BrainBench / longmemeval — those are upstream's
  personal-wiki metrics. A code brain scores low on them structurally, and that is fine.
  Health = the green integrity / sync / embed checks.
- Do NOT apply upstream's privacy / responsible-disclosure rules that reference real
  names (`Wintermute` / `Garry's OpenClaw`). Those are Garry's contacts. Our rule: never
  expose real iTradeAIMS customers or contacts.

## Engineering discipline (kept from gbrain)

We keep gbrain's OWN engineering conventions — `/ship`, the `VERSION` 5-file sync, this
repo's CI + test suite, and PR style — for engine releases (ADR-0041 Q6 exception). We do
NOT impose the control-plane 11-section PR template or the "Validate workflow control
plane" CI on this fork. The architecture invariants in `CLAUDE.md` (trust boundary,
source isolation, JSONB, engine parity, migrations, contract-first) are load-bearing.

## Pointers

- **Governance:** ADR-0041 in `itradeaims-agent-workflows/docs/adr/`; the AIMS-Brain
  glossary in `itradeaims-agent-workflows/CONTEXT.md` (do not duplicate it here).
- **Design spec + implementation plan:** the `docs/aims-brain-spec-plan` branch
  (`docs/superpowers/specs/` + `docs/superpowers/plans/`, 2026-06-28). That tree is
  Conductor scratch (gitignored), so it is kept on its branch rather than on `master`.
- **Agent operating contract:** `AGENTS.md`. **Engine internals + invariants:** `CLAUDE.md`.
- **Engine-internal ADRs:** `docs/adr/`.
