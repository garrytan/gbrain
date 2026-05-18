#!/usr/bin/env python3
"""Push all agent-manual pages to GBrain.

Pages pushed:
  wiki/agent-manual          ← index (輕量，啟動時讀這頁)
  wiki/agent-manual/rules    ← 寫入規則 + 禁止行為
  wiki/agent-manual/links    ← Link type + Namespace 判斷
  wiki/agent-manual/tools    ← 完整工具列表
  wiki/agent-manual/workflow ← 工作流程

Usage:
    python scripts/push_manual.py

Env vars:
    GBRAIN_OTP          — one-time password (優先)
    GBRAIN_TOTP_SECRET  — TOTP secret (fallback)
"""
from __future__ import annotations
import os, sys, hmac, hashlib, time
from pathlib import Path
import requests

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"
DOCS = Path(__file__).parent.parent / "docs"

PAGES = [
    ("wiki/agent-manual",          "agent-manual-index.md",    "Agent Manual — Index"),
    ("wiki/agent-manual/rules",    "agent-manual-rules.md",    "Agent Manual — 寫入規則"),
    ("wiki/agent-manual/links",    "agent-manual-links.md",    "Agent Manual — Link 規則"),
    ("wiki/agent-manual/tools",    "agent-manual-tools.md",    "Agent Manual — 完整工具列表"),
    ("wiki/agent-manual/workflow", "agent-manual-workflow.md", "Agent Manual — 工作流程"),
]


def _otp() -> str:
    if otp := os.environ.get("GBRAIN_OTP"):
        return otp
    secret = os.environ.get("GBRAIN_TOTP_SECRET")
    if not secret:
        sys.exit("ERROR: set GBRAIN_OTP or GBRAIN_TOTP_SECRET")
    day = int(time.time() * 1000 // 86_400_000)
    return hmac.new(secret.encode(), str(day).encode(), hashlib.sha256).digest().hex()[:10]


def _headers() -> dict:
    return {"Authorization": f"OTP {_otp()}"}


def push_page(slug: str, filename: str, title: str) -> str:
    path = DOCS / filename
    if not path.exists():
        return f"SKIP  {slug} (檔案不存在: {filename})"

    body = path.read_text()
    content = f"---\ntitle: {title}\nsource: agent\ntags: [\"fact\"]\n---\n\n{body}"

    r = requests.put(
        f"{GBRAIN_BASE}/page",
        json={"slug": slug, "content": content, "source": "agent", "tags": ["fact"]},
        params={"async": "1"},
        headers=_headers(),
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    status = data.get("status", "?")
    return f"OK    {slug}  [{status}]"


def push_all() -> None:
    print(f"推送 {len(PAGES)} 頁到 GBrain...\n")
    for slug, filename, title in PAGES:
        result = push_page(slug, filename, title)
        print(f"  {result}")
    print("\n完成。索引頁：wiki/agent-manual")
    print("提醒：關鍵字搜尋需等 60-90 秒更新。")


if __name__ == "__main__":
    push_all()
