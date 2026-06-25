"""GBrain Docling sidecar — FastAPI service that parses office documents into
DocIR (docs/proposals/office-ingest.md §6, §7).

Run (one worker on purpose: Docling models load once and stay resident;
concurrency is capped on the gbrain side via ingest.docling.max_concurrency):

    uvicorn app:app --host 127.0.0.1 --port 8765 --workers 1
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from docir import DOCIR_VERSION, content_sha256, document_to_docir
from docling_runtime import MAX_FILE_BYTES, is_ready, get_converter

log = logging.getLogger("docling-sidecar")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the model at startup so the first /parse isn't cold. Never fail
    # startup if Docling isn't installed yet — /health reports not-ready.
    try:
        get_converter()
    except Exception:
        log.warning("Docling not loaded at startup; /health will report not-ready")
    yield


app = FastAPI(title="gbrain-docling-sidecar", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    ready = is_ready()
    return {
        "ok": ready,
        "models_loaded": ready,
        "docir_version": DOCIR_VERSION,
        "version": "0.1.0",
    }


@app.post("/parse")
async def parse(
    file: UploadFile = File(...),
    want_page_images: bool = Form(False),
    format_hint: Optional[str] = Form(None),
) -> JSONResponse:
    data = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail=f"file exceeds {MAX_FILE_BYTES} bytes")
    if not is_ready():
        raise HTTPException(status_code=503, detail="docling models not loaded")
    try:
        docir = document_to_docir(
            filename=file.filename or "upload",
            data=data,
            want_page_images=want_page_images,
            format_hint=format_hint,
            content_hash=content_sha256(data),
        )
    except Exception as e:  # noqa: BLE001 — surface as 422; never leak a 500 stack
        log.exception("parse failed")
        raise HTTPException(status_code=422, detail=f"unparseable: {e}")
    return JSONResponse(docir)
