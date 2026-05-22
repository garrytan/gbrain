#!/usr/bin/env bun
/**
 * GBrain Local Gateway
 *
 * 本地密碼閘道器：LLM 只知道本地密碼，Railway token 永遠不暴露。
 * 本機沒開 → 密碼無效 → 資料拿不走。
 *
 * Usage:
 *   GBRAIN_LOCAL_PASS=你的本地密碼 bun scripts/local-gateway.ts
 *
 * Env vars:
 *   GBRAIN_LOCAL_PASS   本地密碼（LLM 拿到的那把鑰匙）
 *   GBRAIN_REMOTE_URL   Railway URL（預設讀 ~/.gbrain/config.json 推算）
 *   GBRAIN_REMOTE_TOKEN Railway token（預設讀 GBRAIN_HTTP_TOKEN）
 *   GATEWAY_PORT        本地 port（預設 4243）
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

// ── 設定 ──────────────────────────────────────────────────────────────────────

const LOCAL_PASS  = process.env.GBRAIN_LOCAL_PASS;
const REMOTE_URL  = process.env.GBRAIN_REMOTE_URL  ?? "https://gbrain-production-18fa.up.railway.app";
const REMOTE_TOKEN = process.env.GBRAIN_REMOTE_TOKEN ?? process.env.GBRAIN_HTTP_TOKEN;
const PORT        = parseInt(process.env.GATEWAY_PORT ?? "4243", 10);

if (!LOCAL_PASS) {
  console.error("ERROR: GBRAIN_LOCAL_PASS is not set");
  console.error("  export GBRAIN_LOCAL_PASS='你的本地密碼'");
  process.exit(1);
}

if (!REMOTE_TOKEN) {
  console.error("ERROR: GBRAIN_REMOTE_TOKEN or GBRAIN_HTTP_TOKEN is not set");
  process.exit(1);
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyLocalPass(req: Request): boolean {
  const url = new URL(req.url);
  // 支援 ?pass=xxx 或 Authorization: Bearer xxx
  const fromQuery = url.searchParams.get("pass") ?? url.searchParams.get("token");
  const fromHeader = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  const provided = (fromQuery ?? fromHeader ?? "").trim();
  if (!provided) return false;
  return constantTimeEqual(provided, LOCAL_PASS!);
}

function proxyHeaders(): Headers {
  const h = new Headers();
  h.set("Authorization", `Bearer ${REMOTE_TOKEN}`);
  h.set("Content-Type", "application/json");
  return h;
}

// ── 請求處理 ──────────────────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const t0 = Date.now();

  // 健康檢查（不需要密碼，讓 LLM 知道閘道器是活的）
  if (path === "/health" && req.method === "GET") {
    return Response.json({ ok: true, gateway: "local", took_ms: Date.now() - t0 });
  }

  // 驗證本地密碼
  if (!verifyLocalPass(req)) {
    return Response.json(
      { ok: false, error: "Invalid local password", code: "unauthorized" },
      { status: 401 }
    );
  }

  // 清掉 pass/token 參數，避免轉送給 Railway
  url.searchParams.delete("pass");
  url.searchParams.delete("token");

  // 組合 Railway URL
  const remoteUrl = `${REMOTE_URL}${path}${url.search ? url.search : ""}`;

  try {
    const remoteReq = new Request(remoteUrl, {
      method: req.method,
      headers: proxyHeaders(),
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.blob() : undefined,
    });

    const remoteRes = await fetch(remoteReq);
    const body = await remoteRes.json();

    return Response.json(
      { ...body, gateway_ms: Date.now() - t0 },
      { status: remoteRes.status }
    );
  } catch (e: any) {
    return Response.json(
      { ok: false, error: "Gateway error: " + e.message, code: "proxy_error" },
      { status: 502 }
    );
  }
}

// ── 啟動 ──────────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // 只監聽本機，外部無法直接連
  fetch: handleRequest,
});

console.log(`
╔══════════════════════════════════════════════╗
║         GBrain Local Gateway 已啟動          ║
╠══════════════════════════════════════════════╣
║  本地端點  http://127.0.0.1:${PORT}            ║
║  遠端目標  ${REMOTE_URL.slice(0, 36)}...  ║
║  認證方式  ?pass=<本地密碼>                  ║
╚══════════════════════════════════════════════╝

給 LLM 的提示詞片段：
  Base URL: http://127.0.0.1:${PORT}
  認證: ?pass=<你的 GBRAIN_LOCAL_PASS>

Ctrl+C 關閉閘道器（關閉後密碼立即失效）
`);

process.on("SIGINT",  () => { server.stop(); process.exit(0); });
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
