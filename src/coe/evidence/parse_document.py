#!/usr/bin/env python3
"""Deterministic, no-network HTML/PDF block extractor for CoE Lite."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import re
import sys
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


MAX_BLOCKS = 50_000
MAX_PDF_PAGES = 500
BLOCK_TAGS = {
    "title",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "pre",
    "figcaption",
    "td",
    "th",
    "dt",
    "dd",
}
SUPPRESSED_TAGS = {
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "annotation",
    "annotation-xml",
}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
TABLE_CAPTION_PATTERN = re.compile(r"(?im)^\s*table\s+(?:[a-z]?\d+|[ivxlcdm]+)\b")


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


def normalize_code(value: str) -> str:
    return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n")).strip()


def warning(code: str, message: str, severity: str, locator: dict[str, Any] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"code": code, "message": message, "severity": severity}
    if locator is not None:
        value["locator"] = locator
    return value


class BlockHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict[str, Any]] = []
        self.root_counts: dict[str, int] = {}
        self.blocks: list[dict[str, Any]] = []
        self.warnings: list[dict[str, Any]] = []
        self.sequence = 0

    def _path_for(self, tag: str) -> str:
        counts = self.stack[-1]["child_counts"] if self.stack else self.root_counts
        counts[tag] = counts.get(tag, 0) + 1
        parent = self.stack[-1]["path"] if self.stack else ""
        return f"{parent}/{tag}[{counts[tag]}]"

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        line, column = self.getpos()
        path = self._path_for(tag)
        suppressed = (self.stack[-1]["suppressed"] if self.stack else False) or tag in SUPPRESSED_TAGS
        selected = not suppressed and tag in BLOCK_TAGS
        if selected:
            for context in reversed(self.stack):
                if context["selected"]:
                    context["has_selected_child"] = True
                    break
        context = {
            "tag": tag,
            "path": path,
            "line": line,
            "column": column,
            "selected": selected,
            "suppressed": suppressed,
            "has_selected_child": False,
            "parts": [],
            "child_counts": {},
        }
        self.stack.append(context)
        if not suppressed and tag == "img":
            attr_map = {name.lower(): value or "" for name, value in attrs}
            text = normalize_space(attr_map.get("alt", "") or attr_map.get("title", ""))
            locator = {"kind": "block", "block_id": f"html:{path}:{line}:{column}"}
            if text:
                self._append_block("figure", text, text, locator, line, column)
            else:
                self.warnings.append(warning(
                    "html_figure_without_text",
                    "An HTML image has no textual alternative and cannot support a claim.",
                    "blocking",
                    locator,
                ))
        if tag in VOID_TAGS:
            self.stack.pop()

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if not data or (self.stack and self.stack[-1]["suppressed"]):
            return
        for context in self.stack:
            if context["selected"]:
                context["parts"].append(data)

    def handle_entityref(self, name: str) -> None:
        self.handle_data(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self.handle_data(f"&#{name};")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        matching = next((index for index in range(len(self.stack) - 1, -1, -1) if self.stack[index]["tag"] == tag), None)
        if matching is None:
            return
        for context in reversed(self.stack[matching:]):
            self._finish_context(context)
        del self.stack[matching:]

    def close(self) -> None:
        super().close()
        for context in reversed(self.stack):
            self._finish_context(context)
        self.stack.clear()
        self.blocks.sort(key=lambda block: block.pop("_order"))

    def _finish_context(self, context: dict[str, Any]) -> None:
        if not context["selected"] or context["has_selected_child"]:
            return
        raw_text = "".join(context["parts"])
        text = normalize_code(raw_text) if context["tag"] == "pre" else normalize_space(raw_text)
        if not text:
            return
        tag = context["tag"]
        kind = "paragraph"
        heading_level = None
        if re.fullmatch(r"h[1-6]", tag):
            kind = "heading"
            heading_level = int(tag[1])
        elif tag == "title":
            kind = "metadata"
        elif tag == "blockquote":
            kind = "quote"
        elif tag == "li":
            kind = "list_item"
        elif tag in {"td", "th"}:
            kind = "table_cell"
        elif tag == "figcaption":
            kind = "figure"
        elif tag == "pre":
            kind = "code_block"
        locator = {
            "kind": "block",
            "block_id": f"html:{context['path']}:{context['line']}:{context['column']}",
        }
        self._append_block(kind, text, raw_text, locator, context["line"], context["column"], heading_level)

    def _append_block(
        self,
        kind: str,
        text: str,
        raw_text: str,
        locator: dict[str, Any],
        line: int,
        column: int,
        heading_level: int | None = None,
    ) -> None:
        if len(self.blocks) >= MAX_BLOCKS:
            raise ValueError(f"HTML exceeds {MAX_BLOCKS} normalized blocks")
        self.sequence += 1
        block: dict[str, Any] = {
            "block_id": locator["block_id"],
            "kind": kind,
            "text": text,
            "raw_text": raw_text,
            "raw_locator": locator,
            "_order": (line, column, self.sequence),
        }
        if heading_level is not None:
            block["heading_level"] = heading_level
        self.blocks.append(block)


def parse_html(path: Path) -> dict[str, Any]:
    parser = BlockHtmlParser()
    parser.feed(path.read_text(encoding="utf-8", errors="strict"))
    parser.close()
    return {
        "parser": {"name": "python.html.parser", "version": f"{sys.version_info.major}.{sys.version_info.minor}"},
        "blocks": parser.blocks,
        "warnings": parser.warnings,
    }


def parse_pdf(path: Path) -> dict[str, Any]:
    try:
        import fitz  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError("PyMuPDF is required for PDF normalization") from error

    document = fitz.open(path)
    try:
        if document.needs_pass:
            raise ValueError("Encrypted PDFs are not accepted without an explicit decryption policy")
        if document.page_count > MAX_PDF_PAGES:
            raise ValueError(f"PDF exceeds {MAX_PDF_PAGES} pages")
        blocks: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = [warning(
            "pdf_layout_semantics_unverified",
            "PDF text order is deterministic, but visual reading order remains parser-derived.",
            "warning",
        )]
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            page_number = page_index + 1
            page_dict = page.get_text("dict", sort=True)
            page_text_blocks = 0
            for block_index, block in enumerate(page_dict.get("blocks", [])):
                if block.get("type") != 0:
                    continue
                line_texts: list[str] = []
                for line in block.get("lines", []):
                    line_text = "".join(str(span.get("text", "")) for span in line.get("spans", []))
                    line_text = normalize_space(line_text)
                    if line_text:
                        line_texts.append(line_text)
                text = normalize_space(" ".join(line_texts))
                if not text:
                    continue
                bbox = block.get("bbox", [])
                locator: dict[str, Any] = {"kind": "pdf_page", "page": page_number}
                if len(bbox) == 4:
                    x0, y0, x1, y1 = (float(value) for value in bbox)
                    if x1 > x0 and y1 > y0:
                        locator["bounding_box"] = {
                            "x": max(0.0, x0),
                            "y": max(0.0, y0),
                            "width": x1 - x0,
                            "height": y1 - y0,
                        }
                blocks.append({
                    "block_id": f"pdf:page:{page_number}:block:{block_index}",
                    "kind": "paragraph",
                    "text": text,
                    "raw_text": "\n".join(line_texts),
                    "raw_locator": locator,
                })
                page_text_blocks += 1
                if len(blocks) >= MAX_BLOCKS:
                    raise ValueError(f"PDF exceeds {MAX_BLOCKS} normalized blocks")
            images = page.get_images(full=True)
            if images:
                warnings.append(warning(
                    "pdf_figures_not_textualized",
                    f"Page {page_number} contains {len(images)} image object(s) without verified textual semantics.",
                    "blocking",
                    {"kind": "pdf_page", "page": page_number},
                ))
            page_text = page.get_text("text", sort=True)
            caption_count = len(TABLE_CAPTION_PATTERN.findall(page_text))
            try:
                # PyMuPDF may print an optional-layout recommendation. Keep the
                # JSON process boundary deterministic while using only the
                # table count as a conservative signal, never as evidence.
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    detected_tables = page.find_tables()
                detected_table_count = len(detected_tables.tables)
            except Exception as error:
                warnings.append(warning(
                    "pdf_table_detection_failed",
                    f"Page {page_number} table detection failed closed ({type(error).__name__}).",
                    "blocking",
                    {"kind": "pdf_page", "page": page_number},
                ))
                detected_table_count = 0
            if detected_table_count or caption_count:
                warnings.append(warning(
                    "pdf_tables_not_structured",
                    (
                        f"Page {page_number} contains {detected_table_count} layout table candidate(s) "
                        f"and {caption_count} table caption candidate(s); cells are not promoted without review."
                    ),
                    "blocking",
                    {"kind": "pdf_page", "page": page_number},
                ))
            if page_text_blocks == 0:
                warnings.append(warning(
                    "pdf_page_requires_ocr",
                    f"Page {page_number} has no extractable text and requires reviewed OCR.",
                    "blocking",
                    {"kind": "pdf_page", "page": page_number},
                ))
        return {
            "parser": {"name": "PyMuPDF", "version": str(fitz.VersionBind)},
            "blocks": blocks,
            "warnings": warnings,
        }
    finally:
        document.close()


def preflight() -> dict[str, Any]:
    try:
        import fitz  # type: ignore[import-not-found]
        pdf = {"available": True, "name": "PyMuPDF", "version": str(fitz.VersionBind)}
    except ImportError:
        pdf = {"available": False, "name": "PyMuPDF", "version": None}
    return {
        "python": sys.version.split()[0],
        "html": {"available": True, "name": "python.html.parser", "version": f"{sys.version_info.major}.{sys.version_info.minor}"},
        "pdf": pdf,
    }


def main() -> int:
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--kind", choices=["html", "pdf"])
    argument_parser.add_argument("--input", type=Path)
    argument_parser.add_argument("--preflight", action="store_true")
    args = argument_parser.parse_args()
    if args.preflight:
        print(json.dumps(preflight(), ensure_ascii=False, separators=(",", ":")))
        return 0
    if args.kind is None or args.input is None:
        argument_parser.error("--kind and --input are required unless --preflight is used")
    if not args.input.is_file():
        raise ValueError("Input path is not a regular file")
    result = parse_html(args.input) if args.kind == "html" else parse_pdf(args.input)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Stable one-line process boundary; no traceback leaks.
        print(json.dumps({"error": type(error).__name__, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
