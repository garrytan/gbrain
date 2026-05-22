#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "paddlepaddle>=3.0.0",
#   "paddleocr>=2.9.0",
#   "openai>=1.50.0",
#   "Pillow>=10.0.0",
#   "pdf2image>=1.17.0",
#   "tqdm>=4.66.0",
# ]
# ///
"""
Batch OCR + LLM post-processing pipeline (OpenRouter multi-model routing).

Usage:
  uv run scripts/ocr-batch.py <input> [options]

Models (auto-routed unless --model is set):
  fast        deepseek/deepseek-chat-v3-0324   — normal passages (default)
  reason      deepseek/deepseek-r1             — high error density / wenyan
  reason-alt  qwen/qwen3-235b-a22b:thinking   — Qwen3 reasoning alternative

Examples:
  uv run scripts/ocr-batch.py scan.jpg
  uv run scripts/ocr-batch.py scans/ --out-dir wiki/scans --gbrain-sync
  uv run scripts/ocr-batch.py doc.pdf --lang cht --model reason
  uv run scripts/ocr-batch.py scans/ --skip-llm --dry-run
  uv run scripts/ocr-batch.py scans/ --json > report.json

Environment:
  OPENROUTER_API_KEY  required for LLM correction
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterator

from tqdm import tqdm

# ---------------------------------------------------------------------------
# Model routing config
# ---------------------------------------------------------------------------

MODELS: dict[str, str] = {
    "fast":       "deepseek/deepseek-chat-v3-0324",
    "reason":     "deepseek/deepseek-r1",
    "reason-alt": "qwen/qwen3-235b-a22b:thinking",
}

# Thresholds for auto-routing to reasoning model
ERROR_DENSITY_THRESHOLD = 0.03   # >3% suspicious chars → reasoning model
WENYAN_SCORE_THRESHOLD  = 0.12   # >12% classical markers → reasoning model

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

_SYSTEM_BASE = """你是 OCR 文字校對員（批次自動模式）。你會收到 OCR 引擎輸出的原始中文文字。

## 修正規則

**形近字（高信心才改）**
- 日 ↔ 曰、未 ↔ 末、己 ↔ 已 ↔ 巳、土 ↔ 士
- 千 ↔ 干、王 ↔ 玉、刀 ↔ 力、衤 ↔ 礻（偏旁）
- 數字：0/O、1/l/I、5/S、6/G、8/B（依上下文）

**繁簡誤判（依上下文判斷）**
干→乾/幹、面→麵/面、后→後/后、松→鬆/松、斗→鬥/斗

**標點符號**
- 修正全形半形混用
- 中文引號統一為「」，內層用『』
- 頓號、逗號、句號不要互換（除非明顯誤辨）

**版面雜訊（移除）**
- 孤立的頁碼（行首/行尾僅有數字）
- 頁首頁尾殘留字串
- 掃描污點造成的亂碼符號（□、■、｜、· 單獨成行）

**段落結構**
- 合併 OCR 錯誤切斷的同一段落
- 移除中文字之間的多餘空格
- 保留原有章節標題層次

## 保守原則
- 信心不足時保留原字，不猜測
- 不潤飾文句、不改寫風格、不增刪實質內容
- 不標記疑問字，批次模式直接保留不確定項

## 輸出格式
只輸出校正後的乾淨文字（Markdown，段落以空行分隔）。不要輸出說明、修改清單或前言。"""

# Reasoning models get extra guidance for ambiguous classical Chinese
_SYSTEM_REASON_EXTRA = """

## 古籍/文言文額外規則
- 虛詞「之乎者也矣焉哉」務必依文意還原
- 直排轉橫排時，「一」可能是「丨」、相鄰字可能黏連或被切分，逐字核對
- 罕用字與異體字（迴/廻、群/羣、峰/峯）保留原書用法
- 標點空缺時，依語氣補上句讀（。，；：），但不增加原文沒有的語氣助詞"""

SYSTEM_PROMPTS: dict[str, str] = {
    "fast":       _SYSTEM_BASE,
    "reason":     _SYSTEM_BASE + _SYSTEM_REASON_EXTRA,
    "reason-alt": _SYSTEM_BASE + _SYSTEM_REASON_EXTRA,
}

# ---------------------------------------------------------------------------
# OCR error density & content analysis
# ---------------------------------------------------------------------------

# Classical Chinese function words / endings
_WENYAN_CHARS = set("之乎者也矣焉哉與乃夫其所為於以而則若雖雖雖")

# Patterns that suggest OCR noise
_NOISE_RE = re.compile(r"[□■▪▫◆◇○●\x00-\x08\x0b\x0e-\x1f�]")
_STUB_LINE_RE = re.compile(r"^\S{1,2}$")  # suspiciously short line


def analyse_text(text: str) -> dict:
    """Return density metrics used for model routing."""
    chars = [c for c in text if c.strip()]
    if not chars:
        return {"error_density": 0.0, "wenyan_score": 0.0, "char_count": 0}

    total = len(chars)

    # Noise character ratio
    noise_hits = len(_NOISE_RE.findall(text))

    # Short stub-line ratio (fragmented OCR output)
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    stub_lines = sum(1 for l in lines if _STUB_LINE_RE.match(l))
    stub_ratio = stub_lines / max(len(lines), 1)

    error_density = (noise_hits / total) + (stub_ratio * 0.5)

    # Classical Chinese score
    wenyan_count = sum(1 for c in chars if c in _WENYAN_CHARS)
    wenyan_score = wenyan_count / total

    return {
        "error_density": round(error_density, 4),
        "wenyan_score":  round(wenyan_score, 4),
        "char_count":    total,
    }


def pick_model(analysis: dict, override: str | None) -> str:
    """Select model tier based on content analysis or explicit override."""
    if override and override != "auto":
        return override
    needs_reason = (
        analysis["error_density"] > ERROR_DENSITY_THRESHOLD
        or analysis["wenyan_score"]  > WENYAN_SCORE_THRESHOLD
    )
    return "reason" if needs_reason else "fast"

# ---------------------------------------------------------------------------
# OCR engine
# ---------------------------------------------------------------------------

SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp"}
SUPPORTED_EXTS = SUPPORTED_IMAGE_EXTS | {".pdf"}

_LANG_MAP = {"ch": "ch", "cht": "chinese_cht", "en": "en"}


def _init_ocr(lang: str):
    from paddleocr import PaddleOCR  # type: ignore
    return PaddleOCR(
        lang=_LANG_MAP.get(lang, lang),
        # Disable heavy preprocessing — not needed for scanned book pages
        # (already oriented, already flat): drops 3 of 5 model stages
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


def ocr_image_path(img_path: Path, ocr) -> str:
    results = ocr.predict(str(img_path))
    if not results:
        return ""
    lines = []
    for res in results:
        texts  = res.get("rec_texts", [])
        scores = res.get("rec_scores", [])
        for text, score in zip(texts, scores):
            if score >= 0.5 and text.strip():
                lines.append(text)
    return "\n".join(lines)


def _pdf_page_count(pdf_path: Path) -> int:
    from pdf2image.pdf2image import pdfinfo_from_path  # type: ignore
    return int(pdfinfo_from_path(str(pdf_path))["Pages"])


def ocr_pdf_path(pdf_path: Path, ocr, dpi: int = 200) -> str:
    """Process PDF one page at a time to keep memory flat."""
    from pdf2image import convert_from_path  # type: ignore

    total = _pdf_page_count(pdf_path)
    pages: list[str] = []

    bar = tqdm(
        range(1, total + 1),
        desc=f"  {pdf_path.name[:30]}",
        unit="頁",
        ncols=72,
        leave=False,
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        for i in bar:
            # Load exactly one page → peak memory = 1 page (~11 MB at 200 DPI)
            images = convert_from_path(
                str(pdf_path), dpi=dpi,
                first_page=i, last_page=i,
                output_folder=tmpdir,
            )
            if not images:
                continue
            img = images[0]
            img_path = Path(tmpdir) / f"page_{i:04d}.png"
            img.save(str(img_path), "PNG")
            img.close()          # release PIL buffer immediately
            del images           # release list ref

            text = ocr_image_path(img_path, ocr)
            img_path.unlink(missing_ok=True)   # free disk too
            if text.strip():
                pages.append(f"<!-- page {i} -->\n{text}")

    return "\n\n".join(pages)


def run_ocr(file_path: Path, ocr, dpi: int = 200) -> str:
    ext = file_path.suffix.lower()
    if ext == ".pdf":
        return ocr_pdf_path(file_path, ocr, dpi)
    if ext in SUPPORTED_IMAGE_EXTS:
        return ocr_image_path(file_path, ocr)
    raise ValueError(f"Unsupported file type: {ext}")

# ---------------------------------------------------------------------------
# LLM correction (OpenRouter)
# ---------------------------------------------------------------------------

def llm_correct(raw_text: str, client, model_key: str, max_tokens: int = 4096) -> str:
    model_id = MODELS[model_key]
    system  = SYSTEM_PROMPTS[model_key]

    # DeepSeek R1 / Qwen3 thinking: system prompt goes into user turn
    # (some reasoning models on OpenRouter ignore the system field)
    if model_key in ("reason", "reason-alt"):
        messages = [{"role": "user", "content": f"{system}\n\n以下是 OCR 原始輸出：\n\n{raw_text}"}]
        sys_param: str | None = None
    else:
        messages = [{"role": "user", "content": f"以下是 OCR 原始輸出：\n\n{raw_text}"}]
        sys_param = system

    kwargs: dict = dict(model=model_id, max_tokens=max_tokens, messages=messages)
    if sys_param:
        # OpenAI SDK passes system as first message with role="system"
        kwargs["messages"] = [{"role": "system", "content": sys_param}] + messages

    resp = client.chat.completions.create(**kwargs)
    return resp.choices[0].message.content or ""

# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def _output_path(file_path: Path, out_dir: Path) -> Path:
    return out_dir / (file_path.stem + ".md")


def process_file(
    file_path: Path,
    ocr,
    llm_client,
    out_dir: Path,
    *,
    model_override: str | None = None,
    skip_llm: bool = False,
    dry_run: bool = False,
    dpi: int = 200,
) -> dict:
    out_path = _output_path(file_path, out_dir)
    result: dict = {
        "input":       str(file_path),
        "output":      str(out_path),
        "status":      "ok",
        "ocr_chars":   0,
        "model_used":  None,
        "llm_applied": False,
        "error_density": 0.0,
        "wenyan_score":  0.0,
    }

    raw = run_ocr(file_path, ocr, dpi=dpi)
    result["ocr_chars"] = len(raw)

    if not raw.strip():
        result["status"] = "empty"
        tqdm.write(f"  ⚠  {file_path.name}: OCR 無結果")
        return result

    analysis = analyse_text(raw)
    result["error_density"] = analysis["error_density"]
    result["wenyan_score"]  = analysis["wenyan_score"]

    final_text = raw
    if not skip_llm and llm_client is not None:
        model_key = pick_model(analysis, model_override)
        result["model_used"] = MODELS[model_key]
        tier_tag = {"fast": "V3", "reason": "R1", "reason-alt": "Qwen3"}[model_key]
        tqdm.write(
            f"  LLM[{tier_tag}]  err={analysis['error_density']:.1%}"
            f"  wenyan={analysis['wenyan_score']:.1%}"
            f"  → {file_path.name}"
        )
        final_text = llm_correct(raw, llm_client, model_key)
        result["llm_applied"] = True

    frontmatter = (
        f"---\n"
        f"title: {file_path.stem}\n"
        f"source: {file_path.name}\n"
        f"type: scan\n"
        f"tags: [ocr]\n"
        f"---\n\n"
    )
    content = frontmatter + final_text + "\n"

    if dry_run:
        print(f"  dry  would write → {out_path}", file=sys.stderr)
    else:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")
        print(f"  ok   {out_path}", file=sys.stderr)

    return result


def iter_input_files(input_path: Path) -> Iterator[Path]:
    if input_path.is_file():
        if input_path.suffix.lower() in SUPPORTED_EXTS:
            yield input_path
    elif input_path.is_dir():
        for p in sorted(input_path.iterdir()):
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
                yield p
    else:
        print(f"error: {input_path} not found", file=sys.stderr)
        sys.exit(1)

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Batch OCR + LLM correction (OpenRouter multi-model routing)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("input", help="Image, PDF, or directory")
    p.add_argument("--out-dir", default=".", help="Output directory (default: .)")
    p.add_argument(
        "--lang", default="cht", choices=["cht", "ch", "en"],
        help="OCR language: cht=繁體 ch=簡體 en=English (default: cht)",
    )
    p.add_argument("--dpi", type=int, default=150,
                   help="DPI for PDF conversion (default: 150; use 200 for small print)")
    p.add_argument(
        "--model", default="auto",
        choices=["auto", "fast", "reason", "reason-alt"],
        help=(
            "LLM model tier: auto=route by content analysis (default), "
            "fast=DeepSeek V3, reason=DeepSeek R1, reason-alt=Qwen3"
        ),
    )
    p.add_argument("--skip-llm", action="store_true", help="Skip LLM (OCR only)")
    p.add_argument("--gbrain-sync", action="store_true", help="Run gbrain sync after processing")
    p.add_argument("--dry-run", action="store_true", help="Don't write files")
    p.add_argument("--json", action="store_true", dest="json_out", help="Output JSON report to stdout")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    out_dir    = Path(args.out_dir).expanduser().resolve()

    files = list(iter_input_files(input_path))
    if not files:
        print(f"error: no supported files found in {input_path}", file=sys.stderr)
        sys.exit(1)

    # Peak memory per page: width × height × 3 bytes (RGB)
    w = int(args.dpi * 8.27)   # A4 width in inches
    h = int(args.dpi * 11.69)  # A4 height in inches
    page_mb = round(w * h * 3 / 1024 / 1024, 1)
    print(
        f"Found {len(files)} file(s) | DPI={args.dpi} | "
        f"peak ~{page_mb} MB/頁（逐頁串流）",
        file=sys.stderr,
    )
    print(f"Initialising PaddleOCR (lang={args.lang})…", file=sys.stderr)
    ocr = _init_ocr(args.lang)

    llm_client = None
    if not args.skip_llm:
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            print("warn: OPENROUTER_API_KEY not set — skipping LLM correction", file=sys.stderr)
        else:
            from openai import OpenAI  # type: ignore
            llm_client = OpenAI(api_key=api_key, base_url=OPENROUTER_BASE_URL)

    results: list[dict] = []
    errors:  list[str]  = []

    outer = tqdm(files, desc="總進度", unit="檔", ncols=72)
    for f in outer:
        outer.set_postfix_str(f.name[:28], refresh=True)
        try:
            r = process_file(
                f, ocr, llm_client, out_dir,
                model_override=args.model if args.model != "auto" else None,
                skip_llm=args.skip_llm or llm_client is None,
                dry_run=args.dry_run,
                dpi=args.dpi,
            )
            results.append(r)
            if r["status"] == "ok":
                tqdm.write(f"  ✓  {f.name}  ({r['ocr_chars']:,} chars)")
        except Exception as e:
            errors.append(f"{f.name}: {e}")
            tqdm.write(f"  ✗  {f.name}: {e}")

    if args.gbrain_sync and not args.dry_run:
        print("\nRunning gbrain sync…", file=sys.stderr)
        subprocess.run(["gbrain", "sync"], check=False)

    # Summary
    ok    = sum(1 for r in results if r["status"] == "ok")
    fast  = sum(1 for r in results if r.get("model_used") == MODELS["fast"])
    rsn   = sum(1 for r in results if r.get("model_used") in (MODELS["reason"], MODELS["reason-alt"]))
    print(f"\nDone: {ok}/{len(files)} ok — fast={fast} reason={rsn} errors={len(errors)}", file=sys.stderr)

    if args.json_out:
        print(json.dumps({"results": results, "errors": errors}, ensure_ascii=False, indent=2))

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
