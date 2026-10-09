/**
 * #6188 `fence_integrity`: per source, the malformed facts and takes fences
 * still waiting, counted once each across three origins (an `invalid_fence`
 * sync hold, a stored page whose fence fails the coordinated fence step, a
 * working-tree file not yet synced) and split by the tier that would clear
 * it (deterministic Tier 1, resolver, model, manual edit); the oldest
 * unresolved hold's age; and the 7-day trend of fences Tier 1 normalized with
 * its top writers, warning at `FENCE_NORMALIZATION_WARN_7D`.
 *
 * Each run first advances the stored census within a bounded scan
 * (`GBRAIN_DOCTOR_FENCE_TIMEOUT_MS`, default 10 s), then reports the stored
 * summary. A census the scan did not finish is `partial` and never reports
 * ok; the next run resumes where it stopped. The fix is the read-only
 * `gbrain repair fences --source <id>` preview for holds, stored pages and
 * files alike; what the next maintenance run repairs automatically is said
 * so (only while one is active and `fences.repair.enabled` is on), and why
 * model-tier fences wait when `fences.repair.llm` is off or today's budget is
 * spent. Output is location only: slugs, paths, fences, rows, reasons and
 * tiers, never a cell value.
 *
 * #6278: the check also counts `unrenderable_legacy_facts`, the active
 * `row_num IS NULL` fact rows the fence step leaves unadopted because the
 * fence codec would change their text (or their page already carries the
 * claim), from the planner's read-only result: pages, fact ids and reason
 * classes, never the claim. Those rows stay active and searchable and
 * nothing is lost, so the finding has no command (`next: report`) and never
 * suggests `forget_fact`; its verify re-counts the rows.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, doctorVerify } from '../check-fix.ts';
import { auditUnadoptableFacts, planUnfencedFacts, type UnadoptableFactRecord } from '../../../core/facts/unfenced-facts.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { runFenceCensus, summarizeFenceCensus, type SourceCensus, type TierCounts } from '../../../core/fence-repair/census.ts';
import { readTrend, type TrendEntry } from '../../../core/fence-repair/census-store.ts';
import { readFenceRepairCaps } from '../../../core/fence-repair/config.ts';
import { readUncommittedFenceRepairs } from '../../../core/fence-repair/uncommitted.ts';
import { STRUCTURED_WRITE_ADVICE } from '../../../core/fence-repair/report.ts';
import { fencePreviewArgv, readFenceAutoRepair, type FenceAutoRepair } from '../../../core/fence-repair/hold-fix.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../../../core/budget/daily-ledger.ts';

/**
 * A source whose writers made Tier 1 normalize this many pages or files in
 * the last 7 days warns: something keeps emitting malformed fences, and each
 * normalized write returns a page that differs from what was sent.
 */
export const FENCE_NORMALIZATION_WARN_7D = 20;
const TREND_DAYS = 7;
const DOCS = 'docs/guides/write-refusals.md#invalid_fence';
const UNRENDERABLE_DOCS = 'docs/guides/write-refusals.md#fence_unrenderable';

/** `GBRAIN_DOCTOR_FENCE_TIMEOUT_MS` (default 10 s): the wall-clock bound of one census scan. */
export function fenceScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_FENCE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

interface SourceTrend { source_id: string; normalized_7d: number; by_day: Array<{ day: string; count: number }>; top_writers: Array<{ writer: string; count: number }> }

function sourceTrend(sourceId: string, days: readonly TrendEntry[]): SourceTrend {
  const writers = new Map<string, number>();
  for (const day of days) for (const [writer, n] of Object.entries(day.writers)) writers.set(writer, (writers.get(writer) ?? 0) + n);
  return { source_id: sourceId, normalized_7d: days.reduce((sum, day) => sum + day.count, 0), by_day: days.map(day => ({ day: day.day, count: day.count })),
    top_writers: [...writers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([writer, count]) => ({ writer, count })) };
}

const tiers = (counts: TierCounts) => (['deterministic', 'resolver', 'llm', 'manual'] as const).filter(t => counts[t]).map(t => `${t} ${counts[t]}`).join(', ');

function sourceLine(census: SourceCensus, now: number): string {
  const parts = [census.holds.total ? `${census.holds.total} held file(s)` : '', census.pages.total ? `${census.pages.total} stored page(s)` : '',
    census.files.total ? `${census.files.total} unsynced file(s)` : ''].filter(Boolean);
  const age = census.oldest_hold_at ? `; oldest hold ${Math.max(0, Math.round((now - Date.parse(census.oldest_hold_at)) / 3_600_000))} h old` : '';
  return `${census.source_id}: ${parts.join(', ')} (by tier: ${tiers(census.by_tier)})${age}`;
}

/** Whether the maintenance run repairs fences by itself: "repaired automatically by the next maintenance run", or why not. */
function automaticRepair(auto: FenceAutoRepair): string {
  if (auto.active) return 'repaired automatically by the next maintenance run';
  return `not repaired automatically (${auto.enabled ? 'no maintenance run has completed in the last 24 h' : 'fences.repair.enabled is false'})`;
}

/**
 * The next step for one source: the read-only `gbrain repair fences --source <id>` preview for holds, stored pages and files alike.
 * With no active maintenance run, `then` applies the plan (the preview prints the `--expect <hash>` form).
 */
function sourceFix(census: SourceCensus, auto: FenceAutoRepair) {
  const preview = fencePreviewArgv(census.source_id);
  const manual = census.by_tier.manual;
  const why = `Previews the repair of each malformed fence of ${census.source_id} (read-only, no model call): its planned tier and diff, the estimated model cost, or the exact edit for a fence gbrain will not guess; it prints the apply command with --expect <hash>. `
    + (auto.active ? `Everything but the manual ones is ${automaticRepair(auto)}, so no action is needed for those.` : `They are ${automaticRepair(auto)}, so apply the plan with the command the preview prints.`)
    + (manual ? ` ${manual} need a manual edit: make the edit the preview names in the file (or the page), commit, then sync.` : '');
  return agentFix(preview, why, 'fence_integrity', { docs: 'docs/guides/repair.md#fences',
    ...(auto.active ? {} : { then: agentFix([...preview, '--apply'], `Applies the current repair plan of ${census.source_id}; the command the preview prints adds --expect <hash>, which applies exactly what it showed.`, 'fence_integrity') }) });
}

/** Why model-tier fences wait, or the caps when nothing stops them. */
function modelRepairSentence(caps: { perPageUsd: number; perDayUsd: number }, today: { committedUsd: number; reservedUsd: number } | null, auto: FenceAutoRepair, llm: number): string {
  if (!auto.llm) return `Model repair (Tier 3) is off (fences.repair.llm false), so ${llm} model-tier fence(s) wait for a manual edit; turning it on is the user's call (gbrain config set fences.repair.llm true).`;
  if (caps.perDayUsd === 0) return 'Model repair spend is off (fences.repair.max_usd_per_day 0).';
  if (today && today.committedUsd + today.reservedUsd >= caps.perDayUsd) {
    return `Today's model repair budget is spent ($${today.committedUsd.toFixed(2)} of $${caps.perDayUsd.toFixed(2)}), so ${llm} model-tier fence(s) wait until after 00:00 UTC; `
      + 'raising it is the user\'s call (gbrain config set fences.repair.max_usd_per_day <usd>).';
  }
  return `Model repair caps: $${caps.perPageUsd.toFixed(2)} per page, $${caps.perDayUsd.toFixed(2)} per day${today ? ` ($${today.committedUsd.toFixed(2)} spent today)` : ''}.`;
}

interface UnrenderablePage { source_id: string; slug: string; rows: Array<{ fact_id: number; reason: UnadoptableFactRecord['reason']; class: UnadoptableFactRecord['class'] }> }
interface UnrenderableLegacyFacts { total: number; complete: boolean; pages: UnrenderablePage[] }

/** Legacy rows the fence step would leave unadopted, planned read-only per source within `deadline`; location only. */
async function unrenderableLegacyFacts(engine: BrainEngine, sourceIds: string[] | undefined, deadline: number): Promise<UnrenderableLegacyFacts> {
  const byPage = new Map<string, UnrenderablePage>();
  let complete = true;
  for (const sourceId of sourceIds ?? [undefined]) {
    const audit = await auditUnadoptableFacts(engine, await planUnfencedFacts(engine, sourceId === undefined ? {} : { sourceId }), { deadline });
    complete &&= audit.complete;
    for (const record of audit.records) {
      const key = `${record.source_id}\0${record.slug}`;
      const page = byPage.get(key) ?? byPage.set(key, { source_id: record.source_id, slug: record.slug, rows: [] }).get(key)!;
      page.rows.push({ fact_id: record.fact_id, reason: record.reason, class: record.class });
    }
  }
  const pages = [...byPage.values()];
  return { total: pages.reduce((sum, page) => sum + page.rows.length, 0), complete, pages };
}

function unrenderableSentence(found: UnrenderableLegacyFacts): string {
  const pages = found.pages.slice(0, 5).map(page => `${page.slug} (${page.source_id}): ${[...new Set(page.rows.map(row => row.class))].sort().join(', ')}`).join('; ');
  return `${found.total} legacy fact row(s) on ${found.pages.length} page(s) cannot be adopted into their facts fence: ${pages}${found.pages.length > 5 ? '; …' : ''}. `
    + 'They stay active and searchable and nothing is lost: the fence codec would change their text (or the page already carries the claim), so gbrain leaves them as legacy rows '
    + 'and those pages skip destructive fact reconciliation. There is no safe automatic fix; report the pages and reason classes with the gbrain version. Do not forget or expire a row to clear this count.'
    + (found.complete ? '' : ' The scan did not finish within its time budget, so more rows may be affected; run gbrain doctor --only fence_integrity again.');
}

/** The check's verdict after a bounded census scan (`sourceIds`: only those sources, for a scoped remote caller). */
export async function fenceIntegrityResult(engine: BrainEngine, opts: { timeoutMs?: number; now?: () => Date; sourceIds?: string[] } = {}): Promise<Omit<Check, 'name'>> {
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? fenceScanTimeoutMs();
  const runs = await runFenceCensus(engine, { deadline: now().getTime() + timeoutMs, now, ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}) });
  const census = await summarizeFenceCensus(engine, opts.sourceIds, runs);
  const from = new Date(now().getTime() - (TREND_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const trendRows = await readTrend(engine, census.map(c => c.source_id), from);
  const trend = census.map(c => sourceTrend(c.source_id, trendRows.get(c.source_id) ?? []));
  const caps = await readFenceRepairCaps(engine);
  const today = await dailyLedger(engine, FENCE_REPAIR_LEDGER, { now }).readDay().catch(() => null);
  const waiting = census.filter(c => c.total);
  const partial = census.filter(c => !c.scan.complete);
  const noisy = trend.filter(t => t.normalized_7d >= FENCE_NORMALIZATION_WARN_7D);
  const total = waiting.reduce((sum, c) => sum + c.total, 0);
  // T2: legacy fence repairs written and imported but not committed yet (counts for a scoped remote caller, paths locally).
  const uncommitted = await readUncommittedFenceRepairs(engine, opts.sourceIds ?? census.map(c => c.source_id)).catch(() => []);
  // The audit's deadline is on the wall clock (it bounds real work; the census's `now` is for dates).
  const unrenderable = await unrenderableLegacyFacts(engine, opts.sourceIds, Date.now() + timeoutMs).catch((): UnrenderableLegacyFacts => ({ total: 0, complete: false, pages: [] }));
  const details = {
    total, partial: partial.length > 0, partial_sources: partial.map(c => c.source_id), sources: census, trend, warn_at_normalized_7d: FENCE_NORMALIZATION_WARN_7D,
    model_repair: { max_usd_per_page: caps.perPageUsd, max_usd_per_day: caps.perDayUsd, spent_today_usd: today?.committedUsd ?? null, reserved_today_usd: today?.reservedUsd ?? null },
    timeout_ms: timeoutMs, docs: DOCS,
    uncommitted_repairs: uncommitted.length,
    ...(uncommitted.length && !opts.sourceIds ? { uncommitted: uncommitted.map(n => ({ source_id: n.source_id, path: n.path, commit_step: n.commit_step })) } : {}),
    unrenderable_legacy_facts: unrenderable,
  };
  if (!total && !partial.length && !noisy.length && !uncommitted.length && !unrenderable.total && unrenderable.complete) {
    return { status: 'ok', details, message: census.length ? `No malformed facts or takes fence is held, stored or waiting in a checkout (${census.length} source(s) scanned).` : 'No sources to scan.' };
  }
  const auto = await readFenceAutoRepair(engine, now());
  const at = now().getTime();
  const sentences: string[] = [];
  if (total) {
    const manual = waiting.reduce((sum, c) => sum + c.by_tier.manual, 0);
    sentences.push(`${total} malformed facts or takes fence(s) wait: ${waiting.map(c => sourceLine(c, at)).join('; ')}. `
      + `${manual < total ? `The ${auto.llm ? 'deterministic, resolver and model-tier' : 'deterministic and resolver'} ones are ${automaticRepair(auto)}` : 'All of them need a manual edit'}`
      + `${manual && manual < total ? `; ${manual} need the manual edit the preview names` : ''}. None of them blocks a sync. Preview: ${waiting.map(c => fencePreviewArgv(c.source_id).join(' ')).join('; ')}.`);
    const llm = waiting.reduce((sum, c) => sum + c.by_tier.llm, 0);
    if (llm) sentences.push(modelRepairSentence(caps, today, auto, llm));
  }
  if (noisy.length) {
    sentences.push(`Writers keep sending malformed fences: ${noisy.map(t => `${t.source_id} had ${t.normalized_7d} normalized in ${TREND_DAYS} days`
      + `${t.top_writers.length ? ` (top writers: ${t.top_writers.map(w => `${w.writer} ${w.count}`).join(', ')})` : ''}`).join('; ')} (warns at ${FENCE_NORMALIZATION_WARN_7D}). `
      + `Fix the generator; a normalized page differs from what was sent. ${STRUCTURED_WRITE_ADVICE}`);
  }
  if (uncommitted.length) {
    const bySource = [...new Set(uncommitted.map(n => n.source_id))];
    sentences.push(`${uncommitted.length} fence repair(s) on legacy source(s) ${bySource.join(', ')} are written and imported but not committed; `
      + `gbrain sources status ${bySource[0]} prints each file's exact git add and git commit step (the backup of the original is kept).`);
  }
  if (partial.length) {
    sentences.push(`PARTIAL CENSUS: the scan of ${partial.map(c => c.source_id).join(', ')} did not finish within ${timeoutMs / 1000}s, so more fences may be malformed; `
      + 'run gbrain doctor --only fence_integrity again to resume it (raise GBRAIN_DOCTOR_FENCE_TIMEOUT_MS for a larger share per run).');
  }
  if (unrenderable.total || !unrenderable.complete) sentences.push(unrenderable.total ? unrenderableSentence(unrenderable)
    : 'The scan for legacy fact rows the fence cannot render did not finish within its time budget; run gbrain doctor --only fence_integrity again.');
  const first = waiting[0];
  const fix = first ? sourceFix(first, auto)
    : partial.length || (!unrenderable.total && !unrenderable.complete) ? agentFix(['gbrain', 'doctor', '--only', 'fence_integrity', '--json'], 'Resumes the fence census where the last scan stopped and reports what it found.', 'fence_integrity', { docs: DOCS })
      : noisy.length ? agentFix(['gbrain', 'sources', 'status', noisy[0]!.source_id, '--json'], `Shows ${noisy[0]!.source_id}'s recent sync result, including fences_normalized with sample paths, so you can find what writes the malformed fences.`,
        'fence_integrity', { docs: DOCS })
        : uncommitted.length ? agentFix(['gbrain', 'sources', 'status', uncommitted[0]!.source_id], 'Lists the uncommitted fence repairs of this legacy source with the exact git add and git commit step for each file.',
          'fence_integrity', { docs: DOCS })
          // No command to run: the rows stay as they are, so the fix is a report; verify re-counts them.
          : { consent: [], actor: 'agent' as const, requires_exclusive: false, docs: UNRENDERABLE_DOCS, verify: doctorVerify('fence_integrity'),
            why: `Nothing to run: ${unrenderable.total} legacy fact row(s) stay active and searchable because their text cannot be written into a facts fence unchanged. Tell the user which pages are listed under unrenderable_legacy_facts and report them with the gbrain version; the verify re-counts the rows.` };
  return { status: 'warn', details: { ...details, auto_repair: auto }, fix, message: sentences.join(' ') };
}

/** The wave check (`WAVE_CHECKS`): the same verdict, scoped to `sourceIds` when a remote caller is. */
export async function fenceIntegrityCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  return { name: 'fence_integrity', ...await fenceIntegrityResult(engine, sourceIds ? { sourceIds } : {}) };
}

async function runFenceIntegrity(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('fence_integrity');
  try {
    checks.push({ name: 'fence_integrity', ...await fenceIntegrityResult(engine) });
  } catch (error) {
    checks.push({ name: 'fence_integrity', status: 'warn', fix_unavailable_reason: 'check_errored', details: { health: 'unknown' },
      message: `The fence census could not run: ${error instanceof Error ? error.message : String(error)}. Fence health is unknown; run gbrain doctor --only fence_integrity again.` });
  }
  return checks;
}

export const fenceIntegrityEntry: DoctorEntry = { name: 'fence_integrity', emits: ['fence_integrity'], run: runFenceIntegrity };
