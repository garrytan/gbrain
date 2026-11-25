/**
 * The shadow evidence the swap readiness check reads (plan a1; src/core/engine-swap/readiness.ts `ShadowStatus`):
 * `reads`, `search.trigram_exact_disagreements`, `search.keyword_title` and `child`, folded from the ledger, the usage
 * files and the fault history of the CURRENT evidence epoch (evidence-epoch.ts). Rows of another epoch, or of none,
 * count for nothing, so a new Rust build starts every count over.
 *
 * Missing evidence is absent, never zero: no epoch manifest, an unreadable or corrupt ledger or usage file (a torn LAST
 * line is skipped), no operation class used, or a search arm with no comparisons leaves that field out, and readiness
 * reads an absent field as NOT READY. The same holds for `privacy_diverged` (no comparison yet, or a privacy check in the
 * last 7 days that could not be settled) and for `search.vector_recall_at_10` / `search.primary_recall_at_10` (fewer than
 * `RECALL_MIN_SAMPLES` scored samples in the epoch; recall.ts).
 *
 * Counting rules (the lane owner's rulings):
 *   - successful = a `match` or a `collation_order` (explained: same rows in the C byte order Rust follows); stale,
 *     inconclusive, order_diff, errors and dropped attempts are not coverage.
 *   - every operation class used in the epoch is listed, with 0 successes when none compared; each needs
 *     `MIN_SUCCESSFUL_PER_OP` (an engineering default, printed with the status); readiness keeps the 10,000 total.
 *   - every rust_error (error, timeout, addon_unavailable) in the epoch's last 7 days is unresolved; only a new epoch clears it.
 *   - until the stable rerun exists, every inconclusive mismatch on an exactness comparison (exactness.ts) counts as
 *     unexplained, as does a `diff` (which will mean "diverged after rerun"); stale does not.
 *   - child.panics = `rust_internal_error` faults plus SIGABRT child exits; child.faults = child_exit + spawn_failed.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ShadowOutcome } from './classify.ts';
import { readEpoch, type EpochBuild, type EpochManifest } from './evidence-epoch.ts';
import { exactnessArm, RANKED_PRIVATE_EXCEPTION, SHADOW_KEYWORD_RANKER } from './exactness.ts';
import { ledgerDir, readAllFaults, readJsonlStrict, type ShadowLedgerRow } from './ledger.ts';
import { readEpochRecall, RECALL_MIN_SAMPLES } from './recall.ts';
import { zeroUsage, type OpUsage } from './mirror.ts';
import { readEpochUsage } from './usage.ts';

/** Successful comparisons each operation class used in the epoch needs. An engineering default, not a measured bound. */
export const MIN_SUCCESSFUL_PER_OP = 100;
/** Criterion 1's duration (readiness.ts MIN_SHADOW_DAYS); callers pass the duration their policy gives. */
export const DEFAULT_READINESS_DAYS = 14;
export const RUST_ERROR_RULE = 'every rust_error (error, timeout, addon_unavailable) in the last 7 days of the epoch counts as unresolved; only a new epoch clears it';
export const PANICS_LABEL = 'panics or internal errors (conservative)';

const DAY_MS = 86_400_000;

export interface EvidenceStatus {
  reads?: {
    ops: Array<{ op: string; successful: number; minimum: number }>;
    capability_missing_7d: number;
    rust_error_unresolved_7d: number;
    diverged_unexplained_7d: number;
  };
  search?: {
    trigram_exact_disagreements?: number;
    keyword_title?: { ranker: typeof SHADOW_KEYWORD_RANKER; exact_disagreements: number };
    vector_recall_at_10?: number;
    primary_recall_at_10?: number;
  };
  privacy_diverged?: number;
  child?: { panics: number; faults: number };
  /** The epoch and the rules the counts follow; printed by the status and the report. Absent without an epoch. */
  evidence?: {
    epoch_id: string;
    epoch_started_at: string;
    readiness_days: number;
    earliest_ready_at: string;
    min_successful_per_op: number;
    rust_error_rule: string;
    panics_label: string;
    /** The build that opened the epoch (commit, version, addon target); absent when the epoch predates the field: unknown, never guessed. */
    build?: EpochBuild;
    /** Comparisons per operation class explained as `collation_order` (exactness.ts), in the epoch; they also count as successful. */
    collation_order: Record<string, number>;
    /** `<op> <successful>/<minimum>` for each class under the minimum. */
    ops_lacking_samples: string[];
    /** Calls per operation class in the epoch, including those never compared. */
    usage: Record<string, OpUsage>;
    /** Vector recall samples scored in the epoch (the fields need `RECALL_MIN_SAMPLES`), and Rust's mean overlap with the primary's top ten (agreement, not recall). */
    recall_samples: number;
    /** The score files cannot be read whole, or hold a record that is not a recall record: the recall fields stay absent. */
    recall_unavailable: boolean;
    vector_overlap_with_primary?: number;
    /** What counts into `diverged_unexplained_7d`, with the one exception (exactness.ts); printed with the count. */
    unexplained_rule: string;
    /** Accepted ranked-search diffs (every extra Rust row passed the per-row privacy check), per member: reported, not counted as unexplained. */
    ranking_differences: Record<string, number>;
    /** Samples whose privacy check could not be settled in the last 7 days; any of them leaves `privacy_diverged` absent. */
    privacy_checks_unsettled_7d: number;
  };
}

export interface EvidenceOptions {
  dir: string;
  now?: Date;
  /** The epoch manifest; default read from `<dir>/evidence/epoch.json`. */
  epoch?: EpochManifest | null;
  /** Days of shadowing criterion 1 needs; default 14. */
  readinessDays?: number;
}

/** The outcomes that settle the privacy question of a private read: a completed comparison with an outcome (`stale` is the lagged mismatch). `order_diff` settles only because the child's judge (child.ts) turns any non-clean privacy verdict into `inconclusive` or `privacy_diverged` before it can be written. Not `inconclusive`, `capability_missing`, `error`, `timeout`, `addon_unavailable`. */
export const PRIVACY_SETTLING_OUTCOMES = ['match', 'order_diff', 'collation_order', 'diff', 'privacy_diverged', 'stale'] as const satisfies readonly ShadowOutcome[];

const COMPARED = new Set(['match', 'order_diff', 'diff', 'stale', 'inconclusive', 'collation_order']);
const RUST_ERRORS = new Set(['error', 'timeout', 'addon_unavailable']);

interface ReadFold {
  matches: Map<string, number>;
  collation: Map<string, number>;
  ops: Set<string>;
  capability_missing_7d: number;
  rust_error_unresolved_7d: number;
  diverged_unexplained_7d: number;
  compared: number;
  /** Accepted ranked-search diffs per member (the exception), never dropped silently. */
  ranking_differences: Record<string, number>;
  privacy_rows: number;
  privacy_unsettled_7d: number;
  arms: { trigram: { compared: number; bad: number }; keyword_title: { compared: number; bad: number } };
}

/** Folds the epoch's ledger rows one file at a time; null when a ledger file cannot be read whole. */
function foldLedger(dir: string, epoch: EpochManifest, now: number): ReadFold | null {
  const fold: ReadFold = {
    matches: new Map(), collation: new Map(), ops: new Set(), capability_missing_7d: 0, rust_error_unresolved_7d: 0, diverged_unexplained_7d: 0,
    compared: 0, ranking_differences: {}, privacy_rows: 0, privacy_unsettled_7d: 0, arms: { trigram: { compared: 0, bad: 0 }, keyword_title: { compared: 0, bad: 0 } },
  };
  const root = ledgerDir(dir);
  if (!existsSync(root)) return fold;
  // A row is written under the day of its capture, which can precede the epoch's start by the queue's delay.
  const firstDay = new Date(Date.parse(epoch.started_at) - DAY_MS).toISOString().slice(0, 10);
  let names: string[];
  try { names = readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= firstDay).sort(); } catch { return null; } // silent-read-ok: null is the unreadable marker; reads stay absent, never zero
  const pending = new Map<string, ShadowLedgerRow>();
  const closed = new Set<string>();
  const count = (r: ShadowLedgerRow): void => {
    fold.ops.add(r.op);
    const t = Date.parse(r.ts);
    const recent = !(t < now - 7 * DAY_MS); // an unreadable time counts as recent: fail closed
    const arm = exactnessArm(r.op);
    const rerunDone = r.rerun === 'matched' || r.rerun === 'differed';
    // A ranked vector search counts only for a read under excludePrivate, and not when every extra row passed the check (the one exception).
    const accepted = arm === 'private_ranked' && r.outcome === 'diff' && r.reason === 'extra_rows_cleared';
    const diffCounts = arm !== 'private_ranked' || (r.private_read === true && !accepted);
    const unexplained = arm !== null && ((r.outcome === 'diff' && diffCounts) || (r.outcome === 'inconclusive' && r.rerun !== 'matched'));
    const leak = r.outcome === 'privacy_diverged'; // a row the caller may not read is never explained: criterion 3 fails with criterion 6
    if (accepted) fold.ranking_differences[r.op] = (fold.ranking_differences[r.op] ?? 0) + 1;
    if (COMPARED.has(r.outcome)) fold.compared++;
    if (r.outcome === 'privacy_diverged') fold.privacy_rows++;
    // The privacy question of a read made under excludePrivate is open by default, and only an ALLOWLIST settles it: a row of such a read settles it when a rerun completed
    // (matched or differed), or when its outcome is one that completed a comparison (PRIVACY_SETTLING_OUTCOMES) and no rerun is pending or skipped. Everything else is open,
    // whatever reason it carries or lacks, including an outcome nobody has written yet. A reason alone also opens it (older rows without the private-read marker).
    const settled = rerunDone || ((PRIVACY_SETTLING_OUTCOMES as readonly string[]).includes(r.outcome) && r.rerun !== 'pending' && !r.rerun?.startsWith('skipped:'));
    const open = r.private_read === true && !settled;
    if (recent && !rerunDone && (open || (r.outcome === 'inconclusive' && (r.reason?.startsWith('privacy_check_') || r.rerun?.startsWith('skipped:privacy_check_'))))) fold.privacy_unsettled_7d++;
    if (r.outcome === 'match' || r.outcome === 'collation_order') fold.matches.set(r.op, (fold.matches.get(r.op) ?? 0) + 1);
    if (r.outcome === 'collation_order') fold.collation.set(r.op, (fold.collation.get(r.op) ?? 0) + 1);
    if (recent && r.outcome === 'capability_missing') fold.capability_missing_7d++;
    if (recent && RUST_ERRORS.has(r.outcome)) fold.rust_error_unresolved_7d++;
    if (recent && (unexplained || leak)) fold.diverged_unexplained_7d++;
    if ((arm === 'trigram' || arm === 'keyword_title') && COMPARED.has(r.outcome)) {
      fold.arms[arm].compared++;
      if (unexplained) fold.arms[arm].bad++;
    }
  };
  for (const name of names) {
    const rows = readJsonlStrict<ShadowLedgerRow>(join(root, name));
    if (rows === null) return null;
    for (const r of rows) {
      if (r?.epoch_id !== epoch.epoch_id || typeof r.op !== 'string') continue;
      // An unresolved row (`rerun: 'pending'`) is written before its rerun starts and is replaced by the completion row with the
      // same sample id; one that never gets a completion (a crash, a restart) is counted as it stands: unexplained.
      const sid = typeof r.sid === 'string' ? r.sid : null;
      if (sid && r.rerun === 'pending') { if (!closed.has(sid)) pending.set(sid, r); continue; }
      if (sid) { closed.add(sid); pending.delete(sid); }
      count(r);
    }
  }
  for (const r of pending.values()) count(r);
  return fold;
}

/** Child health from the whole fault history, in the epoch. A fault with no epoch tag counts when it is not older than the epoch. */
function foldChild(dir: string, epoch: EpochManifest): { panics: number; faults: number; privacy_pauses: number } | null {
  const faults = readAllFaults(dir);
  if (faults === null) return null;
  const started = Date.parse(epoch.started_at);
  let panics = 0;
  let count = 0;
  let pauses = 0;
  for (const f of faults) {
    if (!(f?.epoch_id !== undefined ? f.epoch_id === epoch.epoch_id : Date.parse(f?.ts) >= started)) continue;
    if (f.kind === 'rust_internal_error') panics++;
    else if (f.kind === 'child_exit') { count++; if (/signal=SIGABRT|code=134\b/.test(f.detail ?? '')) panics++; }
    else if (f.kind === 'spawn_failed') count++;
    // The child's own pause record (`op=...`, tagged with its epoch: one per child session). The serving process writes a second line for the
    // same pause, tagged by the manifest and not by the child, so it cannot tell a client of another owner (which counts nothing).
    else if (f.kind === 'privacy_pause' && f.epoch_id === epoch.epoch_id && /^op=/.test(f.detail ?? '')) pauses++;
  }
  return { panics, faults: count, privacy_pauses: pauses };
}

/** The `reads`, `search` and `child` fields of the status document, plus the `evidence` block the status prints. */
export function buildEvidenceStatus(o: EvidenceOptions): EvidenceStatus {
  const now = (o.now ?? new Date()).getTime();
  const epoch = o.epoch === undefined ? readEpoch(o.dir) : o.epoch;
  if (!epoch) return {};
  const out: EvidenceStatus = {};
  const days = o.readinessDays ?? DEFAULT_READINESS_DAYS;
  const usageLines = readEpochUsage(o.dir, epoch.epoch_id);
  const fold = usageLines === null ? null : foldLedger(o.dir, epoch, now);
  const usage: Record<string, OpUsage> = {};
  for (const line of usageLines ?? []) {
    for (const [op, u] of Object.entries(line.ops)) {
      const into = (usage[op] ??= zeroUsage());
      for (const key of Object.keys(into) as Array<keyof OpUsage>) into[key] += Number(u?.[key]) || 0;
    }
  }
  let lacking: string[] = [];
  const collation: Record<string, number> = fold ? Object.fromEntries([...fold.collation].sort(([a], [b]) => (a < b ? -1 : 1))) : {};
  if (fold) {
    const ops = [...new Set([...Object.keys(usage), ...fold.ops])].sort().map((op) => ({ op, successful: fold.matches.get(op) ?? 0, minimum: MIN_SUCCESSFUL_PER_OP }));
    lacking = ops.filter((r) => r.successful < r.minimum).map((r) => `${r.op} ${r.successful}/${r.minimum}`);
    if (ops.length > 0) {
      out.reads = {
        ops, capability_missing_7d: fold.capability_missing_7d, rust_error_unresolved_7d: fold.rust_error_unresolved_7d,
        diverged_unexplained_7d: fold.diverged_unexplained_7d,
      };
    }
    if (fold.compared + fold.privacy_rows > 0 && fold.privacy_unsettled_7d === 0) out.privacy_diverged = fold.privacy_rows;
    const search: NonNullable<EvidenceStatus['search']> = {};
    if (fold.arms.trigram.compared > 0) search.trigram_exact_disagreements = fold.arms.trigram.bad;
    if (fold.arms.keyword_title.compared > 0) search.keyword_title = { ranker: SHADOW_KEYWORD_RANKER, exact_disagreements: fold.arms.keyword_title.bad };
    if (Object.keys(search).length > 0) out.search = search;
  }
  const child = foldChild(o.dir, epoch);
  if (child) {
    out.child = { panics: child.panics, faults: child.faults };
    if (out.privacy_diverged !== undefined) out.privacy_diverged = Math.max(out.privacy_diverged, child.privacy_pauses);
  }
  const recall = readEpochRecall(o.dir, epoch.epoch_id);
  const mean = (pick: (l: { vector: number; primary: number; overlap: number }) => number): number => recall!.reduce((n, l) => n + pick(l), 0) / recall!.length;
  if (recall && recall.length >= RECALL_MIN_SAMPLES) out.search = { ...out.search, vector_recall_at_10: mean((l) => l.vector), primary_recall_at_10: mean((l) => l.primary) };
  const started = Date.parse(epoch.started_at);
  out.evidence = {
    epoch_id: epoch.epoch_id, epoch_started_at: epoch.started_at, readiness_days: days,
    earliest_ready_at: new Date(started + days * DAY_MS).toISOString(), min_successful_per_op: MIN_SUCCESSFUL_PER_OP,
    rust_error_rule: RUST_ERROR_RULE, panics_label: PANICS_LABEL, ops_lacking_samples: lacking, usage, collation_order: collation,
    ...(epoch.build ? { build: epoch.build } : {}),
    recall_samples: recall?.length ?? 0, recall_unavailable: recall === null, ...(recall?.length ? { vector_overlap_with_primary: mean((l) => l.overlap) } : {}),
    privacy_checks_unsettled_7d: fold?.privacy_unsettled_7d ?? 0,
    unexplained_rule: RANKED_PRIVATE_EXCEPTION, ranking_differences: fold?.ranking_differences ?? {},
  };
  return out;
}

/** The status and report lines for the evidence: the epoch and earliest READY date, each count, and the rules behind them. */
export function renderEvidenceStatus(s: EvidenceStatus): string[] {
  const e = s.evidence;
  if (!e) return ['  evidence epoch: none yet (the shadow child opens one when it starts on a seeded store); read, search and child evidence are missing'];
  const lines = [`  evidence epoch ${e.epoch_id}: started ${e.epoch_started_at}; earliest READY ${e.earliest_ready_at.slice(0, 10)} (${e.readiness_days} days after the start, if every other criterion passes)`];
  const b = e.build;
  lines.push(b ? `  build: commit ${b.gbrain_commit ?? 'unknown (unstamped build)'}, gbrain ${b.gbrain_version}, addon target ${b.addon_target ?? 'unknown'}` : '  build: not recorded (the epoch began before the build fields; consumers treat it as unknown)');
  if (!s.reads) lines.push('  reads: no evidence (no operation class used yet, or the ledger or usage files cannot be read)');
  else {
    lines.push(`  reads: ${s.reads.ops.reduce((n, r) => n + r.successful, 0)} successful over ${s.reads.ops.length} operation classes; each class needs ${e.min_successful_per_op} successful comparisons (an engineering default)`);
    for (const l of e.ops_lacking_samples) {
      const u = e.usage[l.split(' ')[0]!];
      lines.push(`    lacking samples: ${l}${u ? ` (offered ${u.offered}, sampled out ${u.sampled_out}, shed ${u.shed}, in transaction ${u.skipped_in_transaction}, unmirrorable ${u.unmirrorable})` : ''}`);
    }
    lines.push(`  unresolved rust_error in the last 7 days: ${s.reads.rust_error_unresolved_7d} (${e.rust_error_rule})`);
    lines.push(`  unexplained diverged in the last 7 days: ${s.reads.diverged_unexplained_7d}; capability_missing in the last 7 days: ${s.reads.capability_missing_7d}`);
    lines.push(`    rule: ${e.unexplained_rule}`);
    const ranked = Object.entries(e.ranking_differences).map(([op, n]) => `${op} ${n}`);
    lines.push(`  ranking differences accepted under that exception (reported, not unexplained): ${ranked.length ? ranked.join(', ') : 'none'}`);
  }
  lines.push(s.privacy_diverged === undefined
    ? `  privacy: no evidence (nothing compared yet, or ${e.privacy_checks_unsettled_7d} privacy check(s) in the last 7 days could not be settled)`
    : `  privacy: ${s.privacy_diverged} divergence(s) (a Rust row the caller may not read, judged by the primary's read policy)`);
  const recall = (v: number | undefined): string => (v === undefined ? 'no evidence' : v.toFixed(3));
  lines.push(e.recall_unavailable ? '  vector recall@10: unavailable (a score file cannot be read whole, or holds a record that is not a recall record)' : `  vector recall@10 (exact reference on the primary): Rust ${recall(s.search?.vector_recall_at_10)}, primary ${recall(s.search?.primary_recall_at_10)}; ${e.recall_samples} scored sample(s) (needs ${RECALL_MIN_SAMPLES})${e.vector_overlap_with_primary === undefined ? '' : `; Rust's overlap with the primary ${e.vector_overlap_with_primary.toFixed(3)}`}`);
  const collation = Object.entries(e.collation_order).map(([op, n]) => `${op} ${n}`);
  if (collation.length) lines.push(`  collation_order (explained and counted as successful: same rows, in the C byte order Rust follows; ICU and glibc hosts sort differently): ${collation.join(', ')}`);
  const arm = (name: string, v: number | undefined): string => `${name} ${v ?? 'no comparisons'}`;
  lines.push(`  search disagreements: ${arm('trigram', s.search?.trigram_exact_disagreements)}; ${arm(`keyword/title (${SHADOW_KEYWORD_RANKER})`, s.search?.keyword_title?.exact_disagreements)}`);
  lines.push(s.child ? `  child: ${e.panics_label} ${s.child.panics}; faults (exits, failed spawns) ${s.child.faults}` : '  child: no fault evidence (the fault history cannot be read)');
  return lines;
}
