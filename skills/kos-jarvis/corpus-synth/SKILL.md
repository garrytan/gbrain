---
name: corpus-synth
version: 1.0.0
description: |
  Corpus-level Wisdom synthesis. Where synthesis-sweep deepens ONE entity,
  corpus-synth synthesizes a whole imported knowledge base into queryable
  "观点与洞察" pages — the corpus's major themes, cross-document tensions,
  transferable patterns, and open questions. Top-down: Opus reads a corpus
  map, proposes the themes, then deeply synthesizes each. Turns a freshly
  imported systematic KB into knowledge AND wisdom (not just RAG facts).
triggers:
  - "corpus synthesis"
  - "corpus-level wisdom"
  - "语料级综合"
  - "knowledge base viewpoints"
tools:
  - list_pages
  - get_page
  - put_page
mutating: true
---

# corpus-synth

> **Convention:** see [conventions/brain-first.md](../../conventions/brain-first.md) — operates entirely on the brain (`pages.compiled_truth`); no external augmentation.

The corpus-level top of the DIKW stack. enrich-sweep produced entity stubs (Info);
`extract links` built the graph (Knowledge); synthesis-sweep produced per-entity
dossiers (entity-level Wisdom); **corpus-synth produces corpus-level Wisdom** —
the themes, tensions, and transferable patterns that only emerge from reading a
whole body of knowledge at once.

## Why this exists (vs gbrain's native dream phases)

gbrain's K→W phases are gated AND wrong-shaped for our corpus (analysis 2026-06-02):

| gbrain phase | hard input requirement | output shape | verdict |
|---|---|---|---|
| `synthesize_concepts` | `type='atom'` pages with `frontmatter.concepts[]` (needs `extract_atoms` first) | single para, **max 500 tok** | no atom layer → no-ops; too thin for insight |
| `propose_takes` | any prose, but prompt is **tuned-cat15 English VC-forecast** | rows in a `take_proposals` **queue** (manual accept) | calibration tool, not viewpoint pages |
| `patterns` | hard-coded `slug LIKE 'wiki/personal/reflections/%'` | personal-journal recurring themes | our corpus has no reflection journal |

The gate (`packDeclaresPhase`, `cycle.ts:824`) is a trivial feature flag, but
un-gating only unlocks tools whose **input requirements our corpus structurally
doesn't meet** and whose **output shape isn't a corpus viewpoint**. So this skill
is fork-local — it **borrows the good ideas** while fitting our corpus:

- **`min_evidence` anti-hallucination gate** (from `patterns.ts`): a theme must
  cite ≥ N distinct member docs or it's dropped.
- **content_hash idempotency** (from `propose_takes.ts`): a theme's member-set
  hash is the checkpoint key, so a re-run on an unchanged corpus never re-pays;
  only themes whose membership shifted re-synthesize.
- **fact-vs-take distinction** (from the propose_takes prompt): the synthesis
  prompt explicitly separates "事实陈述" from "综合观点" (a take is a judgment
  later evidence can revise).

## Why top-down (not embedding clustering)

A freshly imported corpus is often **not embedded yet** — the real bulk-ingest
order is import→embed→…→corpus-synth, and a manual import can skip embed entirely
(gbrain-docs currently has `embedding IS NULL` on all chunks). Top-down also
tracks the knowledge's **conceptual structure**, not vector proximity. So Phase A
feeds Opus a corpus map and lets it propose the themes. (Bottom-up embedding
clustering is a possible future `--mode cluster`; not built — it needs embeddings
and produces proximity-themes, not concept-themes.)

## Algorithm

### Phase A — corpus map → theme proposal
1. **Map**: every doc in `--source` (excluding prior corpus-synth outputs) →
   `### slug — title\n<snippet>` (snippet ≤ `--map-char-cap`). Recency-desc;
   capped at `CORPUS_MAP_CEILING` tokens (logs the drop on overflow).
2. **Propose**: one Opus call → a JSON array of themes, each with `title`, `slug`,
   `angle`, `members` (doc slugs), `kind` (`theme` | `tension`).
3. **Validate**: intersect proposed `members` with the real slug set (the LLM may
   cite slugs not in the corpus); drop themes below `--min-evidence`; cap to
   `--max-themes`. Each surviving theme gets a member-set `hash`.

### Phase B — per-theme synthesis (checkpointed, concurrent, resumable)
Same engine as synthesis-sweep (Opus streaming, 8× backoff honoring Retry-After,
sliding concurrency pool, real-time `gbrain put`). Per theme: gather member docs
(≤ `--char-cap` each) up to `--token-budget`, Opus synthesizes a Chinese viewpoint
dossier (一句话定性 / 核心论点与共识 / 内部张力与矛盾 / 可迁移的模式与方法 /
未决问题 / 延伸洞见), each line citing `[[来源slug]]`. Write to
`synthesis/<theme-slug>` (kind `synthesis`, or `comparison` for `tension`) in the
same source, marked `synthesized_by: corpus-synth` so future maps skip it.

### Phase C — report
themes proposed / synthesized / failed / skipped + Opus token totals.

## Flags

- `--source <id>` — **required**; the corpus to synthesize.
- `--limit N` — first N themes only (small-batch verify).
- `--min-evidence N` — min distinct member docs per theme (default 3).
- `--max-themes N` — cap themes (default 24).
- `--map-char-cap N` — per-doc snippet in the map (default 800).
- `--char-cap N` — per-doc body fed to synthesis (default 4000).
- `--token-budget N` — gather budget per theme (default 450000; `SYNTH_CONTEXT_1M=1` → 900000 + 1M beta).
- `--concurrency N` — themes in parallel (default 3).
- `--plan` / `--dry` — build the map + show size/preview; **no LLM, no writes** (the validation gate).
- `--resume` — skip themes already done (by member-set hash).

## Rate-limit & cost (inherits synthesis-sweep tuning)

Per-theme synthesis is the same CRS Opus path as synthesis-sweep, so the same
operating point applies: `--concurrency 3` + a moderate `--token-budget` is
stable; rapid kill/restart saturates the rolling rate window. The Phase A theme
proposal is a single large-context call (the corpus map). A bounded systematic KB
(hundreds of docs) is cheap — a few dozen Opus calls total.

## Plug into the bulk-ingest pipeline

corpus-synth is the **wisdom stage** of a full bulk-import chain. The other stages
already exist as discrete tools; run them in order, then corpus-synth last:

1. `gbrain sources add <name>` — isolate the corpus in its own source (never `default`).
2. `gbrain put --source <name>` (bulk) — ingest the docs.
3. `gbrain embed --stale --source <name>` — embed (te3@avman) → RAG/vector queryable.
4. `enrich-sweep --source <name>` — entity stubs (Info).
5. `gbrain extract links --by-mention --source <name>` + `extract timeline` — graph (Knowledge).
6. `synthesis-sweep --source <name>` — per-entity dossiers (entity Wisdom).
7. **`corpus-synth --source <name>`** — corpus-level viewpoints (corpus Wisdom).

## Resumability

- **Checkpoint** `~/.cache/kos-jarvis/corpus-synth/<source>.jsonl` — one line per
  synthesized theme, keyed by member-set hash. A killed run resumes; identical
  themes are never re-paid.
- **Lock** `~/.cache/kos-jarvis/corpus-synth.lock` prevents concurrent runs.
- **Real-time**: one `gbrain put` per theme commits + embeds immediately.

## Delegates / related

- `skills/kos-jarvis/synthesis-sweep/SKILL.md` — per-entity sibling; shares the
  Opus-streaming / backoff / checkpoint / concurrency engine.
- `skills/kos-jarvis/enrich-sweep/SKILL.md` — built the entity layer below.
- `skills/kos-jarvis/type-mapping.md` — `kind: synthesis` / `comparison` filing.

## Rollback

Each theme page is at `synthesis/<slug>` in the source, listed in the checkpoint
JSONL. Delete the pages (`gbrain rm synthesis/<slug> --source <name>`) and the
checkpoint to revert; corpus-synth never touches the source docs it reads.
