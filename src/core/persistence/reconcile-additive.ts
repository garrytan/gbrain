import type { ParsedPage } from '../import-file.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { OperationError } from '../ops/contract.ts';
import { digest } from './digest.ts';
import { ACTIVITY_DATE_KEY as ACTIVITY_DATE } from '../contact-rows.ts';
import { protectedReconcileKey, type ReconcileConflict, type ReconcileDecision } from './reconcile-merge.ts';

/**
 * #5974: structural classification of file/database drift. It proves only
 * structure, never truth: an inserted line can still contradict an older one,
 * so inserted text is `suggested` (an explicit operator acceptance applies it)
 * while only append-only contact lists (whose existing rows may advance an
 * activity date, #8109) and allowlisted activity dates are `auto`. Everything else is `review`. Pure; no I/O.
 */
export const ADDITIVE_RULE_VERSION = 1;
export type AdditiveRule = 'text_insertion_only' | 'contacts_append_only' | 'contacts_activity_advance' | 'activity_date_advance' | 'file_only_field' | 'database_only_kept';
export type DriftClass = 'auto' | 'suggested' | 'review';
export interface DriftPath { path: string; class: DriftClass; rule?: AdditiveRule; reason: string; inserted_lines?: number; appended?: number; advanced?: number }
export interface DriftClassification { paths: DriftPath[]; verdict: 'structurally_additive' | 'additive_with_suggestions' | 'review_required' | 'no_drift' }
export interface AutoDecision { path: string; rule: AdditiveRule; rule_version: number; evidence_digest: string }

const APPEND_ONLY_ARRAYS = new Set(['contacts']);
// Policy-bearing metadata a structural rule must never decide, beyond the protected merge keys.
export const POLICY_KEYS = new Set(['access', 'confidentiality', 'grants', 'grant', 'owner', 'owners', 'permissions', 'acl', 'sharing',
  'private', 'visibility', 'status', 'aliases', 'slug', 'id', 'type', 'title', 'tags', 'withdrawn', 'withdrawals', 'expires', 'expires_at',
  'valid_until', 'archived', 'archived_at', 'deleted', 'deleted_at', 'consent', 'consented_at', 'validate']);
const MAX_APPENDED = 500;
const DAY_MS = 86_400_000;

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');
const escaped = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

function fenceRegions(fileLines: string[]): boolean[] {
  const inside: boolean[] = [];
  let open: string | null = null;
  for (const line of fileLines) {
    const trimmed = line.trim();
    if (open === null && (trimmed === FACTS_FENCE_BEGIN || trimmed === TAKES_FENCE_BEGIN)) { open = trimmed === FACTS_FENCE_BEGIN ? FACTS_FENCE_END : TAKES_FENCE_END; inside.push(true); continue; }
    if (open === null && /^(```|~~~)/.test(trimmed)) { open = trimmed.slice(0, 3); inside.push(true); continue; }
    if (open !== null) { inside.push(true); if (trimmed === open || (open.length === 3 && trimmed.startsWith(open))) open = null; continue; }
    inside.push(false);
  }
  return inside;
}

/** Every database line kept, in order and unchanged; only whole lines inserted, none inside a fence or structural block. */
export function classifyTextInsertion(file: string, database: string): { ok: true; inserted: number } | { ok: false; reason: string } {
  const f = lines(file), d = lines(database);
  const matched = new Array<boolean>(f.length).fill(false);
  let i = 0;
  for (const line of d) {
    while (i < f.length && f[i] !== line) i++;
    if (i === f.length) return { ok: false, reason: 'database_text_changed_or_removed' };
    matched[i++] = true;
  }
  const fenced = fenceRegions(f);
  let inserted = 0;
  for (let k = 0; k < f.length; k++) {
    if (matched[k]) continue;
    if (!f[k].trim()) { inserted++; continue; }
    inserted++;
    if (fenced[k] || [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END].some(m => f[k].includes(m))) return { ok: false, reason: 'fence_insertion' };
    if (/^\s*#/.test(f[k])) return { ok: false, reason: 'heading_insertion' };
    if (/^\s*\|/.test(f[k])) return { ok: false, reason: 'table_insertion' };
  }
  return { ok: true, inserted };
}

function classifyDate(fileValue: unknown, databaseValue: unknown, now: number): { ok: true } | { ok: false; reason: string } {
  // An unquoted YAML date parses to a Date; the database stores the same instant as its ISO string.
  const text = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
  const file = text(fileValue), database = text(databaseValue);
  if (typeof file !== 'string' || typeof database !== 'string') return { ok: false, reason: 'date_not_text' };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/, stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const format = (v: string) => dateOnly.test(v) ? 'date' : stamp.test(v) ? 'timestamp' : null;
  if (!format(file) || format(file) !== format(database)) return { ok: false, reason: 'date_format_changed' };
  const valid = (v: string) => { const t = Date.parse(v); return Number.isFinite(t) && (format(v) !== 'date' || new Date(t).toISOString().slice(0, 10) === v) ? t : NaN; };
  const f = valid(file), d = valid(database);
  if (!Number.isFinite(f) || !Number.isFinite(d)) return { ok: false, reason: 'invalid_date' };
  if (f < d) return { ok: false, reason: 'date_moved_backward' };
  if (f > now + DAY_MS) return { ok: false, reason: 'future_date' };
  return { ok: true };
}

/** #8109: the same row with only activity dates (never a policy key) moved forward under classifyDate's rules. */
function activityOnlyAdvance(file: unknown, database: unknown, now: number): boolean {
  const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
  if (!row(file) || !row(database)) return false;
  const keys = Object.keys(file);
  if (keys.length !== Object.keys(database).length || !keys.every(key => Object.hasOwn(database, key))) return false;
  return keys.every(key => digest(file[key]) === digest(database[key])
    || (ACTIVITY_DATE.test(key) && !POLICY_KEYS.has(key) && !protectedReconcileKey(key) && classifyDate(file[key], database[key], now).ok));
}

function classifyAppend(file: unknown, database: unknown, now: number): { ok: true; appended: number; advanced: number } | { ok: false; reason: string } {
  if (!Array.isArray(file) || !Array.isArray(database)) return { ok: false, reason: 'not_a_list' };
  if (file.length < database.length) return { ok: false, reason: 'list_entries_removed' };
  let advanced = 0;
  for (let k = 0; k < database.length; k++) {
    if (digest(file[k]) === digest(database[k])) continue;
    if (!activityOnlyAdvance(file[k], database[k], now)) return { ok: false, reason: 'list_entries_changed_or_reordered' };
    advanced++;
  }
  if (file.length - database.length > MAX_APPENDED) return { ok: false, reason: 'too_many_appended' };
  return { ok: true, appended: file.length - database.length, advanced };
}

const absent = Symbol('absent');
/** Classifies the complete delta between the parsed file and the database page, not only merge conflicts. */
export function classifyDrift(file: ParsedPage, database: ParsedPage, now = Date.now()): DriftClassification {
  const paths: DriftPath[] = [];
  for (const key of ['title', 'type'] as const) if (file[key] !== database[key]) paths.push({ path: `/${key}`, class: 'review', reason: 'identity_field_changed' });
  for (const key of ['compiled_truth', 'timeline'] as const) {
    const f = file[key] ?? '', d = database[key] ?? '';
    if (f === d) continue;
    const text = classifyTextInsertion(f, d);
    paths.push(text.ok ? { path: `/${key}`, class: 'suggested', rule: 'text_insertion_only', reason: 'inserted_lines_need_acceptance', inserted_lines: text.inserted }
      : { path: `/${key}`, class: 'review', reason: text.reason });
  }
  const fileTags = new Set(file.tags), dbTags = new Set(database.tags);
  if (file.tags.length !== database.tags.length || file.tags.some(t => !dbTags.has(t)) || database.tags.some(t => !fileTags.has(t))) {
    paths.push({ path: '/tags', class: 'review', reason: 'tags_changed' });
  }
  const fm = file.frontmatter ?? {}, dm = database.frontmatter ?? {};
  for (const key of [...new Set([...Object.keys(fm), ...Object.keys(dm)])].sort()) {
    const f = Object.hasOwn(fm, key) ? fm[key] : absent, d = Object.hasOwn(dm, key) ? dm[key] : absent;
    if (f !== absent && d !== absent && digest(f) === digest(d)) continue;
    const path = `/frontmatter/${escaped(key)}`;
    if (POLICY_KEYS.has(key) || protectedReconcileKey(key)) { paths.push({ path, class: 'review', reason: 'policy_field_changed' }); continue; }
    if (f === absent) { paths.push({ path, class: 'auto', rule: 'database_only_kept', reason: 'database_value_kept' }); continue; }
    if (d === absent) { paths.push({ path, class: 'auto', rule: 'file_only_field', reason: 'file_field_added' }); continue; }
    if (APPEND_ONLY_ARRAYS.has(key)) {
      const append = classifyAppend(f, d, now);
      paths.push(!append.ok ? { path, class: 'review', reason: append.reason }
        : append.advanced ? { path, class: 'auto', rule: 'contacts_activity_advance', reason: 'activity_dates_advanced', appended: append.appended, advanced: append.advanced }
        : { path, class: 'auto', rule: 'contacts_append_only', reason: 'entries_appended', appended: append.appended });
      continue;
    }
    if (ACTIVITY_DATE.test(key)) {
      const date = classifyDate(f, d, now);
      paths.push(date.ok ? { path, class: 'auto', rule: 'activity_date_advance', reason: 'activity_date_advanced' } : { path, class: 'review', reason: date.reason });
      continue;
    }
    paths.push({ path, class: 'review', reason: 'value_changed' });
  }
  const verdict = !paths.length ? 'no_drift' : paths.some(p => p.class === 'review') ? 'review_required'
    : paths.some(p => p.class === 'suggested') ? 'additive_with_suggestions' : 'structurally_additive';
  return { paths, verdict };
}

/** Evidence binding one automatic decision to the exact values it judged. */
export function additiveEvidence(path: string, file: ParsedPage, database: ParsedPage): string {
  const pick = (page: ParsedPage) => path.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, page);
  return digest({ path, file: pick(file) ?? null, database: pick(database) ?? null, rule_version: ADDITIVE_RULE_VERSION });
}

/**
 * Decisions for the conflict paths the classification may resolve: `auto`
 * always, `suggested` only with explicit acceptance. Paths left undecided keep
 * the preview in needs_resolution.
 */
export function additiveDecisions(classification: DriftClassification, conflicts: ReconcileConflict[], file: ParsedPage, database: ParsedPage,
  acceptSuggested: boolean): { decisions: ReconcileDecision[]; auto: AutoDecision[] } {
  const byPath = new Map(classification.paths.map(p => [p.path, p]));
  const decisions: ReconcileDecision[] = [], auto: AutoDecision[] = [];
  for (const conflict of conflicts) {
    const entry = byPath.get(conflict.path);
    if (!entry?.rule || entry.class === 'review' || entry.class === 'suggested' && !acceptSuggested) continue;
    decisions.push({ path: conflict.path, action: 'take_file' });
    auto.push({ path: conflict.path, rule: entry.rule, rule_version: ADDITIVE_RULE_VERSION, evidence_digest: additiveEvidence(conflict.path, file, database) });
  }
  return { decisions, auto };
}

/** Apply-time recheck: every recorded automatic decision still classifies the same against the pinned inputs. */
export function assertAutoDecisions(auto: AutoDecision[], file: ParsedPage, database: ParsedPage, decisions: ReconcileDecision[], now = Date.now()): void {
  if (!auto.length) return;
  const current = new Map(classifyDrift(file, database, now).paths.map(p => [p.path, p]));
  for (const entry of auto) {
    const path = current.get(entry.path);
    if (entry.rule_version !== ADDITIVE_RULE_VERSION || !path || path.rule !== entry.rule || path.class === 'review'
      || additiveEvidence(entry.path, file, database) !== entry.evidence_digest
      || !decisions.some(d => d.path === entry.path && d.action === 'take_file')) {
      throw new OperationError('source_changed', `The automatic decision for ${entry.path} no longer holds.`,
        'Create a new preview with --auto-additive and apply it with a new request ID.');
    }
  }
}
