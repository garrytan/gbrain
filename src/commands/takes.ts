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
 *   takes remove <slug> --row N            — remove one row (fence + DB)
 *   takes rebuild <slug> [--source-id id]  — rebuild one page's takes index from its fence
 *
 * Markdown is canonical. The four direct mutation commands use the same
 * durable takes_* operations as MCP, via takes-mutation.ts. This dispatcher
 * retains read/maintenance command parsing and presentation.
 */

import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import type { OperationError } from '../core/ops/contract.ts';
import { usageError } from '../cli/cli-error.ts';
import {
  TakesWriteError,
} from '../core/takes-write.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { resolveOwnerHolder } from '../core/owner-holder.ts';
import { embedStaleTakes } from '../core/embed-takes.ts';
import { assertBrainEmbeddingEnabled } from '../core/embedding-dim-check.ts';
import { loadConfig } from '../core/config.ts';
import { embedQueryWithPrefix } from '../core/search/query-prefix.ts';
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
    await assertBrainEmbeddingEnabled(engine, loadConfig());
    const { validateEmbeddingCreds } = await import('../core/embed-preflight.ts');
    validateEmbeddingCreds();
    const queryEmbedding = await embedQueryWithPrefix(engine, query);
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
    await assertBrainEmbeddingEnabled(engine, loadConfig());
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
  const groupBy = flagValue(args, '--group-by');
  const minNRaw = flagValue(args, '--min-n');
  const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1); };
  if (groupBy !== undefined && groupBy !== 'holder' && groupBy !== 'source') fail('--group-by holder|source groups the scorecard by holder or by source.');
  const minN = minNRaw === undefined ? undefined : Number(minNRaw);
  if (minN !== undefined && !(Number.isSafeInteger(minN) && minN >= 1)) fail('--min-n requires a positive integer, e.g. --min-n 10.');
  const { PARTIAL_RATE_WARNING_THRESHOLD } = await import('../core/takes-resolution.ts');

  const card = await engine.getScorecard(
    { holder, domainPrefix, since, until },
    /* allowList */ undefined, // CLI is local + trusted; MCP path threads allowList from the caller
  );

  // W7: per-holder or per-source rows from the private forecast journal.
  let printGroups = () => {};
  if (groupBy) {
    const { readForecastJournal, scorecardGroups, SCORECARD_DEFAULT_MIN_N } = await import('../core/forecast-journal.ts');
    const sourceId = flagValue(args, '--source-id');
    const query = { ...(sourceId ? { sourceId } : {}), ...(holder ? { holder } : {}), ...(domainPrefix ? { about: domainPrefix } : {}),
      ...(since ? { since } : {}), ...(until ? { until } : {}) };
    const groups = await scorecardGroups(engine, { ...query, groupBy: groupBy as 'holder' | 'source', ...(minN !== undefined ? { minN } : {}) });
    const journal = (await readForecastJournal(engine, { ...query, limit: 0 })).totals;
    if (json) {
      console.log(JSON.stringify({ ...card, groups, journal }, null, 2));
      return;
    }
    const f = (n: number | null, digits = 3) => n === null ? '—' : n.toFixed(digits);
    printGroups = () => {
      console.log('');
      console.log(`## By ${groupBy} (min_n=${minN ?? SCORECARD_DEFAULT_MIN_N}; ${journal.predictions} predictions, ${journal.unresolved} unresolved)`);
      for (const g of groups) {
        const interval = g.accuracy_wilson95 ? `[${f(g.accuracy_wilson95[0])}, ${f(g.accuracy_wilson95[1])}]` : '—';
        console.log(`  ${g.key}  n=${g.n}  accuracy=${f(g.accuracy)}  shrunk=${f(g.accuracy_shrunk)}  wilson95=${interval}  recent=${f(g.accuracy_recent)}  ` +
          `Brier=${f(g.brier, 4)}  skill=${f(g.brier_skill)}  citations=${g.citations}  unresolved=${g.unresolved} (${g.overdue} overdue)${g.low_n ? '  low_n' : ''}`);
      }
    };
  }

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
    printGroups();
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
  printGroups();
}

/**
 * W6: the review surface for grade_takes. The cycle caches a verdict per take
 * (`take_grade_cache`) and, with auto-resolve off, applies none; this lists
 * the newest verdict per take so the owner can review them, marking verdicts
 * whose judge model and prompt the W6 eval did not measure
 * (`GRADE_TAKES_MEASURED_MODELS`, `GRADE_TAKES_MEASURED_PROMPT_VERSION`).
 * Trusted local only: there is no MCP op, so a thin client refuses it.
 */
async function cmdGrades(engine: BrainEngine, args: string[]): Promise<void> {
  const json = flagPresent(args, '--json');
  const verdict = flagValue(args, '--verdict');
  const minRaw = flagValue(args, '--min-confidence');
  const limitRaw = flagValue(args, '--limit');
  const applied = flagPresent(args, '--applied');
  const unapplied = flagPresent(args, '--unapplied');
  if (verdict !== undefined && !['correct', 'incorrect', 'partial', 'unresolvable'].includes(verdict)) {
    console.error(`Invalid --verdict "${verdict}". Expected correct, incorrect, partial or unresolvable.`);
    process.exit(1);
  }
  const minConfidence = minRaw === undefined ? undefined : Number(minRaw);
  if (minConfidence !== undefined && (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) {
    console.error(`Invalid --min-confidence "${minRaw}". Expected a number from 0 to 1.`);
    process.exit(1);
  }
  const limit = limitRaw === undefined ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`Invalid --limit "${limitRaw}". Expected a positive integer.`);
    process.exit(1);
  }
  if (applied && unapplied) {
    console.error('Error: --applied and --unapplied are mutually exclusive (choose one).');
    process.exit(1);
  }

  const { gradeJudgeMeasured } = await import('../core/cycle/grade-takes-measured.ts');
  const rows = await engine.executeRaw<{
    take_id: number; source_id: string; page_slug: string; row_num: number; claim: string; holder: string; since_date: string | null;
    verdict: string; confidence: number; applied: boolean; judge_model_id: string; prompt_version: string; graded_at: string | Date;
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (g.take_id)
              g.take_id, p.source_id, p.slug AS page_slug, t.row_num, t.claim, t.holder, t.since_date,
              g.verdict, g.confidence, g.applied, g.judge_model_id, g.prompt_version, g.graded_at
         FROM take_grade_cache g
         JOIN takes t ON t.id = g.take_id
         JOIN pages p ON p.id = t.page_id
        WHERE p.deleted_at IS NULL
        ORDER BY g.take_id, g.graded_at DESC
     ) latest
     WHERE ($1::text IS NULL OR verdict = $1)
       AND ($2::real IS NULL OR confidence >= $2)
       AND ($3::boolean IS NULL OR applied = $3)
     ORDER BY graded_at DESC, take_id DESC
     LIMIT $4`,
    [verdict ?? null, minConfidence ?? null, applied ? true : unapplied ? false : null, limit],
  );
  const grades = rows.map(r => ({
    ...r,
    confidence: Number(r.confidence),
    graded_at: r.graded_at instanceof Date ? r.graded_at.toISOString() : String(r.graded_at),
    judge_measured: gradeJudgeMeasured(r.judge_model_id, r.prompt_version),
  }));

  if (json) {
    console.log(JSON.stringify(grades, null, 2));
    return;
  }
  if (grades.length === 0) {
    console.log('No grade_takes verdicts match.');
    return;
  }
  console.log(`# grade_takes verdicts (newest per take, ${grades.length} shown)`);
  for (const g of grades) {
    console.log(`  ${g.page_slug}#${g.row_num} [${g.holder}] ${g.verdict} @ ${g.confidence.toFixed(2)}${g.applied ? ' applied' : ''}  judge ${g.judge_model_id}${g.judge_measured ? '' : ' (not measured by W6)'}  ${g.graded_at.slice(0, 10)}`);
    console.log(`      ${g.claim}${g.since_date ? `  (made ${g.since_date})` : ''}`);
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
  // GBRA-130 A-25: pages propose_takes held with a failure tombstone after
  // repeated deterministic extractor failures: list them, or release one page
  // (or every page) so the next run re-extracts it.
  if (flagPresent(args, '--failed') || flagPresent(args, '--retry-failed')) {
    const explicit = flagValue(args, '--source');
    const target = explicit ? await resolveSourceId(engine, explicit) : sourceId;
    const { listFailedProposals, retryFailedProposals } = await import('../core/cycle/propose-takes-failures.ts');
    if (flagPresent(args, '--retry-failed')) {
      const { released } = await retryFailedProposals(engine, target, flagValue(args, '--slug'));
      if (json) console.log(JSON.stringify({ source_id: target, released }, null, 2));
      else console.log(released.length ? `Released ${released.length} page(s) in ${target}; the next propose_takes run re-extracts them: ${released.join(', ')}` : `No held pages in ${target}.`);
      return;
    }
    const failed = await listFailedProposals(engine, target);
    if (json) { console.log(JSON.stringify(failed, null, 2)); return; }
    if (failed.length === 0) { console.log(`No pages held by propose_takes in ${target}.`); return; }
    for (const f of failed) console.log(`${f.slug} (${f.code}, prompt ${f.prompt_version}, held ${f.proposed_at})`);
    console.log(`Retry one with \`gbrain takes propose --retry-failed --slug <slug> --source ${target}\`, or every page by omitting --slug.`);
    return;
  }
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

  const editFlags = ['--claim', '--weight', '--who', '--kind'].filter(flag => flagPresent(args, flag));
  if (editFlags.length && acceptRaw === undefined) {
    console.error(`Error: ${editFlags.join(', ')} edit a proposal only together with --accept <id>.`);
    process.exit(1);
  }
  if (acceptRaw !== undefined) {
    const id = parseId(acceptRaw, '--accept');
    const dirArg = flagValue(args, '--dir');
    const weightRaw = flagValue(args, '--weight');
    const weight = weightRaw === undefined ? undefined : Number(weightRaw);
    if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1)) {
      console.error(`Invalid --weight "${weightRaw}". Expected a number from 0 to 1.`);
      process.exit(1);
    }
    const kind = flagValue(args, '--kind');
    if (kind !== undefined && !['fact', 'take', 'bet', 'hunch'].includes(kind)) {
      console.error(`Invalid --kind "${kind}". Expected fact, take, bet or hunch.`);
      process.exit(1);
    }
    const brainDir = await resolveBrainDir(engine, dirArg ?? null);
    try {
      const { proposal, rowNum } = await acceptProposal({ engine, brainDir, sourceId, actedBy, config: loadConfig() ?? { engine: 'pglite' },
        ...(dirArg ? { localDir: resolvePath(dirArg) } : {}) }, id, { claim: flagValue(args, '--claim'), weight, holder: flagValue(args, '--who'), kind });
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
  takes remove <slug> --row N             Remove one take row from the fence and the DB (other row numbers stay)
  takes rebuild <slug> [--source-id <id>] [--json]
                                          Rebuild one page's takes index from its canonical fence
  takes propose [--limit N] [--json]      List pending LLM-proposed takes (propose_takes queue)
  takes propose --accept <id> [--dir <path>] [--claim "..."] [--weight 0.6] [--who <holder>] [--kind <k>]
                                          Promote a proposal into the page's takes fence (source take_proposals#<id>;
                                          edits mark it "(edited)" and the queue keeps the original text)
  takes propose --reject <id>             Dismiss a proposal
  takes propose --failed [--source <id>] [--json]
                                          Pages propose_takes held after repeated extractor failures
  takes propose --retry-failed [--slug <slug>] [--source <id>] [--json]
                                          Release held pages so the next propose_takes run re-extracts them
  takes scorecard [<holder>] [--domain <prefix>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
                                          Aggregate calibration scorecard (v0.30.0)
                  [--group-by holder|source] [--min-n N] [--source-id <id>]
                                          Per-holder or per-source rows from the forecast journal (W7, private)
  takes journal [--holder h] [--about <slug-prefix>] [--state resolved|overdue|open|undated]
                [--since YYYY-MM] [--until YYYY-MM] [--limit N] [--source-id <id>] [--json]
                                          Every prediction with its time, horizon, state and resolution (W7, private)
  takes calibration [<holder>] [--bucket-size 0.1] [--json]
                                          Calibration curve binned by stated weight (v0.30.0)
  takes horizon scan [--apply] [--source-id <id>] [--json]
                                          Preview (or write) each take's stated deadline (W7, private)
  takes horizon set <slug> --row N --date YYYY-MM-DD | clear <slug> --row N
                                          Set or clear a take's horizon as the owner
  takes grades [--verdict v] [--min-confidence 0.95] [--applied|--unapplied] [--limit 50] [--json]
                                          Review grade_takes verdicts: the newest cached verdict per take,
                                          newest first; marks verdicts whose judge the W6 eval did not measure

Common flags:
  --dir <path>    Verify the configured canonical directory for mutations
  --source-id <id> Select the source for a mutation (--source remains claim provenance)
  --request-id <uuid> Reuse the original mutation ID after a pending/lost response
  --expected-revision <uuid> / --force  Conditional mutation / explicit overwrite
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
    case 'add':
    case 'update':
    case 'supersede':
    case 'resolve':
    case 'remove': { const { runTakesMutation } = await import('./takes-mutation.ts'); return runTakesMutation(engine, args); }
    case 'rebuild':     { const { runTakesRebuild } = await import('./takes-mutation.ts'); return runTakesRebuild(engine, rest); }
    // #2411: `takes propose` used to fall through to the slug path and print
    // "No takes on propose." — the LLM proposal queue had no drain surface.
    case 'propose':     return cmdPropose(engine, rest, await resolveTakesSourceId(engine));
    case 'horizon':     return cmdHorizon(engine, rest);
    case 'journal':     return cmdJournal(engine, rest);
    case 'scorecard':   return cmdScorecard(engine, rest);
    case 'calibration': return cmdCalibration(engine, rest);
    case 'grades':      return cmdGrades(engine, rest);
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
      'Usage: gbrain takes extract --from-pages [--yes] [--dry-run] [--json] [--source-id <id>] [--max-pages N (clamped to 1000)] [--before <updated_at>,<id>] [--include-covered] [--holder <name>]\n' +
      'Runs progress: pages that already hold takes are skipped, so repeat runs sweep a large corpus in slices. Pass a run\'s next_before to --before to continue past pages that yielded no claims. --include-covered rescans everything (refresh).\n',
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
  let before: { updatedAt: string; id: number } | undefined;
  try {
    before = parseTakesBeforeCursor(rest);
  } catch (e) {
    (await import('../cli/cli-error.ts')).exitCliError(e, 'takes');
  }

  // A12 consent gate.
  const bootstrapEnabledCfg = await engine.getConfig('takes.bootstrap_enabled');
  const bootstrapEnabled = bootstrapEnabledCfg === 'true' || bootstrapEnabledCfg === '1';
  if (!bootstrapEnabled) {
    process.stderr.write(
      `takes-bootstrap is opt-in. Enable with:\n  gbrain config set takes.bootstrap_enabled true\nThen run it again with the user's approval (--yes).\n`,
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
    before,
    includeCovered,
    holder,
  }).catch(async (e: unknown) => {
    const { isDatetimeInputError } = await import('../core/utils.ts');
    if (before && isDatetimeInputError(e)) (await import('../cli/cli-error.ts')).exitCliError(beforeCursorError('The database could not read the --before timestamp.'), 'takes');
    throw e;
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
  const unlocatable = result.skipped.filter((s) => !s.reason.startsWith('llm_error:'));
  if (unlocatable.length > 0) {
    const reasons = [...new Set(unlocatable.map((s) => s.reason))].join(', ');
    process.stderr.write(
      `[takes extract] ${unlocatable.length} page(s) skipped (${reasons}) — takes are ` +
      `markdown-canonical; a page with no locatable .md file is not written. ` +
      `Configure sync.repo_path (or the source's local_path) and re-run.\n`,
    );
  }
  const llmErrors = result.skipped.filter((s) => s.reason.startsWith('llm_error:'));
  if (llmErrors.length > 0) {
    const reasons = [...new Set(llmErrors.map((s) => s.reason))].join(', ');
    process.stderr.write(`[takes extract] ${llmErrors.length} page(s) skipped because the model call failed (${reasons}).\n`);
  }
  if (result.budget_exhausted) {
    process.stderr.write(
      `[takes extract] stopped at the USD budget; raise it with ` +
      `\`gbrain config set takes.bootstrap_budget_usd <usd>\` and re-run to continue.\n`,
    );
  }
  if (result.duplicates_skipped > 0) {
    process.stderr.write(`[takes extract] ${result.duplicates_skipped} claim(s) already in the page's takes fence were not re-added.\n`);
  }
  process.stdout.write(
    `takes extract --from-pages: ${result.claims_extracted} claim(s) from ${result.pages_scanned} page(s)` +
    (dryRun ? ' (dry-run)' : '') + '\n',
  );
  // Quoted: the cursor's timestamp contains a space.
  if (result.next_before) process.stdout.write(`next: --before '${result.next_before}'\n`);
}

const BEFORE_CURSOR_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?),([1-9]\d{0,15})$/;

function beforeCursorError(message: string): OperationError {
  return usageError(message, 'Pass the exact next_before value a previous takes extract run printed, or drop --before to start from the newest page.', {
    why: '--before continues a sweep strictly below one (updated_at, id) keyset position; anything else could skip or repeat pages.',
    fix: {
      argv: ['gbrain', 'takes', 'extract', '--from-pages', '--dry-run', '--json'],
      consent: [], actor: 'agent', requires_exclusive: false,
      why: 'A dry run without --before lists the newest pages and prints a fresh next_before.',
      verify: { argv: ['gbrain', 'config', 'get', 'takes.bootstrap_enabled'] },
    },
  });
}

/** #5059: `--before <updated_at>,<id>` (a run's next_before), or undefined. Refuses before any page is read. */
export function parseTakesBeforeCursor(rest: readonly string[]): { updatedAt: string; id: number } | undefined {
  const idx = rest.indexOf('--before');
  if (idx < 0) return undefined;
  const raw = rest[idx + 1];
  if (raw === undefined || raw.startsWith('--')) throw beforeCursorError('--before needs a value: <updated_at>,<page id>.');
  const m = BEFORE_CURSOR_RE.exec(raw.trim());
  if (!m) throw beforeCursorError('--before is not an <updated_at>,<page id> cursor.');
  return { updatedAt: m[1]!, id: Number(m[2]) };
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

/**
 * W7: the stated horizon of each take (`scan`, preview-first) and the
 * owner's own horizon (`set`, `clear`), in the private `take_horizons`
 * table (src/core/takes-horizon.ts). Trusted local only: there is no MCP op,
 * so a thin client refuses it.
 */
async function cmdHorizon(engine: BrainEngine, args: string[]): Promise<void> {
  const usage = 'Usage: gbrain takes horizon scan [--apply] [--source-id <id>] [--json]\n' +
    '       gbrain takes horizon set <slug> --row N --date YYYY-MM-DD [--source-id <id>]\n' +
    '       gbrain takes horizon clear <slug> --row N [--source-id <id>]';
  const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1); };
  const { scanStatedHorizons, setTakeHorizon, clearTakeHorizon } = await import('../core/takes-horizon.ts');
  const [sub, ...rest] = args;
  const json = flagPresent(rest, '--json');

  if (sub === 'scan') {
    const apply = flagPresent(rest, '--apply');
    const sourceId = flagValue(rest, '--source-id');
    const scan = await scanStatedHorizons(engine, { apply, ...(sourceId ? { sourceId } : {}) });
    if (json) {
      console.log(JSON.stringify({ applied: apply, ...scan }, null, 2));
      return;
    }
    for (const p of scan.proposed) console.log(`  take ${p.take_id}: ${p.horizon_date} (${p.basis}, "${p.phrase}")${p.replaces ? ` replaces ${p.replaces}` : ''}  ${p.claim}`);
    const tail = `${scan.kept_owner} owner horizon(s) kept, ${scan.unparsed} take(s) state no single deadline.`;
    if (apply) console.log(`Wrote ${scan.written} stated horizon(s). ${tail}`);
    else console.log(`${scan.proposed.length} stated horizon(s) to write. ${tail}${scan.proposed.length ? ' Write them with: gbrain takes horizon scan --apply' : ''}`);
    return;
  }

  if (sub !== 'set' && sub !== 'clear') fail(usage);
  const slug = rest[0] && !rest[0].startsWith('-') ? rest[0] : fail(usage);
  const rowRaw = flagValue(rest, '--row');
  const row = rowRaw === undefined ? NaN : Number(rowRaw);
  if (!Number.isSafeInteger(row) || row < 1) fail(`--row requires the take's row number (a positive integer), e.g. --row 1.\n${usage}`);
  const sourceId = await resolveSourceId(engine, flagValue(rest, '--source-id') ?? null);
  const [take] = await engine.executeRaw<{ id: number | string }>(
    `SELECT t.id FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.row_num = $3 AND p.deleted_at IS NULL`,
    [sourceId, slug, row]);
  if (!take) fail(`No take ${slug}#${row} on source ${sourceId}. List the page's takes with: gbrain takes ${slug}`);
  const takeId = Number(take!.id);

  if (sub === 'set') {
    const date = flagValue(rest, '--date') ?? fail(`--date YYYY-MM-DD is required.\n${usage}`);
    await setTakeHorizon(engine, takeId, date, 'owner').catch((e: Error) => fail(e.message));
    console.log(`Set the horizon of ${slug}#${row} to ${date} (owner).`);
    return;
  }
  console.log(await clearTakeHorizon(engine, takeId) ? `Cleared the horizon of ${slug}#${row}.` : `${slug}#${row} had no horizon.`);
}

/**
 * W7: the private forecast journal (src/core/forecast-journal.ts). Every
 * prediction with its prediction time (certified or labelled uncertified),
 * horizon, state and resolution; the totals keep the unresolved denominator
 * whatever --state or --limit shows. Trusted local only: there is no MCP op,
 * so a thin client refuses it.
 */
async function cmdJournal(engine: BrainEngine, args: string[]): Promise<void> {
  const usage = 'Usage: gbrain takes journal [--holder h] [--about <slug-prefix>] [--state resolved|overdue|open|undated]\n' +
    '       [--since YYYY-MM] [--until YYYY-MM] [--limit N] [--source-id <id>] [--json]';
  const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(1); };
  const { readForecastJournal } = await import('../core/forecast-journal.ts');
  const state = flagValue(args, '--state');
  if (state !== undefined && !['resolved', 'overdue', 'open', 'undated'].includes(state)) fail(usage);
  const limitRaw = flagValue(args, '--limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1)) fail(`--limit requires a positive integer, e.g. --limit 50.\n${usage}`);
  const value = (flag: string) => flagValue(args, flag);
  const journal = await readForecastJournal(engine, {
    ...(value('--source-id') ? { sourceId: value('--source-id') } : {}), ...(value('--holder') ? { holder: value('--holder') } : {}),
    ...(value('--about') ? { about: value('--about') } : {}), ...(value('--since') ? { since: value('--since') } : {}),
    ...(value('--until') ? { until: value('--until') } : {}), ...(state ? { state: state as 'resolved' } : {}), ...(limit ? { limit } : {}),
  });
  if (flagPresent(args, '--json')) {
    console.log(JSON.stringify(journal, null, 2));
    return;
  }
  const t = journal.totals;
  console.log(`${t.predictions} predictions: ${t.resolved} resolved, ${t.unresolved} unresolved (${t.overdue} overdue, ${t.open} open, ${t.undated} undated)`);
  console.log(`Prediction times certified by the belief ledger: ${t.certified_prediction_times} of ${t.predictions}.`);
  for (const e of journal.entries) {
    const predicted = e.prediction.at ? `${e.prediction.at} (${e.prediction.basis}, ${e.prediction.certified ? 'certified' : 'uncertified'})` : 'unknown';
    const horizon = e.horizon ? `${e.horizon.date} (${e.horizon.basis})` : 'none';
    const weight = e.weight === null ? '' : ` w=${e.weight.toFixed(2)}`;
    const resolution = e.resolution ? `  resolved ${e.resolution.quality}${e.resolution.resolved_at ? ` ${e.resolution.resolved_at.slice(0, 10)}` : ''}${e.resolution.resolved_by ? ` by ${e.resolution.resolved_by}` : ''}` : '';
    const grade = e.grade ? `  grade ${e.grade.verdict} @ ${e.grade.confidence.toFixed(2)}${e.grade.applied ? ' applied' : ''}${e.grade.judge_measured ? '' : ' (judge not measured)'}` : '';
    console.log(`\n[${e.state}] ${e.page_slug}#${e.row_num}  ${e.holder}${weight}  predicted ${predicted}  horizon ${horizon}${resolution}${grade}\n  ${e.claim}`);
  }
  if (journal.entries.length < (state ? t[state as 'resolved'] : t.predictions)) console.log(`\nShowing ${journal.entries.length}; the totals count every match.`);
}
