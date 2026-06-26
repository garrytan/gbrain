# GBrain Docling Sidecar

A small FastAPI service that parses office documents (PDF / DOCX / PPTX / XLSX)
into **DocIR** — the versioned contract consumed by gbrain's office-ingest
adapter. See `docs/proposals/office-ingest.md` §6–§7 for the spec.

> **Mental model:** this is "ollama for documents" — a resident local service
> gbrain calls over HTTP. It runs on `127.0.0.1` only; files never leave the
> machine.

## Files

| File | Role |
|---|---|
| `app.py` | FastAPI: `POST /parse`, `GET /health` |
| `docir.py` | `DoclingDocument` → DocIR v1 mapping (must match `src/core/office/types.ts`) |
| `render.py` | Best-effort figure / page-image rendering (OCR M1, multimodal M3) |
| `docling_runtime.py` | Lazy, resident `DocumentConverter` singleton |
| `pyproject.toml` | Dependencies |

## Setup (run once)

One command from anywhere in the repo:

```bash
gbrain ingest setup-docling     # creates .venv + installs Docling
```

Or manually:

```bash
cd sidecar/docling-service
python -m venv .venv
# Windows:  .venv\Scripts\activate     |  macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt   # pulls Docling + torch — several GB; first run also downloads ML models
```

## Run

`gbrain import` auto-starts a detached sidecar when `ingest.docling.enabled` is
true (the warm, model-loaded server is reused by later imports), so you usually
don't run this by hand. To start it explicitly:

```bash
gbrain ingest start
# …or directly:
uvicorn app:app --host 127.0.0.1 --port 8765 --workers 1
```

`--workers 1` is intentional: Docling models load once and stay resident;
concurrency is bounded on the gbrain side (`ingest.docling.max_concurrency`).

## Smoke test

```bash
curl http://127.0.0.1:8765/health
# → {"ok": true, "models_loaded": true, "docir_version": "1.0", ...}

curl -F "file=@/path/to/doc.pdf" -F "want_page_images=false" \
     http://127.0.0.1:8765/parse | jq '.docir_version, (.blocks | length)'
```

gbrain points at it via:

```bash
gbrain config set ingest.docling.enabled true
gbrain config set ingest.docling.url http://127.0.0.1:8765
```

## Scope & known M0 limits

- **M0 = text layer + tables + provenance.** Figure/page **images** require the
  converter to keep images (`generate_page_images` / `generate_picture_images`);
  that's wired with OCR (**M1**) and multimodal embedding (**M3**), so in M0
  `assets` is usually empty and `want_page_images` returns nothing.
- Lines marked `# DOCLING-API` in `docir.py` / `render.py` depend on the
  installed Docling version — verify them on first run and adjust if the item /
  label / table / picture API differs.
- The DocIR **output shape** is frozen (`DOCIR_VERSION = "1.0"`); keep it in
  lockstep with `src/core/office/types.ts`.
