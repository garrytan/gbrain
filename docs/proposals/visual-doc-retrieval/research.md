# Research (Phase 0): extraction, embedding, chunking, rerank tradeoffs

Decisions below are backed by a hands-on benchmark on the RAG paper (arXiv:2005.11401). Self-contained summary; the raw runs/artifacts live in a companion scratch dir (`gbrain-testing/COMPARISON.md`, not part of this repo).

## Decision: read tables with vision, not text extraction
- Text extractors (firecrawl/pdftotext) and a flat AI extract **garble dense tables** — a `55.2/66.1` cell flattened to `55.266.1`; the alphaXiv "report" mode paraphrases (no raw table).
- **Claude vision-PDF transcribed the same table faithfully** (`55.2/66.1`, split columns recovered).
- → Visual/tabular fidelity requires a **vision** step; plain text extraction is insufficient (SC-001).

## Decision: embed semantic **units**, not pages or whole docs
- Granularity ladder (multimodal embedding, one model): whole-doc **0.223** (truncated + diluted) ≪ per-page **0.486** < per-half **0.549** < **semantic unit** (clean per-table separation).
- Whole-doc-as-one-vector hit the **32K-token per-input cap** → ~32% of pages (incl. the last) silently dropped → motivates FR-004 (no silent truncation) and SC-003.
- Finer chunks fixed **mis-localization** (per-page returned the wrong page; the table crop won) → FR-002, FR-005.

## Decision: multimodal embedding for recall, rerank for precision
- `voyage-multimodal-3.5` retrieves the correct page **image** from a **text** query (clean diagonal) — no extraction needed. Architecture: one shared transformer over image patch-tokens + text tokens (not image→text).
- **Cross-modal similarity runs below text→text** → calibration caveat: keep corpus modality-consistent and/or rerank (§7).
- `rerank-2.5` (cross-encoder, text-only) lifts the true unit and sharpens scores; **chunk→vision-transcribe→rerank** gave the crispest separation (q_QA +0.234, q_gen +0.377). Rerank operates on a **text representation** of candidate units.

## Decision: ingest-time vs query-time vision (cost)
- Embedding + reranking are **≈ free at personal scale** (Voyage free tier ≈ thousands of docs). The only cost with no free tier is **vision/LLM tokens** (measured ~$0.012/page vision).
- → v1 default: **lazy** — multimodal-embed everything (cheap), vision-read only the retrieved hit (~1¢/query). Front-load vision only for heavily re-queried corpora (FR-015, SC-007).

## Decision: contain non-determinism + layout risk
- The stochastic/fragile steps are layout detection + vision; everything else (render, embed, exact search, rerank) is deterministic within a pinned model version.
- → **Cache** layout + transcription artifacts (content-hash), **pin** model versions, **layout-aware** chunking with bbox provenance, **geometric fallback** on detection failure (FR-011, FR-013).

## Open item
- `detect_layout` bbox precision: v1 = pure LLM-vision (normalized bboxes + padding); a hybrid with a deterministic table/figure detector is deferred (T025) if precision proves insufficient.
