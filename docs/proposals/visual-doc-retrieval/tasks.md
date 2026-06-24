# Tasks: Faithful Retrieval over Visually-Rich Documents

**Spec**: `./spec.md` · **Plan**: `./plan.md`

Format: `[ID] [P?] [Story] Description` — **[P]** = parallelizable (different files, no dep). Each User Story phase is an independently shippable PR.

## Phase 1: Setup (shared)

- [ ] T001 Add proposal docs (spec/plan/tasks/research) under `docs/proposals/visual-doc-retrieval/` — **this PR**.
- [ ] T002 [P] Confirm `pdftoppm`/poppler availability + render helper (`src/core/ingestion/visual/render.ts`): page→PNG at a pinned DPI; deterministic.
- [ ] T003 [P] Add file-plane config keys (read-only at call sites): `visual.embedding_model` (`voyage:voyage-multimodal-3.5`), `visual.layout_model`, `visual.budget_*`. No `gbrain config set` (DB plane).

## Phase 2: Foundational (blocking prerequisites)

- [ ] T004 Migration in `src/core/migrate.ts` `MIGRATIONS`: `units` table + provenance columns + multimodal embedding column — DDL for **both** engines (`pglite-engine.ts` + `postgres-engine.ts`).
- [ ] T005 Extend `test/e2e/engine-parity.test.ts` to cover the new SQL shape (parity gate).
- [ ] T006 [P] Wire the `voyage` recipe's **multimodal path** (`supports_multimodal`) for unit embedding through the gateway; confirm `embedMultimodal` route (no new dispatch type).
- [ ] T007 [P] Add gateway-routed **vision call** helper (native-anthropic chat path) for layout detection + answer read.
- [ ] T008 Progress wiring via `src/core/progress.ts` for the ingest path (stderr; `--json` clean).

## Phase 3: User Story 1 — Faithful ingest, no lost tables/figures (P1) 🎯 MVP

- [ ] T009 [US1] `detect_layout(page_image)` in `src/core/ai/layout/` — LLM-vision, **strict JSON schema**, normalized bboxes, caption-binding + column-aware reading order; cached by page content-hash.
- [ ] T010 [P] [US1] Layout post-process (deterministic): validate/clamp bboxes, drop header/footer, pad crops, cross-page table stitch (FR-016), low-confidence → geometric fallback (FR-011).
- [ ] T011 [P] [US1] Unit cropper `src/core/ingestion/visual/crop.ts`: denormalize bbox×dims → semantic-unit image + provenance.
- [ ] T012 [US1] `ingest_visual_doc` Operation in `operations.ts` (`scope:'admin'`, queued); idempotent by content hash (no duplicate units, FR-012); never truncate, flag unprocessable (FR-004).
- [ ] T013 [US1] Visual-ingest minion handler in `src/core/minions/handlers/`: render → detect_layout → crop → multimodal-embed → persist + provenance.
- [ ] T014 [P] [US1] Unit tests: layout post-process + cropper (vision call **stubbed** — keep deterministic part covered).
- [ ] T015 [US1] Validate against the RAG paper p6: auto-detected table crops reproduce the manual §5d separation (the go/no-go gate from `detect-layout-plan.md`).

**Checkpoint**: a visually-rich PDF ingests; its tables/figures persist as retrievable units with provenance. (SC-001, SC-003, SC-005.)

## Phase 4: User Story 2 — Retrieve the correct unit (P2)

- [ ] T016 [US2] Extend `query`/`search` to rank over the multimodal unit column; return units with provenance.
- [ ] T017 [US2] Add **rerank-2.5** stage on candidate units (text rep of the unit), gateway-routed; cross-modal-gap mitigation (§5/§7).
- [ ] T018 [P] [US2] Retrieval eval harness: sibling-table separation (SC-002) + late-content parity (SC-003) + paraphrase recall@3 (SC-008), using `gbrain-testing/` corpus.

**Checkpoint**: targeted queries return the correct unit #1, late content retrievable, paraphrase queries work.

## Phase 5: User Story 3 — Faithful, sourced answer (P3)

- [ ] T019 [US3] Answer path: vision-read the top retrieved unit (gateway), return value + provenance (page/region) (FR-008, SC-004).
- [ ] T020 [US3] "Not found" guard: empty/low-confidence recall → explicit no-answer, no fabrication (FR-014, SC-006).

**Checkpoint**: a value question returns the source-exact value with a citation.

## Phase 6: User Story 4 — Reproducible, cost-bounded ops (P3)

- [ ] T021 [US4] Cache layout + vision-transcription artifacts (content-hash) → freeze the stochastic steps (§7 determinism).
- [ ] T022 [US4] Budget enforcement + cost reporting per ingest/query (FR-015, SC-007); pin model versions, store model id with the index (FR-013).

## Phase 7: Polish

- [ ] T023 [P] `gbrain doctor` check: visual pipeline config + model reachability.
- [ ] T024 [P] Docs: usage + the ingest-time-vs-query-time cost decision (from §6).
- [ ] T025 Decide hybrid `detect_layout` (deterministic detector for tight boxes) if LLM bbox precision proves insufficient (deferred from Phase 0).

## Dependencies & PR slicing
- Phase 1–2 → **PR 2** (foundation: render, config, migration+parity, gateway wiring).
- Phase 3 (US1) → **PR 3** (MVP: faithful ingest). Independently shippable.
- Phase 4 (US2) → **PR 4**; Phase 5 (US3) → **PR 5**; Phase 6 (US4) → **PR 6**; Phase 7 → **PR 7**.
- **This PR (PR 1)** = the proposal docs (spec/plan/tasks/research) only — design review before code.
