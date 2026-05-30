#!/usr/bin/env bun
/**
 * gbrain 垃圾桶確認執行器
 *
 * 讀取 gbrain/trash，執行人工勾選的動作：
 *   - [x] → 刪除該頁面（移入歷史紀錄）
 *   - [k] → 保留，從清單移除
 *   - [c] → 壓縮精華：用 Claude 萃取要點 → 寫入 wiki/notes/<slug>-distilled → 刪原頁
 *   - [ ] → 不動
 *
 * Usage:
 *   bun scripts/trash-confirm.ts             # 正式執行
 *   bun scripts/trash-confirm.ts --dry-run   # 預覽要做什麼（不寫入）
 *
 * 壓縮精華需要 ANTHROPIC_API_KEY 環境變數。
 */

import postgres from "postgres";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const TRASH_SLUG = "gbrain/trash";
const NOW_SLUG = "gbrain/now";

const configPath = `${homedir()}/.gbrain/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const db = postgres(config.database_url, { max: 3 });

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Parse trash page ─────────────────────────────────────────────────────────

interface TrashItem {
  status: "delete" | "keep" | "compress" | "pending";
  slug: string;
  rest: string; // reason + date suffix
  raw: string;  // original line
}

function parseTrashItems(body: string): TrashItem[] {
  const items: TrashItem[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^- \[([xkc ])\] `([^`]+)`(.*)$/);
    if (!m) continue;
    const marker = m[1];
    const slug = m[2];
    const rest = m[3];
    items.push({
      status: marker === "x" ? "delete" : marker === "k" ? "keep" : marker === "c" ? "compress" : "pending",
      slug,
      rest,
      raw: line,
    });
  }
  return items;
}

// ── Execute deletes ──────────────────────────────────────────────────────────

async function deletePage(slug: string): Promise<"ok" | "not_found" | "error"> {
  try {
    const result = await db`DELETE FROM pages WHERE slug = ${slug} RETURNING slug`;
    return result.length > 0 ? "ok" : "not_found";
  } catch (e) {
    log(`  ERROR deleting ${slug}: ${e}`);
    return "error";
  }
}

// ── Compress page via Claude ─────────────────────────────────────────────────

async function compressPage(slug: string): Promise<{ distilledSlug: string; ok: boolean; error?: string }> {
  const rows = await db<{ compiled_truth: string | null }[]>`
    SELECT compiled_truth FROM pages WHERE slug = ${slug}
  `;
  if (!rows.length || !rows[0].compiled_truth) {
    return { distilledSlug: "", ok: false, error: "page not found or empty" };
  }

  const content = rows[0].compiled_truth;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { distilledSlug: "", ok: false, error: "ANTHROPIC_API_KEY not set" };

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `以下是一份腦庫頁面的內容。請萃取其中最核心的要點，輸出一份精簡的 markdown 摘要（100-300字）。\n保留重要的事實、決策、洞察，去掉冗餘敘述。\n輸出純 markdown，不要加說明或前言。\n\n---\n${content}`,
    }],
  });

  const distilled = response.content[0].type === "text" ? response.content[0].text : "";
  if (!distilled) return { distilledSlug: "", ok: false, error: "Claude returned empty response" };

  // slug: wiki/notes/<original-slug-last-segment>-distilled
  const slugSegment = slug.replace(/\//g, "-");
  const distilledSlug = `wiki/notes/${slugSegment}-distilled`;
  const now = new Date().toISOString().slice(0, 10);
  const fullContent = [
    "---",
    `title: ${slug} (distilled)`,
    `source: ${slug}`,
    `created: ${now}`,
    `distilled_at: ${now}`,
    "---",
    "",
    distilled,
  ].join("\n");

  await db`
    INSERT INTO pages (slug, compiled_truth, created_at, updated_at)
    VALUES (${distilledSlug}, ${fullContent}, NOW(), NOW())
    ON CONFLICT (slug) DO UPDATE SET compiled_truth = ${fullContent}, updated_at = NOW()
  `;

  await deletePage(slug);
  return { distilledSlug, ok: true };
}

// ── Rewrite trash page ───────────────────────────────────────────────────────

function rewriteTrashBody(opts: {
  originalBody: string;
  deleted: { slug: string; rest: string }[];
  kept: { slug: string; rest: string }[];
  compressed: { slug: string; distilledSlug: string }[];
  notFound: string[];
  confirmDate: string;
}): string {
  const { originalBody, deleted, kept, compressed, notFound, confirmDate } = opts;

  // 先過濾掉已處理的行（[x]、[k]、[c]）
  const lines = originalBody.split("\n");
  const filteredLines = lines.filter((line) => {
    const m = line.match(/^- \[([xkc])\] `([^`]+)`/);
    if (!m) return true; // 保留非 item 行
    // 移除已確認處理的行
    return false;
  });

  // 更新待審核計數（重算）
  const pendingCount = filteredLines.filter((l) => /^- \[ \]/.test(l)).length;
  const updatedBody = filteredLines
    .join("\n")
    .replace(/\*\*待審核\*\*：\d+ 筆/, `**待審核**：${pendingCount} 筆`);

  // 新增歷史紀錄
  const newHistoryRows = [
    ...deleted.map(
      ({ slug, rest }) =>
        `| ${confirmDate} | \`${slug}\` | 🗑️ 人工刪除 | ${rest.replace(/^[— ]+/, "").replace(/— 加入.*$/, "").trim()} |`,
    ),
    ...kept.map(
      ({ slug }) =>
        `| ${confirmDate} | \`${slug}\` | 🔒 保留 | - |`,
    ),
    ...compressed.map(
      ({ slug, distilledSlug }) =>
        `| ${confirmDate} | \`${slug}\` | 🧪 壓縮精華 → \`${distilledSlug}\` | - |`,
    ),
    ...notFound.map(
      (slug) =>
        `| ${confirmDate} | \`${slug}\` | ⚠️ 已不存在 | - |`,
    ),
  ].join("\n");

  if (!newHistoryRows) return updatedBody;

  return updatedBody.replace(
    /(\| 日期 \| slug \| 決定 \| 原因 \|\n\|[-|]+\|)\n/,
    `$1\n${newHistoryRows}\n`,
  );
}

// ── 清除 gbrain/now 提醒 ─────────────────────────────────────────────────────

async function clearNowReminder() {
  const rows = await db<{ compiled_truth: string | null }[]>`
    SELECT compiled_truth FROM pages WHERE slug = ${NOW_SLUG}
  `;
  if (!rows.length || !rows[0].compiled_truth) return;

  const body = rows[0].compiled_truth;
  if (!body.includes("🗑️ **垃圾桶待審核**")) return;

  const updated = body
    .split("\n")
    .filter((l) => !l.includes("🗑️ **垃圾桶待審核**"))
    .join("\n");

  await db`UPDATE pages SET compiled_truth = ${updated}, updated_at = NOW() WHERE slug = ${NOW_SLUG}`;
  log("  gbrain/now 提醒已清除");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const confirmDate = today();
log(`\n=== gbrain trash-confirm ${DRY_RUN ? "(dry-run)" : ""} — ${confirmDate} ===\n`);

// 讀取 gbrain/trash
const trashRows = await db<{ compiled_truth: string | null }[]>`
  SELECT compiled_truth FROM pages WHERE slug = ${TRASH_SLUG}
`;

if (!trashRows.length || !trashRows[0].compiled_truth) {
  log("gbrain/trash 不存在或為空，無事可做。");
  await db.end();
  process.exit(0);
}

const body = trashRows[0].compiled_truth;
const items = parseTrashItems(body);

const toDelete = items.filter((i) => i.status === "delete");
const toKeep = items.filter((i) => i.status === "keep");
const toCompress = items.filter((i) => i.status === "compress");
const pending = items.filter((i) => i.status === "pending");

log(`  待刪除: ${toDelete.length} 筆`);
log(`  標記保留: ${toKeep.length} 筆`);
log(`  壓縮精華: ${toCompress.length} 筆`);
log(`  尚待審核: ${pending.length} 筆\n`);

if (toDelete.length === 0 && toKeep.length === 0 && toCompress.length === 0) {
  log("沒有 [x]、[k] 或 [c] 標記，無事可做。");
  log("請在 gbrain/trash 將 [ ] 改為 [x]（刪除）、[k]（保留）或 [c]（壓縮精華）後再執行。\n");
  await db.end();
  process.exit(0);
}

// 執行刪除
const deleted: { slug: string; rest: string }[] = [];
const notFound: string[] = [];

for (const item of toDelete) {
  if (DRY_RUN) {
    log(`[dry-run] would delete: ${item.slug}`);
    deleted.push({ slug: item.slug, rest: item.rest });
  } else {
    const result = await deletePage(item.slug);
    if (result === "ok") {
      log(`  ✅ 刪除: ${item.slug}`);
      deleted.push({ slug: item.slug, rest: item.rest });
    } else if (result === "not_found") {
      log(`  ⚠️  不存在（可能已刪）: ${item.slug}`);
      notFound.push(item.slug);
    }
  }
}

// 執行壓縮精華
const compressed: { slug: string; distilledSlug: string }[] = [];

for (const item of toCompress) {
  if (DRY_RUN) {
    log(`[dry-run] would compress: ${item.slug} → wiki/notes/${item.slug.replace(/\//g, "-")}-distilled`);
    compressed.push({ slug: item.slug, distilledSlug: `wiki/notes/${item.slug.replace(/\//g, "-")}-distilled` });
  } else {
    log(`  🧪 壓縮中: ${item.slug}`);
    const result = await compressPage(item.slug);
    if (result.ok) {
      log(`  ✅ 壓縮完成: ${item.slug} → ${result.distilledSlug}`);
      compressed.push({ slug: item.slug, distilledSlug: result.distilledSlug });
    } else {
      log(`  ❌ 壓縮失敗: ${item.slug} — ${result.error}`);
    }
  }
}

// 標記保留（僅從清單移除，不刪資料）
const kept = toKeep.map((i) => ({ slug: i.slug, rest: i.rest }));
for (const k of kept) {
  log(`  🔒 保留: ${k.slug}`);
}

if (!DRY_RUN) {
  // 改寫 gbrain/trash
  const newBody = rewriteTrashBody({ originalBody: body, deleted, kept, compressed, notFound, confirmDate });
  await db`
    UPDATE pages
    SET compiled_truth = ${newBody}, updated_at = NOW()
    WHERE slug = ${TRASH_SLUG}
  `;
  log(`\n✅ gbrain/trash 已更新`);

  // 如果沒有剩餘待審核，清除 gbrain/now 的提醒
  const remainingPending = pending.length;
  if (remainingPending === 0) {
    await clearNowReminder();
  }
} else {
  log(`\n[dry-run] 未執行任何刪除或寫入`);
}

await db.end();
log("\n=== confirm 完成 ===\n");
