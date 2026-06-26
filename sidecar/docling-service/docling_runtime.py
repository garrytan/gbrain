"""Docling converter singleton + input helpers.

The converter is loaded lazily and kept resident (one copy per process) so the
first /parse call isn't cold. Concurrency is capped on the gbrain side
(ingest.docling.max_concurrency); run uvicorn with --workers 1.
"""
from __future__ import annotations

import io
import os
from typing import Any, Optional

# 50 MB — mirrors gbrain's ingest.office.max_file_mb default.
MAX_FILE_BYTES = 50 * 1024 * 1024

_converter: Optional[Any] = None
_load_error: Optional[Exception] = None


def _images_scale() -> float:
    """Page/figure render scale (memory vs quality). From gbrain via env."""
    try:
        return float(os.environ.get("DOCLING_IMAGES_SCALE", "1.5"))
    except Exception:
        return 1.5


def _do_ocr() -> bool:
    """Whether to OCR scanned (no-text-layer) PDFs. From gbrain via env."""
    return os.environ.get("DOCLING_DO_OCR", "true").strip().lower() not in ("0", "false", "off", "no")


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
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions

        # R1 (office-ingest-r1-pipeline-activation.md §3): keep page + figure
        # images (feeds the multimodal embed arm) and OCR scanned PDFs. Knobs
        # come from env set by gbrain's ensureSidecarUp at spawn. Image EMISSION
        # is still gated per-request by want_page_images (docir.py), so a
        # multimodal=off import renders nothing.
        pdf = PdfPipelineOptions()
        pdf.generate_page_images = True      # DOCLING-API: full-page renders
        pdf.generate_picture_images = True   # DOCLING-API: figure images
        pdf.images_scale = _images_scale()
        pdf.do_ocr = _do_ocr()
        pdf.do_table_structure = True
        # OCR engine: keep Docling's default OcrAutoOptions, which auto-detects
        # whatever engine is pip-installed (rapidocr_onnxruntime / easyocr /
        # tesseract). An engine must be installed for do_ocr to actually run; see
        # requirements.txt. Not pinned here because engine availability varies by
        # Python version (e.g. rapidocr_onnxruntime caps at Py<3.13).
        _converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf)},
        )
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
