"""Docling converter singleton + input helpers.

The converter is loaded lazily and kept resident (one copy per process) so the
first /parse call isn't cold. Concurrency is capped on the gbrain side
(ingest.docling.max_concurrency); run uvicorn with --workers 1.
"""
from __future__ import annotations

import io
from typing import Any, Optional

# 50 MB — mirrors gbrain's ingest.office.max_file_mb default.
MAX_FILE_BYTES = 50 * 1024 * 1024

_converter: Optional[Any] = None
_load_error: Optional[Exception] = None


def get_converter() -> Any:
    """Return the singleton DocumentConverter, loading Docling lazily.

    Raises the original import/load error if Docling isn't installed, so /health
    can report not-ready instead of the process crashing at import time.
    """
    global _converter, _load_error
    if _converter is not None:
        return _converter
    if _load_error is not None:
        raise _load_error
    try:
        from docling.document_converter import DocumentConverter

        # M0: default pipeline (layout + table structure). Image generation for
        # OCR (M1) and multimodal (M3) is enabled later via PdfPipelineOptions
        # (generate_page_images / generate_picture_images) — deferred per the
        # office-ingest phasing.
        _converter = DocumentConverter()
        return _converter
    except Exception as e:  # noqa: BLE001 — remembered so /health stays up
        _load_error = e
        raise


def is_ready() -> bool:
    try:
        return get_converter() is not None
    except Exception:
        return False


def to_source(filename: str, data: bytes) -> Any:
    """Wrap raw bytes as a Docling DocumentStream for in-memory conversion."""
    from docling.datamodel.base_models import DocumentStream

    return DocumentStream(name=filename, stream=io.BytesIO(data))
