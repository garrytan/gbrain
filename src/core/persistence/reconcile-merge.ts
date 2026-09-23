import type { ParsedPage } from '../import-file.ts';
import type { Page } from '../types.ts';
import { OperationError } from '../ops/contract.ts';
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
    if (++nodes > 100_000 || depth > 64) throw new OperationError('request_too_large', 'Reconciliation JSON exceeds the structural limit.');
    if (allowDates && item instanceof Date && Number.isFinite(item.getTime())) return;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      for (const child of Object.values(item)) visit(child, depth + 1);
      return;
    }
    throw new OperationError('invalid_params', 'Reconciliation values must be finite JSON data.');
  };
  visit(value, 0);
}
export function strictReconcileKeys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) {
    throw new OperationError('invalid_params', 'Unsupported or missing reconciliation fields.');
  }
}
function pointer(path: string): string[] {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new OperationError('invalid_params', 'Decisions require escaped JSON Pointer paths.');
  return path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function escaped(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1'); }
export function protectedReconcileKey(key: string): boolean {
  return protectedKeys.has(key);
}
export function reconcileDecisions(value: unknown): ReconcileDecision[] {
  if (!Array.isArray(value) || value.length > 1000) throw new OperationError('invalid_params', 'decisions must be a bounded array.');
  const decisions = value.map(item => {
    strictReconcileKeys(item, ['path', 'action', 'value'], ['path', 'action']);
    if (typeof item.path !== 'string' || !['take_file', 'take_database', 'set_value', 'delete'].includes(String(item.action)) ||
      (item.action === 'set_value') !== Object.hasOwn(item, 'value')) throw new OperationError('invalid_params', 'Invalid reconciliation decision.');
    const parts = pointer(item.path);
    if (parts[0] === 'tags' || parts[0] === 'frontmatter' && (parts.length === 1 || protectedReconcileKey(parts[1]))) {
      throw new OperationError('permission_denied', 'Reconciliation decisions cannot change protected metadata or remove tags.');
    }
    if (item.action === 'delete' && parts[0] !== 'frontmatter') throw new OperationError('invalid_params', 'Only ordinary metadata fields support explicit deletion.');
    if (item.action === 'set_value') validateReconcileJson(item.value);
    return item as unknown as ReconcileDecision;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let i = 0; i < decisions.length; i++) for (let j = 0; j < i; j++) {
    if (decisions[i].path === decisions[j].path || decisions[i].path.startsWith(`${decisions[j].path}/`) || decisions[j].path.startsWith(`${decisions[i].path}/`)) {
      throw new OperationError('invalid_params', 'Duplicate or overlapping reconciliation decisions.');
    }
  }
  return decisions;
}

export function mergeReconcile(file: ParsedPage, database: ParsedPage, decisions: ReconcileDecision[] = []) {
  const chosen = new Map(reconcileDecisions(decisions).map(d => [d.path, d]));
  const extractionStatus = file.frontmatter.provenance === 'auto-extracted' || database.frontmatter.provenance === 'auto-extracted';
  if (extractionStatus && [...chosen.keys()].some(path => path === '/frontmatter/status' || path.startsWith('/frontmatter/status/'))) {
    throw new OperationError('permission_denied', 'Extraction review status requires the scoped review workflow.');
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
      if (selected === absent) throw new OperationError('invalid_params', 'The chosen side has no value; use an explicit delete decision.');
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
  if ([...chosen.keys()].some(path => !used.has(path))) throw new OperationError('invalid_params', 'A decision names an unknown field path.');
  if (['title', 'type', 'compiled_truth', 'timeline'].some(key => typeof result[key as keyof ParsedPage] !== 'string') || !object(result.frontmatter)) {
    throw new OperationError('invalid_params', 'Resolved content has invalid canonical field types.');
  }
  return { result, conflicts, protectedPaths, scanPaths };
}
