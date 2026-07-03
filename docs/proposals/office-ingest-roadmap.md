# Office Ingest — post-M0 roadmap (replan) + implementation record

> Companion to `docs/proposals/office-ingest.md` (the PRD/Spec). This file redrew
> the milestone boundaries **after** M0 landed — M0 delivered a large part of the
> original M2/M3 along the way, so the linear M1→M2→M3→M4 sequence no longer held.
> The replan was grounded in **actual code state** (2026-06, branch
> `feature/office-ingest-m0`).

> **✅ Status: this roadmap has been executed in full.** M0 + R1 (a/b) + R2 + R3 +
> the Postgres engine-parity e2e all landed and were verified (PGLite real
> full-path + real Postgres `2 pass / 0 fail`). §1–§3 are the replan-time analysis
> (kept as the record of *why* the milestones were cut this way); each milestone's
> final state is in the "Implementation record" notes under §4.
>
> **Command-layer reachability fixes** (found when connecting a real brain): the
> M0–R3 tests drove `importOfficeFile` directly, bypassing the command layer, which
> hid two gaps that blocked real-world use — ① the `gbrain import`/`sync` file
> collection walker (`isCollectibleForWalker`) did not admit office extensions
> under any strategy (the adapter worked but no files ever reached it); ② the
> office config keys were not in the `config set` allowlist (required `--force`).
> Both fixed (an `officeOn` flag threaded through collection + the §10 keys
> registered). **Verified end-to-end against a real brain**: `gbrain import`
> collects a PDF → Docling → Voyage `embedding_image` → text-to-image search hits
> (cos_dist ≈ 0.45).

## 1. Why replan

M0's goal was "text layer into the store", but the implementation pulled several
later milestones forward:

- **Table LLM summaries + row blocks** (the bulk of the original M2) → landed in
  `src/core/office/table.ts`, working for real.
- **Selective multimodal embedding** (the bulk of the original M3) → landed in
  `src/core/office/multimodal.ts`, selection heuristic unit-tested.
- **The full image pipeline plumbing** (sidecar `want_page_images` → DocIR.assets →
  multimodal embedding) → connected end-to-end, only the converter configuration
  was missing.

So the remaining work was not "build three big milestones" but "**activate dormant
code + fill a few verification holes**".

## 2. State inventory (at replan time · historical snapshot)

| Component | File | State then |
|---|---|---|
| Text-layer ingest (DOCX/PPTX/PDF) | `adapter.ts` + `doc-block.ts` | ✅ working |
| `source_locator` persistence | `engine.upsertChunkLocators` (v120) | ✅ cross-engine, page covered by integration test |
| Table summaries (LLM + template fallback) + row blocks | `table.ts` | ✅ working (fallback verified) |
| Multimodal embedding (selection heuristic + routing) | `multimodal.ts` | 🟡 gbrain side done; **dormant** (no assets fed in) |
| Image pipeline (request flag → DocIR.assets) | `app.py` / `sidecar-client.ts` / `docir.py` / `render.py` | 🟡 plumbing complete; **converter not configured to render** |
| Auto-start + supervision + setup CLI + doctor | `sidecar-manage.ts` / `docling-supervisor.ts` / `ingest.ts` | ✅ done |
| **Converter render/OCR config** | `docling_runtime.py` | 🔴 bare `DocumentConverter()`, no `PdfPipelineOptions` |
| Adapter passing `wantPageImages` | `adapter.ts` | 🔴 always default false |
| XLSX multi-sheet attribution (`loc.sheet`) | `docir.py` | 🔴 only page/slide set, never sheet |
| `docir.warnings` consumption (low-confidence tables) | `adapter.ts` | 🔴 produced but dropped on the gbrain side |
| office content → Facts | dream cycle | ⚪ assumed automatic; unverified (turned out fence-based, see R3) |

🔴/🟡 items were all closed by R1/R2/R3 below.

## 3. Key insight: the master switch was configuration, not engineering

The original M1 (OCR) and M3 (multimodal) were assumed to be greenfield work. In fact:

1. **M3 activation = 2 small changes**: configure the converter in
   `docling_runtime.py` (`generate_page_images` / `generate_picture_images`), and
   have `adapter.ts` pass `wantPageImages: true` when `cfg.multimodal !== 'off'`.
   Assets then flow automatically → `multimodalChunks` fires → image chunks persist.
2. **M1 (OCR) collapses**: Docling has OCR built in
   (`PdfPipelineOptions(do_ocr=True)`) — scanned-PDF text comes out natively as
   ordinary blocks. The originally planned "render pages → reuse the
   `importImageFile` OCR path" detour was unnecessary.
3. ∴ M1 and M3 **live in the same file** (the pipeline options in
   `docling_runtime.py`), strongly coupled → merged into one "pipeline activation"
   milestone.

## 4. Redrawn milestones (R1 / R2 / R3)

### R1 — Pipeline activation (original M1 + M3 merged) · highest leverage

**Goal**: turn on converter rendering + OCR; the dormant multimodal path and
scanned-PDF OCR go live together. **No DocIR contract change** (v1.0 already
defines `assets[]`, `is_rendered_page`, `asset_ref`; R1 just makes them non-empty).

**Changes**
- `docling_runtime.py`: per-format converter with `PdfPipelineOptions` —
  `generate_page_images=True`, `generate_picture_images=True`, `images_scale`,
  `do_ocr` (configurable), `do_table_structure=True`.
- `adapter.ts`: `parseViaSidecar(cfg.url, rel, bytes, { wantPageImages: cfg.multimodal !== 'off' })`.
- New config keys: `ingest.docling.ocr` (`auto|on|off`), `ingest.docling.images_scale` (float).
- Pipeline config reaches the sidecar as env at spawn time (`DOCLING_DO_OCR`,
  `DOCLING_IMAGES_SCALE`, set by `ensureSidecarUp`), fixed per process.

**Constraint made explicit**: `multimodalChunks` needs a **multimodal embedding
provider**. A text-only primary embedder (e.g. ollama `nomic-embed-text`) cannot
embed images — the image arm skips best-effort and the import never fails on it.
So R1 verified in two arms: the **OCR arm** (pure text, verifiable with any text
embedder) and the **multimodal arm** (needs a visual embedder, e.g. Voyage).

**DoD**: scanned PDFs searchable; figure-heavy decks produce `image_asset` chunks;
`multimodal=off` keeps the pure-text path byte-identical to M0; large PDFs respect
the size gate + render scale.

**Implementation record (R1a — OCR arm, landed + verified for real)**: converter
configured with `PdfPipelineOptions` (render + OCR), env-driven; adapter passes
`wantPageImages`; config keys landed. Real smoke: an image-only scanned PDF →
OCR text stored, `revenue`/`million`/`fiscal` searchable; a direct
`/parse(want_page_images=true)` produced valid rendered-page PNGs
(`is_rendered_page=true`, page locators, ~46KB each). **OCR engine note**: on
Python 3.14, `rapidocr_onnxruntime` is incompatible (requires <3.13) → Docling's
auto-OCR selects **easyocr** by default; the first run downloads models (~140MB).

**Implementation record (R1b — multimodal arm, verified)**: enabling the image arm
is pure configuration (three env vars, `.env` works): `VOYAGE_API_KEY` +
`GBRAIN_EMBEDDING_MULTIMODAL=true` +
`GBRAIN_EMBEDDING_MULTIMODAL_MODEL=voyage:voyage-multimodal-3` (primary embedding
stays text-only; multimodal routes to Voyage separately). Verified: ①
`embedMultimodal(image)` → 1024d, cosine(image, "revenue chart") = 0.65; ② a
figure-bearing PDF imported with `multimodal=all` → the `image_asset` chunk's
`embedding_image` persisted (text chunks unaffected); ③ the text "revenue"
embedded into image space → pgvector cosine search over `embedding_image` hits the
figure chunk (cos_dist 0.75 — cross-modal retrieval works). R1b required no new
code; M0/R1a plumbing was already in place.

### R2 — Table hardening (original M2 remainder) · small

**Goal**: take the existing table capability from "runs" to "trustworthy".

**Implementation record (landed + verified)**: Docling maps each xlsx sheet to a
1-based `page_no` (it does not expose sheet names), so `docir.py` maps ordinal →
sheet name via openpyxl; xlsx locators use `loc.sheet` (page left null). `table.ts`
already supported sheet in its locator hint, so the sheet name reaches both
`source_locator` and the searchable summary text (`Table in sheet "Q1Sales": …`).
**Real verification**: a two-sheet xlsx → 4 chunks, each with the correct sheet
(Q1Sales / Regions). **Formulas**: `export_to_dataframe()` reads xlsx *cached*
values — real Excel files carry them; openpyxl-written formulas without cached
values come out empty (recorded, not a bug). **Low confidence**:
`LOW_CONFIDENCE_TABLE` fires on parse failure; clean tables do not trigger it.

### R3 — Parser warnings surfaced (original M4, premise corrected) · small

**Premise correction**: reading the code showed gbrain's Facts are **not**
auto-extracted from page content. Both existing paths — the `## Facts` fence
(reconciled from explicit fences on entity pages) and conversation-turn extraction
(Hot Memory) — never touch office tables. So "suppress Facts from low-confidence
tables" was a non-problem: office tables never auto-produce Facts. The correct
move is to inform whoever *authors* a `## Facts` fence from the page.

**Salvaged real value**: the adapter previously **dropped** `docir.warnings`. R3
surfaces them — into page `frontmatter.warnings` and `ImportResult.warnings` — so
a person or agent later writing Facts from that page sees "this table parsed with
low confidence, don't trust it blindly". Verified with warning fixtures on both
sides, and clean imports carry no warnings field.

## 5. Dependency picture

```
R1 pipeline activation ──┬─→ multimodal retrieval (needs a visual embedder)
                         └─→ scanned-PDF OCR (any text embedder verifies it)
R2 table hardening   (independent, additive)
R3 warnings surfaced (benefits from R2's low-confidence signal; not blocked by it)
```

R1 first — it lit up the largest block of "written but unpowered" code, and its
OCR arm was verifiable end-to-end with the existing local stack. R2/R3 were
incremental hardening.
