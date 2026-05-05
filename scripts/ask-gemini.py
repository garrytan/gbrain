#!/usr/bin/env python3
"""
GBrain → Gemini 橋接腳本
查詢 gbrain 知識庫，將結果注入 Chrome 的 Gemini 分頁。

前置條件：Chrome 已開啟 gemini.google.com/u/1/app（或任意帳號的 /app 頁面）
用法：
  GBRAIN_QUERY="你的問題" browser-harness -c @scripts/ask-gemini.py
  bash scripts/ask-gemini.sh "你的問題"
"""

import hmac as _hmac, hashlib, json, re, time, os, urllib.parse

# ── 1. 設定 ──────────────────────────────────────────────────────────────────

def load_gbrain_env():
    path = os.path.expanduser("~/.gbrain/gateway.env")
    content = open(path).read()
    secret_hex = re.search(r'GBRAIN_TOTP_SECRET=([a-f0-9]+)', content).group(1)
    remote_url = re.search(r'GBRAIN_REMOTE_URL=(\S+)', content).group(1).strip()
    return secret_hex, remote_url

def daily_otp(secret_hex):
    day = int(time.time() / 86400)
    return _hmac.new(
        secret_hex.encode("ascii"),
        str(day).encode(),
        hashlib.sha256
    ).hexdigest()[:10]

# ── 2. 查詢 gbrain ────────────────────────────────────────────────────────────

def query_gbrain(remote_url, otp, question, limit=6):
    import urllib.request as _urlreq
    lex = urllib.parse.quote_plus(question)
    url = remote_url + "/search?otp=" + otp + "&lex=" + lex + "&limit=" + str(limit)
    with _urlreq.urlopen(url, timeout=15) as r:
        data = json.loads(r.read())
    return data.get("results", [])

def format_context(results, question):
    if not results:
        return question
    lines = ["【知識庫相關內容】"]
    for r in results:
        title = r.get("title") or r.get("slug", "")
        lines.append("\n▸ " + title + " (" + r.get("slug", "") + ")")
        excerpt = (r.get("excerpt") or r.get("chunk_text") or "")[:400]
        if excerpt:
            lines.append(excerpt)
    lines.append("\n---\n" + question)
    return "\n".join(lines)

# ── 3. 找 Gemini 分頁 ─────────────────────────────────────────────────────────

def find_or_open_gemini():
    """找現有的 Gemini /app 分頁，或開一個新的。"""
    tabs = list_tabs()
    # 優先找已登入的 /u/N/app 分頁
    for t in tabs:
        if "gemini.google.com" in t["url"] and "/app" in t["url"]:
            return t
    # fallback：找任何 gemini.google.com 分頁
    for t in tabs:
        if "gemini.google.com" in t["url"] and "accounts.google.com" not in t["url"]:
            return t
    # 沒有就開新分頁（需要用戶已在 Chrome 登入 Google）
    print("找不到 Gemini 分頁，開新分頁...")
    new_tab("https://gemini.google.com/app")
    wait_for_load()
    wait(4)
    tabs = list_tabs()
    for t in tabs:
        if "gemini.google.com" in t["url"]:
            return t
    return None

def find_input_coords():
    """找 Gemini 輸入框的視覺座標（中心點）。"""
    result = js("""
        const els = document.querySelectorAll("[contenteditable]");
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 300 && r.height > 5 && r.height < 200) {
                el.focus();
                return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
            }
        }
        return null;
    """)
    if result:
        return json.loads(result)
    return None

# ── 4. 主流程 ─────────────────────────────────────────────────────────────────

question = os.environ.get("GBRAIN_QUERY", "").strip()
if not question:
    print("ERROR: GBRAIN_QUERY 未設定")
    print("用法: GBRAIN_QUERY='你的問題' browser-harness -c @scripts/ask-gemini.py")
    raise SystemExit(1)

print("問題：" + question)

secret_hex, remote_url = load_gbrain_env()
otp = daily_otp(secret_hex)
print("OTP：" + otp)

print("查詢 gbrain 知識庫...")
try:
    results = query_gbrain(remote_url, otp, question)
    print("找到 " + str(len(results)) + " 筆結果")
except Exception as e:
    print("gbrain 查詢失敗：" + str(e) + "，直接送原始問題")
    results = []

message = format_context(results, question)
print("\n--- 訊息預覽（前 200 字）---\n" + message[:200] + "\n---\n")

# ── 5. 找並切換到 Gemini 分頁 ──────────────────────────────────────────────────

gemini_tab = find_or_open_gemini()
if not gemini_tab:
    print("⚠️  找不到可用的 Gemini 分頁，請先在 Chrome 開啟 gemini.google.com")
    raise SystemExit(1)

print("使用分頁：" + gemini_tab["url"])
switch_tab(gemini_tab)
wait(1.5)

current_url = js("return location.href")
print("目前 URL：" + current_url)

if "accounts.google.com" in current_url:
    print("⚠️  需要登入，請先在 Chrome 登入 Google 帳號")
    capture_screenshot()
    raise SystemExit(1)

capture_screenshot()

# ── 6. 找輸入框並輸入 ──────────────────────────────────────────────────────────

pos = find_input_coords()
if not pos:
    print("⚠️  找不到輸入框，截圖診斷...")
    capture_screenshot()
    raise SystemExit(1)

print("輸入框座標：(" + str(pos["x"]) + ", " + str(pos["y"]) + ")")

# 清空現有內容並輸入
click_at_xy(pos["x"], pos["y"])
wait(0.3)
js("document.querySelector(\"[contenteditable]\").focus()")
wait(0.2)
# 全選後刪除（清空殘留文字）
js("document.execCommand('selectAll', false, null)")
wait(0.2)

type_text(message)
wait(0.5)

# 點擊送出按鈕（aria-label="傳送訊息"）
send_clicked = js("""
    const btn = document.querySelector('button[aria-label*="傳送"], button[aria-label*="Send"]');
    if (btn) { btn.click(); return true; }
    return false;
""")
if not send_clicked:
    # fallback: Return 鍵
    press_key("Return")

wait(6)

capture_screenshot()
print("✓ 已送出，等待 Gemini 回應")
