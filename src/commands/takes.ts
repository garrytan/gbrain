/**
 * v0.28: `gbrain takes` CLI.
 *
 * Subcommands:
 *   takes <slug>                          — list takes for a page
 *   takes search "<query>" [--who h]       — keyword search across all takes
 *   takes add <slug> ...flags              — append a take (markdown + DB)
 *   takes update <slug> --row N ...flags   — update mutable fields
 *   takes supersede <slug> --row N ...     — strikethrough old + append new
 *   takes resolve <slug> --row N --outcome true|false [--value N --unit u]
 *
 * Markdown is canonical. Every mutate command:
 *   1. acquires the per-page file lock
 *   2. re-reads the .md file
 *   3. applies the edit via takes-fence (upsertTakeRow / supersedeRow)
 *   4. writes the .md file back
 *   5. mirrors to the DB via the engine method
 *   6. releases the lock (auto via withPageLock)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BrainEngine, TakeKind } from '../core/engine.ts';
import {
  parseTakesFence,
  upsertTakeRow,
  supersedeRow,
  type ParsedTake,
} from '../core/takes-fence.ts';
import { withPageLock } from '../core/page-lock.ts';

// --- Helpers ---

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name);
}

async function resolveBrainDir(engine: BrainEngine | null, explicitDir: string | null): Promise<string> {
  if (explicitDir) {
    if (!existsSync(explicitDir)) {
      console.error(`--dir path does not exist: ${explicitDir}`);
      process.exit(1);
    }
    return explicitDir;
  }
  if (engine) {
    const configured = await engine.getConfig('sync.repo_path');
    if (configured && existsSync(configured)) return configured;
  }
  console.error('No brain directory configured. Pass --dir <path> or run `gbrain init` first.');
  process.exit(1);
}

function pageFilePath(brainDir: string, slug: string): string {
  return join(brainDir, `${slug}.md`);
}

function ensureKind(raw: string | undefined): TakeKind {
  if (!raw) {
    console.error('Missing --kind. Expected one of: fact, take, bet, hunch.');
    process.exit(1);
  }
  if (raw !== 'fact' && raw !== 'take' && raw !== 'bet' && raw !== 'hunch') {
    console.error(`Invalid --kind "${raw}". Expected: fact, take, bet, hunch.`);
    process.exit(1);
  }
  return raw;
}

function ensureFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    console.error(`Invalid weight "${raw}". Expected a number 0..1.`);
    process.exit(1);
  }
  return n;
}

async function getPageId(engine: BrainEngine, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (!rows[0]) {
    console.error(`Page not found in brain: ${slug}. Run \`gbrain sync\` first.`);
    process.exit(1);
  }
  return rows[0].id;
}

function readBodyOrEmpty(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

function writeBody(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

// --- Subcommands ---

async function cmdList(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: gbrain takes <slug> [--json]');
    process.exit(1);
  }
  const json = flagPresent(args, '--json');
  const holder = flagValue(args, '--who');
  const kind = flagValue(args, '--kind') as TakeKind | undefined;
  const sort = flagValue(args, '--sort') as 'weight' | 'since_date' | 'created_at' | undefined;
  const expired = flagPresent(args, '--expired');

  const takes = await engine.listTakes({
    page_slug: slug,
    holder,
    kind,
    active: expired ? false : true,
    sortBy: sort,
  });

  if (json) {
    console.log(JSON.stringify(takes, null, 2));
    return;
  }

  if (takes.length === 0) {
    console.log(`No takes on ${slug}.`);
    return;
  }
  console.log(`# Takes on ${slug}\n`);
  for (const t of takes) {
    const tag = t.active ? '' : ' [superseded]';
    const w = Number(t.weight).toFixed(2);
    const since = t.since_date ?? '';
    const src = t.source ? ` — ${t.source}` : '';
    console.log(`#${t.row_num} [${t.kind} • ${t.holder} • w=${w}${since ? ` • ${since}` : ''}]${tag}\n  ${t.claim}${src}\n`);
  }
}

async function cmdSearch(engine: BrainEngine, args: string[]): Promise<void> {
  const query = args[0];
  if (!query) {
    console.error('Usage: gbrain takes search "<query>" [--who h] [--json]');
    process.exit(1);
  }
  const json = flagPresent(args, '--json');
  const limit = parseInt(flagValue(args, '--limit') ?? '30', 10);
  const hits = await engine.searchTakes(query, { limit });
  if (json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(`No takes match "${query}".`);
    return;
  }
  for (const h of hits) {
    const score = Number(h.score).toFixed(2);
    console.log(`${h.page_slug}#${h.row_num} [${h.kind} • ${h.holder} • w=${Number(h.weight).toFixed(2)} • s=${score}]\n  ${h.claim}\n`);
  }
}

async function cmdAdd(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  if (!slug) {
    console.error('Usage: gbrain takes add <slug> --claim "..." --kind <k> --who <h> [--weight 0.5] [--source "..."] [--since YYYY-MM]');
    process.exit(1);
  }
  const claim = flagValue(args, '--claim');
  if (!claim) { console.error('Missing --claim'); process.exit(1); }
  const kind = ensureKind(flagValue(args, '--kind'));
  const holder = flagValue(args, '--who');
  if (!holder) { console.error('Missing --who'); process.exit(1); }
  const weight = ensureFloat(flagValue(args, '--weight'), 0.5);
  const source = flagValue(args, '--source');
  const since = flagValue(args, '--since');
  const dirArg = flagValue(args, '--dir');
  const brainDir = await resolveBrainDir(engine, dirArg ?? null);

  await withPageLock(slug, async () => {
    const path = pageFilePath(brainDir, slug);
    const body = readBodyOrEmpty(path);
    const { body: nextBody, rowNum } = upsertTakeRow(body, {
      claim, kind, holder, weight, source, sinceDate: since, active: true,
    });
    writeBody(path, nextBody);

    // Mirror to DB. Page may not be in DB yet if not synced — caller must run sync first.
    const pageId = await getPageId(engine, slug);
    await engine.addTakesBatch([{
      page_id: pageId, row_num: rowNum, claim, kind, holder, weight,
      since_date: since, source, active: true, superseded_by: null,
    }]);
    console.log(`Added take #${rowNum} to ${slug}.`);
  });
}

async function cmdUpdate(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  const rowNumStr = flagValue(args, '--row');
  if (!slug || !rowNumStr) {
    console.error('Usage: gbrain takes update <slug> --row N [--weight 0.7] [--source "..."] [--since YYYY-MM]');
    process.exit(1);
  }
  const rowNum = parseInt(rowNumStr, 10);
  const fields: { weight?: number; source?: string; since_date?: string } = {};
  const w = flagValue(args, '--weight');
  if (w !== undefined) fields.weight = ensureFloat(w, 0.5);
  const s = flagValue(args, '--source');
  if (s !== undefined) fields.source = s;
  const since = flagValue(args, '--since');
  if (since !== undefined) fields.since_date = since;
  const dirArg = flagValue(args, '--dir');
  const brainDir = await resolveBrainDir(engine, dirArg ?? null);

  await withPageLock(slug, async () => {
    const pageId = await getPageId(engine, slug);
    await engine.updateTake(pageId, rowNum, fields);

    // Sync the markdown table: read fence, find row, apply field updates, re-render.
    const path = pageFilePath(brainDir, slug);
    const body = readBodyOrEmpty(path);
    const parsed = parseTakesFence(body);
    const target = parsed.takes.find(t => t.rowNum === rowNum);
    if (!target) {
      console.warn(`[takes update] DB updated but row #${rowNum} not in markdown fence on disk; markdown may be out of sync. Run 'gbrain extract takes --slugs ${slug}' to reconcile.`);
      return;
    }
    const updated: ParsedTake = {
      ...target,
      weight: fields.weight ?? target.weight,
      source: fields.source ?? target.source,
      sinceDate: fields.since_date ?? target.sinceDate,
    };
    // Replace the row in-place by stripping the fence and re-rendering all rows.
    const allRows = parsed.takes.map(t => t.rowNum === rowNum ? updated : t);
    // Round-trip via upsertTakeRow with no new row: easiest is to render manually.
    const { renderTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } = await import('../core/takes-fence.ts');
    const newFence = renderTakesFence(allRows);
    const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
    const endIdx = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
    const out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
    writeBody(path, out);
    console.log(`Updated take #${rowNum} on ${slug}.`);
  });
}

async function cmdSupersede(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  const rowNumStr = flagValue(args, '--row');
  if (!slug || !rowNumStr) {
    console.error('Usage: gbrain takes supersede <slug> --row N --claim "..." [--kind k] [--who h] [--weight 0.5] [--source "..."]');
    process.exit(1);
  }
  const rowNum = parseInt(rowNumStr, 10);
  const claim = flagValue(args, '--claim');
  if (!claim) { console.error('Missing --claim'); process.exit(1); }
  const dirArg = flagValue(args, '--dir');
  const brainDir = await resolveBrainDir(engine, dirArg ?? null);

  await withPageLock(slug, async () => {
    const pageId = await getPageId(engine, slug);

    // Read existing row to inherit kind/holder unless overridden
    const existing = await engine.listTakes({ page_id: pageId, active: false, limit: 500 });
    const target = existing.find(t => t.row_num === rowNum);
    if (!target) {
      console.error(`Row #${rowNum} not found on ${slug}.`);
      process.exit(1);
    }
    const kind = ensureKind(flagValue(args, '--kind') ?? target.kind);
    const holder = flagValue(args, '--who') ?? target.holder;
    const weight = ensureFloat(flagValue(args, '--weight'), Math.max(0, target.weight - 0.1));
    const source = flagValue(args, '--source');
    const since = flagValue(args, '--since');

    const dbResult = await engine.supersedeTake(pageId, rowNum, {
      claim, kind, holder, weight, source, since_date: since, active: true,
    });

    // Mirror in markdown
    const path = pageFilePath(brainDir, slug);
    const body = readBodyOrEmpty(path);
    if (parseTakesFence(body).takes.find(t => t.rowNum === rowNum)) {
      const { body: nextBody } = supersedeRow(body, rowNum, {
        claim, kind, holder, weight, source, sinceDate: since,
      });
      writeBody(path, nextBody);
    } else {
      console.warn(`[takes supersede] DB updated but markdown lacks row #${rowNum}; only DB written.`);
    }
    console.log(`Superseded #${dbResult.oldRow} → new #${dbResult.newRow} on ${slug}.`);
  });
}

async function cmdResolve(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args[0];
  const rowNumStr = flagValue(args, '--row');
  const outcomeStr = flagValue(args, '--outcome');
  if (!slug || !rowNumStr || !outcomeStr) {
    console.error('Usage: gbrain takes resolve <slug> --row N --outcome true|false [--value N --unit usd|pct|count] [--source "..."] [--by <slug>]');
    process.exit(1);
  }
  const rowNum = parseInt(rowNumStr, 10);
  const outcome = outcomeStr === 'true';
  const valueStr = flagValue(args, '--value');
  const value = valueStr === undefined ? undefined : parseFloat(valueStr);
  const unit = flagValue(args, '--unit');
  const source = flagValue(args, '--source');
  const resolvedBy = flagValue(args, '--by') ?? 'garry';

  const pageId = await getPageId(engine, slug);
  await engine.resolveTake(pageId, rowNum, {
    outcome,
    value,
    unit,
    source,
    resolvedBy,
  });
  console.log(`Resolved take #${rowNum} on ${slug}: outcome=${outcome}${valueStr ? ` value=${value}${unit ? ` ${unit}` : ''}` : ''}.`);
  console.log(`(Markdown rendering of resolution metadata: deferred to v0.29 — DB stores it; takes-fence renderer doesn't yet surface resolved_* in the table.)`);
}

// --- Dispatcher ---

export async function runTakes(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain takes <subcommand> [options]

Subcommands:
  takes <slug> [--json] [--who h] [--kind k] [--sort weight|since_date|created_at] [--expired]
                                          List takes for a page
  takes search "<query>" [--limit N] [--json]
                                          Keyword search across all takes
  takes add <slug> --claim "..." --kind <fact|take|bet|hunch> --who <holder>
                   [--weight 0.5] [--source "..."] [--since YYYY-MM]
                                          Append a take (markdown + DB)
  takes update <slug> --row N [--weight 0.7] [--source "..."] [--since YYYY-MM]
                                          Update mutable fields
  takes supersede <slug> --row N --claim "..." [--kind k] [--who h] [--weight 0.5] [--source "..."]
                                          Strikethrough old + append new
  takes resolve <slug> --row N --outcome true|false [--value N --unit usd|pct|count] [--source "..."] [--by <slug>]
                                          Record bet resolution (immutable)

Common flags:
  --dir <path>    Override the brain directory (default: sync.repo_path config)
  --help, -h      Show this help
`);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'search':    return cmdSearch(engine, rest);
    case 'add':       return cmdAdd(engine, rest);
    case 'update':    return cmdUpdate(engine, rest);
    case 'supersede': return cmdSupersede(engine, rest);
    case 'resolve':   return cmdResolve(engine, rest);
    default:
      // No subcommand keyword → treat first arg as <slug> for the list path.
      return cmdList(engine, args);
  }
}
