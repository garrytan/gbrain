#!/usr/bin/env bun
/**
 * gbrain 垃圾桶掃描器（Layer 1 + 2）
 *
 * Layer 1：自動刪除 mem/ 頁面（超過 MEM_RETENTION_DAYS 天，無需人工確認）
 * Layer 2：掃描孤立頁面候選，寫入 gbrain/trash 待人工審核
 *
 * Usage:
 *   bun scripts/trash-sweep.ts             # 正式執行
 *   bun scripts/trash-sweep.ts --dry-run   # 預覽，不寫入 DB
 *   bun scripts/trash-sweep.ts --layer=1   # 只跑 mem/ 自動清理
 *   bun scripts/trash-sweep.ts --layer=2   # 只跑孤立頁面掃描
 */

import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const LAYER = process.argv.find((a) => a.startsWith("--layer="))?.split("=")[1] ?? "all";

const MEM_RETENTION_DAYS = 30;     // mem/ 頁面保留天數
const ORPHAN_MIN_AGE_DAYS = 14;    // 孤立候選最小存在天數（太新的不碰）
const ORPHAN_MAX_CANDIDATES = 20;  // 每次最多加入 N 個候選
const TRASH_SLUG = "gbrain/trash";
const NOW_SLUG = "gbrain/now";

// ── DB ────────────────────────────────────────────────────────────────────────

const configPath = `${homedir()}/.gbrain/config.json`;
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const db = postgres(config.database_url, { max: 3 });

// ── Helpers ───────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

// ── Layer 1: 自動刪除 mem/ 頁面 ───────────────────────────────────────────────

async function sweepMemPages(): Promise<{ deleted: string[]; skipped: string[] }> {
  const rows = await db<{ slug: string; ts: Date }[]>`
    SELECT slug, COALESCE(updated_at, created_at)::timestamptz AS ts
    FROM pages
    WHERE slug LIKE 'mem/%'
      AND COALESCE(updated_at, created_at) < NOW() - ${`${MEM_RETENTION_DAYS} days`}::interval
    ORDER BY ts ASC
    LIMIT 200
  `;

  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    if (DRY_RUN) {
      skipped.push(row.slug);
      log(`[dry-run] would delete mem/: ${row.slug}`);
    } else {
      await db`DELETE FROM pages WHERE slug = ${row.slug}`;
      deleted.push(row.slug);
      log(`[layer-1] deleted: ${row.slug}`);
    }
  }

  return { deleted, skipped };
}

// ── Layer 2: 掃描孤立候選 ─────────────────────────────────────────────────────

// 已在 gbrain/trash 中的 slug（避免重複加入）
async function existingTrashSlugs(): Promise<Set<string>> {
  const rows = await db<{ compiled_truth: string | null }[]>`
    SELECT compiled_truth FROM pages WHERE slug = ${TRASH_SLUG}
  `;
  if (!rows.length || !rows[0].compiled_truth) return new Set();

  const body = rows[0].compiled_truth;
  const slugSet = new Set<string>();
  // 格式: - [x/k/ ] `slug` — ...
  for (const m of body.matchAll(/^- \[.?\] `([^`]+)`/gm)) {
    slugSet.add(m[1]);
  }
  return slugSet;
}

interface OrphanCandidate {
  slug: string;
  title: string;
  age_days: number;
  in_link_count: number;
  reason: string;
}

// 不進入垃圾桶審核的前綴
const EXCLUDE_PREFIXES = ["mem/", "gbrain/", "wiki/agents/", "files/", "_"];

async function scanOrphanCandidates(): Promise<OrphanCandidate[]> {
  // 找零入鏈且存在超過 N 天的非系統頁面
  const rows = await db<{
    slug: string;
    title: string | null;
    age_days: number;
    in_link_count: number;
  }[]>`
    SELECT
      p.slug,
      p.title,
      EXTRACT(DAY FROM NOW() - COALESCE(p.updated_at, p.created_at))::int AS age_days,
      COUNT(l.id)::int AS in_link_count
    FROM pages p
    LEFT JOIN links l ON l.to_page_id = p.id
    WHERE COALESCE(p.updated_at, p.created_at) < NOW() - ${`${ORPHAN_MIN_AGE_DAYS} days`}::interval
    GROUP BY p.slug, p.title, p.created_at, p.updated_at
    HAVING COUNT(l.id) = 0
    ORDER BY COALESCE(p.updated_at, p.created_at) ASC
    LIMIT 100
  `;

  const already = await existingTrashSlugs();

  return rows
    .filter((r) => {
      // 排除系統前綴
      if (EXCLUDE_PREFIXES.some((pfx) => r.slug.startsWith(pfx))) return false;
      // 排除已在 trash 的
      if (already.has(r.slug)) return false;
      return true;
    })
    .slice(0, ORPHAN_MAX_CANDIDATES)
    .map((r) => ({
      slug: r.slug,
      title: r.title ?? r.slug,
      age_days: r.age_days,
      in_link_count: r.in_link_count,
      reason: `孤立頁面，零入鏈，存在 ${r.age_days} 天`,
    }));
}

// ── 更新 gbrain/trash ────────────────────────────────────────────────────────

function buildTrashBody(opts: {
  existing: string;
  newCandidates: OrphanCandidate[];
  autoDeleted: string[];
  scanDate: string;
}): string {
  const { existing, newCandidates, autoDeleted, scanDate } = opts;

  // 保留現有 待審核 section 的行（已有 [x]/[k]/[ ] 的行）
  const pendingLines: string[] = [];
  for (const line of existing.split("\n")) {
    if (/^- \[[ xk]\] `/.test(line)) {
      pendingLines.push(line);
    }
  }

  // 加入新候選（[ ] 預設）
  for (const c of newCandidates) {
    pendingLines.push(`- [ ] \`${c.slug}\` — ${c.reason} — 加入 ${scanDate}`);
  }

  const pendingCount = pendingLines.filter((l) => l.startsWith("- [ ]")).length;

  // 保留歷史紀錄行
  const historyMatch = existing.match(/## 歷史紀錄[\s\S]*/);
  const existingHistory = historyMatch ? historyMatch[0] : "## 歷史紀錄\n\n| 日期 | slug | 決定 | 原因 |\n|------|------|------|------|\n";

  // 新增 auto-delete 紀錄
  const autoDeleteRows = autoDeleted
    .map((s) => `| ${scanDate} | \`${s}\` | ♻️ auto | mem/ 超過 ${MEM_RETENTION_DAYS} 天 |`)
    .join("\n");

  const historySection = autoDeleteRows
    ? existingHistory.replace(
        /(\| 日期 \| slug \| 決定 \| 原因 \|\n\|[-|]+\|)\n/,
        `$1\n${autoDeleteRows}\n`,
      )
    : existingHistory;

  const pendingSection =
    pendingLines.length > 0
      ? pendingLines.join("\n")
      : "_目前沒有待審核項目。_";

  return `> **審核方式**：將 \`[ ]\` 改為 \`[x]\` 同意刪除，或改為 \`[k]\` 保留。確認後執行 \`bun scripts/trash-confirm.ts\`
>
> **Layer 1**（自動）：\`mem/\` 頁面超過 ${MEM_RETENTION_DAYS} 天自動刪除，無需確認。
> **Layer 2**（人工）：孤立頁面由 sweep 加入下方，需人工勾選後執行 confirm。

**上次掃描**：${scanDate} | **待審核**：${pendingCount} 筆 | 預覽：\`bun scripts/trash-sweep.ts --dry-run\`

## 🗑️ 待審核

${pendingSection}

${historySection}`.trimEnd();
}

async function updateTrashPage(body: string) {
  const now = new Date().toISOString();
  await db`
    INSERT INTO pages (slug, title, type, compiled_truth, updated_at)
    VALUES (
      ${TRASH_SLUG},
      '垃圾桶審核區',
      'meta',
      ${body},
      ${now}
    )
    ON CONFLICT (slug) DO UPDATE SET
      compiled_truth = EXCLUDED.compiled_truth,
      updated_at = EXCLUDED.updated_at
  `;
}

// ── 提醒注入 gbrain/now ───────────────────────────────────────────────────────

async function injectNowReminder(pendingCount: number) {
  if (pendingCount === 0) return;

  const rows = await db<{ compiled_truth: string | null }[]>`
    SELECT compiled_truth FROM pages WHERE slug = ${NOW_SLUG}
  `;
  if (!rows.length) return;

  const body = rows[0].compiled_truth ?? "";
  const reminderLine = `- 🗑️ **垃圾桶待審核** ${pendingCount} 筆 — 查看 [[gbrain/trash]]，勾選後 \`bun scripts/trash-confirm.ts\``;

  // 如果已有提醒行則更新，否則插入到 🟡待處理 section
  if (body.includes("🗑️ **垃圾桶待審核**")) {
    const updated = body.replace(/^- 🗑️ \*\*垃圾桶待審核\*\*.+$/m, reminderLine);
    await db`UPDATE pages SET compiled_truth = ${updated}, updated_at = NOW() WHERE slug = ${NOW_SLUG}`;
  } else {
    // 插入到 🟡 section 的第一行之後
    const marker = "## 🟡待處理";
    if (body.includes(marker)) {
      const updated = body.replace(marker + "\n", marker + "\n" + reminderLine + "\n");
      await db`UPDATE pages SET compiled_truth = ${updated}, updated_at = NOW() WHERE slug = ${NOW_SLUG}`;
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const scanDate = today();
log(`\n=== gbrain trash-sweep ${DRY_RUN ? "(dry-run)" : ""} — ${scanDate} ===\n`);

// Layer 1
let autoDeleted: string[] = [];
if (LAYER === "all" || LAYER === "1") {
  log("── Layer 1: mem/ 自動清理 ──");
  const result = await sweepMemPages();
  autoDeleted = result.deleted;
  log(`  刪除: ${result.deleted.length} 筆${DRY_RUN ? ` (dry-run: ${result.skipped.length} 筆)` : ""}`);
}

// Layer 2
let candidates: OrphanCandidate[] = [];
if (LAYER === "all" || LAYER === "2") {
  log("── Layer 2: 孤立頁面掃描 ──");
  candidates = await scanOrphanCandidates();
  log(`  新候選: ${candidates.length} 筆`);
  for (const c of candidates) {
    log(`  · ${c.slug} (${c.reason})`);
  }
}

// 更新 gbrain/trash
if (!DRY_RUN) {
  const existingRows = await db<{ compiled_truth: string | null }[]>`
    SELECT compiled_truth FROM pages WHERE slug = ${TRASH_SLUG}
  `;
  const existing = existingRows[0]?.compiled_truth ?? "";

  const newBody = buildTrashBody({ existing, newCandidates: candidates, autoDeleted, scanDate });
  await updateTrashPage(newBody);
  log(`\n✅ gbrain/trash 已更新`);

  // 計算總待審核數
  const pendingCount = newBody.match(/^- \[ \] /gm)?.length ?? 0;
  await injectNowReminder(pendingCount);
  if (pendingCount > 0) {
    log(`🔔 gbrain/now 提醒已注入（待審核: ${pendingCount} 筆）`);
  }
} else {
  log(`\n[dry-run] 未寫入任何資料`);
  log(`         Layer 1 will delete: ${autoDeleted.length > 0 ? autoDeleted.join(", ") : "(none yet)"}`);
  log(`         Layer 2 candidates: ${candidates.map((c) => c.slug).join(", ") || "(none)"}`);
}

await db.end();
log("\n=== sweep 完成 ===\n");
