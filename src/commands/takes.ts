/**
 * v0.28: `gbrain takes` CLI.
 *
 * Subcommands:
 *   takes <slug>                          — list takes for a page
 *   takes list                            — list all active takes (#2079)
 *   takes search "<query>" [--who h]       — keyword search across all takes
 *   takes add <slug> ...flags              — append a take (markdown + DB)
 *   takes update <slug> --row N ...flags   — update mutable fields
 *   takes supersede <slug> --row N ...     — strikethrough old + append new
 *   takes resolve <slug> --row N --outcome true|false [--value N --unit u]
 *
 * Markdown is canonical. Every mutate command routes through the shared
 * write-through core (src/core/takes-write.ts — also the takes_* MCP ops'
 * backend): lock → resolve page → fence edit → write .md → DB mirror. This
 * file owns arg parsing + rendering + exit codes only.
 */

import { existsSync } from 'node:fs';
import type { BrainEngine, TakeKind } from '../core/engine.ts';
import {
  addTakeToPage,
  updateTakeOnPage,
  supersedeTakeOnPage,
  resolveTakeOnPage,
  TakesWriteError,
} from '../core/takes-write.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { resolveOwnerHolder } from '../core/owner-holder.ts';
import { embedStaleTakes } from '../core/embed-takes.ts';
import { assertEmbeddingEnabled } from '../core/embedding-dim-check.ts';
import { loadConfig } from '../core/config.ts';
import { embedQuery } from '../core/embedding.ts';
import {
  listPendingProposals,
  acceptProposal,
  rejectProposal,
  TakeProposalError,
} from '../core/take-proposals.ts';

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

/**
 * Map a TakesWriteError to the historical CLI error surface (stderr + exit 1).
 * Message text preserves the pre-extraction wording users and scripts saw.
 */
function exitTakesError(err: unknown): never {
  if (err instanceof TakesWriteError) {
    switch (err.code) {
      case 'page_not_found':
        console.error(`${err.message} Run \`gbrain sync\` first.`);
        process.exit(1);
      default:
        console.error(err.hint && err.code !== 'holder_denied' ? `${err.message} ${err.hint}` : err.message);
        process.exit(1);
    }
  }
  throw err;
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

// Fail-closed (#2698 residual, TODOS.md): `resolveSourceId` only ever
// throws when a source WAS explicitly in play — an invalid or
// unregistered `GBRAIN_SOURCE`, a `.gbrain-source` dotfile pointing at a
// source that doesn't exist, or a genuine DB error — never for "nothing
// configured" (that path resolves cleanly to the seeded `'default'`
// source, tier 6 of resolveSourceId). Swallowing those errors here used
// to fall back to the unscoped slug-only page lookup, silently
// reintroducing the pre-#2698 cross-source write bug whenever resolution
// merely errored instead of resolving cleanly. Let it propagate so the
// write is blocked instead of silently unscoped.
async function resolveTakesSourceId(engine: BrainEngine): Promise<string> {
  return resolveSourceId(engine, null);
}

// --- Subcommands ---

async function cmdList(engine: BrainEngine, args: string[]): Promise<void> {
  // #2079: slug is optional. `gbrain takes list` (no slug) lists ALL active
  // takes — CLI parity with the takes_list operation. A leading flag is not
  // a slug.
  const slug = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const json = flagPresent(args, '--json');
  const holder = flagValue(args, '--who');
  const kind = flagValue(args, '--kind') as string | undefined;
  const sort = flagValue(args, '--sort') as 'weight' | 'since_date' | 'created_at' | undefined;
  const expired = flagPresent(args, '--expired');
  // #4629: --limit/--offset were documented on the takes_list op but never
  // parsed by the CLI — every `takes list` call silently used the engine
  // defaults. The engine clamps limit (default 100, cap 500) and floors
  // offset at 0; the CLI just validates the raw values are integers.
  // Whole-string digit pre-check: parseInt('12abc') === 12 would otherwise
  // slip trailing garbage through as a silently-truncated value (and
  // '1e3' would become 1). Same full-string discipline as cmdPropose's
  // parseId; the error copy stays identical to the numeric guards below.
  const limitRaw = flagValue(args, '--limit');
  if (limitRaw !== undefined && !/^\d+$/.test(limitRaw.trim())) {
    console.error(`Invalid --limit "${limitRaw}". Expected a positive integer.`);
    process.exit(1);
  }
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`Invalid --limit "${limitRaw}". Expected a positive integer.`);
    process.exit(1);
  }
  const offsetRaw = flagValue(args, '--offset');
  if (offsetRaw !== undefined && !/^\d+$/.test(offsetRaw.trim())) {
    console.error(`Invalid --offset "${offsetRaw}". Expected a non-negative integer.`);
    process.exit(1);
  }
  const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : undefined;
  if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
    console.error(`Invalid --offset "${offsetRaw}". Expected a non-negative integer.`);
    process.exit(1);
  }

  const takes = await engine.listTakes({
    page_slug: slug,
    holder,
    kind,
    active: expired ? false : true,
    sortBy: sort,
    limit,
    offset,
  });

  if (json) {
    console.log(JSON.stringify(takes, null, 2));
    return;
  }

  const scope = slug ?? 'this brain';
  if (takes.length === 0) {
    console.log(`No takes on ${scope}.`);
    return;
  }
  console.log(`# Takes on ${scope}\n`);
  for (const t of takes) {
    const tag = t.active ? '' : ' [superseded]';
    const w = Number(t.weight).toFixed(2);
    const since = t.since_date ?? '';
    const src = t.source ? ` — ${t.source}` : '';
    const where = slug ? '' : `${t.page_slug} `;
    console.log(`${where}#${t.row_num} [${t.kind} • ${t.holder} • w=${w}${since ? ` • ${since}` : ''}]${tag}\n  ${t.claim}${src}\n`);
  }
}

async function cmdSearch(engine: BrainEngine, args: string[]): Promise<void> {
  const query = args[0];
  if (!query) {
    console.error('Usage: gbrain takes search "<query>" [--semantic] [--limit N] [--json]');
    process.exit(1);
  }
  const json = flagPresent(args, '--json');
  const semantic = flagPresent(args, '--semantic');
  const limit = parseInt(flagValue(args, '--limit') ?? '30', 10);
  let hits;
  if (semantic) {
    assertEmbeddingEnabled(loadConfig());
    const { validateEmbeddingCreds } = await import('../core/embed-preflight.ts');
    validateEmbeddingCreds();
    const queryEmbedding = await embedQuery(query);
    hits = await engine.searchTakesVector(queryEmbedding, { limit });
  } else {
    hits = await engine.searchTakes(query, { limit });
  }
  if (json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(`No ${semantic ? 'semantic ' : ''}takes match "${query}".`);
    return;
  }
  for (const h of hits) {
    const score = Number(h.score).toFixed(2);
    console.log(`${h.page_slug}#${h.row_num} [${h.kind} • ${h.holder} • w=${Number(h.weight).toFixed(2)} • s=${score}]\n  ${h.claim}\n`);
  }
}

async function cmdEmbed(engine: BrainEngine, args: string[]): Promise<void> {
  const dryRun = flagPresent(args, '--dry-run');
  const json = flagPresent(args, '--json');
  const batchSizeRaw = flagValue(args, '--batch-size');
  const batchSize = batchSizeRaw === undefined ? undefined : Number.parseInt(batchSizeRaw, 10);
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    console.error(`Invalid --batch-size "${batchSizeRaw}". Expected a positive integer.`);
    process.exit(1);
  }

  if (!dryRun) {
    assertEmbeddingEnabled(loadConfig());
    const { validateEmbeddingCreds } = await import('../core/embed-preflight.ts');
    validateEmbeddingCreds();
  }

  const result = await embedStaleTakes(engine, { batchSize, dryRun });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (dryRun) {
    console.log(`[dry-run] Would embed ${result.would_embed} active take(s)`);
  } else {
    console.log(`Embedded ${result.embedded} take(s); ${result.total_stale - result.embedded} remain stale.`);
    if (result.failures > 0) {
      console.error(`Failed to embed ${result.failures} take(s): ${result.failure_samples[0] ?? 'unknown error'}`);
    }
  }
  if (result.failures > 0) {
    throw new Error(`takes embedding failed for ${result.failures} take(s)`);
  }
}

async function cmdAdd(engine: BrainEngine, args: string[], sourceId?: string): Promise<void> {
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

  try {
    const { rowNum } = await addTakeToPage(
      { engine, slug, brainDir, sourceId },
      { claim, kind, holder, weight, source, sinceDate: since },
    );
    console.log(`Added take #${rowNum} to ${slug}.`);
  } catch (err) {
    exitTakesError(err);
  }
}

async function cmdUpdate(engine: BrainEngine, args: string[], sourceId?: string): Promise<void> {
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

  // v0.46.x (EV1): markdown is canonical, so a row missing from the on-disk
  // fence now REFUSES the whole write instead of the old DB-update-then-warn
  // path — that path was self-defeating (its own reconcile hint, extract
  // takes, would clobber the DB-only update it had just written).
  try {
    await updateTakeOnPage(
      { engine, slug, brainDir, sourceId },
      rowNum,
      { weight: fields.weight, source: fields.source, sinceDate: fields.since_date },
    );
    console.log(`Updated take #${rowNum} on ${slug}.`);
  } catch (err) {
    exitTakesError(err);
  }
}

async function cmdSupersede(engine: BrainEngine, args: string[], sourceId?: string): Promise<void> {
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

  // v0.46.x (EV1): fence-first — kind/holder inherit from the MARKDOWN row
  // (canonical), the fence assigns the new row number, and a row absent from
  // the on-disk fence refuses instead of the old DB-only write.
  const kindArg = flagValue(args, '--kind');
  try {
    const result = await supersedeTakeOnPage(
      { engine, slug, brainDir, sourceId },
      rowNum,
      {
        claim,
        kind: kindArg !== undefined ? ensureKind(kindArg) : undefined,
        holder: flagValue(args, '--who'),
        weight: flagValue(args, '--weight') !== undefined
          ? ensureFloat(flagValue(args, '--weight'), 0.5)
          : undefined,
        source: flagValue(args, '--source'),
        sinceDate: flagValue(args, '--since'),
      },
    );
    console.log(`Superseded #${result.oldRow} → new #${result.newRow} on ${slug}.`);
  } catch (err) {
    exitTakesError(err);
  }
}

async function cmdResolve(engine: BrainEngine, args: string[], sourceId?: string): Promise<void> {
  const slug = args[0];
  const rowNumStr = flagValue(args, '--row');
  const qualityStr = flagValue(args, '--quality');
  const outcomeStr = flagValue(args, '--outcome');
  if (!slug || !rowNumStr || (!qualityStr && !outcomeStr)) {
    console.error('Usage: gbrain takes resolve <slug> --row N --quality correct|incorrect|partial|unresolvable [--evidence "..."] [--value N --unit usd|pct|count] [--by <slug>]');
    console.error('       (back-compat) gbrain takes resolve <slug> --row N --outcome true|false [...]');
    process.exit(1);
  }
  if (qualityStr && outcomeStr) {
    console.error('Error: --quality and --outcome are mutually exclusive (choose one).');
    process.exit(1);
  }
  const rowNum = parseInt(rowNumStr, 10);

  // v0.30.0: --quality is the new primary input. --outcome stays as a back-compat
  // alias auto-mapping true→correct / false→incorrect; cannot express partial
  // or unresolvable (v0.36.1.1).
  let quality: 'correct' | 'incorrect' | 'partial' | 'unresolvable' | undefined;
  let outcome: boolean | undefined;
  if (qualityStr) {
    if (qualityStr !== 'correct' && qualityStr !== 'incorrect' && qualityStr !== 'partial' && qualityStr !== 'unresolvable') {
      console.error(`Invalid --quality "${qualityStr}". Expected: correct, incorrect, partial, unresolvable.`);
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
  const resolvedBy = flagValue(args, '--by') ?? resolveOwnerHolder({ configValue: await engine.getConfig('emotional_weight.user_holder') });
  const dirArg = flagValue(args, '--dir');
  const brainDir = await resolveBrainDir(engine, dirArg ?? null);

  // Back-compat --outcome maps onto quality; the shared core takes quality only.
  const finalQuality = quality ?? (outcome === true ? 'correct' : 'incorrect');

  // v0.46.x (EV1): markdown is canonical — the fence row must exist on disk
  // (the old path resolved the DB first and warned when the fence lacked the
  // row, leaving a resolution the next reconcile couldn't see).
  try {
    await resolveTakeOnPage(
      { engine, slug, brainDir, sourceId },
      rowNum,
      { quality: finalQuality, evidence: source, value, unit, resolvedBy },
    );
  } catch (err) {
    exitTakesError(err);
  }

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

  // v0.37.2.0: don't hide the unresolvable signal. A brain with only unresolvable
  // verdicts still has a story to tell — "your judge tried but couldn't decide" —
  // and the spec's whole headline ("50% of your tech calls land unresolvable")
  // depends on this output rendering when resolved=0 but unresolvable_count>0.
  const unresolvableCount = card.unresolvable_count ?? 0;
  if (card.resolved === 0 && unresolvableCount === 0) {
    console.log(`No resolved bets yet${holder ? ` for ${holder}` : ''}.`);
    return;
  }
  const fmt = (n: number | null | undefined, digits = 3) =>
    n === null || n === undefined ? '—' : n.toFixed(digits);
  console.log(`# Scorecard${holder ? ` — ${holder}` : ''}`);
  if (domainPrefix) console.log(`Scope: domain=${domainPrefix}`);
  if (since || until) console.log(`Window: ${since ?? 'all'} → ${until ?? 'now'}`);
  console.log('');
  console.log(`  total bets:        ${card.total_bets}`);
  console.log(`  resolved:          ${card.resolved}`);
  console.log(`  correct:           ${card.correct}`);
  console.log(`  incorrect:         ${card.incorrect}`);
  console.log(`  partial:           ${card.partial}`);
  if (unresolvableCount > 0 || card.unresolvable_rate !== undefined) {
    console.log(`  unresolvable:      ${unresolvableCount}`);
  }
  console.log(`  accuracy:          ${fmt(card.accuracy)}`);
  console.log(`  Brier:             ${fmt(card.brier, 4)}   (correct ∨ incorrect only; lower is better; 0.25 = always-50% baseline)`);
  console.log(`  partial_rate:      ${fmt(card.partial_rate)}`);
  if (unresolvableCount > 0 || card.unresolvable_rate !== undefined && card.unresolvable_rate !== null) {
    console.log(`  unresolvable_rate: ${fmt(card.unresolvable_rate)}   (unresolvable / (resolved + unresolvable); high = weak evidence retrieval)`);
  }
  if (card.partial_rate !== null && card.partial_rate > PARTIAL_RATE_WARNING_THRESHOLD) {
    console.log('');
    console.log(`  [!] partial_rate is high (>${(PARTIAL_RATE_WARNING_THRESHOLD * 100).toFixed(0)}%) — calibration may be optimistic.`);
    console.log(`      Hedged bets escape the Brier denominator. Resolve them more decisively if the data supports it.`);
  }
  if (card.unresolvable_rate !== null && card.unresolvable_rate !== undefined && card.unresolvable_rate > 0.30) {
    console.log('');
    console.log(`  [!] unresolvable_rate is high (>${(0.30 * 100).toFixed(0)}%) — most grade attempts are running into evidence gaps.`);
    console.log(`      The judge is working; retrieval isn't producing enough context to decide. Look at evidence-retrieval coverage, not prediction accuracy.`);
  }
  if (card.resolved < 100 && card.resolved > 0) {
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

/**
 * #2411 / #4102 — `gbrain takes propose` drains the take_proposals queue the
 * propose_takes cycle phase fills. Bare invocation lists pending proposals;
 * --accept promotes one into the page's takes fence via the shared
 * write-through core (D17: the ONLY queue→canonical path); --reject dismisses.
 * Before this command existed the dispatcher parsed `propose` as a page slug
 * and printed "No takes on propose." with exit 0 — a dead-end queue.
 */
async function cmdPropose(engine: BrainEngine, args: string[], sourceId: string): Promise<void> {
  const json = flagPresent(args, '--json');
  const acceptRaw = flagValue(args, '--accept');
  const rejectRaw = flagValue(args, '--reject');
  if (acceptRaw !== undefined && rejectRaw !== undefined) {
    console.error('Error: --accept and --reject are mutually exclusive (choose one).');
    process.exit(1);
  }

  const parseId = (raw: string, flag: string): number => {
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0 || String(id) !== raw.trim()) {
      console.error(`Invalid ${flag} "${raw}". Expected a proposal id (from \`gbrain takes propose\`).`);
      process.exit(1);
    }
    return id;
  };

  const actedBy = resolveOwnerHolder({
    configValue: await engine.getConfig('emotional_weight.user_holder'),
  });

  if (acceptRaw !== undefined) {
    const id = parseId(acceptRaw, '--accept');
    const dirArg = flagValue(args, '--dir');
    const brainDir = await resolveBrainDir(engine, dirArg ?? null);
    try {
      const { proposal, rowNum } = await acceptProposal({ engine, brainDir, sourceId, actedBy }, id);
      console.log(`Accepted proposal #${id} → take #${rowNum} on ${proposal.page_slug}.`);
    } catch (err) {
      if (err instanceof TakeProposalError) {
        console.error(err.message);
        process.exit(1);
      }
      exitTakesError(err);
    }
    return;
  }

  if (rejectRaw !== undefined) {
    const id = parseId(rejectRaw, '--reject');
    try {
      const proposal = await rejectProposal({ engine, sourceId, actedBy }, id);
      console.log(`Rejected proposal #${id} (${proposal.page_slug}).`);
    } catch (err) {
      if (err instanceof TakeProposalError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  // Bare `takes propose` — list the pending queue (source-scoped).
  const limitRaw = flagValue(args, '--limit');
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`Invalid --limit "${limitRaw}". Expected a positive integer.`);
    process.exit(1);
  }
  const pending = await listPendingProposals(engine, { sourceId, limit });
  if (json) {
    console.log(JSON.stringify(pending, null, 2));
    return;
  }
  if (pending.length === 0) {
    console.log('No pending take proposals. The propose_takes cycle phase fills this queue.');
    return;
  }
  console.log(`# Pending take proposals (${pending.length})\n`);
  for (const p of pending) {
    const w = Number(p.weight).toFixed(2);
    const domain = p.domain ? ` • ${p.domain}` : '';
    console.log(`#${p.id} ${p.page_slug} [${p.kind} • ${p.holder} • w=${w}${domain}]\n  ${p.claim_text}\n`);
  }
  console.log('Accept with `gbrain takes propose --accept <id>`; reject with `--reject <id>`.');
}

// --- Dispatcher ---

export async function runTakes(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain takes <subcommand> [options]

Subcommands:
  takes <slug> [--json] [--who h] [--kind k] [--sort weight|since_date|created_at] [--expired]
                                          List takes for a page
  takes list [--json] [--who h] [--kind k] [--sort ...] [--expired] [--limit N] [--offset N]
                                          List all active takes across the brain (#2079)
  takes search "<query>" [--semantic] [--limit N] [--json]
                                          Keyword search, or semantic search with --semantic
  takes embed [--dry-run] [--batch-size N] [--json]
                                          Embed active takes for semantic think/search retrieval (#2089)
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
  takes propose [--limit N] [--json]      List pending LLM-proposed takes (propose_takes queue)
  takes propose --accept <id> [--dir <path>]
                                          Promote a proposal into the page's takes fence
  takes propose --reject <id>             Dismiss a proposal
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
    // #2079: `takes list` used to be parsed as page slug "list" and printed
    // "No takes on list." — reading exactly like an empty takes table.
    case 'list':        return cmdList(engine, rest);
    case 'search':      return cmdSearch(engine, rest);
    case 'embed':       return cmdEmbed(engine, rest);
    case 'add':         return cmdAdd(engine, rest, await resolveTakesSourceId(engine));
    case 'update':      return cmdUpdate(engine, rest, await resolveTakesSourceId(engine));
    case 'supersede':   return cmdSupersede(engine, rest, await resolveTakesSourceId(engine));
    case 'resolve':     return cmdResolve(engine, rest, await resolveTakesSourceId(engine));
    // #2411: `takes propose` used to fall through to the slug path and print
    // "No takes on propose." — the LLM proposal queue had no drain surface.
    case 'propose':     return cmdPropose(engine, rest, await resolveTakesSourceId(engine));
    case 'scorecard':   return cmdScorecard(engine, rest);
    case 'calibration': return cmdCalibration(engine, rest);
    case 'revisit':     return cmdRevisit(engine, rest);
    case 'extract':     return cmdExtract(engine, rest);
    default:
      // No subcommand keyword → treat first arg as <slug> for the list path.
      return cmdList(engine, args);
  }
}

/**
 * v0.41.18.0 (A12, A24, T9) — `gbrain takes extract --from-pages` runs
 * Haiku over concept/atom/lore/briefing/writing/originals pages and
 * lifts gradeable claims into the takes fence.
 *
 * Two-gate consent: requires `takes.bootstrap_enabled=true` in config
 * AND explicit --yes flag for any non-dryRun run. Refuses LLM-bearing
 * extraction without both.
 */
async function cmdExtract(engine: BrainEngine, rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub !== '--from-pages') {
    process.stderr.write(
      'Usage: gbrain takes extract --from-pages [--yes] [--dry-run] [--json] [--source-id <id>] [--max-pages N (clamped to 1000)] [--include-covered] [--holder <name>]\n' +
      'Runs progress: pages that already hold takes are skipped, so repeat runs sweep a large corpus in slices. --include-covered rescans everything (refresh).\n',
    );
    process.exit(1);
  }
  const dryRun = rest.includes('--dry-run');
  const json = rest.includes('--json');
  const skipConfirm = rest.includes('--yes');
  const sourceIdx = rest.indexOf('--source-id');
  const sourceIdFilter = sourceIdx >= 0 ? rest[sourceIdx + 1] : undefined;
  const maxIdx = rest.indexOf('--max-pages');
  const maxPagesRaw = maxIdx >= 0 ? rest[maxIdx + 1] : undefined;
  const maxPages = maxPagesRaw ? Math.max(1, Math.min(1000, parseInt(maxPagesRaw, 10) || 50)) : 50;
  const holderIdx = rest.indexOf('--holder');
  const holder = holderIdx >= 0 ? rest[holderIdx + 1] : 'system';
  const includeCovered = rest.includes('--include-covered');

  // A12 consent gate.
  const bootstrapEnabledCfg = await engine.getConfig('takes.bootstrap_enabled');
  const bootstrapEnabled = bootstrapEnabledCfg === 'true' || bootstrapEnabledCfg === '1';
  if (!bootstrapEnabled) {
    process.stderr.write(
      `takes-bootstrap is opt-in. Enable with:\n  gbrain config set takes.bootstrap_enabled true\nThen re-run with --yes.\n`,
    );
    process.exit(2);
  }
  if (!dryRun && !skipConfirm) {
    // Name the model the extraction actually uses (extract-takes-from-pages
    // resolves getChatModel()), not a hardcoded "Haiku" — the gateway may be
    // unconfigured at this consent gate, so resolve defensively.
    let modelLabel = 'the configured chat model';
    try {
      const { getChatModel } = await import('../core/ai/gateway.ts');
      modelLabel = getChatModel();
    } catch {
      // Gateway unconfigured — keep the generic label.
    }
    process.stderr.write(
      `[takes extract] sends concept/atom/lore/briefing/writing/originals page content to ${modelLabel}.\n` +
      `Pass --yes to proceed (or --dry-run to preview).\n`,
    );
    process.exit(1);
  }

  const { extractTakesFromPages } = await import('../core/extract-takes-from-pages.ts');
  const result = await extractTakesFromPages(engine, {
    bootstrapEnabled: true,
    dryRun,
    sourceIdFilter,
    maxPages,
    includeCovered,
    holder,
  });
  if (result.llm_unavailable) {
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stderr.write(`[takes extract] chat gateway unavailable (no API key configured).\n`);
    }
    process.exit(2);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  // #4473: takes are markdown-canonical — pages the fence writer refused are
  // skipped (never written DB-only). Say so instead of silently undercounting.
  if (result.pages_skipped > 0) {
    const reasons = [...new Set(result.skipped.map((s) => s.reason))].join(', ');
    process.stderr.write(
      `[takes extract] ${result.pages_skipped} page(s) skipped (${reasons}) — takes are ` +
      `markdown-canonical; a page with no locatable .md file is not written. ` +
      `Configure sync.repo_path (or the source's local_path) and re-run.\n`,
    );
  }
  process.stdout.write(
    `takes extract --from-pages: ${result.claims_extracted} claim(s) from ${result.pages_scanned} page(s)` +
    (dryRun ? ' (dry-run)' : '') + '\n',
  );
}

/**
 * v0.36.1.0 (TD4 / D30) — `gbrain takes revisit <slug>` opens $EDITOR on
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
