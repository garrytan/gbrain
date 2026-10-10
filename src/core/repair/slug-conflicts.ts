/**
 * `gbrain repair slug-conflicts` (#6377, Lane B): clears
 * `frontmatter_slug_conflict` sync holds (a file whose frontmatter `slug:`
 * names a page other than the one its path names) without a person, or
 * says exactly why a person is needed. `gbrain repair content` runs it after
 * `fences` for the same selection; the maintenance cycle and
 * `sync unblock --apply` run it with a bare `--apply`.
 *
 * Candidates: every `frontmatter_slug_conflict` hold of the sources in scope
 * (`--only <path>` / `--skip <path>` select, and `--only` also reaches an
 * unheld file that screens as a slug conflict now). Identity is resolved,
 * not textual (Codex #8): the declared slug is normalized the way the screen
 * does (`slugifyPath`), resolved through `slug_aliases`
 * (`readPageSnapshot` with `resolveAlias`) to a page in the same source; a
 * slug that resolves to the held file's own page is `already_exempt` and
 * never a candidate; a held file with no page yet (`page_id: null`) is a
 * normal candidate.
 *
 * Deterministic tier (confidence `high`, no model): `remove_slug` when the
 * named slug resolves to no page and names no file in the checkout (a stray
 * line from a template or a rename; nothing to merge into), or when the
 * named page has a different `type` and shares no title token with the held
 * file. The edit is exactly the `slug:` line (`autoFixFrontmatter` with the
 * file path, as `repair frontmatter` proposes it), and the result must
 * strict-parse with no hold. Everything else is `ambiguous` and goes to the
 * model at apply time (content-repair/llm.ts): the preview calls no model
 * and lists `model decides`, the estimated cost and the cap left.
 *
 * Model outcomes: `remove_slug` applies as above (confidence `medium`);
 * `merge_into` and `needs_human` write nothing: the hold records the verdict
 * as codes and slugs (`recordContentHoldRepair`, `merge_recommended` /
 * `content_repair_needs_human`) and `sync status` renders a paragraph for a
 * person. The model's `why` sentence appears in the run output only.
 * `--no-llm` (or `fences.repair.llm false`) holds model-tier candidates
 * `llm_disabled`; the per-page and daily caps, the run allowance and the
 * attempt memo work as the fence repair's (one lane, one budget).
 *
 * Publication: managed sources go through `prepareRepairPublication` and
 * `submitManagedFileRepair` with a `ContentRepairReceipt` (exact bytes bound
 * to the sha256 the plan read, import, hold clear and Git target effect in
 * one coordinated write; the commit reads `gbrain: repair frontmatter slug
 * in <path>` with the `gbrain-repair:` trailer); legacy sources back up,
 * write, import, clear the hold and print the commit step. Every candidate
 * passes the owner check and the `repairBusy` admission re-read, at plan,
 * at apply and again at the write (file-repair.ts). Messages carry paths,
 * slugs, codes and amounts only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { shellQuote, type Action } from '../agent-output.ts';
import { autoFixFrontmatter, createFrontmatterBackup, makeFrontmatterBackupRunId } from '../brain-writer.ts';
import { classifyImportHold, parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { MAX_FILE_SIZE } from '../import-screen.ts';
import { importFromFile } from '../import-file.ts';
import { resolveSlugForPath, slugifyPath } from '../sync.ts';
import { isReservedSkillBundlePath } from '../skill-reserved-paths.ts';
import { gbrainPath } from '../config.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER, nextUtcMidnight } from '../budget/daily-ledger.ts';
import { pricingSetCommand } from '../budget/no-pricing.ts';
import type { CapSource } from '../consent.ts';
import { sha256 } from '../persistence/digest.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { clearGitHold, readGitHold, readGitSourceHolds, recordContentHoldRepair, type ContentHoldRepairState, type GitHoldRecord } from '../persistence/sync-holds.ts';
import { confinedRepairTarget, prepareRepairPublication, repairScreenConfig, submitManagedFileRepair } from '../persistence/file-repair.ts';
import { repairBusy, repairBusyMessage } from '../persistence/repair-busy.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { attemptStore } from '../fence-repair/attempts.ts';
import { fenceRepairLlmEnabled, readFenceRepairCaps } from '../fence-repair/config.ts';
import { loadFenceSource, type FenceSource } from '../fence-repair/repair-io.ts';
import { judgmentParticipant, type JudgmentInput, type JudgmentVerdict } from '../content-repair/judgment.ts';
import { callJudgment, CONTENT_REPAIR_MODEL_KEY, judgmentEstimate, judgmentMemoReason, resolveContentRepairModel } from '../content-repair/llm.ts';
import { CONTENT_REPAIR_MEASURED_MODELS } from '../content-repair/measured.ts';
import { CONTENT_REPAIR_ACTOR, CONTENT_REPAIR_HOLD_CODE, contentRepairCommitSubject, contentRepairTrailer, type ContentRepairReceipt } from '../content-repair/receipt.ts';
import { contentPreviewArgv } from '../content-repair/hold-fix.ts';
import { lineDiff } from './frontmatter.ts';
import { repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairPlanOptions, type RepairResult, type RepairScope } from './core.ts';

type Tier = 'deterministic' | 'llm';
type DeterministicRule = 'absent_page' | 'different_type';
interface Selection { source_ids: string[]; only: string[]; skip: string[]; no_llm: boolean }

/** One previewed candidate: everything the hash binds (location, hashes, tier), never a frontmatter value. */
interface ApprovedConflict {
  source_id: string; path: string; source_path: string; slug: string; mode: 'managed' | 'legacy';
  page_id: number | null; revision: string | null; before: string; upstream_version: string | null; held: boolean;
  /** The slug the `slug:` line resolves to (alias followed), and that page's id and content hash; null when no page has it. */
  named: string | null; named_page_id: number | null; named_sha256: string | null;
  tier: Tier;
  /** Deterministic: the rule and the sha256 of the edited bytes; null for the model tier (decided at apply time). */
  rule: DeterministicRule | null; after: string | null;
  estimate_usd: number;
  /** Model items from this one to the end of the plan (the pages a budget stop leaves waiting). */
  llm_waiting: number;
}
interface ApprovedSetItem extends ApprovedConflict { selection: Selection }
interface ConflictItem extends RepairItem { entry: ApprovedConflict; hash: string | null; last: boolean }

interface HeldEntry { item: string; reason: string; tier: Tier | 'manual'; resolution: string }
export interface SlugConflictsPreviewDetails {
  counts: { deterministic: number; llm: number; held: number; skipped: number };
  model: string | null;
  llm_enabled: boolean;
  diffs: Array<{ item: string; rule: DeterministicRule; diff: string }>;
  llm_items: Array<{ item: string; named: string | null; estimate_usd: number }>;
  held: HeldEntry[];
  skipped: Array<{ item: string; reason: string }>;
  caps: { max_usd_per_page: number; max_usd_per_day: number; day_remaining_usd: number | null; run_max_usd: number | null };
  next_actions: Action[];
}

/** The slug-conflicts result's `verification` (report hook). */
export interface SlugConflictsVerification {
  candidates: number;
  repaired_by_tier: Record<Tier, number>;
  held_by_reason: Record<string, number>;
  oldest_hold_at: string | null;
  llm_judgments: number;
  llm_usd: number;
}

const CALL_TIMEOUT_MS = () => { const n = parseInt(process.env.GBRAIN_CONTENT_REPAIR_CALL_TIMEOUT_MS ?? process.env.GBRAIN_FENCE_REPAIR_CALL_TIMEOUT_MS ?? '', 10); return Number.isFinite(n) && n > 0 ? n : 90_000; };
/** How long a transient model failure waits before the maintenance run tries the candidate again. */
const RETRY_AFTER_MS = 24 * 3_600_000;
const TRANSIENT: ReadonlySet<string> = new Set(['llm_unavailable', 'ledger_unavailable', 'sync_in_progress', 'claimed_elsewhere', 'changed_since_read']);
const STOPWORDS: ReadonlySet<string> = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'mr', 'ms', 'dr']);

const itemName = (entry: Pick<ApprovedConflict, 'source_id' | 'path'>) => `${entry.source_id}:${entry.path}`;

function previewArgv(scope: RepairScope, selection: Selection): string[] {
  return ['gbrain', 'repair', 'slug-conflicts', ...(scope.source_ids.length === 1 ? ['--source', scope.source_ids[0]!] : []),
    ...selection.only.flatMap(path => ['--only', path]), ...selection.skip.flatMap(path => ['--skip', path]), ...(selection.no_llm ? ['--no-llm'] : [])];
}

/** Slugified title words, stopwords removed. */
export function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(word => word.length > 1 && !STOPWORDS.has(word)));
}

/** Git-visible Markdown under the root (tracked and untracked, ignored files excluded); a plain walk outside Git. */
function checkoutSlugs(root: string): Set<string> {
  let paths: string[];
  try {
    paths = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    paths = (readdirSync(root, { recursive: true }) as string[]).map(path => path.split('\\').join('/'));
  }
  const out = new Set<string>();
  for (const path of paths) {
    if (!/\.mdx?$/i.test(path) || path.split('/').some(part => part.startsWith('.')) || isReservedSkillBundlePath(path)) continue;
    out.add(slugifyPath(path)); out.add(resolveSlugForPath(path));
  }
  return out;
}

/** The declared `slug:` value of a file as written, or null when the frontmatter has none. */
function declaredSlug(content: string): string | null {
  const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[1];
  const line = block?.split(/\r?\n/).find(l => /^slug:\s*\S/.test(l));
  return line ? line.replace(/^slug:\s*/, '').trim().replace(/^["']|["']$/g, '') : null;
}

/** The slug a declared value is looked up by: as written, then as the screen normalizes it. */
function lookupSlugs(declared: string): string[] {
  return [...new Set([declared, slugifyPath(declared)])].filter(Boolean);
}

/**
 * The exact edit: the `slug:` line removed (with its line break) and nothing else. `autoFixFrontmatter` with the
 * file path decides that this is the one fix the file needs, as `repair frontmatter` proposes it; null when the
 * file needs other frontmatter changes too, or the result still fails to strict-parse or earns a hold.
 */
export function removeSlugLine(content: string, sourcePath: string, path: string, activePack?: FenceSource['activePack']): string | null {
  const fixed = autoFixFrontmatter(content, { filePath: sourcePath });
  if (fixed.fixes.length !== 1 || fixed.fixes[0]!.code !== 'SLUG_MISMATCH' || fixed.content === content) return null;
  const block = /^(\uFEFF?---[ \t]*(\r?\n))([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(content);
  if (!block) return null;
  const newline = block[2]!;
  const lines = block[3]!.split(/\r?\n/);
  const at = lines.findIndex(line => /^slug:\s*\S/.test(line));
  if (at < 0) return null;
  const after = `${block[1]}${[...lines.slice(0, at), ...lines.slice(at + 1)].join(newline)}${block[4]}${content.slice(block[0].length)}`;
  const parsed = parseMarkdown(after, path, { validate: true, ...(activePack ? { activePack } : {}) });
  if (parsed.errors?.some(error => error.code === 'YAML_PARSE')) return null;
  if (classifyImportHold(parsed, { expectedSlug: resolveSlugForPath(sourcePath), byteLength: Buffer.byteLength(after), maxBytes: MAX_FILE_SIZE })) return null;
  return after;
}

/** A stored page as the judgment shows it: serialized with its frontmatter, so both sides read alike. */
function pageContent(snapshot: PageSnapshot): string {
  return serializePageToMarkdown(snapshot.page, snapshot.tags);
}

interface Settings {
  llmEnabled: boolean; model: string | null; overrides: Awaited<ReturnType<typeof loadPricingOverrides>>; capSource: CapSource;
  perPageUsd: number; perDayUsd: number; dayRemaining: number | null; runMaxUsd: number | null;
}

async function settings(engine: BrainEngine, opts: Pick<RepairPlanOptions, 'noLlm' | 'maxLlmUsd'>): Promise<Settings> {
  const caps = await readFenceRepairCaps(engine);
  const day = await dailyLedger(engine, FENCE_REPAIR_LEDGER).readDay().catch(() => null);
  return { llmEnabled: !opts.noLlm && await fenceRepairLlmEnabled(engine), model: await resolveContentRepairModel(engine), overrides: await loadPricingOverrides(engine),
    capSource: caps.perPageSource === 'user' || caps.perDaySource === 'user' || opts.maxLlmUsd !== undefined ? 'user' : 'default',
    perPageUsd: caps.perPageUsd, perDayUsd: caps.perDayUsd, dayRemaining: day ? Math.max(0, caps.perDayUsd - day.committedUsd - day.reservedUsd) : null, runMaxUsd: opts.maxLlmUsd ?? null };
}

/** Held because no measured model has a key: the exact choice the user makes. */
function noMeasuredModel(path: string): string {
  return `No model measured for the slug-conflict judgment has a provider key here (${CONTENT_REPAIR_MEASURED_MODELS.join(', ')}) and ${CONTENT_REPAIR_MODEL_KEY} is unset, so ${path} stays held. `
    + `Decide the slug by hand, or ask the user which model to trust, then: gbrain config set ${CONTENT_REPAIR_MODEL_KEY} <provider:model>.`;
}

/** One candidate's current state, read from the checkout and the page store. */
interface Candidate {
  src: FenceSource; path: string; sourcePath: string; slug: string; hold: GitHoldRecord | null; content: string; before: string;
  snapshot: PageSnapshot | null; declared: string; named: PageSnapshot | null; namedSlug: string | null;
}

type Analysis =
  | { status: 'skip'; reason: 'already_exempt' | 'already_clean' | 'gone' | 'unsafe_path' | 'not_utf8'; message: string }
  | { status: 'deterministic'; rule: DeterministicRule; after: string }
  | { status: 'llm'; input: JudgmentInput }
  | { status: 'held'; reason: string; message: string };

async function readCandidate(engine: BrainEngine, src: FenceSource, path: string): Promise<{ ok: true; cand: Candidate } | { ok: false; reason: 'gone' | 'unsafe_path' | 'not_utf8' | 'no_checkout' }> {
  if (!src.root) return { ok: false, reason: 'no_checkout' };
  const abs = join(src.root, path);
  if (!existsSync(abs)) return { ok: false, reason: 'gone' };
  try { confinedRepairTarget(src.root, path, src.id, 'content'); } catch (error) {
    if (error instanceof OperationError) return { ok: false, reason: 'unsafe_path' };
    throw error;
  }
  const bytes = readFileSync(abs);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) return { ok: false, reason: 'not_utf8' };
  const hold = await readGitHold(engine, src.id, src.incarnation, path);
  const sourcePath = hold?.source_path ?? path;
  const [byOrigin] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND source_path=$2 AND deleted_at IS NULL LIMIT 1', [src.id, sourcePath]);
  const slug = byOrigin?.slug ?? hold?.slug ?? resolveSlugForPath(sourcePath);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: src.id, includeDeleted: true });
  const declared = declaredSlug(content) ?? '';
  let named: PageSnapshot | null = null;
  for (const lookup of lookupSlugs(declared)) {
    named = await engine.readPageSnapshot(lookup, { sourceId: src.id, resolveAlias: true });
    if (named) break;
  }
  return { ok: true, cand: { src, path, sourcePath, slug, hold, content, before: sha256(bytes), snapshot: snapshot && !snapshot.page.deleted_at ? snapshot : null, declared,
    named, namedSlug: named?.page.slug ?? null } };
}

/** The free tier over a candidate: exempt, clean, a deterministic edit, or the model's question. */
function analyze(cand: Candidate, slugsInCheckout: () => Set<string>): Analysis {
  const expected = resolveSlugForPath(cand.sourcePath);
  if (!cand.declared || cand.declared === expected || slugifyPath(cand.declared) === expected) {
    return { status: 'skip', reason: 'already_clean', message: `${cand.path} no longer declares a conflicting slug; the next gbrain sync --source ${cand.src.id} --no-pull clears its hold.` };
  }
  const own = cand.named && ((cand.hold?.page_id !== null && cand.hold?.page_id !== undefined && cand.named.page.id === cand.hold.page_id)
    || (cand.named.page.source_path != null && cand.named.page.source_path === cand.sourcePath) || (cand.snapshot !== null && cand.named.page.id === cand.snapshot.page.id));
  if (own) return { status: 'skip', reason: 'already_exempt', message: `The slug: line of ${cand.path} resolves to the file's own page (${cand.named!.page.slug}); nothing to repair.` };
  const after = () => removeSlugLine(cand.content, cand.sourcePath, cand.path, cand.src.activePack);
  if (!cand.named) {
    const inCheckout = lookupSlugs(cand.declared).some(slug => slugsInCheckout().has(slug));
    if (!inCheckout) {
      const edited = after();
      return edited === null ? { status: 'held', reason: 'still_invalid', message: `Removing the slug: line of ${cand.path} alone does not make it importable (the frontmatter needs other changes too); preview gbrain repair frontmatter --source ${cand.src.id} --only ${cand.path} --include-ambiguous.` }
        : { status: 'deterministic', rule: 'absent_page', after: edited };
    }
  } else {
    const parsed = parseMarkdown(cand.content, cand.path, cand.src.activePack ? { activePack: cand.src.activePack } : undefined);
    const shared = [...titleTokens(parsed.title)].some(token => titleTokens(cand.named!.page.title ?? '').has(token));
    if (parsed.type !== cand.named.page.type && !shared) {
      const edited = after();
      return edited === null ? { status: 'held', reason: 'still_invalid', message: `Removing the slug: line of ${cand.path} alone does not make it importable (the frontmatter needs other changes too); preview gbrain repair frontmatter --source ${cand.src.id} --only ${cand.path} --include-ambiguous.` }
        : { status: 'deterministic', rule: 'different_type', after: edited };
    }
  }
  if (after() === null) return { status: 'held', reason: 'still_invalid', message: `Removing the slug: line of ${cand.path} alone would not make it importable, so no model is asked; preview gbrain repair frontmatter --source ${cand.src.id} --only ${cand.path} --include-ambiguous.` };
  const held = judgmentParticipant({ path: cand.path, slug: cand.slug, content: cand.content, otherSlug: cand.namedSlug });
  const named = cand.named ? judgmentParticipant({ path: cand.named.page.source_path ?? null, slug: cand.named.page.slug, content: pageContent(cand.named), otherSlug: cand.slug, type: cand.named.page.type }) : null;
  return { status: 'llm', input: { held, named, reason: 'frontmatter_slug_conflict' } };
}

const nextAttempt = (reason: string, resetsAt?: string): string | null => reason === 'budget_exhausted' ? resetsAt ?? nextUtcMidnight(new Date()) : TRANSIENT.has(reason) ? new Date(Date.now() + RETRY_AFTER_MS).toISOString() : null;

async function recordState(engine: BrainEngine, cand: Pick<Candidate, 'src' | 'path' | 'hold'>, state: Omit<ContentHoldRepairState, 'at'>): Promise<void> {
  if (!cand.hold) return;
  await recordContentHoldRepair(engine, { sourceId: cand.src.id, incarnation: cand.src.incarnation, path: cand.path, upstreamVersion: cand.hold.upstream_version,
    state: { ...state, at: new Date().toISOString() } }).catch(() => false);
}

function item(entry: ApprovedConflict, index: number, hash: string | null, last: boolean): ConflictItem {
  return { cursor: { phase: 1, id: index + 1 }, source_id: entry.source_id, slug: entry.path, chars: 0, action: `${entry.tier}:${entry.path}`,
    ...(entry.tier === 'llm' ? { llm_usd: entry.estimate_usd } : {}), entry, hash, last };
}

function digestOf(selection: Selection): string {
  return sha256(JSON.stringify([selection.source_ids, selection.only, selection.skip, selection.no_llm]));
}

/** The candidates of the selection: held paths, plus `--only` files that screen as a slug conflict now. */
async function candidatePaths(engine: BrainEngine, src: FenceSource, selection: Selection): Promise<{ paths: string[]; unknown: string[] }> {
  const holds = ((await readGitSourceHolds(engine, { sourceIds: [src.id] }))[0]?.holds ?? []).filter(hold => hold.code === 'frontmatter_slug_conflict').map(hold => hold.path);
  const paths = new Set(holds.filter(path => (!selection.only.length || selection.only.includes(path)) && !selection.skip.includes(path)));
  const unknown: string[] = [];
  for (const path of selection.only) {
    if (paths.has(path) || selection.skip.includes(path)) continue;
    const abs = src.root ? join(src.root, path) : null;
    if (!abs || !existsSync(abs) || !lstatSync(abs).isFile()) { unknown.push(path); continue; }
    const content = readFileSync(abs, 'utf8');
    const hold = classifyImportHold(parseMarkdown(content, path, { validate: true }), { expectedSlug: resolveSlugForPath(path), byteLength: Buffer.byteLength(content), maxBytes: MAX_FILE_SIZE });
    if (hold?.code === 'frontmatter_slug_conflict') paths.add(path); else unknown.push(path);
  }
  return { paths: [...paths].sort(), unknown };
}


/** The hash a preview of this selection prints when it finds nothing to repair. */
async function emptyPlanHash(engine: BrainEngine, scope: RepairScope, selection: Selection): Promise<string> {
  const sourcesRows = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return previewHash({ kind: 'slug-conflicts-v1', brain_id: scope.brain_id, sources: sourcesRows, selection, items: [] });
}

export const slugConflictsRepair: RepairHandler = {
  kind: 'slug-conflicts',
  outcomeItemsLimit: 1000,
  async plan(engine, scope, _after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, only: [...(opts?.only ?? [])].sort(), skip: [...(opts?.skip ?? [])].sort(), no_llm: opts?.noLlm === true };
    const preview = previewArgv(scope, selection);
    if (opts?.apply && opts.expect) {
      // #6377: a preview that found nothing saved no set; its hash still binds "nothing to apply" (the content lane passes one hash per kind).
      if (opts.expect === await emptyPlanHash(engine, scope, selection)) return { items: [], preview_hash: opts.expect, residuals: {}, llm: { usd: 0, cap_remaining_usd: null } };
      const approved = await loadApprovedSet<ApprovedSetItem>(engine, { command: 'slug-conflicts', hash: opts.expect, previewCommand: shellQuote(preview) });
      if (approved.items.some(entry => digestOf(entry.selection) !== digestOf(selection))) throw previewChangedError(opts.expect, shellQuote(preview));
      const items = approved.items.map(({ selection: _chosen, ...entry }, index) => item(entry, index, opts.expect!, index === approved.items.length - 1));
      const s = await settings(engine, opts);
      return { items, preview_hash: opts.expect, residuals: {}, llm: { usd: items.reduce((sum, i) => sum + (i.llm_usd ?? 0), 0), cap_remaining_usd: s.llmEnabled ? s.dayRemaining : 0 } };
    }
    const s = await settings(engine, opts ?? { noLlm: false });
    const residuals: Record<string, number> = {};
    const warnings: string[] = [];
    const approved: ApprovedConflict[] = [];
    const diffs: SlugConflictsPreviewDetails['diffs'] = [];
    const held: HeldEntry[] = [];
    const skipped: SlugConflictsPreviewDetails['skipped'] = [];
    const llmItems: SlugConflictsPreviewDetails['llm_items'] = [];
    let unpricedWarned = false;
    for (const sourceId of scope.source_ids) {
      const src = await loadFenceSource(engine, sourceId, { remote: opts?.remote !== false, work: 'content repair' });
      if (!src) continue;
      const { paths, unknown } = await candidatePaths(engine, src, selection);
      warnings.push(...unknown.map(path => `--only ${path}: no held or conflicting file at that path in ${sourceId}; check the source-relative path.`));
      let slugs: Set<string> | null = null;
      const slugsInCheckout = () => (slugs ??= src.root ? checkoutSlugs(src.root) : new Set<string>());
      for (const path of paths) {
        const name = `${sourceId}:${path}`;
        const keep = async (entry: Omit<HeldEntry, 'item'>, state?: Omit<ContentHoldRepairState, 'at'>) => {
          held.push({ item: name, ...entry }); residuals[entry.reason] = (residuals[entry.reason] ?? 0) + 1;
          if (opts?.apply && state) await recordState(engine, { src, path, hold: await readGitHold(engine, src.id, src.incarnation, path) }, state);
        };
        const skip = (reason: string) => { skipped.push({ item: name, reason }); residuals[reason] = (residuals[reason] ?? 0) + 1; };
        if (src.owner) { await keep({ reason: src.owner.reason, tier: 'manual', resolution: `${src.owner.message} ${src.owner.why}` }); continue; }
        if (src.mirror) { await keep({ reason: 'mirror_read_only', tier: 'manual', resolution: `${path} belongs to a read-only mirror, so gbrain does not edit its file; remove the slug: line where the source is written.` }); continue; }
        if (repairBusy(src.busy, { path })) { await keep({ reason: 'sync_in_progress', tier: 'manual', resolution: repairBusyMessage(src.busy, src.id, path) }); continue; }
        const read = await readCandidate(engine, src, path);
        if (!read.ok) {
          if (read.reason === 'gone' || read.reason === 'no_checkout') { skip(read.reason === 'gone' ? 'gone' : 'local_path_missing'); continue; }
          await keep({ reason: read.reason, tier: 'manual', resolution: read.reason === 'unsafe_path'
            ? `${path} is a symlink, sits under one, or resolves outside the source root; gbrain never writes through one. Replace it with the real file.`
            : `${path} is not valid UTF-8; re-save it as UTF-8 and preview again.` });
          continue;
        }
        const cand = read.cand;
        const analysis = analyze(cand, slugsInCheckout);
        if (analysis.status === 'skip') { skip(analysis.reason); continue; }
        if (analysis.status === 'held') { await keep({ reason: analysis.reason, tier: 'manual', resolution: analysis.message }, { action: 'remove_slug', reason: analysis.reason, next_attempt_after: null }); continue; }
        const base: Omit<ApprovedConflict, 'tier' | 'rule' | 'after' | 'estimate_usd' | 'llm_waiting'> = { source_id: src.id, path, source_path: cand.sourcePath, slug: cand.slug, mode: src.managed ? 'managed' : 'legacy',
          page_id: cand.snapshot?.page.id ?? null, revision: cand.snapshot?.revision ?? null, before: cand.before, upstream_version: cand.hold?.upstream_version ?? null, held: cand.hold !== null,
          named: cand.namedSlug, named_page_id: cand.named?.page.id ?? null, named_sha256: cand.named ? sha256(pageContent(cand.named)) : null };
        if (analysis.status === 'deterministic') {
          approved.push({ ...base, tier: 'deterministic', rule: analysis.rule, after: sha256(Buffer.from(analysis.after, 'utf8')), estimate_usd: 0, llm_waiting: 0 });
          diffs.push({ item: name, rule: analysis.rule, diff: lineDiff(path, cand.content, analysis.after) });
          continue;
        }
        const pending = (reason: string, resolution: string, next: string | null = null) => keep({ reason, tier: 'llm', resolution }, { action: 'pending', reason, ...(cand.namedSlug ? { named: cand.namedSlug } : {}),
          ...(s.model ? { model: s.model } : {}), next_attempt_after: next });
        if (!s.llmEnabled) {
          await pending('llm_disabled', `Model repair is off (${selection.no_llm ? '--no-llm' : 'fences.repair.llm false'}), so ${path} stays held: whether it and ${cand.namedSlug ?? 'the page its slug: line names'} are the same page needs a judgment. `
            + 'Decide by hand, or ask the user before turning model repair on: gbrain config set fences.repair.llm true.');
          continue;
        }
        if (!s.model) { await pending('no_measured_model', noMeasuredModel(path)); continue; }
        const estimate = judgmentEstimate(analysis.input, { model: s.model, overrides: s.overrides, capSource: s.capSource });
        if (!estimate.ok) { await pending('no_pricing', `A spend cap is set but gbrain has no price for ${s.model}. ${estimate.guidance.lookup} Register it with: ${estimate.guidance.register_command}`); continue; }
        if (estimate.estimated && !unpricedWarned) {
          unpricedWarned = true;
          warnings.push(`gbrain has no price for the content-repair model ${s.model}; the judgment runs under the default caps and is metered at an estimated ceiling (the highest chat rate gbrain knows). Make it exact with: ${pricingSetCommand(s.model, 'chat')}`);
        }
        if (s.perPageUsd === 0 || s.perDayUsd === 0) {
          const key = s.perPageUsd === 0 ? 'page' : 'day';
          await pending('budget_exhausted', `Model repair spend is set to 0 (fences.repair.max_usd_per_${key}), so ${path} stays held. Raising it is the user's call: gbrain config set fences.repair.max_usd_per_${key} <usd>.`, nextUtcMidnight(new Date()));
          continue;
        }
        if (estimate.usd > s.perPageUsd + 1e-9) {
          await pending('budget_exhausted', `The estimated judgment cost ($${estimate.usd.toFixed(4)}) exceeds fences.repair.max_usd_per_page ($${s.perPageUsd.toFixed(2)}). Raising it is the user's call: gbrain config set fences.repair.max_usd_per_page <usd>.`);
          continue;
        }
        approved.push({ ...base, tier: 'llm', rule: null, after: null, estimate_usd: estimate.usd, llm_waiting: 0 });
        llmItems.push({ item: name, named: cand.namedSlug, estimate_usd: estimate.usd });
      }
    }
    let waiting = 0;
    for (const entry of [...approved].reverse()) { if (entry.tier === 'llm') waiting++; entry.llm_waiting = entry.tier === 'llm' ? waiting : 0; }
    const sourcesRows = await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
    const hash = previewHash({ kind: 'slug-conflicts-v1', brain_id: scope.brain_id, sources: sourcesRows, selection, items: approved });
    if (approved.length && !opts?.apply) await saveApprovedSet<ApprovedSetItem>(engine, { command: 'slug-conflicts', hash }, approved.map(entry => ({ ...entry, selection })));
    const listing: RepairListing[] = [
      ...approved.map(entry => ({ item: itemName(entry), class: entry.tier, detail: entry.tier === 'deterministic' ? `remove_slug (${entry.rule}): the slug: line is removed; the path decides the slug`
        : `model decides (${s.model}) at apply time: remove_slug, merge_into ${entry.named ?? '?'} or needs_human; est. $${entry.estimate_usd.toFixed(4)}` })),
      ...held.map(entry => ({ item: entry.item, class: entry.reason, detail: entry.resolution })),
      ...skipped.map(entry => ({ item: entry.item, class: entry.reason })),
    ];
    const llmUsd = approved.reduce((sum, entry) => sum + entry.estimate_usd, 0);
    const apply = [...preview, ...(s.runMaxUsd !== null ? ['--max-usd', String(s.runMaxUsd)] : []), '--apply', '--expect', hash];
    const next_actions: Action[] = approved.length ? [{ argv: apply, consent: [], actor: 'agent', requires_exclusive: false, plan_hash: hash, preview_argv: preview,
      why: `Applies exactly the ${approved.length} previewed slug-conflict repair(s)${llmItems.length ? `, ${llmItems.length} of them judged by the model (estimated $${llmUsd.toFixed(4)}; a recommended merge or an undecidable pair writes nothing and is recorded on the hold)` : ''}; a file that changed since this preview is skipped.`,
      verify: { argv: ['gbrain', 'sources', 'status', ...(scope.source_ids.length === 1 ? [scope.source_ids[0]!] : []), '--json'] } }] : [];
    const counts = { deterministic: approved.filter(e => e.tier === 'deterministic').length, llm: llmItems.length, held: held.length, skipped: skipped.length };
    const details: SlugConflictsPreviewDetails = { counts, model: s.llmEnabled ? s.model : null, llm_enabled: s.llmEnabled, diffs, llm_items: llmItems, held, skipped,
      caps: { max_usd_per_page: s.perPageUsd, max_usd_per_day: s.perDayUsd, day_remaining_usd: s.dayRemaining, run_max_usd: s.runMaxUsd }, next_actions };
    return { items: approved.map((entry, index) => item(entry, index, null, index === approved.length - 1)), preview_hash: hash, residuals, listing,
      ...(warnings.length ? { warnings } : {}), details: details as unknown as Record<string, unknown>, llm: { usd: llmUsd, cap_remaining_usd: s.llmEnabled ? s.dayRemaining : 0 } };
  },
  async apply(ctx, raw, opts): Promise<RepairItemOutcome> {
    if (ctx.remote !== false) throw trustedCliRequired('gbrain repair slug-conflicts writes files and may call a paid model, so it runs only from the trusted local CLI or the maintenance job on the brain host.');
    const { entry, hash, last } = raw as ConflictItem;
    try {
      return await applyConflict(ctx, entry, { embed: opts?.embed === true, expect: hash, allowanceUsd: opts?.llmAllowanceUsd, deadline: opts?.deadline, noLlm: opts?.noLlm === true });
    } finally {
      if (hash && last) await clearApprovedSet(ctx.engine, { command: 'slug-conflicts', hash });
    }
  },
  render(details, opts) {
    const d = details as unknown as SlugConflictsPreviewDetails;
    const lines = [`  tiers: deterministic=${d.counts.deterministic}, model=${d.counts.llm}, held=${d.counts.held}, skipped=${d.counts.skipped}${d.llm_enabled ? `; model ${d.model}` : '; model repair off'}`];
    if (d.counts.llm || d.held.some(h => h.tier === 'llm')) {
      lines.push(`  model caps: $${d.caps.max_usd_per_page.toFixed(2)}/page, $${d.caps.max_usd_per_day.toFixed(2)}/day${d.caps.day_remaining_usd !== null ? ` ($${d.caps.day_remaining_usd.toFixed(4)} left today)` : ''}`
        + `${d.caps.run_max_usd !== null ? `; this run at most $${d.caps.run_max_usd.toFixed(4)}` : ''}`);
    }
    const shown = opts.diff ? d.diffs : d.diffs.slice(0, 1);
    for (const diff of shown) lines.push(`  deterministic: ${diff.item} (remove_slug, ${diff.rule})`, ...diff.diff.split('\n').map(line => `    ${line}`));
    if (!opts.diff && d.diffs.length > shown.length) lines.push(`  (one sample diff; --diff or --json shows all ${d.diffs.length})`);
    for (const llm of d.llm_items) lines.push(`  model decides: ${llm.item}${llm.named ? ` vs page ${llm.named}` : ' (no page has the named slug)'}: remove_slug, merge_into or needs_human at apply time; est. $${llm.estimate_usd.toFixed(4)}`);
    for (const h of d.held) lines.push(`  held ${h.item} [${h.reason}]: ${h.resolution}`);
    for (const s of d.skipped) lines.push(`  skipped ${s.item} [${s.reason}]`);
    for (const action of d.next_actions) lines.push(`  next: ${shellQuote(action.argv!)}`);
    return lines;
  },
  async report(ctx, scope, result) {
    return reportConflicts(ctx, scope, result);
  },
};

interface ApplyOptions { embed: boolean; expect: string | null; allowanceUsd?: number; deadline?: number; noLlm: boolean }

async function applyConflict(ctx: OperationContext, entry: ApprovedConflict, opts: ApplyOptions): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const where = { path: entry.path, slug: entry.slug, mode: entry.mode, tier: entry.tier, ...(entry.named ? { named: entry.named } : {}) };
  const moved = opts.expect ? 'changed_since_preview' : 'changed_since_read';
  const skipped = (reason: string, message: string): RepairItemOutcome => ({ applied: false, outcome: 'skipped', reason, detail: { ...where, message } });
  const src = await loadFenceSource(engine, entry.source_id, { remote: false, work: 'content repair' });
  if (!src) return skipped(moved, `Source ${entry.source_id} is gone or archived.`);
  const hold = await readGitHold(engine, src.id, src.incarnation, entry.path);
  const held = async (reason: string, message: string, state: Omit<ContentHoldRepairState, 'at'> | null, extra: Record<string, unknown> = {}): Promise<RepairItemOutcome> => {
    if (state) await recordState(engine, { src, path: entry.path, hold }, state);
    return { applied: false, outcome: 'held', reason, detail: { ...where, message, ...extra } };
  };
  if (src.owner) {
    const out = skipped(src.owner.reason, src.owner.message);
    return { ...out, detail: { ...out.detail, why: src.owner.why, fix: src.owner.fix.argv, retryable: src.owner.retryable } };
  }
  if (src.mirror) return held('mirror_read_only', `${entry.path} belongs to a read-only mirror, so gbrain does not edit its file.`, null);
  // Re-checked here and again at the write's admission (file-repair.ts): a sync may have frozen this candidate since the plan.
  if (repairBusy(src.busy, { path: entry.path, slug: entry.slug })) {
    await recordState(engine, { src, path: entry.path, hold }, { action: 'pending', reason: 'sync_in_progress', next_attempt_after: nextAttempt('sync_in_progress') });
    return skipped('sync_in_progress', repairBusyMessage(src.busy, src.id, entry.path));
  }
  const read = await readCandidate(engine, src, entry.path);
  if (!read.ok) return skipped(moved, `${entry.path} is ${read.reason === 'gone' ? 'gone' : read.reason}.`);
  const cand = read.cand;
  if (cand.before !== entry.before || (cand.named ? sha256(pageContent(cand.named)) : null) !== entry.named_sha256 || (cand.named?.page.id ?? null) !== entry.named_page_id) {
    return skipped(moved, `${entry.path} or the page its slug: line names changed since it was ${opts.expect ? 'previewed' : 'read'}; preview again with ${shellQuote(contentPreviewArgv(src.id, entry.path))}.`);
  }
  let slugs: Set<string> | null = null;
  const analysis = analyze(cand, () => (slugs ??= src.root ? checkoutSlugs(src.root) : new Set<string>()));
  if (analysis.status === 'skip') return skipped(analysis.reason, analysis.message);
  if (analysis.status === 'held') return held(analysis.reason, analysis.message, { action: 'remove_slug', reason: analysis.reason, next_attempt_after: null });
  if (analysis.status === 'deterministic') {
    if (opts.expect && sha256(Buffer.from(analysis.after, 'utf8')) !== entry.after) return skipped('changed_since_preview', `The repair of ${entry.path} differs from the preview; preview again.`);
    return write(ctx, src, cand, analysis.after, { tier: 'deterministic', confidence: 'high', model: null, cost_usd: 0 }, opts, held, { rule: analysis.rule });
  }
  return judge(ctx, src, cand, analysis.input, entry, opts, held);
}

type HeldFn = (reason: string, message: string, state: Omit<ContentHoldRepairState, 'at'> | null, extra?: Record<string, unknown>) => Promise<RepairItemOutcome>;

/** Writes the edited file through the source's path with its receipt; the hold clears in the same write (managed) or right after the import (legacy). */
async function write(ctx: OperationContext, src: FenceSource, cand: Candidate, after: string, parts: Pick<ContentRepairReceipt, 'tier' | 'confidence' | 'model' | 'cost_usd'>, opts: ApplyOptions, held: HeldFn,
  extra: Record<string, unknown>): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const local = { ...ctx, remote: false, sourceId: src.id } as OperationContext;
  const receipt: ContentRepairReceipt = { actor: CONTENT_REPAIR_ACTOR, hold_code: CONTENT_REPAIR_HOLD_CODE, action: 'remove_slug', ...parts, before_sha256: cand.before, after_sha256: sha256(Buffer.from(after, 'utf8')) };
  const detail = { path: cand.path, slug: cand.slug, action: 'remove_slug', tier: parts.tier, confidence: parts.confidence, ...(cand.namedSlug ? { named: cand.namedSlug } : {}), ...extra };
  const spend = parts.cost_usd ? { llm_usd: parts.cost_usd } : {};
  if (src.managed) {
    const config = await repairScreenConfig(engine, src.id);
    const publication = await prepareRepairPublication(engine, { sourceId: src.id, slug: cand.slug, sourcePath: cand.sourcePath, path: cand.path, root: src.root!, content: after,
      snapshot: cand.snapshot, base: cand.snapshot, ...config });
    if (publication.status === 'refused') return held(publication.refusal.code === 'frontmatter_slug_conflict' ? 'still_invalid' : publication.refusal.code, `Importing the repaired ${cand.path} would be refused (${publication.refusal.code}), so nothing was written.`,
      { action: 'remove_slug', reason: 'still_invalid', next_attempt_after: null }, spend);
    if (publication.status === 'overlay') return held('canonical_overlay', `Importing the repaired ${cand.path} would keep page data the file does not carry (tags added outside the file, a withdrawal or sanitized text), so nothing was written. `
      + `Edit the file by hand to carry them (gbrain get --source ${src.id} -- ${cand.slug} shows the page), remove the slug: line, and commit.`, { action: 'remove_slug', reason: 'canonical_overlay', next_attempt_after: null }, spend);
    try {
      const outcome = await submitManagedFileRepair(local, { sourceId: src.id, requestId: await repairRequestId(local, 'slug-conflicts', { source_id: src.id, slug: cand.slug }, `${receipt.before_sha256}:${receipt.after_sha256}`),
        slug: cand.slug, path: cand.path, sourcePath: cand.sourcePath, content: after, beforeHash: cand.before, resultDigest: publication.digest,
        ...(cand.snapshot ? { expected_revision: cand.snapshot.revision } : {}), noEmbed: !opts.embed, contentRepair: receipt });
      const persistence = outcome.persistence as { git_state?: string } | undefined;
      return { applied: true, outcome: 'repaired', detail: { ...detail, mode: 'managed', imported: outcome.status, hold_cleared: outcome.hold_cleared === true, committed: persistence?.git_state ?? 'not_requested' }, ...spend };
    } catch (error) {
      if (error instanceof OperationError && ['changed_since_preview', 'revision_conflict', 'page_identity_changed', 'source_changed'].includes(error.code)) {
        return { applied: false, outcome: 'skipped', reason: 'changed_since_read', detail: { ...detail, message: `${cand.path} changed while it was being repaired; the next run reads it again.` }, ...spend };
      }
      if (error instanceof OperationError && error.code === 'sync_in_progress') {
        await recordState(engine, { src, path: cand.path, hold: cand.hold }, { action: 'pending', reason: 'sync_in_progress', next_attempt_after: nextAttempt('sync_in_progress') });
        return { applied: false, outcome: 'skipped', reason: 'sync_in_progress', detail: { ...detail, message: error.message }, ...spend };
      }
      throw error;
    }
  }
  const root = src.root!;
  let abs: string;
  try { abs = confinedRepairTarget(root, cand.path, src.id, 'content'); } catch (error) {
    if (error instanceof OperationError) return held('unsafe_path', `${cand.path} is a symlink, sits under one, or resolves outside the source root; gbrain never writes through one.`, null, spend);
    throw error;
  }
  if (sha256(readFileSync(abs)) !== cand.before) return { applied: false, outcome: 'skipped', reason: 'changed_since_read', detail: { ...detail, message: `${cand.path} changed after the repair read it, so nothing was written.` }, ...spend };
  const backup = createFrontmatterBackup(abs, { sourcePath: root, backupRoot: gbrainPath('backups', 'content-repair', makeFrontmatterBackupRunId()) });
  writeFileSync(abs, after);
  const imported = await importFromFile(engine, abs, cand.sourcePath, { sourceId: src.id, noEmbed: !opts.embed });
  if (imported.status === 'error' || imported.refusal) {
    writeFileSync(abs, cand.content);
    return held('still_invalid', `The repaired ${cand.path} did not import (${imported.refusal?.code ?? 'error'}), so the file was restored from its backup.`, { action: 'remove_slug', reason: 'still_invalid', next_attempt_after: null }, spend);
  }
  const holdCleared = cand.hold ? await clearGitHold(engine, { sourceId: src.id, incarnation: src.incarnation, path: cand.path, observedAt: new Date().toISOString() }) : false;
  const commitStep = `git -C ${shellQuote([root])} add -- ${shellQuote([cand.path])} && git -C ${shellQuote([root])} commit -m ${shellQuote([contentRepairCommitSubject(cand.path)])} -m ${shellQuote([contentRepairTrailer(receipt)])} -- ${shellQuote([cand.path])}`;
  return { applied: true, outcome: 'repaired', detail: { ...detail, mode: 'legacy', backup, imported: imported.status, hold_cleared: holdCleared, content_repair: receipt, committed: 'commit_step', commit_step: commitStep }, ...spend };
}

/** The model tier for one candidate: the metered judgment, then the verdict's action. */
async function judge(ctx: OperationContext, src: FenceSource, cand: Candidate, input: JudgmentInput, entry: ApprovedConflict, opts: ApplyOptions, held: HeldFn): Promise<RepairItemOutcome> {
  const engine = ctx.engine;
  const s = await settings(engine, { noLlm: opts.noLlm, ...(opts.allowanceUsd !== undefined ? { maxLlmUsd: opts.allowanceUsd } : {}) });
  const named = cand.namedSlug ? { named: cand.namedSlug } : {};
  const pending = (reason: string, message: string, next: string | null, extra: Record<string, unknown> = {}) => held(reason, message, { action: 'pending', reason, ...named, ...(s.model ? { model: s.model } : {}), next_attempt_after: next }, extra);
  if (!s.llmEnabled) return pending('llm_disabled', `Model repair is off, so ${cand.path} stays held: whether it and ${cand.namedSlug ?? 'the page its slug: line names'} are the same page needs a judgment.`, null);
  const model = s.model;
  if (!model) return pending('no_measured_model', noMeasuredModel(cand.path), null);
  if (s.perPageUsd === 0 || s.perDayUsd === 0) return pending('budget_exhausted', 'Model repair spend is set to 0.', nextUtcMidnight(new Date()));
  const timeoutMs = Math.max(5_000, Math.min(CALL_TIMEOUT_MS(), opts.deadline !== undefined ? opts.deadline - Date.now() : Infinity));
  const result = await callJudgment(engine, model, input, { sourceId: src.id, incarnation: src.incarnation, path: cand.path,
    memo: { heldSha256: cand.before, namedSha256: entry.named_sha256, heldPageId: cand.snapshot?.page.id ?? null, namedPageId: entry.named_page_id },
    overrides: s.overrides, capSource: s.capSource, perPageUsd: s.perPageUsd, perDayUsd: s.perDayUsd, ...(opts.allowanceUsd !== undefined ? { allowanceUsd: opts.allowanceUsd } : {}), timeoutMs });
  const store = attemptStore(engine);
  if (!result.ok) {
    const spend = result.spentUsd ? { llm_usd: result.spentUsd } : {};
    if (result.reason === 'claimed_elsewhere') return { applied: false, outcome: 'skipped', reason: 'claimed_elsewhere', detail: { path: cand.path, slug: cand.slug, message: result.message }, ...spend };
    if (result.memoHit && result.reason === 'remove_slug') return write(ctx, src, cand, removeSlugLine(cand.content, cand.sourcePath, cand.path, src.activePack)!, { tier: 'llm', confidence: 'medium', model, cost_usd: 0 }, opts, held, { memo: 'judged_before' });
    if (result.memoHit) {
      const state = cand.hold?.meta.content_repair;
      const out = await held(result.reason, result.message, state && state.reason === result.reason ? null : { action: result.reason === 'merge_recommended' ? 'merge_into' : result.reason === 'content_repair_needs_human' ? 'needs_human' : 'pending',
        reason: result.reason, ...named, model, next_attempt_after: null }, { memo: 'judged_before' });
      return { ...out, ...spend };
    }
    const next = nextAttempt(result.reason, result.resetsAt);
    const out = await pending(result.reason, result.message, next, { ...(result.guidance ? { guidance: result.guidance } : {}) });
    if (!result.stop) return { ...out, ...spend };
    const day = await dailyLedger(engine, FENCE_REPAIR_LEDGER).readDay().catch(() => null);
    const resets = result.resetsAt ?? nextUtcMidnight(new Date());
    const message = opts.allowanceUsd !== undefined && !result.resetsAt
      ? `Stopped: ${result.message} ${entry.llm_waiting} file(s) wait for the model. Rerun with a larger --max-usd, or leave them to the maintenance run.`
      : `Stopped: the daily content-repair budget is spent ($${(day?.committedUsd ?? 0).toFixed(4)} of $${s.perDayUsd.toFixed(2)} today). It resets at ${resets}; `
        + `${entry.llm_waiting} file(s) wait for the model and the next run after that judges them. Raising the cap is the user's call: gbrain config set fences.repair.max_usd_per_day <usd>.`;
    return { ...out, ...spend, stop: { reason: 'budget_exhausted', message, fix: { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
      why: `The content-repair lane stopped at the daily cap it shares with fence repair; ${entry.llm_waiting} file(s) wait until ${resets} unless the cap is raised.`,
      user_message: `The daily model budget for content repair ($${s.perDayUsd.toFixed(2)}) is spent and ${entry.llm_waiting} file(s) still wait. Raise it for today, or let them repair after ${resets}?`,
      inputs: [{ name: 'usd', how: 'The new daily cap in USD the user agrees to; it must exceed what is already spent today.' }],
      verify: { argv: ['gbrain', 'sources', 'status', src.id, '--json'] } } } };
  }
  const verdict: JudgmentVerdict = result.verdict;
  const spend = result.spentUsd ? { llm_usd: result.spentUsd } : {};
  const why = verdict.why ? { why: verdict.why } : {};
  if (verdict.action === 'remove_slug') {
    const after = removeSlugLine(cand.content, cand.sourcePath, cand.path, src.activePack);
    if (after === null) { await store.reject(result.claim, { reason: 'still_invalid' }); return held('still_invalid', `The model chose remove_slug for ${cand.path}, but removing the line alone does not make it importable.`, { action: 'remove_slug', reason: 'still_invalid', model, next_attempt_after: null }, { ...why, ...spend }); }
    const written = await write(ctx, src, cand, after, { tier: 'llm', confidence: 'medium', model, cost_usd: result.spentUsd }, opts, held, why);
    if (written.applied) await store.publish(result.claim);
    else if (written.reason === 'changed_since_read' || written.reason === 'sync_in_progress') await store.transient(result.claim, written.reason);
    else await store.reject(result.claim, { reason: written.reason ?? 'still_invalid' });
    return written;
  }
  const reason = judgmentMemoReason(verdict);
  await store.reject(result.claim, { reason });
  const type = verdict.action === 'merge_into' ? cand.named?.page.type ?? parseMarkdown(cand.content, cand.path).type : undefined;
  const state: Omit<ContentHoldRepairState, 'at'> = { action: verdict.action, reason, ...(verdict.action === 'merge_into' ? { canonical: verdict.canonical } : {}), ...named, ...(type ? { type } : {}), model, next_attempt_after: null };
  const message = verdict.action === 'merge_into'
    ? `The model judged ${cand.path} and page ${cand.namedSlug ?? verdict.canonical} to be the same page; ${verdict.canonical} keeps the slug. gbrain does not merge pages by itself yet, so nothing was written; a person merges them (gbrain sources status ${src.id} shows the paragraph).`
    : `The model could not decide whether ${cand.path} and ${cand.namedSlug ?? 'the page its slug: line names'} are the same page, so nothing was written; a person decides which keeps the slug.`;
  return { ...await held(reason, message, state, { action: verdict.action, ...(verdict.action === 'merge_into' ? { canonical: verdict.canonical } : {}), ...why, tier: 'llm' }), ...spend };
}

async function reportConflicts(ctx: OperationContext, scope: RepairScope, result: RepairResult) {
  const repairedByTier: Record<Tier, number> = { deterministic: 0, llm: 0 };
  const remaining: Record<string, number> = {};
  const skips = new Set(['already_clean', 'already_exempt', 'gone']);
  for (const [reason, count] of Object.entries(result.residuals)) if (!skips.has(reason)) remaining[reason] = (remaining[reason] ?? 0) + count;
  const repaired = result.mode === 'apply' ? result.outcomes?.repaired ?? 0 : 0;
  let judgments = 0;
  if (result.mode === 'apply') {
    for (const outcome of result.outcome_items ?? []) {
      if (outcome.outcome === 'repaired') { const tier = outcome.detail?.tier as Tier | undefined; if (tier) repairedByTier[tier]++; if (tier === 'llm') judgments++; }
      else if (outcome.reason && !skips.has(outcome.reason)) { remaining[outcome.reason] = (remaining[outcome.reason] ?? 0) + 1; if (outcome.detail?.tier === 'llm') judgments++; }
    }
    const unattempted = result.affected - result.applied - result.skipped;
    if (unattempted > 0 && result.stopped) remaining[result.stopped.reason] = (remaining[result.stopped.reason] ?? 0) + unattempted;
  } else if (result.affected) remaining.pending_repair = result.affected;
  const [oldest] = await ctx.engine.executeRaw<{ held_at: string | null }>(`SELECT min(completed_keys->0->>'held_at') AS held_at FROM op_checkpoints
    WHERE op='sync-hold' AND completed_keys->0->>'code'='frontmatter_slug_conflict' AND completed_keys->0->>'source_id'=ANY($1::text[])`, [scope.source_ids]).catch(() => [{ held_at: null }]);
  const verification: SlugConflictsVerification = { candidates: result.affected + Object.entries(result.residuals).filter(([reason]) => !skips.has(reason)).reduce((a, [, b]) => a + b, 0),
    repaired_by_tier: repairedByTier, held_by_reason: Object.fromEntries(Object.entries(remaining).filter(([reason]) => reason !== 'pending_repair')), oldest_hold_at: oldest?.held_at ?? null,
    llm_judgments: judgments, llm_usd: typeof result.cost.llm_usd === 'number' ? result.cost.llm_usd : 0 };
  return { repaired, remaining, verification: verification as unknown as Record<string, unknown> };
}
