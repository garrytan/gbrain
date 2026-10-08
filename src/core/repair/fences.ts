/**
 * `gbrain repair fences` (#6188): repairs malformed facts and takes fences
 * that sync held, that pages store, or that a checkout holds unsynced.
 *
 * Candidates come from the fence census (holds, stored pages, files), after
 * a bounded census scan; `--only <path>` and `--slug <slug>` also reach a
 * file or page the census has not judged yet. Per candidate the current
 * bytes are re-read and the free tiers run first (Tier 1 rules, then Tier 2
 * holder names verified against `people/` and `companies/` pages); a
 * candidate whose only residuals are rows a model can realign goes to Tier 3
 * (fence-repair/llm.ts) at apply time, under `fences.repair.llm`, the
 * per-page and daily caps (`fences.repair.max_usd_per_page` / `_per_day`,
 * the daily USD ledger) and any lower `--max-usd`, with the attempt memo so
 * an unchanged rejected file never costs twice. Every proposal passes gates
 * (a)-(g) and is a Tier 1 fixed point before it is written
 * (fence-repair/repair-io.ts has the four write-back paths).
 *
 * Preview (no --apply) is read-only and calls no model: per candidate the
 * planned tier, rows and classes, the exact diff for Tier 1/2 (one sample
 * per tier; all with --diff or --json), the estimated model cost against the
 * day's remaining cap, and a preview hash bound to the selection.
 * `--apply --expect <hash>` applies exactly that set (`changed_since_preview`
 * for anything whose bytes or revision moved); a bare `--apply` (from
 * `--all`, `doctor --remediate`, the maintenance cycle) applies the current
 * plan, rotating its start so a backlog under a time budget is not starved.
 *
 * Per-item outcomes: `repaired` (detail: tier, classes, mode, path or slug),
 * `held` (reason: a FenceReason; the hold records it for the surfaces), or
 * `skipped` (an owner reason: host_mismatch, transfer_in_progress,
 * clone_in_progress, incarnation_changed, local_path_missing,
 * coordination_path_missing, or owner_unavailable; sync_in_progress,
 * changed_since_read, changed_since_preview, claimed_elsewhere,
 * already_clean). A source whose sync is running is not skipped as a whole:
 * only the candidates a write in flight or the sync's frozen manifest still
 * names are `sync_in_progress`, and the busy set is read again at apply and
 * at the write's admission (#6278). When the daily
 * ledger refuses a call the run stops with `budget_exhausted` (D15). The
 * result adds `repaired`, `remaining` by reason, `scan` and `verification`;
 * a run whose every model proposal is rejected reports 0 repaired.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import { parseMarkdown } from '../markdown.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from '../fence-repair/measured.ts';
import { FENCE_REPAIR_MODEL_KEY, resolveFenceRepairModel } from '../fence-repair/model.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER, nextUtcMidnight } from '../budget/daily-ledger.ts';
import { pricingSetCommand } from '../budget/no-pricing.ts';
import type { CapSource } from '../consent.ts';
import { sha256 } from '../persistence/digest.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { readGitSourceHolds, recordFenceHoldRepair } from '../persistence/sync-holds.ts';
import { attemptStore } from '../fence-repair/attempts.ts';
import { listFenceCandidates, runFenceCensus, type FenceCandidate } from '../fence-repair/census.ts';
import { fenceRepairLlmEnabled, readFenceRepairCaps } from '../fence-repair/config.ts';
import { FENCE_REASONS } from '../fence-repair/reasons.ts';
import { FENCE_REPAIR_ACTOR } from '../fence-repair/receipt.ts';
import { checkoutFileExists, loadFenceSource, pageSha, readFenceTarget, spliceFileSections, writeFenceRepair, type FenceRepairMode, type FenceSource, type FenceTarget } from '../fence-repair/repair-io.ts';
import type { OwnerRefusal } from '../persistence/owner-refusal.ts';
import { repairBusy, repairBusyMessage } from '../persistence/repair-busy.ts';
import { analyzeFences, attemptCandidate, runTier3, tier3Estimate, tier3Memo, type FenceAnalysis } from '../fence-repair/repair-tiers.ts';
import type { FenceFix, FenceIssue, FencePage, FenceReason, FenceTier, GateLetter } from '../fence-repair/types.ts';
import { lineDiff } from './frontmatter.ts';
import type { RepairHandler, RepairItem, RepairItemOutcome, RepairListing, RepairPlan, RepairPlanOptions, RepairResult, RepairScope } from './core.ts';

/** The fences result's `verification` (report hook): what the run did and what is left, for the CLI and the cycle phase report. */
export interface FenceRepairVerification {
  /** Candidates the plan found (after selection). */
  candidates: number;
  repaired_by_tier: Record<Exclude<FenceTier, 'manual'>, number>;
  /** Candidates still waiting after the run, by reason (manual-only residuals, gates, budget, ...). */
  held_by_reason: Record<string, number>;
  /** Oldest unresolved `invalid_fence` hold in scope (ISO), or null. */
  oldest_hold_at: string | null;
  /** Successful Tier 3 repairs in this run and the USD per repair (null when none). */
  llm_repairs: number;
  llm_usd_per_repair: number | null;
  /** The scan behind the plan did not finish. */
  partial: boolean;
}

type RepairTier = Exclude<FenceTier, 'manual'>;
interface Selection { source_ids: string[]; only: string[]; skip: string[]; slugs: string[]; no_llm: boolean }

/** One previewed repair: everything the hash binds (location, hashes, tier), never a cell value. */
interface ApprovedFence {
  source_id: string; key: string; slug: string; path: string | null; mode: FenceRepairMode;
  before: string; revision: string | null; page_id: number | null;
  tier: RepairTier;
  /** sha256 of the repaired bytes (Tier 1/2); null for Tier 3 (rewritten at apply time). */
  after: string | null;
  classes: string[]; rows: number[]; columns: string[];
  estimate_usd: number;
  held: boolean;
  /** Model items from this one to the end of the plan (the pages a budget stop leaves waiting). */
  llm_waiting: number;
}
interface ApprovedSetItem extends ApprovedFence { selection: Selection }
interface FenceItem extends RepairItem { entry: ApprovedFence; hash: string | null; last: boolean; scan_partial: boolean }

interface FileDiff { item: string; tier: RepairTier; classes: string[]; diff: string }
interface HeldEntry { item: string; reason: string; tier: FenceTier; resolution: string; gate?: GateLetter; rows?: number[] }
export interface FencesPreviewDetails {
  counts: Record<RepairTier | 'held', number>;
  model: string | null;
  llm_enabled: boolean;
  samples: Partial<Record<RepairTier, FileDiff>>;
  diffs: FileDiff[];
  llm_items: Array<{ item: string; rows: number[]; reasons: string[]; estimate_usd: number }>;
  held: HeldEntry[];
  caps: { max_usd_per_page: number; max_usd_per_day: number; day_remaining_usd: number | null; run_max_usd: number | null };
  next_actions: Action[];
}

const SCAN_MS = () => { const n = parseInt(process.env.GBRAIN_FENCE_REPAIR_SCAN_MS ?? '', 10); return Number.isFinite(n) && n > 0 ? n : 10_000; };
const CALL_TIMEOUT_MS = () => { const n = parseInt(process.env.GBRAIN_FENCE_REPAIR_CALL_TIMEOUT_MS ?? '', 10); return Number.isFinite(n) && n > 0 ? n : 90_000; };
const ROTATION_OP = 'fence-repair-rotation';

/** Held because no measured model has a key: the exact choice the user makes. */
function noMeasuredModel(rows: readonly number[]): string {
  return `No model measured accurate enough for fence repair has a provider key here (${FENCE_REPAIR_MEASURED_MODELS.join(', ')}) and ${FENCE_REPAIR_MODEL_KEY} is unset, `
    + `so row(s) ${rows.join(', ') || '?'} stay held. Fix them by hand, or ask the user which model to trust, then: gbrain config set ${FENCE_REPAIR_MODEL_KEY} <provider:model>.`;
}

function previewArgv(scope: RepairScope, selection: Selection): string[] {
  return ['gbrain', 'repair', 'fences', ...(scope.source_ids.length === 1 ? ['--source', scope.source_ids[0]!] : []),
    ...selection.only.flatMap(path => ['--only', path]), ...selection.skip.flatMap(path => ['--skip', path]), ...selection.slugs.flatMap(slug => ['--slug', slug]),
    ...(selection.no_llm ? ['--no-llm'] : [])];
}

const itemName = (entry: Pick<ApprovedFence, 'source_id' | 'path' | 'slug'>) => `${entry.source_id}:${entry.path ?? entry.slug}`;

function fixLocation(fixes: readonly FenceFix[], residual: readonly FenceIssue[]) {
  const all = [...fixes, ...residual];
  return { rows: [...new Set(all.flatMap(f => f.row === null ? [] : [f.row]))].sort((a, b) => a - b).slice(0, 200),
    columns: [...new Set(all.flatMap(f => f.column === null ? [] : [f.column]))].sort().slice(0, 40) };
}

function classesOf(fixes: readonly FenceFix[], cleared: readonly string[] = []): string[] {
  return [...new Set([...fixes.map(f => f.class), ...cleared])].sort();
}

/** The repaired bytes as the hash binds them: the spliced file, or the page's two sections. */
function afterBytes(target: FenceTarget, after: FencePage): { sha: string; text: string } | null {
  if (target.content !== null && target.path) {
    const content = spliceFileSections(target.content, target.path, target.page, after);
    return content === null ? null : { sha: sha256(Buffer.from(content, 'utf8')), text: content };
  }
  return { sha: pageSha(after), text: `${after.compiled_truth}\n${after.timeline}` };
}

interface Settings {
  llmEnabled: boolean; model: string | null; overrides: Awaited<ReturnType<typeof loadPricingOverrides>>; capSource: CapSource;
  perPageUsd: number; perDayUsd: number; dayRemaining: number | null; runMaxUsd: number | null;
}

async function settings(engine: BrainEngine, opts: Pick<RepairPlanOptions, 'noLlm' | 'maxLlmUsd'>): Promise<Settings> {
  const caps = await readFenceRepairCaps(engine);
  const model = await resolveFenceRepairModel(engine);
  const day = await dailyLedger(engine, FENCE_REPAIR_LEDGER).readDay().catch(() => null);
  return { llmEnabled: !opts.noLlm && await fenceRepairLlmEnabled(engine), model, overrides: await loadPricingOverrides(engine),
    capSource: caps.perPageSource === 'user' || caps.perDaySource === 'user' || opts.maxLlmUsd !== undefined ? 'user' : 'default',
    perPageUsd: caps.perPageUsd, perDayUsd: caps.perDayUsd, dayRemaining: day ? Math.max(0, caps.perDayUsd - day.committedUsd - day.reservedUsd) : null,
    runMaxUsd: opts.maxLlmUsd ?? null };
}

/** The tier a reason's hold state records. */
function heldTier(reason: string): FenceTier {
  const spec = FENCE_REASONS[reason as FenceReason];
  return spec?.manualOnly || spec?.stage === 'gate' ? 'manual' : spec?.tier ?? 'manual';
}

async function recordHeld(engine: BrainEngine, src: FenceSource, cand: { path: string | null; held: boolean }, held: { reason: string; gate?: GateLetter; rows?: number[]; next?: string | null }): Promise<void> {
  if (!cand.held || !cand.path || !(held.reason in FENCE_REASONS)) return;
  const reason = held.reason as FenceReason;
  await recordFenceHoldRepair(engine, { sourceId: src.id, incarnation: src.incarnation, path: cand.path, state: { reason, tier: heldTier(reason), at: new Date().toISOString(),
    next_attempt_after: held.next ?? null, ...(held.gate ? { gate: held.gate } : {}), ...(held.rows?.length ? { rows: held.rows.slice(0, 50) } : {}) } }).catch(() => false);
}

/** Candidates the selection names that the census has not judged yet: a file under a source root, or a stored page. */
async function extraCandidates(engine: BrainEngine, scope: RepairScope, selection: Selection, found: readonly FenceCandidate[], sources: Map<string, FenceSource | null>): Promise<{ extra: FenceCandidate[]; unknown: string[] }> {
  const extra: FenceCandidate[] = [];
  const unknown: string[] = [];
  const base = (sourceId: string, key: string, path: string | null): FenceCandidate => ({ source_id: sourceId, key, path, page_id: null, origins: [path ? 'file' : 'page'],
    bucket: path ? 'file' : 'page', tier: 'manual', reasons: [], location: null, bound: {} });
  for (const path of selection.only) {
    if (found.some(c => c.path === path)) continue;
    const hits = scope.source_ids.filter(id => { const src = sources.get(id); return !!src?.root && checkoutFileExists(src.root, path); });
    if (!hits.length) unknown.push(`--only ${path}`);
    for (const id of hits) extra.push(base(id, `path:${path}`, path));
  }
  for (const slug of selection.slugs) {
    if (found.some(c => c.key === slug)) continue;
    const rows = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM pages WHERE slug=$1 AND source_id=ANY($2::text[]) AND deleted_at IS NULL', [slug, scope.source_ids]);
    if (!rows.length) unknown.push(`--slug ${slug}`);
    for (const row of rows) extra.push(base(row.source_id, slug, null));
  }
  return { extra, unknown };
}

function selected(cand: FenceCandidate, selection: Selection): boolean {
  if (cand.path && selection.skip.includes(cand.path)) return false;
  if (!selection.only.length && !selection.slugs.length) return true;
  return (!!cand.path && selection.only.includes(cand.path)) || selection.slugs.includes(cand.key);
}

async function rotationAfter(engine: BrainEngine, brainId: string): Promise<string | null> {
  const [row] = await engine.executeRaw<{ last: string | null }>("SELECT completed_keys->0->>'last' AS last FROM op_checkpoints WHERE op=$1 AND fingerprint=$2", [ROTATION_OP, brainId]);
  return row?.last ?? null;
}

async function saveRotation(engine: BrainEngine, brainId: string, last: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [ROTATION_OP, brainId, JSON.stringify([{ last }])]);
}

const rotationKey = (entry: Pick<ApprovedFence, 'source_id' | 'key'>) => `${entry.source_id}\u0000${entry.key}`;

function item(entry: ApprovedFence, index: number, hash: string | null, last: boolean, partial: boolean): FenceItem {
  return { cursor: { phase: 1, id: index + 1 }, source_id: entry.source_id, slug: entry.slug, chars: 0, action: `${entry.tier}:${entry.path ?? entry.slug}`,
    ...(entry.tier === 'llm' ? { llm_usd: entry.estimate_usd } : {}), entry, hash, last, scan_partial: partial };
}

/** The hold reason of an owner refusal: the matrix reason where the fence reason table has it, else the generic `owner_unavailable`. */
function ownerReason(owner: OwnerRefusal): FenceReason {
  return owner.reason in FENCE_REASONS ? owner.reason as FenceReason : 'owner_unavailable';
}

/** The read-only fix that previews one candidate's repair again. */
const previewFix = (sourceId: string, path: string | null, slug: string): Action => ({ argv: ['gbrain', 'repair', 'fences', '--source', sourceId, ...(path ? ['--only', path] : ['--slug', slug])],
  consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews this fence repair again from the bytes as they are now; nothing is written.' });

export const fencesRepair: RepairHandler = {
  kind: 'fences',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, _after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, only: [...(opts?.only ?? [])].sort(), skip: [...(opts?.skip ?? [])].sort(),
      slugs: [...(opts?.slugs ?? [])].sort(), no_llm: opts?.noLlm === true };
    const preview = previewArgv(scope, selection);
    if (opts?.apply && opts.expect) {
      const approved = await loadApprovedSet<ApprovedSetItem>(engine, { command: 'fences', hash: opts.expect, previewCommand: shellQuote(preview) });
      if (approved.items.some(entry => digestOf(entry.selection) !== digestOf(selection))) throw previewChangedError(opts.expect, shellQuote(preview));
      const items = approved.items.map(({ selection: _chosen, ...entry }, index) => item(entry, index, opts.expect!, index === approved.items.length - 1, false));
      const s = await settings(engine, opts);
      return { items, preview_hash: opts.expect, residuals: {}, llm: { usd: items.reduce((sum, i) => sum + (i.llm_usd ?? 0), 0), cap_remaining_usd: s.llmEnabled ? s.dayRemaining : 0 } };
    }
    const now = Date.now();
    const runs = await runFenceCensus(engine, { sourceIds: scope.source_ids, deadline: Math.min(now + SCAN_MS(), opts?.deadline ?? Infinity) });
    const sources = new Map<string, FenceSource | null>();
    for (const id of scope.source_ids) sources.set(id, await loadFenceSource(engine, id, { remote: opts?.remote !== false }));
    const found = await listFenceCandidates(engine, scope.source_ids);
    const { extra, unknown } = await extraCandidates(engine, scope, selection, found, sources);
    let candidates = [...found, ...extra].filter(cand => selected(cand, selection));
    const rotation = opts?.apply ? await rotationAfter(engine, scope.brain_id) : null;
    if (rotation) candidates = [...candidates.filter(c => rotationKey({ source_id: c.source_id, key: c.key }) > rotation), ...candidates.filter(c => rotationKey({ source_id: c.source_id, key: c.key }) <= rotation)];
    const s = await settings(engine, opts ?? { noLlm: false });
    const store = attemptStore(engine);
    const residuals: Record<string, number> = {};
    const warnings = unknown.map(name => `${name}: no such file, page or fence candidate in scope; check the source-relative path or slug.`);
    const approved: ApprovedFence[] = [];
    const diffs: FileDiff[] = [];
    const held: HeldEntry[] = [];
    const llmItems: FencesPreviewDetails['llm_items'] = [];
    const hold = (cand: FenceCandidate, entry: HeldEntry) => { held.push(entry); residuals[entry.reason] = (residuals[entry.reason] ?? 0) + 1; return entry; };
    let unpricedWarned = false;
    for (const cand of candidates) {
      const name = `${cand.source_id}:${cand.path ?? cand.key}`;
      const isHeld = cand.origins.includes('hold');
      const src = sources.get(cand.source_id) ?? null;
      if (!src) continue;
      const keep = async (entry: HeldEntry, next: string | null = null) => {
        hold(cand, entry);
        if (opts?.apply) await recordHeld(engine, src, { path: cand.path, held: isHeld }, { reason: entry.reason, gate: entry.gate, rows: entry.rows, next });
      };
      if (src.owner) { await keep({ item: name, reason: ownerReason(src.owner), tier: 'manual', resolution: `${src.owner.message} ${src.owner.why}` }); continue; }
      if (repairBusy(src.busy, { path: cand.path, slug: cand.key })) {
        await keep({ item: name, reason: 'sync_in_progress', tier: cand.tier, resolution: repairBusyMessage(src.busy, src.id, cand.path ?? cand.key) });
        continue;
      }
      const read = await readFenceTarget(engine, src, { key: cand.key, path: cand.path });
      if (!read.ok) {
        if (read.reason !== 'gone') await keep({ item: name, reason: read.reason, tier: 'manual', resolution: read.reason === 'unsafe_path'
          ? `${cand.path} is a symlink, sits under one, or resolves outside the source root; gbrain never writes through one. Replace it with the real file.`
          : `${cand.path} is not valid UTF-8; re-save it as UTF-8 and preview again.` });
        continue;
      }
      const target = read.target;
      const analysis = await analyzeFences(engine, target, { pageId: target.snapshot?.page.id ?? null });
      if (analysis.status === 'clean') { residuals.already_clean = (residuals.already_clean ?? 0) + 1; continue; }
      if (analysis.status === 'manual') {
        await keep({ item: name, reason: analysis.reason, tier: 'manual', resolution: analysis.resolution, ...(analysis.gate ? { gate: analysis.gate } : {}), ...(analysis.rows ? { rows: analysis.rows } : {}) });
        continue;
      }
      const base: Omit<ApprovedFence, 'tier' | 'after' | 'classes' | 'rows' | 'columns' | 'estimate_usd' | 'llm_waiting'> = { source_id: src.id, key: cand.key, slug: target.slug, path: target.path,
        mode: target.mode, before: target.before, revision: target.snapshot?.revision ?? null, page_id: target.snapshot?.page.id ?? null, held: isHeld };
      if (analysis.status === 'proposal') {
        const bytes = afterBytes(target, analysis.after);
        if (!bytes) { await keep({ item: name, reason: 'unparseable', tier: 'manual', resolution: `gbrain could not place the repaired fence back into ${target.path}; edit the fence there by hand.` }); continue; }
        const at = fixLocation(analysis.fixes, []);
        approved.push({ ...base, tier: analysis.tier, after: bytes.sha, classes: classesOf(analysis.fixes), ...at, estimate_usd: 0, llm_waiting: 0 });
        const beforeText = target.content ?? `${target.page.compiled_truth}\n${target.page.timeline}`;
        diffs.push({ item: name, tier: analysis.tier, classes: classesOf(analysis.fixes), diff: lineDiff(target.path ?? target.slug, beforeText, bytes.text) });
        continue;
      }
      const reasons = [...new Set(analysis.residual.map(i => i.reason))];
      const at = fixLocation(analysis.fixes, analysis.residual);
      const llmHeld = (reason: FenceReason, resolution: string, next: string | null = null) => keep({ item: name, reason, tier: 'llm', resolution, rows: at.rows }, next);
      if (!s.llmEnabled) {
        await llmHeld('llm_disabled', `Model repair is off (${selection.no_llm ? '--no-llm' : 'fences.repair.llm false'}), so row(s) ${at.rows.join(', ') || '?'} stay held (${reasons.join(', ')}). `
          + 'Fix them by hand, or ask the user before turning model repair on: gbrain config set fences.repair.llm true.');
        continue;
      }
      const model = s.model;
      if (!model) { await llmHeld('no_measured_model', noMeasuredModel(at.rows)); continue; }
      if (target.mode === 'managed' && target.snapshot && !target.snapshot.page.deleted_at) {
        const fileTags = new Set(parseMarkdown(target.content ?? '', target.path ?? 'page.md').tags);
        if (target.snapshot.tags.some(tag => !fileTags.has(tag))) {
          await keep({ item: name, reason: 'canonical_overlay', tier: 'manual', resolution: `The page of ${target.path} carries tags its file does not, so a repaired file could not publish as written; add the tags to the file's frontmatter (gbrain get --source ${src.id} -- ${target.slug} shows them), then preview again.` });
          continue;
        }
      }
      const estimate = tier3Estimate(analysis.requests, { model, overrides: s.overrides, capSource: s.capSource });
      if (!estimate.ok) {
        await llmHeld('no_pricing', `A spend cap is set but gbrain has no price for ${model}. ${estimate.guidance.lookup} Register it with: ${estimate.guidance.register_command}`);
        continue;
      }
      if (estimate.estimated && !unpricedWarned) {
        unpricedWarned = true;
        warnings.push(`gbrain has no price for the fence repair model ${model}; model repair runs under the default caps and is metered at an estimated ceiling (the highest chat rate gbrain knows). Make it exact with: ${pricingSetCommand(model, 'chat')}`);
      }
      if (s.perPageUsd === 0 || s.perDayUsd === 0) {
        await llmHeld('budget_exhausted', `Model repair spend is set to 0 (fences.repair.max_usd_per_${s.perPageUsd === 0 ? 'page' : 'day'}), so these rows stay held. Raising it is the user's call: gbrain config set fences.repair.max_usd_per_${s.perPageUsd === 0 ? 'page' : 'day'} <usd>.`);
        continue;
      }
      if (estimate.usd > s.perPageUsd + 1e-9) {
        await llmHeld('budget_exhausted', `The estimated model cost ($${estimate.usd.toFixed(4)}) exceeds fences.repair.max_usd_per_page ($${s.perPageUsd.toFixed(2)}). Raising it is the user's call: gbrain config set fences.repair.max_usd_per_page <usd>.`);
        continue;
      }
      const memo = await store.read(attemptCandidate(target, src.incarnation));
      if (memo && memo.memo === tier3Memo(target, model) && memo.state === 'rejected') {
        const reason = (memo.reason ?? 'still_invalid') as FenceReason;
        await keep({ item: name, reason, tier: 'manual', resolution: `${model}'s repair of these exact bytes was rejected (${reason}${memo.gate ? `, gate ${memo.gate}` : ''}); it is not retried until the file, the model or the rules change. `
          + `Fix row(s) ${(memo.rows ?? at.rows).join(', ') || '?'} by hand.`, ...(memo.gate ? { gate: memo.gate as GateLetter } : {}), ...(memo.rows ? { rows: memo.rows } : {}) });
        continue;
      }
      approved.push({ ...base, tier: 'llm', after: null, classes: [...new Set([...classesOf(analysis.fixes), ...reasons])].sort(), ...at, estimate_usd: estimate.usd, llm_waiting: 0 });
      llmItems.push({ item: name, rows: at.rows, reasons, estimate_usd: estimate.usd });
    }
    let waiting = 0;
    for (const entry of [...approved].reverse()) { if (entry.tier === 'llm') waiting++; entry.llm_waiting = entry.tier === 'llm' ? waiting : 0; }
    const sourcesRows = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
    const hash = previewHash({ kind: 'fences-v1', brain_id: scope.brain_id, sources: sourcesRows, selection, items: approved });
    if (approved.length && !opts?.apply) await saveApprovedSet<ApprovedSetItem>(engine, { command: 'fences', hash }, approved.map(entry => ({ ...entry, selection })));
    const partial = runs.some(run => !run.complete);
    const freshAt = runs.every(run => run.fresh_at) ? runs.map(run => run.fresh_at!).sort()[0] ?? null : null;
    const listing: RepairListing[] = [
      ...approved.map(entry => ({ item: itemName(entry), class: entry.tier, detail: `${entry.classes.join(', ')}${entry.rows.length ? `; rows ${entry.rows.join(', ')}` : ''}`
        + `${entry.tier === 'llm' ? `; rewritten by ${s.model} at apply time, gated by (a)-(g); est. $${entry.estimate_usd.toFixed(4)}` : ''}` })),
      ...held.map(entry => ({ item: entry.item, class: entry.reason, detail: entry.resolution })),
    ];
    const llmUsd = approved.reduce((sum, entry) => sum + entry.estimate_usd, 0);
    const apply = [...preview, ...(s.runMaxUsd !== null ? ['--max-usd', String(s.runMaxUsd)] : []), '--apply', '--expect', hash];
    const next_actions: Action[] = approved.length ? [{ argv: apply, consent: [], actor: 'agent', requires_exclusive: false, plan_hash: hash, preview_argv: preview,
      why: `Applies exactly the ${approved.length} previewed fence repair(s)${llmItems.length ? `, ${llmItems.length} of them by the model (estimated $${llmUsd.toFixed(4)})` : ''}; a file or page that changed since this preview is skipped.`,
      verify: { argv: ['gbrain', 'doctor', '--only', 'fence_integrity', '--json'] } }] : [];
    const counts = { deterministic: 0, resolver: 0, llm: 0, held: held.length };
    for (const entry of approved) counts[entry.tier]++;
    const details: FencesPreviewDetails = { counts, model: s.llmEnabled ? s.model : null, llm_enabled: s.llmEnabled,
      samples: Object.fromEntries((['deterministic', 'resolver'] as const).flatMap(tier => { const d = diffs.find(x => x.tier === tier); return d ? [[tier, d]] : []; })),
      diffs, llm_items: llmItems, held, caps: { max_usd_per_page: s.perPageUsd, max_usd_per_day: s.perDayUsd, day_remaining_usd: s.dayRemaining, run_max_usd: s.runMaxUsd }, next_actions };
    return { items: approved.map((entry, index) => item(entry, index, null, index === approved.length - 1, partial)), preview_hash: hash, residuals, listing,
      ...(warnings.length ? { warnings } : {}), details: details as unknown as Record<string, unknown>,
      llm: { usd: llmUsd, cap_remaining_usd: s.llmEnabled ? s.dayRemaining : 0 }, scan: { fresh_at: freshAt, partial } };
  },
  async apply(ctx, raw, opts): Promise<RepairItemOutcome> {
    if (ctx.remote !== false) throw trustedCliRequired('gbrain repair fences writes files and may call a paid model, so it runs only from the trusted local CLI or the maintenance job on the brain host.');
    const { entry, hash, last } = raw as FenceItem;
    try {
      return await applyFence(ctx, entry, { embed: opts?.embed === true, expect: hash, allowanceUsd: opts?.llmAllowanceUsd, deadline: opts?.deadline, noLlm: opts?.noLlm === true });
    } finally {
      if (hash && last) await clearApprovedSet(ctx.engine, { command: 'fences', hash });
      if (!hash) {
        const [brain] = await ctx.engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
        await saveRotation(ctx.engine, brain?.brain_id ?? 'host', rotationKey(entry)).catch(() => undefined);
      }
    }
  },
  render(details, opts) {
    const d = details as unknown as FencesPreviewDetails;
    const lines = [`  tiers: deterministic=${d.counts.deterministic}, resolver=${d.counts.resolver}, llm=${d.counts.llm}, held=${d.counts.held}`
      + `${d.llm_enabled ? `; model ${d.model}` : '; model repair off'}`];
    const capLine = `  model caps: $${d.caps.max_usd_per_page.toFixed(2)}/page, $${d.caps.max_usd_per_day.toFixed(2)}/day${d.caps.day_remaining_usd !== null ? ` ($${d.caps.day_remaining_usd.toFixed(4)} left today)` : ''}`
      + `${d.caps.run_max_usd !== null ? `; this run at most $${d.caps.run_max_usd.toFixed(4)}` : ''}`;
    if (d.counts.llm || d.held.some(h => h.tier === 'llm')) lines.push(capLine);
    const shown = opts.diff ? d.diffs : Object.values(d.samples);
    for (const diff of shown) lines.push(`  ${diff.tier}: ${diff.item} (${diff.classes.join(', ')})`, ...diff.diff.split('\n').map(line => `    ${line}`));
    if (!opts.diff && d.diffs.length > shown.length) lines.push(`  (one sample diff per tier; --diff or --json shows all ${d.diffs.length})`);
    for (const llm of d.llm_items) lines.push(`  llm: ${llm.item}${llm.rows.length ? ` rows ${llm.rows.join(', ')}` : ''} (${llm.reasons.join(', ')}): rewritten by ${d.model} at apply time, gated by (a)-(g); est. $${llm.estimate_usd.toFixed(4)}`);
    for (const h of d.held) lines.push(`  held ${h.item} [${h.reason}${h.gate ? `, gate ${h.gate}` : ''}]: ${h.resolution}`);
    for (const action of d.next_actions) lines.push(`  next: ${shellQuote(action.argv!)}`);
    return lines;
  },
  async report(ctx, scope, result, opts) {
    return reportFences(ctx, scope, result, opts);
  },
};

function digestOf(selection: Selection): string {
  return sha256(JSON.stringify([selection.source_ids, selection.only, selection.skip, selection.slugs, selection.no_llm]));
}

interface ApplyOptions { embed: boolean; expect: string | null; allowanceUsd?: number; deadline?: number; noLlm: boolean }

async function applyFence(ctx: OperationContext, entry: ApprovedFence, opts: ApplyOptions): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const where = { ...(entry.path ? { path: entry.path } : {}), slug: entry.slug, mode: entry.mode, tier: entry.tier };
  const moved = opts.expect ? 'changed_since_preview' : 'changed_since_read';
  const skipped = (reason: string, message: string): RepairItemOutcome => ({ applied: false, outcome: 'skipped', reason, detail: { ...where, message } });
  const src = await loadFenceSource(engine, entry.source_id, { remote: ctx.remote !== false });
  if (!src) return skipped(moved, `Source ${entry.source_id} is gone or archived.`);
  const heldOutcome = async (reason: string, message: string, extra: { gate?: GateLetter; rows?: number[]; next?: string | null; tier?: FenceTier } = {}): Promise<RepairItemOutcome> => {
    await recordHeld(engine, src, entry, { reason, ...extra });
    return { applied: false, outcome: 'held', reason, detail: { ...where, tier: extra.tier ?? heldTier(reason), message, ...(extra.gate ? { gate: extra.gate } : {}), ...(extra.rows?.length ? { rows: extra.rows } : {}) } };
  };
  if (src.owner) {
    const reason = ownerReason(src.owner);
    await recordHeld(engine, src, entry, { reason });
    const out = skipped(reason, src.owner.message);
    return { ...out, detail: { ...out.detail, why: src.owner.why, fix: src.owner.fix.argv, retryable: src.owner.retryable } };
  }
  // Re-checked here and again at the write's admission (file-repair.ts): a sync may have frozen this candidate since the plan.
  if (repairBusy(src.busy, { path: entry.path, slug: entry.slug })) {
    await recordHeld(engine, src, entry, { reason: 'sync_in_progress' });
    return skipped('sync_in_progress', repairBusyMessage(src.busy, src.id, entry.path ?? entry.slug));
  }
  const read = await readFenceTarget(engine, src, { key: entry.key, path: entry.path });
  if (!read.ok) return skipped(moved, `The candidate is ${read.reason === 'gone' ? 'gone' : read.reason}.`);
  const target = read.target;
  if (target.before !== entry.before || (target.snapshot?.revision ?? null) !== entry.revision && target.mode !== 'managed' && target.mode !== 'legacy') {
    return skipped(moved, `${entry.path ?? entry.slug} changed since it was ${opts.expect ? 'previewed' : 'read'}; preview again with gbrain repair fences --source ${src.id}.`);
  }
  const analysis = await analyzeFences(engine, target, { pageId: target.snapshot?.page.id ?? null });
  if (analysis.status === 'clean') return skipped('already_clean', `${entry.path ?? entry.slug} no longer has a malformed fence.`);
  if (analysis.status === 'manual') return heldOutcome(analysis.reason, analysis.resolution, { ...(analysis.gate ? { gate: analysis.gate } : {}), ...(analysis.rows ? { rows: analysis.rows } : {}) });
  if (analysis.status === 'proposal') {
    const bytes = afterBytes(target, analysis.after);
    if (opts.expect && bytes?.sha !== entry.after) return skipped('changed_since_preview', `The repair of ${entry.path ?? entry.slug} differs from the preview; preview again.`);
    return write(ctx, src, target, analysis.after, { tier: analysis.tier, classes: classesOf(analysis.fixes), ...fixLocation(analysis.fixes, []), model: null, cost: 0 }, opts, heldOutcome);
  }
  return tier3(ctx, src, target, analysis, entry, opts, heldOutcome);
}

type HeldFn = (reason: string, message: string, extra?: { gate?: GateLetter; rows?: number[]; next?: string | null; tier?: FenceTier }) => Promise<RepairItemOutcome>;

async function write(ctx: OperationContext, src: FenceSource, target: FenceTarget, after: FencePage,
  r: { tier: RepairTier; classes: string[]; rows: number[]; columns: string[]; model: string | null; cost: number | null }, opts: ApplyOptions, held: HeldFn): Promise<RepairItemOutcome> {
  const outcome = await writeFenceRepair(ctx, src, target, after, { actor: FENCE_REPAIR_ACTOR, tier: r.tier, classes: r.classes, rows: r.rows, columns: r.columns, model: r.model, cost_usd: r.cost },
    { embed: opts.embed });
  if (!outcome.ok) {
    if (outcome.reason === 'changed_since_read') return { applied: false, outcome: 'skipped', reason: 'changed_since_read', detail: { path: target.path, slug: target.slug, mode: target.mode, message: outcome.message } };
    if (outcome.reason === 'sync_in_progress') {
      await recordHeld(ctx.engine, src, { path: target.path, held: target.hold !== null }, { reason: 'sync_in_progress' });
      return { applied: false, outcome: 'skipped', reason: 'sync_in_progress', detail: { path: target.path, slug: target.slug, mode: target.mode, message: outcome.message } };
    }
    return held(outcome.reason, outcome.message, { tier: 'manual' });
  }
  return { applied: true, outcome: 'repaired', detail: { tier: r.tier, classes: r.classes.join(', '), slug: target.slug, ...outcome.detail }, ...(r.cost ? { llm_usd: r.cost } : {}) };
}

async function tier3(ctx: OperationContext, src: FenceSource, target: FenceTarget, analysis: Extract<FenceAnalysis, { status: 'llm' }>, entry: ApprovedFence, opts: ApplyOptions, held: HeldFn): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const s = await settings(engine, { noLlm: opts.noLlm, ...(opts.allowanceUsd !== undefined ? { maxLlmUsd: opts.allowanceUsd } : {}) });
  const rows = fixLocation(analysis.fixes, analysis.residual).rows;
  if (!s.llmEnabled) return held('llm_disabled', `Model repair is off; row(s) ${rows.join(', ')} stay held.`, { rows, tier: 'llm' });
  const model = s.model;
  if (!model) return held('no_measured_model', noMeasuredModel(rows), { rows, tier: 'llm' });
  if (s.perPageUsd === 0 || s.perDayUsd === 0) return held('budget_exhausted', 'Model repair spend is set to 0.', { rows, tier: 'llm' });
  const now = () => new Date();
  const timeoutMs = Math.max(5_000, Math.min(CALL_TIMEOUT_MS(), opts.deadline !== undefined ? opts.deadline - Date.now() : Infinity));
  const result = await runTier3(target, analysis, src.incarnation, { ledger: dailyLedger(engine, FENCE_REPAIR_LEDGER), store: attemptStore(engine), model, overrides: s.overrides,
    capSource: s.capSource, perPageUsd: s.perPageUsd, perDayUsd: s.perDayUsd, ...(opts.allowanceUsd !== undefined ? { allowanceUsd: opts.allowanceUsd } : {}), timeoutMs, now });
  if (!result.ok) {
    if (result.reason === 'claimed_elsewhere') return { applied: false, outcome: 'skipped', reason: 'claimed_elsewhere', detail: { path: target.path, slug: target.slug, message: result.message } };
    const next = result.reason === 'budget_exhausted' ? result.resetsAt ?? nextUtcMidnight(new Date()) : null;
    const out = await held(result.reason, result.message, { ...(result.gate ? { gate: result.gate } : {}), ...(result.rows ? { rows: result.rows } : {}), next, tier: FENCE_REASONS[result.reason]?.stage === 'gate' ? 'manual' : 'llm' });
    const withSpend = { ...out, ...(result.spentUsd ? { llm_usd: result.spentUsd } : {}), detail: { ...out.detail, ...(result.memoHit ? { memo: 'rejected_before' } : {}) } };
    if (!result.stop) return withSpend;
    const day = await dailyLedger(engine, FENCE_REPAIR_LEDGER).readDay().catch(() => null);
    const resets = result.resetsAt ?? nextUtcMidnight(new Date());
    const message = opts.allowanceUsd !== undefined && !result.resetsAt
      ? `Stopped: ${result.message} ${entry.llm_waiting} page(s) wait for the model. Rerun with a larger --max-usd, or leave them to the maintenance run.`
      : `Stopped: the daily fence-repair budget is spent ($${(day?.committedUsd ?? 0).toFixed(4)} of $${s.perDayUsd.toFixed(2)} today). It resets at ${resets}; `
        + `${entry.llm_waiting} page(s) wait for the model and the next run after that repairs them. Raising the cap is the user's call: gbrain config set fences.repair.max_usd_per_day <usd>.`;
    return { ...withSpend, stop: { reason: 'budget_exhausted', message, fix: { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
      why: `Model fence repair stopped at the daily cap; ${entry.llm_waiting} page(s) wait until ${resets} unless the cap is raised.`,
      user_message: `The daily model budget for fence repair ($${s.perDayUsd.toFixed(2)}) is spent and ${entry.llm_waiting} page(s) still wait. Raise it for today, or let them repair after ${resets}?`,
      inputs: [{ name: 'usd', how: 'The new daily cap in USD the user agrees to; it must exceed what is already spent today.' }],
      verify: { argv: ['gbrain', 'doctor', '--only', 'fence_integrity', '--json'] } } } };
  }
  const written = await write(ctx, src, target, result.after, { tier: 'llm', classes: classesOf(analysis.fixes, result.cleared), ...fixLocation(analysis.fixes, analysis.residual), model, cost: result.spentUsd },
    opts, held);
  const store = attemptStore(engine);
  if (written.applied) await store.publish(result.claim);
  else if (written.reason === 'changed_since_read' || written.reason === 'sync_in_progress') await store.transient(result.claim, written.reason);
  else await store.reject(result.claim, { reason: written.reason ?? 'still_invalid' });
  return { ...written, ...(result.spentUsd ? { llm_usd: result.spentUsd } : {}) };
}

/** Verification and the summary counts: what this run repaired by tier, what is left by reason, and the oldest hold. */
/** Candidates of the selection this run did not touch, by the reason they are held (the last repair's, else the census's). */
async function heldInScope(engine: BrainEngine, scope: RepairScope, opts: RepairPlanOptions, result: RepairResult): Promise<Record<string, number>> {
  const selection: Selection = { source_ids: scope.source_ids, only: opts.only ?? [], skip: opts.skip ?? [], slugs: opts.slugs ?? [], no_llm: opts.noLlm === true };
  const touched = new Set((result.outcome_items ?? []).map(outcome => outcome.item));
  const holds = new Map((await readGitSourceHolds(engine, { sourceIds: scope.source_ids })).flatMap(source => source.holds.map(hold => [`${hold.source_id}:${hold.path}`, hold] as const)));
  const out: Record<string, number> = {};
  for (const cand of await listFenceCandidates(engine, scope.source_ids)) {
    if (!selected(cand, selection) || touched.has(`${cand.source_id}:${cand.key}`)) continue;
    const hold = cand.path ? holds.get(`${cand.source_id}:${cand.path}`) : undefined;
    const reason = hold?.meta.fence_repair?.reason ?? cand.reasons[0] ?? 'unparseable';
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

async function reportFences(ctx: OperationContext, scope: RepairScope, result: RepairResult, opts: RepairPlanOptions) {
  const repairedByTier: Record<RepairTier, number> = { deterministic: 0, resolver: 0, llm: 0 };
  const remaining: Record<string, number> = {};
  for (const [reason, count] of Object.entries(result.residuals)) if (reason !== 'already_clean') remaining[reason] = (remaining[reason] ?? 0) + count;
  const repaired = result.mode === 'apply' ? result.outcomes?.repaired ?? 0 : 0;
  if (result.mode === 'apply') {
    for (const outcome of result.outcome_items ?? []) {
      if (outcome.outcome === 'repaired') { const tier = outcome.detail?.tier as RepairTier | undefined; if (tier) repairedByTier[tier]++; }
      else if (outcome.reason && outcome.reason !== 'already_clean') remaining[outcome.reason] = (remaining[outcome.reason] ?? 0) + 1;
    }
    const unattempted = result.affected - result.applied - result.skipped;
    if (unattempted > 0 && result.stopped) remaining[result.stopped.reason] = (remaining[result.stopped.reason] ?? 0) + unattempted;
    // An --expect apply replays the approved set only; re-check the selection for what the preview listed as held.
    if (opts.expect) for (const [reason, count] of Object.entries(await heldInScope(ctx.engine, scope, opts, result))) remaining[reason] = (remaining[reason] ?? 0) + count;
  } else if (result.affected) remaining.pending_repair = result.affected;
  const [oldest] = await ctx.engine.executeRaw<{ held_at: string | null }>(`SELECT min(completed_keys->0->>'held_at') AS held_at FROM op_checkpoints
    WHERE op='sync-hold' AND completed_keys->0->>'code'='invalid_fence' AND completed_keys->0->>'source_id'=ANY($1::text[])`, [scope.source_ids]).catch(() => [{ held_at: null }]);
  const llmRepairs = repairedByTier.llm;
  const spent = typeof result.cost.llm_usd === 'number' ? result.cost.llm_usd : 0;
  const verification: FenceRepairVerification = { candidates: result.affected + Object.values(result.residuals).reduce((a, b) => a + b, 0) - (result.residuals.already_clean ?? 0),
    repaired_by_tier: repairedByTier, held_by_reason: Object.fromEntries(Object.entries(remaining).filter(([reason]) => reason !== 'pending_repair')),
    oldest_hold_at: oldest?.held_at ?? null, llm_repairs: llmRepairs, llm_usd_per_repair: llmRepairs ? spent / llmRepairs : null, partial: result.scan?.partial ?? false };
  return { repaired, remaining, verification: verification as unknown as Record<string, unknown> };
}

