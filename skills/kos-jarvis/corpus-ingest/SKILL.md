---
name: corpus-ingest
version: 1.0.0
description: |
  One-command bulk-ingest pipeline (D→I→K→W) for a single isolated source.
  Sequences the 7 fork stages — register → ingest → embed → enrich → graph →
  (per-entity synth, opt-in) → corpus-synth — over a folder of frontmatter'd
  .md files, each idempotent/incremental so re-runs only do new work. Turns a
  systematic corpus (product docs, FAQ, a research library) into a queryable
  knowledge asset: facts (RAG) + entities + graph + corpus-level viewpoints.
triggers:
  - "corpus ingest"
  - "bulk ingest pipeline"
  - "一键入脑"
  - "ingest a knowledge base"
tools:
  - list_pages
  - get_page
  - put_page
  - query
mutating: true
---

# corpus-ingest

> **Convention:** see [conventions/brain-first.md](../../conventions/brain-first.md). Orchestrator only — it shells out to the existing stage tools; no new brain logic.

The runner is **`run.sh`** (bash), not `run.ts`: the orchestrator is pure
sequencing of shell commands with parallelism + gating, so bash is the honest
tool. The stages it drives are the real logic (enrich-sweep / synthesis-sweep /
corpus-synth / gbrain).

## What it does

Validated end-to-end building the `omada` source (2026-06-02): 507-page PDF →
114 sections + 573 FAQs → 688 fact pages + 720 entities + 1913 links + 24
corpus-level viewpoint pages.

| Stage | Tool | Incremental mechanism |
|---|---|---|
| 0 register | `gbrain sources add --no-federated` | skips if source exists |
| 1 ingest | parallel `gbrain put` (N-way) of every `*.md` under the source dir | skips slugs already in DB |
| 2 embed | `gbrain embed --stale --source` (20-way concurrent) | only NULL/stale chunks |
| 3 enrich | `enrich-sweep --tier3-only` (Haiku NER → entity stubs) | NER cache (slug+updated) |
| 4 graph | `extract links --by-mention` + `extract timeline` | idempotent rebuild |
| 5 entity-synth *(opt-in)* | `synthesis-sweep` (per-entity Opus dossiers) | checkpoint by slug; `--refresh-stale` |
| 6 corpus-synth | `corpus-synth` (corpus-level Opus viewpoints) | content_hash per theme |

## Picking the W layer (stage 5 vs 6)

The fork has **two** Wisdom primitives; corpus-ingest defaults to the universal one:

- **corpus-synth (stage 6, always on)** — corpus-level themes/tensions. The right
  W layer for **document / knowledge corpora** (product docs, FAQ, research). The
  knowledge lives in the material, not in named entities.
- **synthesis-sweep (stage 5, `--entity-synth` opt-in)** — per-entity dossiers.
  Right for **entity-rich corpora** (emails, people/company networks) where the
  by-mention graph has well-connected, non-noise entity hubs.

Stage 5 prints the count of entities with ≥`--min-neighbors` source-neighbors and,
when it's ≥30, hints that `--entity-synth` may be worthwhile. On omada it was 10
(and dominated by brand noise: omada/tp-link/google), so per-entity is correctly
skipped — synthesizing `companies/google` from Omada FAQs is noise.

## Input contract

corpus-ingest ingests **frontmatter'd `.md` files already prepared in the source
dir** (`--path`, or the source's registered `local_path`). Slug = path relative
to the source dir, minus `.md` (e.g. `~/omada-kb/faq/5111-x.md` → slug `faq/5111-x`).
Frontmatter should set `type: source` (so docs become enrich/synthesis neighbors),
`kind:` (KOS kind), `title:`, and any provenance (`last_update` for date-weighting).

**Format adapters** (PDF→sections, site→FAQ, …) are a separate per-source concern
that produce those `.md` files. References that built omada:
- `docs/omada/extract-ug.py` — PyMuPDF: split a PDF by its L2 TOC into one page
  per section.
- `docs/omada/crawl-faq.py` — enumerate a TP-Link support FAQ via its JSON search
  API (`sort=latest`, date-filter) → server-rendered detail pages → markdown.

## Flags

- `--source <name>` — **required**; the isolated source to build.
- `--path <dir>` — source dir of `.md` files (default: the source's registered `local_path`).
- `--from-stage N` / `--to-stage N` — run a subset (0–6). E.g. `--from-stage 6` re-runs only corpus W.
- `--entity-synth` — also run stage 5 (per-entity dossiers).
- `--refresh-stale` — pass `--refresh-stale` to synthesis-sweep (refresh dossiers whose evidence grew).
- `--put-concurrency N` (default 8) / `--synth-concurrency N` (default 3).
- `--min-evidence N` (corpus-synth, default 3) / `--min-neighbors N` (synthesis-sweep, default 3).
- `--token-budget N` (synthesis-sweep gather, default 120000).
- `--plan` / `--dry` — print the stage plan + counts; **no LLM, no writes**.

## Incremental / daily refresh

Everything is incremental, so a periodic re-run (e.g. after the daily 舆情 writer
adds pages) does only new work:
```
corpus-ingest --source omada --refresh-stale
```
- ingest: new `.md` only · embed: stale only · enrich: NER-cached · graph: idempotent
- corpus-synth: re-proposes themes (1 Opus call) + re-synthesizes only themes whose
  member-set changed (content_hash) · synthesis-sweep (if `--entity-synth`):
  `--refresh-stale` re-does entities whose source-neighbor count grew ≥ `--stale-delta`.

No stage ever does a full re-embed or full re-NER. See `synthesis-sweep` /
`corpus-synth` / `enrich-sweep` SKILLs for per-stage detail.

## Cost note

Stages 5–6 spend CRS Opus; 3 spends CRS Haiku; 2 spends avman embeddings. Use
`--to-stage 4` to build D→I→K and inspect before paying for W, or `--plan` first.

## Delegates / related

- `skills/kos-jarvis/corpus-synth/SKILL.md` — stage 6 (universal W).
- `skills/kos-jarvis/synthesis-sweep/SKILL.md` — stage 5 (per-entity W, opt-in).
- `skills/kos-jarvis/enrich-sweep/SKILL.md` — stage 3.
- `gbrain extract links --by-mention` / `embed --stale` — stages 4 / 2.
