import type { ParsedPage } from '../import-file.ts';
import type { Page } from '../types.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { digest, stableJson } from './digest.ts';
import { RECONCILE_SAFETY_KEYS } from './reconcile-safety.ts';

export type ReconcileDecision = { path: string; action: 'take_file' | 'take_database' | 'set_value' | 'delete'; value?: unknown };
export interface ReconcileConflict { path: string; file: unknown; database: unknown; }
export const RECONCILE_SCAN_KEYS = ['atoms_scan_hash', 'atoms_fail_hash', 'atoms_fail_count'];
const protectedKeys = new Set([...RECONCILE_SCAN_KEYS, ...RECONCILE_SAFETY_KEYS, 'visibility', 'source_hash', 'source_kind',
  'source_uri', 'source_slug', 'source_path', 'source_quote', 'source_quote_verified', 'source_quote_offset', 'quote_unverified',
  'ingested_via', 'ingested_at', 'captured_at', 'extracted_at', 'extracted_by', 'provenance',
  'trust', 'trust_level', 'trusted', 'trust_frontmatter_overrides', 'allowed_tools']);

export function reconcileCanonical(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]): ParsedPage {
  const value = { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() };
  validateReconcileJson(value, true);
  return JSON.parse(stableJson(value)) as ParsedPage;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateReconcileJson(value: unknown, allowDates = false): void {
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 100_000 || depth > 64) throw opError('request_too_large', 'Reconciliation JSON exceeds the structural limit.',
      'Keep reconciliation JSON under 100,000 values and 64 levels of nesting: pass the preview file written by --out unchanged, with only the decisions it needs.');
    if (allowDates && item instanceof Date && Number.isFinite(item.getTime())) return;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const child of Object.values(item)) visit(child, depth + 1);
      return;
    }
    throw opError('invalid_params', 'Reconciliation values must be finite JSON data.',
      'Use only JSON strings, finite numbers, booleans, null, arrays and plain objects in decisions and set_value values.');
  };
  visit(value, 0);
}
export function strictReconcileKeys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) {
    throw opError('invalid_params', 'Unsupported or missing reconciliation fields.',
      'Pass the preview file written by --out unchanged, and give each decision only path, action and, for set_value, value.');
  }
}
function pointer(path: string): string[] {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw opError('invalid_params', 'Decisions require escaped JSON Pointer paths.',
    "Write each decision path as a JSON Pointer from the preview's conflict_paths (for example /frontmatter/title), escaping '~' as ~0 and '/' inside a key as ~1.");
  return path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function escaped(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1'); }
export function protectedReconcileKey(key: string): boolean {
  return protectedKeys.has(key);
}
export function reconcileDecisions(value: unknown): ReconcileDecision[] {
  if (!Array.isArray(value) || value.length > 1000) throw opError('invalid_params', 'decisions must be a bounded array.',
    'Pass decisions as one JSON array of at most 1000 decision objects.');
  const decisions = value.map(item => {
    strictReconcileKeys(item, ['path', 'action', 'value'], ['path', 'action']);
    if (typeof item.path !== 'string' || !['take_file', 'take_database', 'set_value', 'delete'].includes(String(item.action)) ||
      (item.action === 'set_value') !== Object.hasOwn(item, 'value')) {
      throw opError('invalid_params', 'Invalid reconciliation decision.',
        'Give each decision a string path and an action of take_file, take_database, delete, or set_value with a value; only set_value carries a value.');
    }
    const parts = pointer(item.path);
    if (parts[0] === 'tags' || parts[0] === 'frontmatter' && (parts.length === 1 || protectedReconcileKey(parts[1]))) {
      throw opError('permission_denied', 'Reconciliation decisions cannot change protected metadata or remove tags.',
        'Drop decisions on tags and on protected frontmatter keys (provenance, trust, source and scan fields): reconcile keeps those from the database and unions tags. Decide only the conflict_paths the preview lists.');
    }
    if (item.action === 'delete' && parts[0] !== 'frontmatter') throw opError('invalid_params', 'Only ordinary metadata fields support explicit deletion.',
      'Use delete only on paths under /frontmatter; for title, type, compiled_truth or timeline choose take_file, take_database or set_value.');
    if (item.action === 'set_value') validateReconcileJson(item.value);
    return item as unknown as ReconcileDecision;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let i = 0; i < decisions.length; i++) for (let j = 0; j < i; j++) {
    if (decisions[i].path === decisions[j].path || decisions[i].path.startsWith(`${decisions[j].path}/`) || decisions[j].path.startsWith(`${decisions[i].path}/`)) {
      throw opError('invalid_params', 'Duplicate or overlapping reconciliation decisions.',
        'Give each path exactly one decision, and do not decide both a field and a path inside it.');
    }
  }
  return decisions;
}

export function mergeReconcile(file: ParsedPage, database: ParsedPage, decisions: ReconcileDecision[] = []) {
  const chosen = new Map(reconcileDecisions(decisions).map(d => [d.path, d]));
  const extractionStatus = file.frontmatter.provenance === 'auto-extracted' || database.frontmatter.provenance === 'auto-extracted';
  if (extractionStatus && [...chosen.keys()].some(path => path === '/frontmatter/status' || path.startsWith('/frontmatter/status/'))) {
    throw opError('permission_denied', 'Extraction review status requires the scoped review workflow.',
      "Drop the /frontmatter/status decision: an auto-extracted page's review status changes only through extraction review. The command in fix lists pending stubs; gbrain extraction-review promotes or rejects them.",
      { fix: readFix('Lists the unverified auto-extracted stubs awaiting review, with their slugs.', { argv: ['gbrain', 'extraction-pending'] }) });
  }
  const used = new Set<string>(), conflicts: ReconcileConflict[] = [], protectedPaths: string[] = [], scanPaths: string[] = [];
  const absent = Symbol('absent');
  const merge = (left: unknown | typeof absent, right: unknown | typeof absent, path: string): unknown | typeof absent => {
    const parts = path ? pointer(path) : [];
    if (parts[0] === 'frontmatter' && parts.length === 2 && (protectedReconcileKey(parts[1]) || extractionStatus && parts[1] === 'status')) {
      if (RECONCILE_SCAN_KEYS.includes(parts[1])) { scanPaths.push(path); return absent; }
      if (left !== absent && (right === absent || digest(left) !== digest(right))) protectedPaths.push(path);
      return right;
    }
    const decision = chosen.get(path);
    if (decision) {
      used.add(path);
      if (decision.action === 'delete') return absent;
      if (decision.action === 'set_value') return decision.value;
      const selected = decision.action === 'take_file' ? left : right;
      if (selected === absent) throw opError('invalid_params', 'The chosen side has no value; use an explicit delete decision.',
        `The ${decision.action === 'take_file' ? 'file' : 'database'} side has nothing at ${path}. Use delete for that path to drop it, or set_value with the value to keep.`);
      return selected;
    }
    if (left === absent) {
      if (object(right)) return merge({}, right, path);
      return right;
    }
    if (right === absent) {
      if (object(left)) return merge(left, {}, path);
      return left;
    }
    if (object(left) && object(right)) {
      return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => {
        const value = merge(Object.hasOwn(left, key) ? left[key] : absent, Object.hasOwn(right, key) ? right[key] : absent, `${path}/${escaped(key)}`);
        return value === absent ? [] : [[key, value]];
      }));
    }
    if (digest(left) === digest(right)) return left;
    conflicts.push({ path, file: left, database: right });
    return right;
  };
  const tags = [...new Set([...file.tags, ...database.tags])].sort();
  const result = merge({ ...file, tags }, { ...database, tags }, '') as ParsedPage;
  if ([...chosen.keys()].some(path => !used.has(path))) throw opError('invalid_params', 'A decision names an unknown field path.',
    "Decide only paths the preview lists in conflict_paths (or fields present on either side); remove decisions whose path matches neither.");
  if (['title', 'type', 'compiled_truth', 'timeline'].some(key => typeof result[key as keyof ParsedPage] !== 'string') || !object(result.frontmatter)) {
    throw opError('invalid_params', 'Resolved content has invalid canonical field types.',
      'Keep title, type, compiled_truth and timeline as strings and frontmatter as an object in set_value decisions, then resolve the preview again.');
  }
  return { result, conflicts, protectedPaths, scanPaths };
}
