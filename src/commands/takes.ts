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
  const qualityStr = flagValue(args, '--quality');
  const outcomeStr = flagValue(args, '--outcome');
  if (!slug || !rowNumStr || (!qualityStr && !outcomeStr)) {
    console.error('Usage: gbrain takes resolve <slug> --row N --quality correct|incorrect|partial [--evidence "..."] [--value N --unit usd|pct|count] [--by <slug>]');
    console.error('       (back-compat) gbrain takes resolve <slug> --row N --outcome true|false [...]');
    process.exit(1);
  }
  if (qualityStr && outcomeStr) {
    console.error('Error: --quality and --outcome are mutually exclusive (choose one).');
    process.exit(1);
  }
  const rowNum = parseInt(rowNumStr, 10);

  // v0.30.0: --quality is the new primary input. --outcome stays as a back-compat
  // alias auto-mapping true→correct / false→incorrect; cannot express partial.
  let quality: 'correct' | 'incorrect' | 'partial' | undefined;
  let outcome: boolean | undefined;
  if (qualityStr) {
    if (qualityStr !== 'correct' && qualityStr !== 'incorrect' && qualityStr !== 'partial') {
      console.error(`Invalid --quality "${qualityStr}". Expected: correct, incorrect, partial.`);
      process.exit(1);
    }
    quality = qualityStr;
  } else if (outcomeStr) {
    if (outcomeStr !== 'true' && outcomeStr !== 'false') {
      console.error(`Invalid --outcome "${outcomeStr}". Expected: true or false.`);
      process.exit(1);
    }
    outcome = outcomeStr === 'true';
    console.error('[deprecated] --outcome is the v0.28 alias for --quality. Prefer --quality correct|incorrect|partial in new scripts.');
  }

  const valueStr = flagValue(args, '--value');
  const value = valueStr === undefined ? undefined : parseFloat(valueStr);
  const unit = flagValue(args, '--unit');
  // --evidence is the v0.30.0 alias for --source on the resolve subcommand
  // (semantic clarity: "what evidence resolved this bet?").
  const source = flagValue(args, '--evidence') ?? flagValue(args, '--source');
  const resolvedBy = flagValue(args, '--by') ?? 'garry';
  const dirArg = flagValue(args, '--dir');

  const pageId = await getPageId(engine, slug);
  await engine.resolveTake(pageId, rowNum, {
    quality,
    outcome,
    value,
    unit,
    source,
    resolvedBy,
  });

  // Mirror resolution into the markdown fence so the page is self-describing.
  // The renderer conditionally widens the table to 13 columns when at least one
  // row has resolution data; pages with no resolved rows keep the 7-col shape.
  // Round-trip via parseTakesFence + renderTakesFence preserves all rows.
  const brainDir = await resolveBrainDir(engine, dirArg ?? null);
  await withPageLock(slug, async () => {
    const path = pageFilePath(brainDir, slug);
    const body = readBodyOrEmpty(path);
    if (!body) {
      console.warn(`[takes resolve] markdown file not found at ${path}; DB updated but on-disk page absent.`);
      return;
    }
    const { parseTakesFence, renderTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END } = await import('../core/takes-fence.ts');
    const parsed = parseTakesFence(body);
    const target = parsed.takes.find(t => t.rowNum === rowNum);
    if (!target) {
      console.warn(`[takes resolve] DB updated but row #${rowNum} not in markdown fence; run 'gbrain extract takes --slugs ${slug}' to reconcile.`);
      return;
    }
    // Derive resolved fields from the inputs. Mirror the engine semantics:
    // quality wins when both set; partial → outcome=null.
    const finalQuality = quality ?? (outcome === true ? 'correct' : outcome === false ? 'incorrect' : undefined);
    if (!finalQuality) return; // unreachable — covered by earlier validation
    const finalOutcome = finalQuality === 'partial' ? undefined
                       : finalQuality === 'correct' ? true : false;
    const updated = {
      ...target,
      resolvedAt: new Date().toISOString().slice(0, 10),
      resolvedQuality: finalQuality,
      resolvedOutcome: finalOutcome,
      resolvedEvidence: source,
      resolvedValue: value,
      resolvedUnit: unit,
      resolvedBy,
    };
    const allRows = parsed.takes.map(t => t.rowNum === rowNum ? updated : t);
    const newFence = renderTakesFence(allRows);
    const beginIdx = body.indexOf(TAKES_FENCE_BEGIN);
    const endIdx = body.indexOf(TAKES_FENCE_END, beginIdx + TAKES_FENCE_BEGIN.length);
    const out = body.slice(0, beginIdx) + newFence + body.slice(endIdx + TAKES_FENCE_END.length);
    writeBody(path, out);
  });

  const finalQuality = quality ?? (outcome === true ? 'correct' : outcome === false ? 'incorrect' : 'unknown');
  const valueSummary = valueStr ? ` value=${value}${unit ? ` ${unit}` : ''}` : '';
  console.log(`Resolved take #${rowNum} on ${slug}: quality=${finalQuality}${valueSummary}.`);
}

/**
 * v0.30.0: aggregate calibration scorecard for a holder.
 *
 * Brier scope (D5+D11): partial bets are excluded from Brier — partial
 * isn't a binary outcome to compare a probability against. The partial_rate
 * counter reports the rate as a separate signal so hedging behavior stays
 * visible even though it doesn't enter the calibration math. When the rate
 * exceeds 20% the CLI prints a warning line; calibration on a hedge-heavy
 * scorecard is artificially clean, and the user should know.
 */
async function cmdScorecard(engine: BrainEngine, args: string[]): Promise<void> {
  const json = flagPresent(args, '--json');
  const holder = args[0] && !args[0].startsWith('--') ? args[0] : flagValue(args, '--holder');
  const domainPrefix = flagValue(args, '--domain');
  const since = flagValue(args, '--since');
  const until = flagValue(args, '--until');
  const { PARTIAL_RATE_WARNING_THRESHOLD } = await import('../core/takes-resolution.ts');

  const card = await engine.getScorecard(
    { holder, domainPrefix, since, until },
    /* allowList */ undefined, // CLI is local + trusted; MCP path threads allowList from the caller
  );

  if (json) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  if (card.resolved === 0) {
    console.log(`No resolved bets yet${holder ? ` for ${holder}` : ''}.`);
    return;
  }
  const fmt = (n: number | null, digits = 3) => n === null ? '—' : n.toFixed(digits);
  console.log(`# Scorecard${holder ? ` — ${holder}` : ''}`);
  if (domainPrefix) console.log(`Scope: domain=${domainPrefix}`);
  if (since || until) console.log(`Window: ${since ?? 'all'} → ${until ?? 'now'}`);
  console.log('');
  console.log(`  total bets:    ${card.total_bets}`);
  console.log(`  resolved:      ${card.resolved}`);
  console.log(`  correct:       ${card.correct}`);
  console.log(`  incorrect:     ${card.incorrect}`);
  console.log(`  partial:       ${card.partial}`);
  console.log(`  accuracy:      ${fmt(card.accuracy)}`);
  console.log(`  Brier:         ${fmt(card.brier, 4)}   (correct ∨ incorrect only; lower is better; 0.25 = always-50% baseline)`);
  console.log(`  partial_rate:  ${fmt(card.partial_rate)}`);
  if (card.partial_rate !== null && card.partial_rate > PARTIAL_RATE_WARNING_THRESHOLD) {
    console.log('');
    console.log(`  [!] partial_rate is high (>${(PARTIAL_RATE_WARNING_THRESHOLD * 100).toFixed(0)}%) — calibration may be optimistic.`);
    console.log(`      Hedged bets escape the Brier denominator. Resolve them more decisively if the data supports it.`);
  }
  if (card.resolved < 100) {
    console.log('');
    console.log(`  Note: n=${card.resolved} is small. Brier is noisy below ~100 resolved bets.`);
  }
}

/**
 * v0.30.0: calibration curve. Bins resolved correct+incorrect bets by stated
 * weight and reports observed vs predicted frequency per bucket. The diagonal
 * (observed ≈ predicted in every bucket) is perfect calibration.
 */
async function cmdCalibration(engine: BrainEngine, args: string[]): Promise<void> {
  const json = flagPresent(args, '--json');
  const holder = args[0] && !args[0].startsWith('--') ? args[0] : flagValue(args, '--holder');
  const bucketSizeStr = flagValue(args, '--bucket-size');
  const bucketSize = bucketSizeStr === undefined ? 0.1 : parseFloat(bucketSizeStr);
  if (!Number.isFinite(bucketSize) || bucketSize <= 0 || bucketSize > 1) {
    console.error(`Invalid --bucket-size "${bucketSizeStr}". Expected a number in (0, 1].`);
    process.exit(1);
  }

  const buckets = await engine.getCalibrationCurve(
    { holder, bucketSize },
    /* allowList */ undefined,
  );

  if (json) {
    console.log(JSON.stringify(buckets, null, 2));
    return;
  }

  if (buckets.length === 0) {
    console.log(`No resolved correct/incorrect bets yet${holder ? ` for ${holder}` : ''}.`);
    return;
  }
  console.log(`# Calibration curve${holder ? ` — ${holder}` : ''}`);
  console.log(`Bucket size: ${bucketSize}`);
  console.log('');
  console.log(`  bucket          n     observed  predicted  delta`);
  console.log(`  --------------- ----- --------- ---------- -------`);
  const fmt = (n: number | null) => n === null ? '   —' : n.toFixed(3);
  for (const b of buckets) {
    const range = `${b.bucket_lo.toFixed(2)}-${b.bucket_hi.toFixed(2)}`.padEnd(15);
    const nStr = String(b.n).padStart(5);
    const obs = fmt(b.observed).padStart(9);
    const pred = fmt(b.predicted).padStart(10);
    const delta = b.observed !== null && b.predicted !== null
      ? (b.observed - b.predicted).toFixed(3).padStart(7)
      : '     —';
    console.log(`  ${range} ${nStr} ${obs} ${pred} ${delta}`);
  }
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
  takes resolve <slug> --row N --quality correct|incorrect|partial
                       [--evidence "..."] [--value N --unit usd|pct|count] [--by <slug>]
                                          Record bet resolution (immutable, v0.30.0)
                                          Back-compat: --outcome true|false (deprecated alias)
  takes scorecard [<holder>] [--domain <prefix>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                          Aggregate calibration scorecard (v0.30.0)
  takes calibration [<holder>] [--bucket-size 0.1] [--json]
                                          Calibration curve binned by stated weight (v0.30.0)

Common flags:
  --dir <path>    Override the brain directory (default: sync.repo_path config)
  --help, -h      Show this help
`);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'search':      return cmdSearch(engine, rest);
    case 'add':         return cmdAdd(engine, rest);
    case 'update':      return cmdUpdate(engine, rest);
    case 'supersede':   return cmdSupersede(engine, rest);
    case 'resolve':     return cmdResolve(engine, rest);
    case 'scorecard':   return cmdScorecard(engine, rest);
    case 'calibration': return cmdCalibration(engine, rest);
    case 'revisit':     return cmdRevisit(engine, rest);
    default:
      // No subcommand keyword → treat first arg as <slug> for the list path.
      return cmdList(engine, args);
  }
}

/**
 * v0.36.0.0 (TD4 / D30) — `gbrain takes revisit <slug>` opens $EDITOR on
 * the source page so the user can write a follow-up immediately. The
 * action the admin SPA's "revisit now" link triggers (via a small
 * route handler that dispatches into this CLI command).
 *
 * Inserts a `<!-- gbrain:revisit -->` cursor marker at the bottom of the
 * page body so the editor opens with intent visible.
 */
async function cmdRevisit(_engine: BrainEngine, rest: string[]): Promise<void> {
  const slug = rest[0];
  if (!slug) {
    process.stderr.write('Usage: gbrain takes revisit <slug>\n');
    process.exit(1);
  }
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { loadConfig } = await import('../core/config.ts');
  const cfg = loadConfig();
  const repoPath = (cfg as { sync?: { repo_path?: string } } | null)?.sync?.repo_path;
  if (!repoPath) {
    process.stderr.write('No brain repo configured. Run `gbrain config set sync.repo_path /path/to/brain`.\n');
    process.exit(1);
  }
  const filePath = join(repoPath, `${slug}.md`);
  if (!existsSync(filePath)) {
    process.stderr.write(`Page not found: ${filePath}\n`);
    process.exit(1);
  }
  // Append a cursor marker if not already present.
  const existing = readFileSync(filePath, 'utf8');
  const marker = '\n<!-- gbrain:revisit -->\n';
  if (!existing.includes('<!-- gbrain:revisit -->')) {
    writeFileSync(filePath, existing + marker);
  }
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  process.stderr.write(`Opening ${filePath} in ${editor}...\n`);
  // Use spawnSync with stdio:'inherit' so the editor takes the terminal.
  const result = spawnSync(editor, [filePath], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`Editor exited with status ${result.status ?? 'unknown'}\n`);
  }
  void execFileSync;
}
