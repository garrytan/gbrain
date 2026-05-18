#!/usr/bin/env python3
"""Push docs/agent-manual.md to GBrain at wiki/agent-manual.

Usage:
    python scripts/push_manual.py

Env vars required (same as harness):
    GBRAIN_OTP          — one-time password (if not using TOTP)
    GBRAIN_TOTP_SECRET  — TOTP secret (used if GBRAIN_OTP is not set)
"""
from __future__ import annotations
import os, sys, hmac, hashlib, time
from pathlib import Path
import requests

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"
SLUG = "wiki/agent-manual"
MANUAL_PATH = Path(__file__).parent.parent / "docs" / "agent-manual.md"


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


def push() -> None:
    if not MANUAL_PATH.exists():
        sys.exit(f"ERROR: manual not found at {MANUAL_PATH}")

    body = MANUAL_PATH.read_text()
    title = "Agent Operating Manual"
    content = f"---\ntitle: {title}\nsource: agent\ntags: [\"fact\"]\n---\n\n{body}"

    print(f"Pushing {MANUAL_PATH.name} → {SLUG} ...")
    r = requests.put(
        f"{GBRAIN_BASE}/page",
        json={"slug": SLUG, "content": content, "source": "agent", "tags": ["fact"]},
        params={"async": "1"},
        headers=_headers(),
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    status = data.get("status", "?")
    h = data.get("content_hash") or data.get("hash") or "?"
    print(f"OK  status={status}  hash={h}")
    print(f"\nThe agent will read '{SLUG}' at startup.")
    print("Allow 60-90 seconds for keyword search index to update.")


if __name__ == "__main__":
    push()
