"""Image rendering helpers (figures + full-page renders).

Best-effort and version-tolerant: returns None whenever an image isn't
available, so the caller simply omits the asset. Full page/figure rendering
relies on the converter being configured to keep images (generate_page_images /
generate_picture_images), which lands with OCR (M1) and multimodal (M3); in M0
these typically return None.
"""
from __future__ import annotations

import base64
import io
from typing import Any, Optional


def _png_b64(pil_image: Any) -> Optional[str]:
    if pil_image is None:
        return None
    try:
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


def render_page_png(doc: Any, page_no: int) -> Optional[str]:
    """Return base64 PNG of a rendered page, or None if not available."""
    pages = getattr(doc, "pages", {}) or {}
    page = pages.get(page_no)
    img = getattr(page, "image", None)  # DOCLING-API: PageItem.image
    pil = getattr(img, "pil_image", None) if img is not None else None
    return _png_b64(pil)


def asset_from_picture(item: Any, doc: Any, locator: dict) -> Optional[dict]:
    """Build a DocIR image asset from a Docling picture item, or None."""
    pil = None
    getter = getattr(item, "get_image", None)  # DOCLING-API: PictureItem.get_image(doc)
    if callable(getter):
        try:
            pil = getter(doc)
        except Exception:
            pil = None
    if pil is None:
        img = getattr(item, "image", None)
        pil = getattr(img, "pil_image", None) if img is not None else None

    b64 = _png_b64(pil)
    if b64 is None:
        return None

    ref = str(getattr(item, "self_ref", None) or "fig")
    aid = "a-" + str(abs(hash(ref)) % 100000)
    return {
        "id": aid,
        "kind": "image",
        "mime": "image/png",
        "data_b64": b64,
        "is_rendered_page": False,
        "locator": locator,
    }
