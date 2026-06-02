#!/usr/bin/env python3
"""
now-audit.py
比對最近 24 小時內有寫入的頁面，
與 gbrain/now「本輪已完成」區塊，
若發現漏記就推進 wiki/review-queue/ 提醒。
"""
import urllib.request, urllib.parse, json, os, hmac, hashlib, time, re, sys
from datetime import datetime, timezone, timedelta

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"
QUEUE_SLUG = "wiki/review-queue/now-audit-" + datetime.now().strftime("%Y%m%d")
SKIP_PREFIXES = ["wiki/review-queue/", "wiki/outbox/", "wiki/inbox/", "mem/", "gbrain/trash"]

def load_secret():
    s = os.environ.get("GBRAIN_TOTP_SECRET", "")
    if s: return s
    f = os.path.expanduser("~/.gbrain/gateway.env")
    if os.path.exists(f):
        m = re.search(r"GBRAIN_TOTP_SECRET=([a-f0-9]+)", open(f).read())
        if m: return m.group(1)
    sys.exit("ERROR: GBRAIN_TOTP_SECRET not found")

def gen_otp(secret):
    day = int(time.time() // 86400)
    return hmac.new(secret.encode(), str(day).encode(), hashlib.sha256).hexdigest()[:10]

def get(path, secret):
    otp = gen_otp(secret)
    sep = "&" if "?" in path else "?"
    url = GBRAIN_BASE + "/" + path.lstrip("/") + sep + "otp=" + otp
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read())

def put_page(slug, content, secret):
    import subprocess
    result = subprocess.run(
        ["/Users/ryan/.bun/bin/gbrain", "put", slug],
        input=content.encode(), capture_output=True, timeout=15
    )
    if result.returncode != 0:
        raise Exception(result.stderr.decode())

def main():
    secret = load_secret()
    print(f"[now-audit] {datetime.now().strftime('%Y-%m-%d %H:%M')} 開始對帳")

    # 取 gbrain/now 的已完成區塊
    try:
        d = get("page?slug=gbrain%2Fnow", secret)
        now_body = d.get("page", {}).get("compiled_truth", "")
    except Exception as e:
        print(f"[now-audit] 無法讀 gbrain/now: {e}"); return

    # 取最近 24 小時更新的頁面
    try:
        d = get("pages?days=1&limit=100", secret)
        recent = d.get("pages", [])
    except:
        # fallback: /pages/recent
        try:
            d = get("pages/recent?days=1", secret)
            recent = d.get("pages", [])
        except Exception as e:
            print(f"[now-audit] 無法取近期頁面: {e}"); return

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    missed = []
    for p in recent:
        slug = p.get("slug", "")
        updated = p.get("updated_at", "")
        # 跳過系統頁
        if any(slug.startswith(pfx) for pfx in SKIP_PREFIXES):
            continue
        if slug in ("gbrain/now", "gbrain/0", "gbrain/search-protocol"):
            continue
        # 檢查是否在 now 裡被提及
        if slug not in now_body and p.get("title", "") not in now_body:
            missed.append({"slug": slug, "title": p.get("title", ""), "updated_at": updated})

    if not missed:
        print("[now-audit] 一切對帳正常，無漏記頁面")
        return

    # 檢查今日 queue 是否已存在
    try:
        existing = get(f"page?slug={urllib.parse.quote(QUEUE_SLUG)}", secret)
        if existing.get("page"):
            print(f"[now-audit] 今日審核項目已存在：{QUEUE_SLUG}"); return
    except: pass

    # 推送審核項目
    lines = "\n".join(f"- [{m['title'] or m['slug']}]({m['slug']}) — {m['updated_at'][:10]}" for m in missed[:20])
    content = f"""---
title: "Now 對帳 {datetime.now().strftime('%Y-%m-%d')}"
type: task
status: pending
review_type: audit
reason: "以下頁面在過去 24 小時內有寫入，但未出現在 gbrain/now 已完成區塊"
---

## 漏記頁面

{lines}

## 動作

請確認這些頁面是否需要補記到 [[gbrain/now]] 的「本輪已完成」區塊。
"""
    put_page(QUEUE_SLUG, content, secret)
    print(f"[now-audit] 發現 {len(missed)} 頁漏記，已推送 {QUEUE_SLUG}")

if __name__ == "__main__":
    main()
