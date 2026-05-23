#!/usr/bin/env bun
/**
 * gbrain 垃圾桶確認執行器
 *
 * 讀取 gbrain/trash，執行人工勾選的刪除動作：
 *   - [x] → 刪除該頁面（移入歷史紀錄）
 *   - [k] → 保留，從清單移除
 *   - [ ] → 不動
 *
 * Usage:
 *   bun scripts/trash-confirm.ts             # 正式執行
 *   bun scripts/trash-confirm.ts --dry-run   # 預覽要刪什麼
 */

import postgres from "postgres";
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
  status: "delete" | "keep" | "pending";
  slug: string;
  rest: string; // reason + date suffix
  raw: string;  // original line
}

function parseTrashItems(body: string): TrashItem[] {
  const items: TrashItem[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^- \[([xk ])\] `([^`]+)`(.*)$/);
    if (!m) continue;
    const marker = m[1];
    const slug = m[2];
    const rest = m[3];
    items.push({
      status: marker === "x" ? "delete" : marker === "k" ? "keep" : "pending",
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

// ── Rewrite trash page ───────────────────────────────────────────────────────

function rewriteTrashBody(opts: {
  originalBody: string;
  deleted: { slug: string; rest: string }[];
  kept: { slug: string; rest: string }[];
  notFound: string[];
  confirmDate: string;
}): string {
  const { originalBody, deleted, kept, notFound, confirmDate } = opts;

  // 先過濾掉已處理的行（[x] 和 [k]）
  const lines = originalBody.split("\n");
  const filteredLines = lines.filter((line) => {
    const m = line.match(/^- \[([xk])\] `([^`]+)`/);
    if (!m) return true; // 保留非 item 行
    const slug = m[2];
    // 移除 [x] 和 [k] 行（已確認處理的）
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
const pending = items.filter((i) => i.status === "pending");

log(`  待刪除: ${toDelete.length} 筆`);
log(`  標記保留: ${toKeep.length} 筆`);
log(`  尚待審核: ${pending.length} 筆\n`);

if (toDelete.length === 0 && toKeep.length === 0) {
  log("沒有 [x] 或 [k] 標記，無事可做。");
  log("請在 gbrain/trash 將 [ ] 改為 [x]（刪除）或 [k]（保留）後再執行。\n");
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
    // error 已在 deletePage 內記錄
  }
}

// 標記保留（僅從清單移除，不刪資料）
const kept = toKeep.map((i) => ({ slug: i.slug, rest: i.rest }));
for (const k of kept) {
  log(`  🔒 保留: ${k.slug}`);
}

if (!DRY_RUN) {
  // 改寫 gbrain/trash
  const newBody = rewriteTrashBody({ originalBody: body, deleted, kept, notFound, confirmDate });
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
