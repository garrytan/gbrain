#!/usr/bin/env bun
/**
 * notes/ 域自動分類腳本
 * 直接連 DB 取所有 notes/ 頁面，用標題+前200字判斷 source: original | external | junk
 * 結果輸出 JSONL 到 stdout，供後續批次更新 frontmatter
 *
 * Usage:
 *   bun scripts/classify-notes.ts > /tmp/notes-classification.jsonl
 *   bun scripts/classify-notes.ts --apply   # 直接寫入 frontmatter
 */

import postgres from "postgres";
import { readFileSync } from "fs";
import { homedir } from "os";

// ── Config ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 10;

function loadDb() {
  const configPath = `${homedir()}/.gbrain/config.json`;
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return postgres(config.database_url, { max: CONCURRENCY + 2 });
}

// ── Classification rules ──────────────────────────────────────────────────────

type Source = "original" | "external" | "junk";

function classify(slug: string, title: string, body: string): { source: Source; reason: string } {
  const text = (title + " " + body).toLowerCase();
  const bodyLen = body.replace(/<[^>]*>/g, "").trim().length;

  // Junk: very short, no real content
  if (bodyLen < 20) return { source: "junk", reason: "too_short" };

  // Junk: just numbers (account numbers, phone numbers)
  if (/^\d[\d\s\-\/]*$/.test(body.replace(/<[^>]*>/g, "").trim()))
    return { source: "junk", reason: "numbers_only" };

  // External: TikTok transcripts
  if (text.includes("tiktok") || text.includes("轉錄"))
    return { source: "external", reason: "tiktok_transcript" };

  // External: contains obvious copy-paste markers
  if (text.includes("來源：") || text.includes("source:") || text.includes("原文連結"))
    return { source: "external", reason: "has_source_attribution" };

  // External: long blocks of simplified Chinese (likely mainland content)
  const simplifiedRatio = (body.match(/[一-鿿]/g) || []).length > 0
    ? (body.match(/[的了在是我不有人这个中大为上]/g) || []).length / (body.match(/[一-鿿]/g) || []).length
    : 0;
  if (simplifiedRatio > 0.15 && bodyLen > 500)
    return { source: "external", reason: "likely_mainland_content" };

  // Original: meeting notes pattern
  if (text.includes("晨會") || text.includes("會議") || text.includes("點名") || text.includes("到場"))
    return { source: "original", reason: "meeting_notes" };

  // Original: personal schedule/todo
  if (text.includes("行程") || text.includes("待辦") || text.includes("目標"))
    return { source: "original", reason: "schedule_or_todo" };

  // Original: contains team member names (房多多 team pattern)
  if (text.includes("泓任") || text.includes("馥宇") || text.includes("宗仁") || text.includes("山晴"))
    return { source: "original", reason: "team_notes" };

  // Original: first person markers
  if (text.includes("我的") || text.includes("我們") || text.includes("我覺得") || text.includes("我要"))
    return { source: "original", reason: "first_person" };

  // Default: assume original (notes/ is mostly personal notes from sync)
  return { source: "original", reason: "default_notes_domain" };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = loadDb();

  process.stderr.write("Fetching all notes/ pages from DB...\n");

  const rows: { slug: string; title: string; compiled_truth: string; frontmatter: any }[] = await db`
    SELECT slug, title, compiled_truth, frontmatter
    FROM pages
    WHERE slug LIKE 'notes/%'
    ORDER BY slug
  `;

  process.stderr.write(`  found ${rows.length} notes/ pages\n`);

  const stats = { original: 0, external: 0, junk: 0 };
  const results: Array<{ slug: string; source: Source; reason: string }> = [];

  for (const row of rows) {
    const body = (row.compiled_truth || "").slice(0, 500);
    const cls = classify(row.slug, row.title || "", body);
    stats[cls.source]++;
    results.push({ slug: row.slug, ...cls });
    console.log(JSON.stringify({ slug: row.slug, ...cls }));
  }

  process.stderr.write(`\nDone. ${JSON.stringify(stats)}\n`);

  if (APPLY) {
    process.stderr.write("\nApplying source to frontmatter...\n");
    let applied = 0;
    for (const r of results) {
      await db`
        UPDATE pages
        SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || ${db.json({ source: r.source })}
        WHERE slug = ${r.slug}
      `;
      applied++;
      if (applied % 50 === 0)
        process.stderr.write(`\r  ${applied}/${results.length} updated...`);
    }
    process.stderr.write(`\n  Done. ${applied} pages updated.\n`);
  }

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
