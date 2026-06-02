#!/usr/bin/env python3
"""
signal-triage.py
掃描腦庫中沒有 signal:N tag 的頁面，
依路徑規則推斷建議分數，寫入 wiki/review-queue/ 等待人工審核。
"""
import urllib.request, urllib.parse, json, os, hmac, hashlib, time, re, sys
from datetime import datetime

GBRAIN_BASE = "https://gbrain-production-18fa.up.railway.app"
QUEUE_PREFIX = "wiki/review-queue/signal-"
BATCH = 50  # 每次最多推幾筆進 queue

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

def infer_signal(slug, tags):
    # 已有 signal tag 就跳過
    if any(t.startswith("signal:") for t in (tags or [])):
        return None
    # 路徑規則
    s = slug.lower()
    if any(s.startswith(p) for p in ["gbrain/0", "gbrain/now", "wiki/concepts/條件"]):
        return 10
    if any(s.startswith(p) for p in ["gbrain/", "wiki/identity/", "wiki/agent-manual"]):
        return 7
    if any(s.startswith(p) for p in ["people/", "wiki/decisions/", "wiki/concepts/", "wiki/projects/"]):
        return 5
    if s.startswith("notes/"):
        return 3
    if any(s.startswith(p) for p in ["mem/", "工作/"]):
        return 1
    return 3  # default

def slug_to_id(slug):
    return re.sub(r"[^a-zA-Z0-9\-]", "-", slug)[:60]

def main():
    secret = load_secret()
    print(f"[signal-triage] {datetime.now().strftime('%Y-%m-%d %H:%M')} 開始掃描")

    # 取得已在 queue 的項目（避免重複推送）
    existing_queue = set()
    try:
        d = get(f"pages?prefix={urllib.parse.quote(QUEUE_PREFIX)}", secret)
        for p in d.get("pages", []):
            # 從 queue slug 反推 target slug
            existing_queue.add(p["slug"])
    except: pass

    # 取最近更新的頁面
    pushed = 0
    for page_type in ["concept", "note", "person", "decision"]:
        if pushed >= BATCH: break
        try:
            d = get(f"pages?type={page_type}&limit=100", secret)
        except Exception as e:
            print(f"  [skip] {page_type}: {e}"); continue

        for p in d.get("pages", []):
            if pushed >= BATCH: break
            slug = p["slug"]
            tags = p.get("tags", [])
            suggested = infer_signal(slug, tags)
            if suggested is None:
                continue  # 已有 signal tag

            queue_slug = QUEUE_PREFIX + slug_to_id(slug)
            if queue_slug in existing_queue:
                continue

            # 寫入 review-queue
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
                put_page(queue_slug, fm, secret)
                existing_queue.add(queue_slug)
                pushed += 1
                print(f"  → queued signal:{suggested} for {slug}")
            except Exception as e:
                print(f"  [err] {slug}: {e}")

    print(f"[signal-triage] 完成，推送 {pushed} 筆")

if __name__ == "__main__":
    main()
