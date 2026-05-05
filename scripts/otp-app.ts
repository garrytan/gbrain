#!/usr/bin/env bun
/**
 * GBrain OTP Desktop App
 * 啟動一個本地頁面，顯示當前每日 OTP + 複製按鈕 + Gemini 提示詞產生器
 * Usage: bun scripts/otp-app.ts
 */

import { createHmac } from "crypto";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { exec } from "child_process";

const PORT = 4244;

function loadEnv(): { secret: string; remoteUrl: string } {
  const envFile = `${homedir()}/.gbrain/gateway.env`;
  let secret = process.env.GBRAIN_TOTP_SECRET ?? "";
  let remoteUrl = process.env.GBRAIN_REMOTE_URL ?? "https://gbrain-production-18fa.up.railway.app";

  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    if (!secret) {
      const m = content.match(/GBRAIN_TOTP_SECRET=([a-f0-9]+)/);
      if (m) secret = m[1];
    }
    if (!process.env.GBRAIN_REMOTE_URL) {
      const m = content.match(/GBRAIN_REMOTE_URL=(\S+)/);
      if (m) remoteUrl = m[1];
    }
  }

  if (!secret) {
    console.error("ERROR: GBRAIN_TOTP_SECRET not found in ~/.gbrain/gateway.env");
    process.exit(1);
  }
  return { secret, remoteUrl };
}

// 每日鑰匙（與 src/http/server.ts 保持一致）
function generateOtp(secret: string): string {
  const day = Math.floor(Date.now() / 86_400_000);
  return createHmac("sha256", secret).update(String(day)).digest("hex").slice(0, 10);
}

// 距離下一個 UTC 午夜的秒數
function secondsUntilMidnight(): number {
  return 86400 - (Math.floor(Date.now() / 1000) % 86400);
}

function formatCountdown(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`;
}

const { secret, remoteUrl } = loadEnv();

const HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GBrain 鑰匙</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
    background: #0a0a0f;
    color: #e8e8f0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 16px;
    padding: 24px;
    overflow-x: hidden;
  }

  .card {
    background: linear-gradient(135deg, #13131f 0%, #1a1a2e 100%);
    border: 1px solid #2a2a4a;
    border-radius: 20px;
    padding: 36px 44px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03);
    width: 100%;
    max-width: 380px;
  }

  .label {
    font-size: 11px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: #6060a0;
    margin-bottom: 20px;
    font-weight: 600;
  }

  .otp {
    font-size: 38px;
    font-weight: 700;
    letter-spacing: 6px;
    color: #a0a0ff;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    padding: 12px 20px;
    border-radius: 12px;
    transition: all 0.15s ease;
  }

  .otp:hover { background: rgba(100,100,255,0.08); color: #c0c0ff; }
  .otp:active { background: rgba(100,100,255,0.15); transform: scale(0.97); }
  .otp.copied { color: #60e060; background: rgba(60,200,60,0.08); }

  .copy-hint {
    font-size: 11px;
    color: #3a3a6a;
    margin-top: 6px;
    height: 16px;
    transition: color 0.3s;
  }
  .copy-hint.visible { color: #60c060; }

  .timer-wrap {
    margin-top: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .timer-bar-bg {
    width: 100%;
    height: 3px;
    background: #1e1e3a;
    border-radius: 99px;
    overflow: hidden;
  }

  .timer-bar {
    height: 100%;
    border-radius: 99px;
    background: linear-gradient(90deg, #4040c0, #8080ff);
    transition: width 1s linear;
  }

  .timer-text {
    font-size: 11px;
    color: #4a4a7a;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .timer-text span { color: #8080c0; font-weight: 600; }

  .divider {
    width: 40px; height: 1px;
    background: #2a2a4a;
    margin: 20px auto;
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 11px;
    color: #3a3a5a;
  }

  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #40c060;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Gemini card */
  .gemini-card {
    background: linear-gradient(135deg, #0f1a14 0%, #0f1f1a 100%);
    border: 1px solid #1a3a2a;
    border-radius: 20px;
    padding: 28px 32px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }

  .gemini-label {
    font-size: 11px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: #3a7a5a;
    margin-bottom: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .gemini-label::before {
    content: '';
    display: inline-block;
    width: 16px; height: 16px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%2340c060' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z'/%3E%3C/svg%3E") center/contain no-repeat;
    opacity: 0.6;
  }

  .gemini-desc {
    font-size: 12px;
    color: #4a6a5a;
    line-height: 1.6;
    margin-bottom: 16px;
  }

  .btn {
    display: block;
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
    margin-bottom: 8px;
  }

  .btn-gemini {
    background: linear-gradient(135deg, #1a4a2a, #1a5a35);
    color: #60e0a0;
    border: 1px solid #2a6a3a;
  }
  .btn-gemini:hover { background: linear-gradient(135deg, #1a5a35, #1a6a40); }
  .btn-gemini:active { transform: scale(0.98); }
  .btn-gemini.copied { background: linear-gradient(135deg, #0a3a1a, #0a4a22); color: #40c070; }

  .url-preview {
    font-size: 9px;
    color: #2a5a3a;
    word-break: break-all;
    line-height: 1.5;
    padding: 8px;
    background: rgba(0,0,0,0.3);
    border-radius: 6px;
    margin-top: 4px;
    text-align: left;
    opacity: 0;
    max-height: 0;
    overflow: hidden;
    transition: opacity 0.3s, max-height 0.3s;
  }
  .url-preview.show { opacity: 1; max-height: 120px; }
</style>
</head>
<body>
<div class="card">
  <div class="label">GBrain 每日鑰匙</div>

  <div class="otp" id="otp" onclick="copyOtp()" title="點擊複製">----------</div>
  <div class="copy-hint" id="hint">點擊複製 OTP</div>

  <div class="timer-wrap">
    <div class="timer-bar-bg">
      <div class="timer-bar" id="bar"></div>
    </div>
    <div class="timer-text">UTC 午夜重置，剩餘 <span id="countdown">--</span></div>
  </div>

  <div class="divider"></div>

  <div class="status">
    <div class="dot"></div>
    每日鑰匙 · UTC 00:00 輪換
  </div>
</div>

<div class="gemini-card">
  <div class="gemini-label">Gemini 網頁版 搜尋</div>
  <div class="gemini-desc">
    將今日搜尋指令複製給 Gemini，它可以用 web browsing 直接查詢你的知識庫。每天更新一次。
  </div>
  <button class="btn btn-gemini" id="geminiBtn" onclick="copyGeminiPrompt()">
    複製 Gemini 搜尋指令
  </button>
  <div class="url-preview" id="urlPreview"></div>
</div>

<script>
  let currentOtp = '';
  const REMOTE_URL = ${JSON.stringify(remoteUrl)};

  async function fetchOtp() {
    try {
      const r = await fetch('/api/otp');
      const d = await r.json();
      currentOtp = d.otp;
      document.getElementById('otp').textContent = currentOtp;
      updateUrlPreview();
    } catch(e) {}
  }

  function updateUrlPreview() {
    const el = document.getElementById('urlPreview');
    if (currentOtp && el.classList.contains('show')) {
      el.textContent = REMOTE_URL + '/search?otp=' + currentOtp + '&q={你的查詢}';
    }
  }

  function copyOtp() {
    if (!currentOtp) return;
    navigator.clipboard.writeText(currentOtp).then(() => {
      const el = document.getElementById('otp');
      const hint = document.getElementById('hint');
      el.classList.add('copied');
      hint.classList.add('visible');
      hint.textContent = '已複製！';
      setTimeout(() => {
        el.classList.remove('copied');
        hint.classList.remove('visible');
        hint.textContent = '點擊複製 OTP';
      }, 1800);
    });
  }

  function buildGeminiPrompt(otp) {
    return \`你現在可以使用我的個人知識庫。請用 web browsing 呼叫以下 URL。

【搜尋端點】
簡單搜尋（單一關鍵字）：
\${REMOTE_URL}/search?otp=\${otp}&q={查詢詞}

進階搜尋（qmd 多型，效果更好）：
\${REMOTE_URL}/search?otp=\${otp}&lex={關鍵字}&vec={語意問句}&hyde={假設答案段落}

範例（三種類型混合）：
\${REMOTE_URL}/search?otp=\${otp}&lex=AI+agent+architecture&vec=how+do+I+design+a+multi-agent+system&limit=8

說明：
- lex  = BM25 關鍵字搜尋（精確詞彙）
- vec  = 語意搜尋（自然語言問句）
- hyde = 假設文件（寫出你期望看到的答案，會嵌入後做向量搜尋）
- 三種可任意組合，系統會做 RRF 融合排序
- 建議：lex + vec 組合覆蓋率最高

【讀取頁面】
\${REMOTE_URL}/page?slug={slug}&otp=\${otp}

【返回格式】
results 陣列，每筆有：slug、title、excerpt（chunk 內容）

今日鑰匙（UTC 午夜輪換）：\${otp}\`;
  }

  function copyGeminiPrompt() {
    if (!currentOtp) return;
    const prompt = buildGeminiPrompt(currentOtp);
    const btn = document.getElementById('geminiBtn');
    const preview = document.getElementById('urlPreview');

    navigator.clipboard.writeText(prompt).then(() => {
      btn.textContent = '已複製！貼給 Gemini 即可';
      btn.classList.add('copied');
      preview.textContent = REMOTE_URL + '/search?otp=' + currentOtp + '&q={查詢}';
      preview.classList.add('show');
      setTimeout(() => {
        btn.textContent = '複製 Gemini 搜尋指令';
        btn.classList.remove('copied');
      }, 2500);
    });
  }

  function tick() {
    const now = Math.floor(Date.now() / 1000);
    const secsLeft = 86400 - (now % 86400);
    const pct = (secsLeft / 86400) * 100;
    const h = Math.floor(secsLeft / 3600);
    const m = Math.floor((secsLeft % 3600) / 60);
    const s = secsLeft % 60;

    document.getElementById('bar').style.width = pct + '%';
    document.getElementById('countdown').textContent =
      h + 'h ' + String(m).padStart(2,'0') + 'm ' + String(s).padStart(2,'0') + 's';

    // 午夜剛過時重取 OTP
    if (secsLeft === 86400 || secsLeft === 86399) fetchOtp();
  }

  fetchOtp();
  tick();
  setInterval(tick, 1000);
</script>
</body>
</html>`;

// ── 本地 API ───────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/otp") {
      const otp = generateOtp(secret);
      const secsLeft = secondsUntilMidnight();
      return Response.json({ otp, secsLeft, validUntil: "UTC midnight" });
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`GBrain OTP App 啟動：http://127.0.0.1:${PORT}`);

// 自動開啟瀏覽器（Comet 優先，fallback 系統預設）
exec(
  `open -a "Comet" http://127.0.0.1:${PORT} 2>/dev/null || open http://127.0.0.1:${PORT}`
);

process.on("SIGINT",  () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
