#!/usr/bin/env bun
/**
 * OpenRouter Proxy — 讓 Claude Code 走 GLM-4.6
 *
 * 攔截 Claude Code → Anthropic API 的請求，轉發到 OpenRouter，
 * 把模型替換成 GLM-4.6（便宜 ~8x）。
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... bun scripts/openrouter-proxy.ts
 *
 * Claude Code 設定：
 *   export ANTHROPIC_BASE_URL=http://localhost:4000
 *   export ANTHROPIC_API_KEY=anything
 */

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PORT = parseInt(process.env.PROXY_PORT ?? "4000", 10);
const TARGET_MODEL = process.env.PROXY_MODEL ?? "z-ai/glm-4.6";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

if (!OPENROUTER_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY is not set");
  process.exit(1);
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, proxy: "openrouter", model: TARGET_MODEL });
    }

    // 轉發到 OpenRouter
    // Claude Code 送 /v1/messages，OpenRouter base 已含 /api/v1，需去掉 /v1 前綴
    const strippedPath = url.pathname.replace(/^\/v1/, "");
    const target = `${OPENROUTER_BASE}${strippedPath}${url.search}`;

    let body: unknown;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { body = await req.json(); } catch { body = null; }
    }

    // 替換 model
    if (body && typeof body === "object" && "model" in (body as object)) {
      (body as Record<string, unknown>).model = TARGET_MODEL;
    }

    const headers = new Headers();
    headers.set("Authorization", `Bearer ${OPENROUTER_KEY}`);
    headers.set("Content-Type", "application/json");
    // 把 Anthropic 版本 header 一起帶上（OpenRouter 支援 Anthropic 格式）
    const anthropicVersion = req.headers.get("anthropic-version");
    if (anthropicVersion) headers.set("anthropic-version", anthropicVersion);
    // OpenRouter 識別 header（可選，方便追蹤）
    headers.set("HTTP-Referer", "https://gbrain.local");
    headers.set("X-Title", "gbrain-proxy");

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    });

    // streaming 支援：直接轉發 body
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
});

console.log(`OpenRouter proxy running on http://localhost:${PORT}`);
console.log(`  Model: ${TARGET_MODEL}`);
console.log(`  Set ANTHROPIC_BASE_URL=http://localhost:${PORT} in Claude Code`);
