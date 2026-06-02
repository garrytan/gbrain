#!/usr/bin/env python3
"""
signal-triage.py — 三層分流版
Layer 1 高信心：直接 gbrain tag，不進 queue
Layer 2 中信心：進 wiki/review-queue/，帶 suggested 預設值
Layer 3 低信心：不處理（留給人工）
"""
import urllib.request, urllib.parse, json, os, hmac, hashlib, time, re, sys, subprocess
from datetime import datetime

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"
QUEUE_PREFIX = "wiki/review-queue/signal-"
GBRAIN_BIN = "/Users/ryan/.bun/bin/gbrain"
BATCH_L1 = 30   # Layer 1 每次最多自動標幾筆
BATCH_L2 = 30   # Layer 2 每次最多推幾筆進 queue

SKIP_PREFIXES = [
    "wiki/review-queue/", "wiki/inbox/", "wiki/outbox/",
    "gbrain/trash", "mem/probe-", "mem/write-test"
]

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

def api_get(path, secret):
    otp = gen_otp(secret)
    sep = "&" if "?" in path else "?"
    url = GBRAIN_BASE + "/" + path.lstrip("/") + sep + "otp=" + otp
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read())

def gbrain_tag(slug, signal):
    """Layer 1: 直接 gbrain tag，不過 queue"""
    result = subprocess.run(
        [GBRAIN_BIN, "tag", slug, f"signal:{signal}"],
        capture_output=True, timeout=10
    )
    return result.returncode == 0

def put_page(slug, content):
    """Layer 2: 寫進 review-queue"""
    result = subprocess.run(
        [GBRAIN_BIN, "put", slug],
        input=content.encode(), capture_output=True, timeout=15
    )
    if result.returncode != 0:
        raise Exception(result.stderr.decode())

def infer(slug, tags):
    """
    回傳 (suggested_signal, confidence)
    confidence: 'l1'=高信心直接打標, 'l2'=中信心進queue, None=跳過
    """
    if any(t.startswith("signal:") for t in (tags or [])):
        return None, None   # 已標，跳過
    if any(slug.startswith(p) for p in SKIP_PREFIXES):
        return None, None   # 系統頁，跳過

    s = slug.lower()

    # Layer 1 高信心規則（路徑語義清晰，幾乎不會錯）
    if any(s.startswith(p) for p in ["mem/"]):
        return 1, "l1"      # 暫存/會議紀錄
    if re.match(r"^notes/[0-9]", s):
        return 1, "l1"      # notes/5.3xxx / notes/4.12xxx 等日期型
    if any(s.startswith(p) for p in ["gbrain/0", "gbrain/now", "wiki/concepts/條件"]):
        return 10, "l1"

    # Layer 2 中信心規則（路徑有意義，但值得人過目）
    if any(s.startswith(p) for p in ["gbrain/", "wiki/identity/", "wiki/agent-manual"]):
        return 7, "l2"
    if any(s.startswith(p) for p in ["people/", "wiki/decisions/", "wiki/concepts/", "wiki/projects/"]):
        return 5, "l2"
    if s.startswith("notes/"):
        return 3, "l2"
    if any(s.startswith(p) for p in ["工作/"]):
        return 3, "l2"

    return 3, "l2"   # default: 中信心

def slug_to_id(slug):
    return re.sub(r"[^a-zA-Z0-9\-]", "-", slug)[:60]

def main():
    secret = load_secret()
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"[signal-triage] {now} 開始（三層分流版）")

    # 取得已在 queue 的項目（避免重複推）
    existing_queue = set()
    try:
        d = api_get(f"pages?type=task&limit=200", secret)
        for p in d.get("pages", []):
            if p["slug"].startswith(QUEUE_PREFIX):
                existing_queue.add(p["slug"])
    except Exception as e:
        print(f"  [warn] 無法取 queue 清單：{e}")

    l1_done, l2_done = 0, 0

    for page_type in ["concept", "note", "person", "decision"]:
        if l1_done >= BATCH_L1 and l2_done >= BATCH_L2:
            break
        try:
            d = api_get(f"pages?type={page_type}&limit=100", secret)
        except Exception as e:
            print(f"  [skip] {page_type}: {e}"); continue

        for p in d.get("pages", []):
            slug = p["slug"]
            tags = p.get("tags", [])
            suggested, conf = infer(slug, tags)

            if conf is None:
                continue

            if conf == "l1" and l1_done < BATCH_L1:
                # 直接打標
                ok = gbrain_tag(slug, suggested)
                if ok:
                    l1_done += 1
                    print(f"  [L1] signal:{suggested} → {slug}")
                else:
                    print(f"  [L1-err] {slug}")

            elif conf == "l2" and l2_done < BATCH_L2:
                queue_slug = QUEUE_PREFIX + slug_to_id(slug)
                if queue_slug in existing_queue:
                    continue
                fm = f"""---
title: "Signal: {slug}"
type: task
status: pending
review_type: signal
target: "{slug}"
suggested: {suggested}
reason: "路徑規則推斷 signal:{suggested}（{page_type}）"
---
"""
                try:
                    put_page(queue_slug, fm)
                    existing_queue.add(queue_slug)
                    l2_done += 1
                    print(f"  [L2] queued signal:{suggested} for {slug}")
                except Exception as e:
                    print(f"  [L2-err] {slug}: {e}")

    print(f"[signal-triage] 完成 — L1 自動標 {l1_done} 筆，L2 推 queue {l2_done} 筆")

if __name__ == "__main__":
    main()
