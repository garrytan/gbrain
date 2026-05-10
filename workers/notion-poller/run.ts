#!/usr/bin/env bun
/**
 * notion-poller — 5-min cron pull from Notion DBs into the brain.
 *
 * Replaces the old "weekly manual scan" pattern from KOS v1 with an ambient
 * push: any page saved in a monitored DB lands in the brain within 5 min.
 * Original design contract previously lived in
 * skills/kos-jarvis/notion-ingest-delta/SKILL.md (now a 5-line redirect).
 *
 * ## Two-mode design (per @notionhq/workers backfill+delta pattern)
 *
 *   Mode      | Schedule | Filter                              | Purpose
 *   ----------|----------|-------------------------------------|--------------------
 *   backfill  | manual   | (none)                              | one-time full crawl
 *   delta     | 5 min    | last_edited_time > cursor (per DB)  | normal operation
 *
 * Flow per monitored DB (delta mode shown):
 *   databases.query(sort=last_edited_time desc, filter last_edited_time > cursor)
 *     → for each page, retrieve page + all children blocks (paginate has_more)
 *     → flatten blocks to markdown
 *     → POST /ingest { markdown, title, source:"notion:<id>", notion_id, kind }
 *     → update cursor on success
 *
 * ## /ingest payload shape
 *
 * The kos-compat-api /ingest endpoint detects `markdown` and skips its
 * usual fetch step, writing the supplied body straight to staging with
 * Notion-sourced frontmatter (id=source-notion-<slug>, kind=source,
 * source_of_truth=notion, source_refs=[notion URL, notion_id], tags=[notion-ingest]).
 *
 * ## Failure modes (handled here)
 *
 * - Notion page references other Notion pages → unfurl as plain text links
 * - Large pages (>100 blocks) → paginate fetch via `has_more`
 * - Rate limits → in-process pacer (kos-worker has its own)
 * - Deletes in Notion → DO NOT delete from gbrain (sources are immutable);
 *   downstream may mark status=deprecated on the source page instead
 *
 * See ./README.md for config (env vars, run modes, launchd plist).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── config ──

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const DB_IDS = (process.env.NOTION_DATABASE_IDS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/-/g, ""))
  .filter(Boolean);
const KOS_API_BASE = process.env.KOS_API_BASE ?? "http://127.0.0.1:7225";
const KOS_API_TOKEN = process.env.KOS_API_TOKEN ?? "";
const STATE_PATH =
  process.env.POLLER_STATE_PATH ??
  join(homedir(), "brain", ".agent", "notion-poller-state.json");
const NOTION_VERSION = "2022-06-28";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const BACKFILL = args.includes("--backfill");

// ── state ──

type DbState = { last_edited_time: string | null };
type State = Record<string, DbState>;

function loadState(): State {
  if (BACKFILL || !existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: State) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ── notion REST ──

async function notion(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("Retry-After") ?? "1");
    await new Promise((res) => setTimeout(res, retry * 1000));
    return notion(path, init);
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Notion ${init.method ?? "GET"} ${path} → ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

type NotionPage = {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, any>;
  url: string;
  archived: boolean;
};

// Properties whose value is auto-derived and rarely informative for retrieval.
const BORING_PROPS = new Set([
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
]);

async function queryDatabase(dbId: string, since: string | null): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  while (true) {
    const body: any = {
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    };
    if (since) {
      body.filter = {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: since },
      };
    }
    if (cursor) body.start_cursor = cursor;
    const resp = await notion(`/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    for (const p of resp.results as NotionPage[]) pages.push(p);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
    // Cap defensively on backfill
    if (pages.length >= 500) break;
  }
  return pages;
}

async function fetchChildren(blockId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const resp = await notion(`/blocks/${blockId}/children?${params}`);
    for (const block of resp.results) out.push(block);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return out;
}

// ── property → title ──

function extractTitle(page: NotionPage): string {
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t: any) => t.plain_text ?? "").join("").trim() || "(untitled)";
    }
  }
  return "(untitled)";
}

// ── properties → markdown + frontmatter hints ──

function propValueToStr(prop: any): string {
  if (!prop) return "";
  const type = prop.type;
  const v = prop[type];
  if (v === null || v === undefined) return "";
  switch (type) {
    case "title":
    case "rich_text":
      if (!Array.isArray(v)) return "";
      return v.map((rt: any) => rt.plain_text ?? "").join("").trim();
    case "number":
      return typeof v === "number" ? String(v) : "";
    case "select":
      return v?.name ?? "";
    case "multi_select":
      return Array.isArray(v) ? v.map((s: any) => s.name).filter(Boolean).join(", ") : "";
    case "status":
      return v?.name ?? "";
    case "date": {
      if (!v?.start) return "";
      return v.end ? `${v.start} → ${v.end}` : v.start;
    }
    case "people":
      return Array.isArray(v) ? v.map((p: any) => p.name ?? p.id).filter(Boolean).join(", ") : "";
    case "files":
      return Array.isArray(v) ? v.map((f: any) => f.name ?? "(unnamed file)").join(", ") : "";
    case "checkbox":
      return v === true ? "yes" : v === false ? "no" : "";
    case "url":
    case "email":
    case "phone_number":
      return typeof v === "string" ? v : "";
    case "formula":
      return propValueToStr({ type: v.type, [v.type]: v[v.type] });
    case "rollup":
      if (v.type === "array" && Array.isArray(v.array)) {
        return v.array.map((item: any) => propValueToStr(item)).filter(Boolean).join(", ");
      }
      return propValueToStr({ type: v.type, [v.type]: v[v.type] });
    case "relation":
      return Array.isArray(v) && v.length > 0 ? `[${v.length} related]` : "";
    case "unique_id":
      return v ? `${v.prefix ?? ""}${v.number}` : "";
    case "created_time":
    case "last_edited_time":
      return typeof v === "string" ? v : "";
    case "created_by":
    case "last_edited_by":
      return v?.name ?? "";
    default:
      return "";
  }
}

type PropBundle = {
  body: string;           // "## Properties\n- Key: value\n..." or ""
  notion_date?: string;   // first Date-typed value, for frontmatter
  notion_status?: string; // first select/status, for frontmatter
  notion_url?: string;    // first URL-typed value
  meaningful_count: number;
};

function extractProperties(page: NotionPage): PropBundle {
  const lines: string[] = [];
  const out: PropBundle = { body: "", meaningful_count: 0 };

  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    const type = (prop as any)?.type;
    if (!type || type === "title") continue; // title already used
    if (BORING_PROPS.has(type)) continue;
    const val = propValueToStr(prop);
    if (!val) continue;
    lines.push(`- **${name}**: ${val}`);
    out.meaningful_count++;
    // Capture first-of-kind for frontmatter
    if (!out.notion_date && type === "date") out.notion_date = val;
    if (!out.notion_status && (type === "select" || type === "status")) out.notion_status = val;
    if (!out.notion_url && type === "url") out.notion_url = val;
  }
  if (lines.length > 0) out.body = `## Properties\n\n${lines.join("\n")}\n`;
  return out;
}

// ── block → markdown ──

function richTextToMd(rts: any[] | undefined): string {
  if (!Array.isArray(rts)) return "";
  return rts
    .map((rt) => {
      let t = rt.plain_text ?? "";
      const ann = rt.annotations ?? {};
      if (ann.code) t = `\`${t}\``;
      if (ann.bold) t = `**${t}**`;
      if (ann.italic) t = `*${t}*`;
      if (ann.strikethrough) t = `~~${t}~~`;
      if (rt.href) t = `[${t}](${rt.href})`;
      return t;
    })
    .join("");
}

async function blocksToMarkdown(blocks: any[], depth = 0): Promise<string> {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    const type = b.type;
    const content = b[type] ?? {};
    switch (type) {
      case "heading_1":
        lines.push(`# ${richTextToMd(content.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`## ${richTextToMd(content.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`### ${richTextToMd(content.rich_text)}`);
        break;
      case "paragraph": {
        const t = richTextToMd(content.rich_text);
        if (t.trim()) lines.push(`${indent}${t}`);
        break;
      }
      case "bulleted_list_item":
        lines.push(`${indent}- ${richTextToMd(content.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${richTextToMd(content.rich_text)}`);
        break;
      case "to_do": {
        const mark = content.checked ? "x" : " ";
        lines.push(`${indent}- [${mark}] ${richTextToMd(content.rich_text)}`);
        break;
      }
      case "quote":
        lines.push(`${indent}> ${richTextToMd(content.rich_text)}`);
        break;
      case "callout":
        lines.push(`${indent}> 💡 ${richTextToMd(content.rich_text)}`);
        break;
      case "code": {
        const lang = content.language ?? "";
        const code = richTextToMd(content.rich_text);
        lines.push("```" + lang, code, "```");
        break;
      }
      case "divider":
        lines.push("---");
        break;
      case "bookmark":
      case "embed":
      case "link_preview":
        if (content.url) lines.push(`${indent}🔗 ${content.url}`);
        break;
      case "image": {
        const url = content.external?.url ?? content.file?.url;
        if (url) lines.push(`${indent}![image](${url})`);
        break;
      }
      case "toggle":
        lines.push(`${indent}<details><summary>${richTextToMd(content.rich_text)}</summary>`);
        break;
      case "child_page":
      case "child_database":
        lines.push(`${indent}_[nested ${type}: ${content.title ?? ""}]_`);
        break;
      case "table":
      case "synced_block":
      case "column_list":
      case "column":
        lines.push(`${indent}_[${type} — open in Notion for full content]_`);
        break;
      default:
        // Last-ditch: dump plain_text if present
        if (content.rich_text) {
          const t = richTextToMd(content.rich_text);
          if (t.trim()) lines.push(`${indent}${t}`);
        }
    }
    if (b.has_children && ["toggle", "bulleted_list_item", "numbered_list_item", "to_do"].includes(type)) {
      const kids = await fetchChildren(b.id);
      const sub = await blocksToMarkdown(kids, depth + 1);
      if (sub.trim()) lines.push(sub);
    }
  }
  return lines.join("\n");
}

// ── slug derive ──

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled"; // id suffix provides uniqueness; fallback is deterministic
}

// ── ingest ──

async function ingest(payload: {
  title: string;
  markdown: string;
  notion_id: string;
  source: string;
  slug: string;            // sub-kind path, e.g. "notion/foo-<id>" (server prepends kind dir)
}): Promise<string> {
  const url = `${KOS_API_BASE}/ingest`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KOS_API_TOKEN}`,
    },
    body: JSON.stringify({
      markdown: payload.markdown,
      title: payload.title,
      slug: payload.slug,
      kind: "source",
      source: payload.source,
      notion_id: payload.notion_id,
      tags: ["notion", "notion-poller"],
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`ingest ${r.status}: ${text.slice(0, 300)}`);
  return text;
}

// ── main ──

async function main() {
  console.log(`=== notion-poller @ ${new Date().toISOString()} ===`);
  console.log(`Mode: ${DRY ? "DRY" : BACKFILL ? "BACKFILL" : "DELTA"}`);

  if (!NOTION_TOKEN) {
    console.log("NOTION_TOKEN not set in env — skipping run. Fill .env.local.");
    process.exit(0);
  }
  if (DB_IDS.length === 0) {
    console.log("NOTION_DATABASE_IDS empty — skipping run. Fill .env.local with one or more UUIDs.");
    process.exit(0);
  }

  const state = loadState();
  let totalSeen = 0;
  let totalIngested = 0;
  let totalSkipped = 0;

  for (const dbId of DB_IDS) {
    console.log(`\n[DB ${dbId.slice(0, 8)}…]`);
    const prev = state[dbId] ?? { last_edited_time: null };
    const since = prev.last_edited_time;
    if (since) console.log(`  since: ${since}`);
    else console.log(`  since: (backfill, no prior cursor)`);

    let pages: NotionPage[];
    try {
      pages = await queryDatabase(dbId, since);
    } catch (e) {
      console.error(`  ✗ query failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    console.log(`  ${pages.length} pages match`);
    totalSeen += pages.length;

    let newest = since;
    let ingested = 0;
    let skipped = 0;
    for (const page of pages) {
      if (page.archived) continue;
      if (since && page.last_edited_time <= since) continue;

      const title = extractTitle(page);
      const notionRef = page.id.replace(/-/g, ""); // 32 hex chars, globally unique
      // Use the full 32-char id as suffix. 8 chars collided (UUID v1-ish prefixes
      // are shared within a DB); 12 chars still too risky. Full id is bulletproof.
      // Leave the `sources/` prefix to kos-compat-api (kindToDir('source') == 'sources').
      // Supplying it here double-nested files under sources/sources/notion/ pre-fix.
      const slug = `notion/${slugify(title)}-${notionRef}`;
      console.log(`    • ${page.id.slice(0, 8)} ${title.slice(0, 60)}`);
      let pageOk = false;
      if (DRY) {
        ingested++;
        pageOk = true;
      } else {
        try {
          const props = extractProperties(page);
          const blocks = await fetchChildren(page.id);
          const bodyMd = await blocksToMarkdown(blocks);
          const hasBody = bodyMd.trim().length > 0;

          // Skip truly empty pages: no children + no meaningful properties.
          if (!hasBody && props.meaningful_count === 0) {
            skipped++;
            console.log(`      – skip (empty: 0 blocks, 0 props)`);
            pageOk = true; // advance cursor so we don't retry forever
            if (!newest || page.last_edited_time > newest) newest = page.last_edited_time;
            continue;
          }

          // Build markdown with a Properties section (if any) + body blocks.
          const sections: string[] = [];
          const fmHints: string[] = [];
          if (props.notion_date) fmHints.push(`notion_date: '${props.notion_date}'`);
          if (props.notion_status) fmHints.push(`notion_status: ${JSON.stringify(props.notion_status)}`);
          fmHints.push(`notion_url: ${page.url}`);

          // Caller provides no frontmatter → kos-compat-api adds its default one.
          // We embed notion-specific hints as a visible HTML comment so they survive
          // and can be grepped without competing with the default frontmatter.
          sections.push(`<!-- notion-metadata\n${fmHints.join("\n")}\n-->`);
          if (props.body) sections.push(props.body);
          if (hasBody) sections.push(bodyMd);
          const md = sections.join("\n\n");

          await ingest({
            title,
            markdown: md,
            notion_id: notionRef,
            source: `notion:${notionRef}`,
            slug,
          });
          ingested++;
          pageOk = true;
        } catch (e) {
          console.error(`      ✗ ingest failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      // Advance cursor ONLY on success so failed pages get retried next run.
      if (pageOk && (!newest || page.last_edited_time > newest)) newest = page.last_edited_time;
    }
    totalIngested += ingested;
    totalSkipped += skipped;
    console.log(`  ${ingested} ingested, ${skipped} skipped (empty)${DRY ? " (dry)" : ""}`);
    if (!DRY && newest) state[dbId] = { last_edited_time: newest };
  }

  if (!DRY) saveState(state);

  console.log(
    `\nSummary: ${DB_IDS.length} DBs, ${totalSeen} seen, ${totalIngested} ingested, ${totalSkipped} skipped${DRY ? " (dry)" : ""}`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
