# Implementation Plan: Faithful Retrieval over Visually-Rich Documents

**Branch**: `feat/visual-doc-retrieval` · **Spec**: `./spec.md` · **Status**: Draft

## Summary

Add a gbrain ingestion + retrieval path for visually-rich PDFs (tables, figures, charts) that preserves visual/tabular content plain-text extraction destroys. Documents are segmented into **semantic units** (table, figure+caption, section) by an LLM-vision layout detector, each unit is **multimodally embedded** (image), retrieval is sharpened by a **cross-encoder rerank**, and answers are produced by a **vision read** of the retrieved unit with provenance. Rationale and measured tradeoffs: `/workspaces/random/gbrain-testing/COMPARISON.md` (§5–§7).

## Technical Context

**Language/Version**: TypeScript on Bun (gbrain's runtime).

**Primary Dependencies**: gbrain AI gateway (`src/core/ai/`); Voyage `voyage-multimodal-3.5` (unit embedding) + `rerank-2.5` (precision); Anthropic Claude vision (layout detection + answer read) via the gateway; `pdftoppm`/poppler (PDF→image render). All model access routes through the gateway — no direct provider SDK calls at call sites.

**Storage**: PGLite + pgvector (default) / Postgres + pgvector (scale) — existing gbrain engines; new tables for units + provenance, in lockstep across both engines.

**Testing**: `bun test`; engine-parity test for any new SQL; unit tests for layout post-processing (deterministic part) with the stochastic vision call stubbed.

**Target Platform**: gbrain CLI + MCP server (stdio/HTTP) on Linux/macOS.

**Project Type**: Library/CLI feature inside the gbrain monorepo (contract-first operation + minion handler + AI recipe).

**Performance Goals**: ingest a 20-page PDF within the configured cost budget; query p50 dominated by rerank+vision-read (~seconds), recall stage sub-second.

**Constraints**: per-unit embedding ≤ Voyage 32K-token cap (no silent truncation, FR-004); reproducibility within a pinned model version (FR-013); cost budget enforced + reported (FR-015, SC-007).

**Scale/Scope**: personal-to-moderate (≤ low-thousands of docs) for v1.

## Constitution Check

*GATE: gbrain's invariants are its constitution (`CLAUDE.md` → Cross-cutting invariants). This feature must satisfy:*

- **Contract-first** — new capabilities are `Operation`s in `src/core/operations.ts` (CLI + MCP generated); each carries `scope` + optional `localOnly`. ✅ planned.
- **Trust fail-closed** — ingestion/answer ops that spawn vision/model work assert `ctx.remote === false` where they must; reads honor `sourceScopeOpts(ctx)`. ✅ planned.
- **Engine parity** — new unit/provenance tables land in BOTH `pglite-engine.ts` and `postgres-engine.ts`, pinned by `test/e2e/engine-parity.test.ts`; DDL in the `MIGRATIONS` array in `src/core/migrate.ts`. ✅ planned.
- **JSONB** — region/bbox metadata passed as raw objects to `executeRaw`/`executeRawJsonb`, never `JSON.stringify` into a `::jsonb` cast. ✅ planned.
- **Config planes** — model/budget/driver settings read from file plane (`~/.gbrain/config.json`) or env, never `gbrain config set` (DB plane). ✅ planned.
- **Bulk progress to stderr** — ingestion streams progress via `src/core/progress.ts` (stdout stays clean for `--json`). ✅ planned.
- **AI gateway is the single seam** — all model calls (embed/rerank/vision) go through `src/core/ai/gateway.ts` recipes; layout-detection + vision-read added as gateway-routed calls, not ad-hoc SDK usage. ⚠️ *gateway today returns AI-SDK `LanguageModelV2`; the vision-read + layout calls fit the existing native-anthropic chat path; the multimodal-embed fits the existing `voyage` recipe's multimodal path (`supports_multimodal`).* No new dispatch type required.

*No constitution violations anticipated → Complexity Tracking empty.*

## Project Structure

### Documentation (this feature)
```
docs/proposals/visual-doc-retrieval/
├── spec.md      # WHAT/WHY (done)
├── plan.md      # this file — HOW
├── tasks.md     # sliced, dependency-ordered tasks
└── research.md  # Phase 0 — points at gbrain-testing/COMPARISON.md (the experiments)
```

### Source code (gbrain repo)
```
src/core/ai/recipes/          # reuse voyage (multimodal path) + anthropic (vision) recipes
src/core/ingestion/
  └── visual/                 # NEW: render, detect_layout, semantic-unit crop, provenance
src/core/ai/layout/           # NEW: detect_layout (LLM-vision, strict-schema JSON, cached)
src/core/operations.ts        # NEW ops: ingest_visual_doc, (answer path reuses query/think)
src/core/minions/handlers/    # NEW: visual-ingest minion (long-running, queued)
src/core/migrate.ts           # NEW migration: units + provenance columns/tables (both engines)
test/                         # parity test + layout post-process unit tests (vision stubbed)
```

## Phase 0 — Research (DONE)

The hard questions are already answered empirically in `gbrain-testing/COMPARISON.md`:
- Text extraction garbles dense tables; vision reads them faithfully (§1–§4, the `55.266.1` vs `55.2/66.1` result).
- Multimodal embedding retrieves page images from text queries (§5); cross-modal similarity runs below text→text (calibration caveat).
- Granularity ladder: whole-doc (truncates+dilutes) ≪ per-page < per-half < **semantic unit** (§5b–§5d).
- Rerank lifts the true unit and sharpens scores; chunk+transcribe+rerank is crispest (§5e–§5f).
- Cost: embed/rerank ≈ free at this scale; vision-LLM tokens are the only real cost — decide ingest-time vs query-time (§6).
- Determinism/layout risk concentrate in the vision/layout steps → cache outputs, pin versions, layout-aware chunking (§7).

**Open research item**: `detect_layout` box precision (pure LLM-vision vs hybrid with a deterministic detector) — see `detect-layout-plan.md` work; v1 ships pure LLM-vision with normalized bboxes + padding, hybrid deferred.

## Phase 1 — Design (contracts & data model)

**Data model (entities → tables, both engines):**
- `documents` (reuse existing pages/source where possible) — id, source, page_count, content_hash.
- `units` — id, document_id, type (table/figure/text/...), page(s), bbox (jsonb, normalized), reading_order, provenance, confidence, embedding (vector, multimodal column), source_image_ref.
- Provenance recorded on every unit (FR-009).

**Contracts:**
- `detect_layout(page_image) -> regions[]` — LLM-vision, strict JSON schema, normalized bboxes, cached by page content-hash (FR-002, FR-011; determinism §7).
- `ingest_visual_doc` operation — `scope: admin`, queued to a minion; render → detect_layout → crop units → multimodal-embed → persist + provenance; idempotent by content hash (FR-001/003/004/008/012); progress→stderr.
- Retrieval reuses `query`/`search` over the multimodal column; **rerank** stage added on the candidate units (FR-005/007).
- Answer path reuses `think`/vision-read over the retrieved unit, returning provenance and an explicit "not found" when recall is empty (FR-008/014).

## Phase 2 — Tasks

See `tasks.md` (sliced by user story P1→P4, dependency-ordered, parity- and budget-aware).

## Complexity Tracking

*Empty — no constitution violations to justify. The one risk (LLM-vision bbox precision) is contained: normalized bboxes + crop padding + geometric fallback (FR-011), with a hybrid detector deferred to a follow-up if precision is insufficient.*
