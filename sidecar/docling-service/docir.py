"""DoclingDocument -> DocIR mapping.

Authoritative contract: docs/proposals/office-ingest.md §6. The DocIR shape
here MUST stay byte-compatible with src/core/office/types.ts (DOCIR_VERSION).

NOTE (version sensitivity): Docling's item/label/table/picture APIs vary across
releases. The DocIR *output shape* is fully controlled here; the Docling *input*
calls marked `# DOCLING-API` should be re-verified against the installed
docling version when the sidecar is first run.
"""
from __future__ import annotations

import hashlib
from typing import Any, Optional

from docling_runtime import get_converter, to_source
from render import asset_from_picture, render_page_png

DOCIR_VERSION = "1.0"


def content_sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# Docling DocItemLabel -> DocIR block type.
_LABEL_TO_TYPE = {
    "title": "heading",
    "section_header": "heading",
    "paragraph": "paragraph",
    "text": "paragraph",
    "list_item": "list",
    "code": "code",
    "table": "table",
    "picture": "figure",
    "caption": "paragraph",
}


def _empty_locator() -> dict:
    return {
        "page": None,
        "slide": None,
        "sheet": None,
        "cell_range": None,
        "table_id": None,
        "row_range": None,
        "bbox": None,
    }


def _detect_format(filename: str, hint: Optional[str]) -> str:
    name = (hint or filename or "").lower()
    for ext, fmt in (
        (".pdf", "pdf"),
        (".docx", "docx"),
        (".pptx", "pptx"),
        (".xlsx", "xlsx"),
        (".png", "image"),
        (".jpg", "image"),
        (".jpeg", "image"),
    ):
        if name.endswith(ext):
            return fmt
    return "pdf"


def _locator_from_prov(prov: Any, fmt: str) -> dict:
    loc = _empty_locator()
    if not prov:
        return loc
    p = prov[0]  # DOCLING-API: ProvenanceItem
    page = getattr(p, "page_no", None)
    if page is not None:
        loc["slide" if fmt == "pptx" else "page"] = int(page)
    bbox = getattr(p, "bbox", None)
    if bbox is not None:
        try:
            loc["bbox"] = [float(bbox.l), float(bbox.t), float(bbox.r), float(bbox.b)]
        except Exception:
            pass
    return loc


def _heading_level(item: Any) -> int:
    lvl = getattr(item, "level", None)
    return int(lvl) if isinstance(lvl, int) else 1


def _item_markdown(item: Any, doc: Any) -> str:
    fn = getattr(item, "export_to_markdown", None)  # DOCLING-API
    if callable(fn):
        try:
            return fn(doc)
        except TypeError:
            try:
                return fn()
            except Exception:
                pass
        except Exception:
            pass
    return getattr(item, "text", "") or ""


def _table_payload(item: Any) -> tuple[dict, bool]:
    """Return (DocTable, low_confidence). Uses Docling's dataframe export."""
    try:
        df = item.export_to_dataframe()  # DOCLING-API
        columns = [str(c) for c in list(df.columns)]
        rows = [
            ["" if v is None else str(v) for v in row]
            for row in df.itertuples(index=False, name=None)
        ]
        n_rows, n_cols = len(rows), len(columns)
        return (
            {
                "header_rows": 1,
                "n_rows": n_rows,
                "n_cols": n_cols,
                "columns": columns,
                "rows": rows,
            },
            (n_rows == 0 or n_cols == 0),
        )
    except Exception:
        return (
            {"header_rows": 0, "n_rows": 0, "n_cols": 0, "columns": [], "rows": []},
            True,  # could not parse → low confidence (suppresses Facts extraction)
        )


def _page_count(doc: Any, fmt: str) -> Optional[int]:
    pages = getattr(doc, "pages", None)
    if pages:
        try:
            return len(pages)
        except Exception:
            return None
    return None


def _parser_id() -> str:
    try:
        import docling  # type: ignore

        return f"docling@{getattr(docling, '__version__', '?')}"
    except Exception:
        return "docling@?"


def document_to_docir(
    filename: str,
    data: bytes,
    want_page_images: bool,
    format_hint: Optional[str],
    content_hash: str,
) -> dict:
    conv = get_converter()
    result = conv.convert(to_source(filename, data))  # DOCLING-API
    doc = result.document
    fmt = _detect_format(filename, format_hint)

    blocks: list[dict] = []
    assets: list[dict] = []
    warnings: list[str] = []
    order = 0

    # DOCLING-API: iterate_items() yields (item, level) in reading order.
    for item, _level in doc.iterate_items():
        label = str(getattr(item, "label", "")).split(".")[-1].lower()
        btype = _LABEL_TO_TYPE.get(label)
        if btype is None:
            continue  # skip page_header/footer/formula/etc. for M0

        bid = str(getattr(item, "self_ref", None) or f"b{order}")
        block: dict = {
            "id": bid,
            "type": btype,
            "level": _heading_level(item) if btype == "heading" else None,
            "markdown": _item_markdown(item, doc),
            "text": getattr(item, "text", "") or "",
            "order": order,
            "locator": _locator_from_prov(getattr(item, "prov", None), fmt),
            "table": None,
            "asset_ref": None,
        }

        if btype == "table":
            table, low_conf = _table_payload(item)
            block["table"] = table
            if low_conf:
                warnings.append(f"LOW_CONFIDENCE_TABLE:{bid}")
        elif btype == "figure":
            # M0: best-effort; full picture-image extraction lands in M3.
            asset = asset_from_picture(item, doc, block["locator"])
            if asset is not None:
                assets.append(asset)
                block["asset_ref"] = asset["id"]

        blocks.append(block)
        order += 1

    # Full-page render (OCR M1 / multimodal M3). Best-effort; empty unless the
    # converter was configured to keep page images.
    if want_page_images:
        pages = getattr(doc, "pages", {}) or {}
        for pno in sorted(pages):
            b64 = render_page_png(doc, pno)
            if not b64:
                continue
            loc = _empty_locator()
            loc["slide" if fmt == "pptx" else "page"] = int(pno)
            assets.append(
                {
                    "id": f"page{pno}",
                    "kind": "image",
                    "mime": "image/png",
                    "data_b64": b64,
                    "is_rendered_page": True,
                    "locator": loc,
                }
            )

    return {
        "docir_version": DOCIR_VERSION,
        "doc": {
            "format": fmt,
            "page_count": _page_count(doc, fmt),
            "content_hash": content_hash,
            "parser": _parser_id(),
        },
        "blocks": blocks,
        "assets": assets,
        "warnings": warnings,
    }
