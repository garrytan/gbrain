#!/usr/bin/env bun
/**
 * GBrain OTP 產生器
 * 生成當前有效的 60 秒一次性密碼
 *
 * Usage:
 *   bun scripts/otp.ts
 *   # 或加進 PATH 後: gbrain-otp
 *
 * 需要環境變數 GBRAIN_TOTP_SECRET（或讀 ~/.gbrain/gateway.env）
 */

import { createHmac } from "crypto";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

// 讀取 secret（優先 env，其次 gateway.env 檔）
function loadSecret(): string {
  if (process.env.GBRAIN_TOTP_SECRET) return process.env.GBRAIN_TOTP_SECRET;
  const envFile = `${homedir()}/.gbrain/gateway.env`;
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf-8");
    const match = content.match(/GBRAIN_TOTP_SECRET=([a-f0-9]+)/);
    if (match) return match[1];
  }
  console.error("ERROR: GBRAIN_TOTP_SECRET not found");
  console.error("  Set it in ~/.gbrain/gateway.env or as env var");
  process.exit(1);
}

// 產生 OTP（HMAC-SHA256，window = 60秒）
export function generateOtp(secret: string, windowOffset = 0): string {
  const window = Math.floor(Date.now() / 60_000) + windowOffset;
  return createHmac("sha256", secret)
    .update(String(window))
    .digest("hex")
    .slice(0, 10); // 10碼，夠長又不難複製
}

// 主程式
const secret = loadSecret();
const otp = generateOtp(secret);
const secondsLeft = 60 - (Math.floor(Date.now() / 1000) % 60);

console.log(`
┌─────────────────────────────┐
│   GBrain 當前 OTP 鑰匙      │
│                             │
│   ${otp}    │
│                             │
│   剩餘有效時間: ${String(secondsLeft).padStart(2, "0")}s         │
└─────────────────────────────┘

給 LLM: 在請求中加上 ?otp=${otp}
`);
