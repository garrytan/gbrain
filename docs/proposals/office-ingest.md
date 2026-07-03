# PRD + Spec: Office-Format Ingest for GBrain

| | |
|---|---|
| **Status** | Implemented — M0 + R1 (a/b) + R2 + R3 landed and verified (PGLite full-path + real-Postgres engine-parity e2e) |
| **Created** | 2026-06-23 |
| **Version** | 1.0 |
| **Scope** | Extend GBrain Sources/Ingest from text-only to DOCX / PPTX / PDF / XLSX (plus ODT/ODS/ODP/HTML/CSV via the same adapter) |
| **Related** | `docs/architecture/KEY_FILES.md`, `docs/architecture/RETRIEVAL.md`, `src/core/import-file.ts`, `src/core/ai/gateway.ts`, `docs/proposals/office-ingest-roadmap.md` (post-M0 replan + implementation record) |

> The first half of this document is the **PRD/RFC** (why it is designed this way,
> decisions and trade-offs). The second half is the **frozen Spec** (contracts,
> schema, acceptance). Source files cite sections of this document by number
> (§6–§12, §21.x) — keep the numbering stable when editing.

---

## 0. TL;DR

GBrain ingest previously had first-class support only for Markdown / code / images.
This proposal adds a **format-adapter layer**: **Docling** (Python, resident FastAPI
sidecar, supervised by gbrain) normalizes office documents into **DocIR** (a unified
block stream with precise locators), which a new `importOfficeFile` adapter feeds
into the **existing pipeline** (chunk → embed → edge extraction → FTS). Downstream
(brain store / hybrid search / synthesis / dream cycle) needs **zero changes**.
Tables get **LLM summaries + row blocks**; visual blocks get **selective multimodal
embedding**; every chunk carries a **`source_locator` jsonb** for precise citations
(p.X / Slide Y / Sheet!B4:D9).

---

# PART I — PRD / RFC (design intent)

## 1. Problem & motivation

- **Before this work**: `importFromFile` (`src/core/import-file.ts`) dispatched only
  to `importFromContent` (markdown), `importCodeFile`, and `importImageFile`.
  **No native parsing for PDF / DOCX / PPTX / XLSX** (no PDF/Office library in the
  dependency tree).
- **Pain**: a lot of user knowledge lives in office formats (contracts, proposals,
  reports, slide decks). Not ingestible = invisible to the brain; neither retrieval
  nor synthesis can reach it.
- **Opportunity**: downstream (store / retrieval / synthesis / dream cycle) is
  **format-agnostic** — it only understands "text + vectors + edges + locator". So
  only the **front-most layer** needs extending: bounded effort, broad payoff.

## 2. Goals / Non-Goals

**Goals**
- G1: DOCX / PPTX / PDF (with a text layer) → stored and searchable (M0).
- G2: every chunk carries **precise provenance** (page / slide / cell) so synthesis
  citations are locatable.
- G3: reuse the existing chunk → embed → edge-extraction → FTS pipeline; downstream unchanged.
- G4: scanned-PDF OCR, table strategy, and visual multimodal land in follow-up stages.
- G5: local-first, privacy-first (Docling runs locally; files never leave the machine).

**Non-Goals**
- N1: M0 does not solve scanned-document OCR, complex tables, or visual embedding
  (staged later; see §17).
- N2: no cloud parsing services (e.g. LlamaParse) — violates privacy-first.
- N3: no changes to downstream retrieval/synthesis algorithms.
- N4: no office-document **write/edit** support (read-only ingest).

## 3. Personas / use cases

- **Personal knowledge-base user**: pours exported PDFs, meeting decks, and report
  spreadsheets into the brain, then does semantic retrieval + synthesis.
- **Team brain**: contracts / proposals / internal documents as a source, scoped
  per person.
- **Core use case**: `gbrain import ~/docs` (mixed formats) → `gbrain query "Q3
  revenue conclusion"` → synthesized answer cites **"report.pdf p.12"**.

## 4. Decision record (locked, with rationale)

| # | Decision | Choice | Rationale / trade-off |
|---|---|---|---|
| D1 | Parse location | **Python sidecar** | The strongest parser (Docling) is Python; same shape as the ollama service users already run (resident local service) |
| D2 | Framework | **Docling** | Best layout/table structure + page/bbox provenance; fits G2 |
| D3 | Sidecar form | **Own FastAPI service** | Controllable, trimmable output contract; better fit than the official docling-serve |
| D4 | Chunk size | **Office-specific setting** | Office document structure differs from prose; independent `ingest.office.chunk_tokens` |
| D5 | Tables | **LLM summary + row blocks + conditional Facts** | Summary drives recall, row blocks drive precision, Facts drive structured queries (see roadmap: Facts turned out to be fence-based, not auto-extracted) |
| D6 | Multimodal | **Selective by default + switch + cost posture** | Controls cost; text-only documents waste nothing |
| D7 | Provenance | **`source_locator` jsonb** | One column serves every format, no per-format migrations; citations are for display, not filtering |
| D8 | Sidecar lifecycle | **Supervised by gbrain** | Start / health check / restart managed like a minion |
| D9 | Table summary generation | **LLM-generated** | Higher quality than templates; **with a fallback chain** (no key / over budget → template) |

> ⚠️ **D9's global side effect**: before this, ingest depended only on the embedding
> model; D9 makes ingest **depend on a chat LLM (and its cost) for the first
> time**. It must degrade gracefully — see §11, §14.

## 5. Architecture overview

```
                            ┌──────────────────────────────┐
 office file ──HTTP POST──▶ │ Docling sidecar (FastAPI,    │
 (pdf/docx/pptx/xlsx/…)     │ resident, models pre-warmed, │
                            │ gbrain-supervised)           │
                            │ parse → DocIR (JSON)         │
                            └───────────────┬──────────────┘
                                            │ DocIR
 gbrain (Bun/TS)                            ▼
 importFromFile (dispatch) ───────▶ importOfficeFile (adapter)
                                            │
        ┌───────────────┬───────────────────┼──────────────────┬───────────────┐
        ▼               ▼                   ▼                  ▼               ▼
 doc-block chunker   table.ts          multimodal.ts      link/NER edges   source_locator
 (structure-aware,   summary (LLM) +   selective image    (reused,         (jsonb)
  locator-carrying)  row blocks        embedding          zero-LLM)
        └───────────────┴───────────────────┴──────────────────┴───────────────┘
                                            ▼
        existing brain store (content_chunks: embedding / embedding_image / search_vector / + source_locator)
                                            ▼
        downstream unchanged: hybrid search (incl. cross-modal both/RRF) → synthesis (citations carry locator) → dream cycle
```

**Integration principle**: `importOfficeFile` is a **sibling** of `importCodeFile` /
`importImageFile`, hanging off the `importFromFile` dispatcher; it produces
`ChunkInput[]` carrying `source_locator` plus optional image assets, and everything
downstream is reused.

---

# PART II — SPEC (frozen contracts / schema / acceptance)

## 6. DocIR Contract v1 (authoritative sidecar ↔ gbrain contract)

> Versioned: `docir_version: "1.0"`. Any change in field semantics bumps the
> version; sidecar and adapter validate it in lockstep.

```jsonc
// Response body of POST /parse
{
  "docir_version": "1.0",
  "doc": {
    "format": "pdf" | "docx" | "pptx" | "xlsx" | "image",
    "page_count": 12,                     // pdf=pages, pptx=slides, xlsx=sheet count, docx=null
    "content_hash": "sha256:…",           // computed by the sidecar over the raw bytes; gbrain re-verifies
    "parser": "docling@<ver>"
  },
  "blocks": [
    {
      "id": "b1",                          // stable id within the document
      "type": "heading"|"paragraph"|"list"|"table"|"figure"|"code",
      "level": 1,                          // heading only
      "markdown": "## Q3 Results",         // normalized text (what gbrain stores)
      "text": "Q3 Results",                // plain text (FTS / edge extraction)
      "order": 7,                          // global order within the document
      "locator": {                         // precise position (→ source_locator)
        "page": 3,                         // 1-based; null when unavailable
        "slide": null,                     // pptx slide number
        "sheet": null,                     // xlsx sheet name (multi-sheet: one block group per sheet)
        "cell_range": null,                // xlsx only, A1 notation like "Sheet1!B4:D9"
        "table_id": null,                  // id of the table block a row-block belongs to
        "row_range": null,                 // [startRow, endRow] 0-based rows within a table (precise location for PDF/DOCX/PPTX tables)
        "bbox": [x0, y0, x1, y1]           // optional, in-page coordinates
      },
      "table": {                           // type=table only
        "header_rows": 1,
        "n_rows": 40,
        "n_cols": 5,
        "columns": ["Quarter","Revenue","…"],
        "rows": [["Q1","$1.2M","…"], …]    // regular 2-D array
      },
      "asset_ref": "a1"                    // visual blocks only; points at assets[].id
    }
  ],
  "assets": [
    {
      "id": "a1",
      "kind": "image",
      "mime": "image/png",
      "data_b64": "…",                     // extracted or rendered image
      "is_rendered_page": false,           // true = full-page render (OCR / visual arm)
      "locator": { "page": 5, … }
    }
  ],
  "warnings": ["LOW_CONFIDENCE_TABLE:b9"]  // low-confidence signals → surfaced to the importer (§16, R3)
}
```

**Contract invariants**
- C1: `blocks` sorted ascending by `order`, non-overlapping.
- C2: `type=table` must carry `table`; `type=figure` must carry `asset_ref`.
- C3: `locator.page` is 1-based; unavailable dimensions are `null`, keys never omitted.
- C4: `content_hash` feeds dedup (gbrain reuses the existing content_hash path).

**Excel / XLSX specifics**
- `doc.page_count` = sheet count; **each sheet is an independent block group**;
  `blocks` order = sheet order, then row order within the sheet.
- Each sheet's used range → one `type=table` block (the adapter then slices it into
  row blocks); `locator.sheet` = sheet name.
- **Formulas yield computed values** (not formula strings). Merged cells put their
  value in the anchor cell. (Implementation note: `export_to_dataframe()` reads the
  xlsx *cached* values — real Excel files carry them; openpyxl-written formulas
  without cached values come out empty. Recorded, not a bug.)
- Row blocks use real A1 notation in `locator.cell_range` (e.g. `"Q3!B4:D9"`) —
  XLSX-specific precision, distinct from `row_range` used for PDF tables.

## 7. Sidecar API (FastAPI)

```
POST /parse
  Content-Type: multipart/form-data
  fields: file (bytes, required),
          want_page_images: bool = false,
          format_hint: string = null
  200 → DocIR v1
  413 → file too large (see §13 size cap)
  422 → unparseable
  503 → models not loaded yet

GET /health
  200 → { "ok": true, "models_loaded": true, "docir_version": "1.0", "version": "…" }
```

Skeleton (sketch, see `sidecar/docling-service/` for the real implementation):
```python
from fastapi import FastAPI, UploadFile
from docling.document_converter import DocumentConverter
app = FastAPI()
conv = DocumentConverter()                          # pre-warmed at startup (the point of a resident service)

@app.get("/health")
def health(): return {"ok": True, "models_loaded": True, "docir_version": "1.0"}

@app.post("/parse")
async def parse(file: UploadFile, want_page_images: bool = False):
    doc = conv.convert(file.file).document           # DoclingDocument (with page+bbox)
    return to_docir(doc, want_page_images)           # → DocIR v1
```

## 8. gbrain adapter: `importOfficeFile` flow (normative)

```
importOfficeFile(engine, filePath, relativePath, opts):
  1. content_hash unchanged → skip (reuses existing dedup)
  2. ensureSidecarUp (auto-start; §12) — down + unstartable → clean ImportResult error
  3. POST sidecar /parse(want_page_images = cfg.multimodal !== 'off') → DocIR
  4. validate docir_version == "1.0", else fail with a clear error
  5. doc-block chunker: merge consecutive text blocks up to ingest.office.chunk_tokens,
     producing ChunkInput{ chunk_text, chunk_source:'compiled_truth', source_locator (merged page range) }
  6. each type=table:
       a. summary chunk (LLM; fallback chain per §11)
       b. row-block chunks (every N rows) with locator{page|sheet, cell_range|row_range}
  7. visual blocks (figures / visually dense pages) & ingest.office.multimodal != 'off':
       take asset → gateway.embedMultimodal → write embedding_image (best-effort;
       missing multimodal provider skips gracefully, import never fails on it)
  8. persist through the engine (page + chunks + per-chunk source_locator via the
     cross-engine JSONB path), parser warnings surfaced into page frontmatter +
     ImportResult (§16, R3)
```

## 9. Data model / schema change

```sql
-- One additive entry in the MIGRATIONS array (src/core/migrate.ts, v120); both engines in lockstep
ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS source_locator JSONB;
-- src/schema.sql adds the column for the fresh-install path
-- No index for now: provenance is for display/citation, not filtering. If page-filtered
-- queries become common → add a dedicated page_number INTEGER column + CREATE INDEX CONCURRENTLY
```

- New `chunk_source` values (additive, nothing existing breaks): office text chunks
  persist as `compiled_truth`; image chunks as `image_asset`.
- **Schema invariants**:
  - the column joins the **bootstrap probe set** (`test/schema-bootstrap-coverage.test.ts`);
  - `source_locator` writes **must** go through `executeRawJsonb` — never
    `JSON.stringify` into a `::jsonb` cast (`scripts/check-jsonb-pattern.sh` guards);
  - DDL lands in BOTH `pglite-engine.ts` and `postgres-engine.ts`
    (`test/e2e/engine-parity.test.ts` and `test/e2e/office-engine-parity.test.ts` pin it).

## 10. Config keys (frozen)

```
ingest.docling.enabled              bool      default false (opt-in)
ingest.docling.url                  string    http://127.0.0.1:<port>
ingest.docling.python               string    python path of the managed venv
ingest.docling.max_concurrency      int       default 2 (gbrain-side cap on in-flight /parse, §21.3)
ingest.docling.ocr                  enum      'auto' (default) | 'on' | 'off'  (R1: scanned-PDF OCR)
ingest.docling.images_scale         float     default 1.5 (R1: page/figure render scale, memory vs quality)
ingest.office.chunk_tokens          int       default 512 (D4, independent of markdown chunking)
ingest.office.table_summary.model   string    chat model alias (D9)
ingest.office.table_summary.enabled bool      default true; false → always template summary
ingest.office.multimodal            enum      'selective' (default) | 'all' | 'off'  (D6)
ingest.office.max_file_mb           int       default 50 (§13)
```

**R1b multimodal image embedding (gateway-level env, not office config keys)**: for
images to actually embed, set `VOYAGE_API_KEY` +
`GBRAIN_EMBEDDING_MULTIMODAL=true` +
`GBRAIN_EMBEDDING_MULTIMODAL_MODEL=voyage:voyage-multimodal-3`. The primary
embedding provider can stay text-only (e.g. ollama) while multimodal routes to
Voyage separately; otherwise the recipe reports it does not support multimodal.
Image vectors land in `content_chunks.embedding_image` (1024d).

## 11. LLM table summaries + fallback chain (D9 normative)

```
for each table:
  if ingest.office.table_summary.enabled and a chat provider is available:
     summary = gateway.chat(model=ingest.office.table_summary.model, prompt=table structure + sample rows)
  else:
     summary = template summary ("Table on p.{page}: {n_rows}×{n_cols}, columns: {columns}")
  → an import NEVER fails because a table summary failed
```
- Chat spend is accounted like any other gateway call.
- Low-confidence tables (`warnings: LOW_CONFIDENCE_TABLE`) are surfaced to whoever
  later authors Facts from the page (§16, R3) — the summary itself still imports.

## 12. Sidecar supervision + degradation contract (D8 normative)

`src/core/docling-supervisor.ts` (modeled on the minion supervisor):
1. **Start**: `uvicorn app:app --port <p>` inside the managed venv.
2. **Health polling**: periodic `/health`; N consecutive failures trigger a restart.
3. **Backoff restarts**: jittered backoff, no restart storms; a crash **never wedges
   an import** (the import side catches and reports a clean error).
4. **Shutdown with gbrain**: no zombie processes.
5. **First install**: `gbrain ingest setup-docling` → create venv + `pip install`
  (one-time ML model download; the user is warned about the size).
6. **doctor**: a `docling_service` check (modeled on the ollama health check).

**Import-time auto-start + degradation** (`ensureSidecarUp`, `sidecar-manage.ts`):
- Imports auto-start a **detached** uvicorn when the sidecar is not serving, so
  later imports reuse the warm (model-loaded) process. `gbrain ingest start` does
  the same explicitly.
- **Degradation is fail-fast and never crashes the run** (pinned by
  `test/office-sidecar-degradation.test.ts`): office disabled → clear error telling
  the user how to enable; venv missing → immediate false, no spawn; spawn failure →
  captured (no unhandled `'error'` event), poll short-circuits; sidecar down +
  unstartable → the adapter returns a clean per-file `ImportResult` error and the
  surrounding bulk import continues with the other files.
- **Failed-start cooldown**: a failed start is memoized per URL (in-process,
  5 minutes) so a persistently broken sidecar does not cost every file in a bulk
  import its own spawn + health-poll wait. The health probe always runs first, so a
  recovered or hand-started sidecar wins immediately; explicit `gbrain ingest start`
  bypasses the cooldown.

## 13. Performance / cost / caps

- **Large files**: bounded concurrency + `progress.ts` heartbeats;
  `ingest.office.max_file_mb` gate (default 50MB, modeled on transcription's 25MB pattern).
- **Multimodal cost (verified 2026-06)**: image embedding goes to Voyage
  `voyage-multimodal-3`, landing in `embedding_image` (1024d). **The cost lever is
  `ingest.office.multimodal`** (`off` / `selective` default / `all`) — `selective`
  embeds only figures + visually dense pages; `off` embeds nothing (zero cost).
  **Honest correction**: the *inline* embeddings at import time (text via the
  primary provider, images via Voyage) do **not** pass through `gbrain embed`'s
  interactive spend gate (`spend.posture` governs the bulk backfill path). The
  real cost gates for multimodal are this config key + the provider's free tier
  (Voyage: 200M text tokens + 150B pixels ≈ 75k page images per account; past
  that, $0.60 per billion pixels).
- **Table summary cost**: chat calls, bounded by the fallback chain (§11).

## 14. GBrain invariants that must hold

| Invariant | Where it lands |
|---|---|
| Engine parity (pglite + postgres lockstep) | `source_locator` column, chunk insert path, `upsertChunkLocators` |
| JSONB (executeRawJsonb; never stringify into ::jsonb) | `source_locator` writes |
| Contract-first (operations.ts generates CLI+MCP) | no new op needed (`import` exists); dispatch + config only |
| Migrations (MIGRATIONS array + bootstrap probe) | §9 |
| Progress reporting (progress.ts, stderr) | bulk import heartbeats |
| content_hash dedup | adapter step 1 |
| Trust boundary (remote/MCP vs local) | edge extraction on the local CLI path; remote writes keep existing skip semantics |
| Cost posture | table-summary chat + multimodal embed (§13) |

## 15. Test strategy (mapped to invariants)

- `office-engine-parity` (e2e): office import path identical on both engines.
- `schema-bootstrap-coverage`: the new column is in the probe set.
- doc-block chunker unit tests: merge-to-target-size + locator page ranges.
- adapter integration (**injected DocIR** via the `_parseForTest` seam): chunks /
  locators / warnings correct, idempotent re-import.
- table handling: summary fallback chain, row-block slicing, sheet attribution.
- JSONB writes: `source_locator` via `executeRawJsonb`, no double-encoding.
- supervisor: start / health-fail restart / exit cleanup, backoff.
- **sidecar degradation** (real path, no seam): disabled / unreachable / venv
  missing / spawn failure / cooldown — see §12.

## 16. Acceptance criteria (Definition of Done · M0)

As Given/When/Then assertions:

- **AC1**: Given `gbrain ingest setup-docling` has run, When `gbrain doctor`, Then
  `docling_service: ok`.
- **AC2**: Given a directory containing DOCX/PPTX/text-layer PDF, When
  `gbrain import <dir>`, Then all three import and every chunk's `source_locator`
  is non-empty with correct `page|slide`.
- **AC3**: Given imports done, When `gbrain query "<key sentence from the doc>"`,
  Then the target chunk is hit and the result can display "p.X / Slide Y".
- **AC4**: Given a document with a table, When imported, Then summary + row-block
  chunks exist; Given no chat key, Then the summary falls back to the template and
  the import succeeds.
- **AC5**: Given any change, When CI runs (engine-parity / schema-bootstrap / jsonb
  guards), Then all green; pglite and postgres behave identically.

**Implementation status (all landed on branch `feature/office-ingest-m0`)**: DocIR
contract v1 + types; doc-block chunker; `source_locator` migration (v120) +
cross-engine JSONB writes (`engine.upsertChunkLocators`, pglite/postgres parity);
table handler (LLM summary with template fallback + row blocks + sheet attribution);
`importOfficeFile` + import-file dispatch + collection-walker admission
(`isCollectibleForWalker` accepts office extensions when `ingest.docling.enabled`);
office config keys registered; FastAPI sidecar (OCR + page/figure rendering);
selective multimodal embedding (heuristic unit-tested; Voyage-verified end-to-end);
sidecar supervision (`docling-supervisor.ts`, jittered backoff) + detached
import-time auto-start (`ensureSidecarUp`, §12 degradation contract) +
`gbrain ingest setup-docling|start` commands + doctor `docling_service` check;
parser warnings surfaced (R3). Verified: full office unit suite + real-brain
end-to-end (`gbrain import` collects a PDF → Docling → Voyage `embedding_image` →
text-to-image search hits, cos_dist ≈ 0.45); real-Postgres parity e2e 2 pass / 0 fail.

## 17. Staged roadmap

> **✅ All complete (2026-06).** M1–M4 below were **replanned** after M0 landed
> (M0 over-delivered, and Facts turned out to be fence-based rather than
> auto-extracted) into R1/R2/R3 — see `office-ingest-roadmap.md` for the replan
> and per-milestone implementation records. M0 + R1 + R2 + R3 + the Postgres
> engine-parity e2e all landed and were verified.

| Stage | Scope | Exit |
|---|---|---|
| **M0** | sidecar (resident + supervised) + `importOfficeFile` + doc-block chunker + `source_locator` migration; DOCX/PPTX/PDF (text layer) | AC1–AC5 |
| M1 → R1a | OCR: scanned PDFs parsed via Docling's native OCR | scanned documents searchable |
| M2 → R2 | tables: multi-sheet attribution, computed values, low-confidence marking | tables trustworthy |
| M3 → R1b | multimodal: selective embedding + cross-modal retrieval verified | visual search |
| M4 → R3 | parser warnings surfaced (Facts are fence-authored; see roadmap) | warnings visible downstream |

## 18. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Python sidecar deployment + serialization overhead | breaks zero-config; large files double memory; a crash wedges imports | same shape as ollama (users already accept it); per-file timeout; supervised restarts; §12 degradation contract |
| Large PDF/PPT memory + slow rendering | OOM / imports look stuck | bounded concurrency + render only when needed + progress heartbeats + size gate |
| Complex-table quality (merged / cross-page / table-as-image) | wrong tables → confidently wrong answers | structure-aware parsing (Docling) + low-confidence warnings surfaced (§16, R3) |
| Engine parity + migration workload | strict CI guards, easy to stall | one additive migration + follow existing templates + run parity/bootstrap tests early |
| Ingest gains a chat dependency (D9) | cost + availability coupling | fallback chain + cost exposure |

## 19. Security & privacy

- Docling runs **locally**; files **never leave the machine** (unlike cloud parsers) —
  consistent with GBrain's privacy-first posture.
- The sidecar binds `127.0.0.1` only.
- Edge extraction / writes follow the existing trust boundary: the local CLI path is
  trusted; remote MCP writes keep their existing skip semantics.

## 20. Compatibility / rollback

- Everything is **additive**: new column, new chunk sources, new adapter — **no
  existing behavior changes**.
- `ingest.docling.enabled=false` (the default) → **zero impact** on existing users.
- Rollback = turn the config off; `source_locator` stays NULL for old chunks, harmless.

## 21. Design details (formerly Open Questions, now settled)

### 21.1 doc-block chunker boundary rules
- **Hard boundaries**: `table` / `figure` / `code` blocks are **chunks of their
  own**, flushing before and after — **never** merged with prose, never split
  (avoids slicing table headers / figures into running text).
- **Soft boundaries**: `heading` triggers a flush (a new chunk starts at the
  heading), and the **heading text is prepended to the next chunk** as context
  (contextual retrieval, helps recall).
- `paragraph` / `list` merge until `ingest.office.chunk_tokens`, then flush.
- **No overlap** by default (consistent with the existing markdown chunker; avoids
  behavioral forks).
- A chunk's `source_locator` is the union of its blocks' locators (`page`: min→max;
  single page if all one page).

### 21.2 Table location: cell_range vs row_range
- **XLSX**: real `sheet` + `cell_range` (A1 notation, e.g. `"Q3!B4:D9"`).
- **PDF / DOCX / PPTX tables**: no real cell coordinates → `cell_range = null`; use
  `table_id` + `row_range` (0-based row interval within the table) instead.
- Citation rendering: XLSX → `"book.xlsx Q3!B4:D9"`; PDF table →
  `"report.pdf p.3, table rows 11–20"`.

### 21.3 Sidecar concurrency
- Sidecar runs `uvicorn workers=1`: **a single model replica**, saving memory and
  preventing large-document OOM.
- Concurrency control lives on the **gbrain side**: `ingest.docling.max_concurrency`
  (default 2) caps in-flight `/parse` calls (same concurrency-cap idea as
  `db-pacer`); bulk imports queue on the gbrain side instead of overwhelming the sidecar.
- Larger files get longer timeouts (§13).

### 21.4 Visual-density heuristic (selective multimodal)
- `figure` blocks: **always** embedded (they are images).
- `slide` / `page`: compute visual density; embed the full-page render when any of:
  - `image_area_ratio ≥ 0.30` (image share of page area), **or**
  - `n_figures ≥ 1 and text_char_count < 280` (sparse text + figures), **or**
  - `text_char_count < 50` (nearly no text = probably a chart/diagram).
- Thresholds are built-in defaults (tunable later); `ingest.office.multimodal`:
  `'all'` embeds everything / `'off'` nothing / `'selective'` (default) uses this heuristic.

## Appendix A — Affected files

| File | Kind | Change |
|---|---|---|
| `sidecar/docling-service/{app,docir,docling_runtime,render}.py` | NEW | FastAPI + Docling pipeline config + DocIR mapping |
| `src/core/office/{types,adapter,config,extensions,table,multimodal,sidecar-client,sidecar-manage}.ts` | NEW | adapter + office config + sidecar client / management |
| `src/core/chunkers/doc-block.ts` | NEW | structure-aware chunker (§21.1) |
| `src/core/docling-supervisor.ts` | NEW | sidecar supervision (D8, §12) |
| `src/commands/ingest.ts` | NEW | `gbrain ingest setup-docling|start` |
| `src/core/import-file.ts` | EDIT | dispatch via `isOfficeFilePath` (binary-safe, before the UTF-8 read) |
| `src/commands/import.ts` | EDIT | collection walker admits office extensions when enabled |
| `src/core/migrate.ts` | EDIT | `source_locator` migration (v120) |
| `src/schema.sql` (+ embedded copies) | EDIT | content_chunks column for fresh installs |
| `src/core/pglite-engine.ts` / `postgres-engine.ts` | EDIT | `upsertChunkLocators` (cross-engine JSONB) |
| `src/core/config.ts` | EDIT | §10 config keys registered |
| `src/commands/doctor.ts` | EDIT | `docling_service` check |
| `evals/office-ingest/` | NEW | retrieval sanity-eval scaffold (hit@k / MRR) |

## Appendix B — Glossary

- **DocIR**: Document Intermediate Representation — the normalized contract between
  the sidecar and gbrain.
- **source_locator**: a chunk's precise position in the original document
  (page/slide/sheet/cell/bbox).
- **sidecar**: a helper process cooperating with the main process (here: the
  Docling FastAPI service).
