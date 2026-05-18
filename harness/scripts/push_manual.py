#!/usr/bin/env python3
"""Push all agent-manual and living-document pages to GBrain.

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

GBRAIN_BASE = "https://brain.3141919ryanfeofjpewfp.uk"
DOCS = Path(__file__).parent.parent / "docs"

PAGES = [
    # Agent Manual（說明書）
    ("wiki/agent-manual",          "agent-manual-index.md",    "Agent Manual — Index"),
    ("wiki/agent-manual/rules",    "agent-manual-rules.md",    "Agent Manual — 寫入規則"),
    ("wiki/agent-manual/links",    "agent-manual-links.md",    "Agent Manual — Link 規則"),
    ("wiki/agent-manual/tools",    "agent-manual-tools.md",    "Agent Manual — 完整工具列表"),
    ("wiki/agent-manual/workflow", "agent-manual-workflow.md", "Agent Manual — 工作流程"),
    # Status（狀態層，活文件）
    ("wiki/status/priorities",     "status-priorities.md",     "當前優先任務"),
    ("wiki/status/health",         "status-health.md",         "腦庫健康快照"),
    ("wiki/status/session-log",    "status-session-log.md",    "AI 工作記錄"),
    ("wiki/status/orphans",        "status-orphans.md",        "孤立頁面清單"),
    # Conventions（慣例層）
    ("wiki/conventions/namespace-rules",    "conventions-namespace.md",          "Namespace 判斷規則"),
    ("wiki/conventions/frontmatter",        "conventions-frontmatter.md",        "Frontmatter 格式規範"),
    ("wiki/conventions/sync-architecture",  "conventions-sync-architecture.md",  "同步架構說明"),
    # Workflow（協作協議）
    ("wiki/workflow/protocol",     "workflow-protocol.md",     "Genspark ↔ 本地 AI 協作協議"),
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
    ok = skip = 0
    for slug, filename, title in PAGES:
        result = push_page(slug, filename, title)
        print(f"  {result}")
        if result.startswith("OK"):
            ok += 1
        else:
            skip += 1
    print(f"\n完成：{ok} 頁成功，{skip} 頁跳過")
    print("索引頁：wiki/agent-manual")
    print("提醒：關鍵字搜尋需等 60-90 秒更新。")


if __name__ == "__main__":
    push_all()
