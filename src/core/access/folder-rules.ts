/**
 * GBRA-218 (PR A2): the folder-rule grammar, shared by the git policy file
 * (`<source root>/.gbrain/access.yml`), `gbrain access rule export|import|migrate`
 * and `gbrain export` / `import`. One parser, so every path accepts and refuses
 * exactly the same rules.
 *
 *   version: 1
 *   rules:
 *     - id: alice-notes                       # optional; derived from the prefix
 *       prefix: partners/alice-example/       # literal slug prefix, lower case, ends in '/'
 *       readable_by: [alice-example, group:team-a]
 *     - slug: projects                        # a page rule: exactly this one slug (GST-2462)
 *       readable_by: [alice-example]
 *     - prefix: transcripts/                  # a raw-only rule: keeps these pages to its readers, but not
 *       readable_by: [alice-example]          # the pages and facts derived from them (covers_derived, default true)
 *       covers_derived: false
 *
 * A prefix is matched literally against the source's slugs (never LIKE): it is
 * lower case, built of segments that start with a letter or digit, ends in
 * '/', and holds no '..' or '*'. Rule ids are stable: an omitted id is derived
 * deterministically from the normalized prefix. A page rule names one exact slug
 * instead (`slug:`), so a page at the source root or a page whose file left git
 * can be restricted without writing it; it is stored in the same prefix column
 * without the trailing '/', and a prefix without '/' covers only itself
 * (ruleCovers, ruleCoversSql). Duplicate ids or prefixes make
 * the file invalid. Readers use the page grammar (principals.ts).
 *
 * classifyRulebook() compares the applied rulebook with a desired one rule by
 * rule: an added rule and removed readers narrow and apply at once; a removed
 * rule and added readers widen and wait for an operator's
 * `gbrain access apply --yes`. Turning covers_derived off (a rule stops closing its pages' lineage) widens; turning it
 * back on narrows. A moved prefix is both: the rule applies at its
 * new prefix at once, and its old prefix keeps the old readers under a held
 * rule (heldRuleId) whose release waits for apply. Its target (what is applied
 * now) is never wider than the applied rulebook: a rule whose readers both lose
 * and gain entries applies the intersection.
 */
import { createHash } from 'node:crypto';
import { JSON_SCHEMA } from 'js-yaml';
import { loadBoundedYaml } from '../data-frontmatter.ts';
import { ACCESS_ID_RE, normalizePrincipal } from './principals.ts';

export interface FolderRule {
  id: string;
  prefix: string;
  /** Sorted, distinct normalized principals; empty means readable by nobody (an applied intersection only). */
  readable_by: string[];
  /**
   * Raw-only rules: false when the rule keeps its pages to its readers but no longer closes the lineage of the pages
   * and facts derived from them. Absent means true (every rule written before it existed); only false is carried.
   */
  covers_derived?: false;
}

export interface PolicyProblem {
  /** 1-based line in the YAML text, when known. */
  line: number | null;
  message: string;
}

export type ParsedPolicy =
  | { ok: true; rules: FolderRule[] }
  | { ok: false; problems: PolicyProblem[]; /** Valid prefixes the text names; null when they cannot all be read (cover the whole source). */ prefixes: string[] | null };

export const POLICY_VERSION = 1;
export const MAX_RULES = 256;
const MAX_READERS = 256;
const PREFIX_RE = /^(?:[a-z0-9][a-z0-9._-]*\/)+$/;
const SLUG_RE = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*$/;
const RULE_KEYS = new Set(['id', 'prefix', 'slug', 'readable_by', 'covers_derived']);

/** A stored rule prefix the grammar accepts: a folder (ends in '/') or one page's exact slug. Also safe to embed as an SQL literal: no quote or backslash. */
export function validPrefix(prefix: string): boolean {
  return prefix.length <= 512 && (PREFIX_RE.test(prefix) || SLUG_RE.test(prefix)) && !prefix.includes('..');
}

/** Whether a rule's stored prefix covers `slug`: a folder covers the slugs under it, a page rule only its own slug. */
export function ruleCovers(slug: string, prefix: string): boolean {
  return prefix.endsWith('/') ? slug.startsWith(prefix) : slug === prefix;
}

/** The SQL twin of ruleCovers over two text expressions; an empty prefix (pending coverage of a whole source) covers every slug. */
export function ruleCoversSql(slug: string, prefix: string): string {
  return `(starts_with(${slug}, ${prefix}) AND (${prefix} = '' OR right(${prefix}, 1) = '/' OR ${slug} = ${prefix}))`;
}

/** A source-qualified rule id (`<source>:<rule>`) safe to embed as an SQL literal. */
export function validQualifiedRuleId(id: string): boolean {
  const i = id.indexOf(':');
  return i > 0 && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id.slice(0, i)) && ACCESS_ID_RE.test(id.slice(i + 1));
}

/** The id a rule gets when the file omits one: its prefix with '/' as '-' (a page rule's ends in '.page'), hashed when longer than an id may be. */
export function ruleIdForPrefix(prefix: string): string {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1).replace(/\//g, '-') : `${prefix.replace(/\//g, '-')}.page`;
  if (base.length <= 64) return base;
  return `${base.slice(0, 55).replace(/[._-]+$/, '')}-${createHash('sha256').update(prefix).digest('hex').slice(0, 8)}`;
}

/** Why a prefix is refused, with the corrected form when there is an obvious one. */
function prefixProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return 'prefix must be a non-empty string such as partners/alice-example/';
  if (raw.includes('*')) return `prefix "${raw}" holds '*': prefixes are literal; name the folder itself, as in ${raw.split('*')[0]!.replace(/[^/]*$/, '') || 'partners/'}`;
  if (raw.includes('..')) return `prefix "${raw}" holds '..'`;
  if (raw.startsWith('/')) return `prefix "${raw}" starts with '/': prefixes are relative to the source's slugs, as in ${raw.replace(/^\/+/, '')}`;
  if (raw !== raw.toLowerCase()) return `prefix "${raw}" is not lower case; slugs are lower case, so write ${raw.toLowerCase()}`;
  if (!raw.endsWith('/')) return `prefix "${raw}" does not end in '/'; write ${raw}/ so it names a folder, or slug: ${raw} for that one page`;
  if (raw.length > 512 || !PREFIX_RE.test(raw)) return `prefix "${raw}" is not a slug folder: each segment starts with a letter or digit and holds only a-z, 0-9, '.', '_' and '-'`;
  return null;
}

/** Why a page rule's slug is refused. */
function slugProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return 'slug must be a non-empty page slug such as projects or notes/plan';
  if (raw !== raw.toLowerCase()) return `slug "${raw}" is not lower case; slugs are lower case, so write ${raw.toLowerCase()}`;
  if (raw.endsWith('/')) return `slug "${raw}" ends in '/'; a folder is a prefix: write prefix: ${raw}`;
  if (raw.length > 512 || !SLUG_RE.test(raw) || raw.includes('..')) return `slug "${raw}" is not a page slug: each segment starts with a letter or digit and holds only a-z, 0-9, '.', '_' and '-'`;
  return null;
}

/** One readers list normalized, or a problem. */
function readersOf(raw: unknown): { readers: string[] } | { problem: string } {
  const list = typeof raw === 'string' ? [raw]
    : Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_READERS && raw.every(v => typeof v === 'string') ? raw as string[] : null;
  if (!list) return { problem: 'readable_by must be a member id, group:<id>, or a list of 1-256 of them' };
  const out = new Set<string>();
  for (const entry of list) {
    const p = normalizePrincipal(entry);
    if (!p) return { problem: `readable_by entry ${JSON.stringify(entry)} is not a member id or group:<id> (lower-case letters, digits, '.', '_' and '-', 1-64 characters)` };
    out.add(p);
  }
  return { readers: [...out].sort() };
}

/** One rule from untrusted input (a YAML entry or CLI flags), normalized, or the problem with it. */
export function normalizeRule(raw: unknown): { rule: FolderRule } | { problem: string; prefix?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: 'each rule is a mapping with prefix, readable_by and an optional id' };
  const entry = raw as Record<string, unknown>;
  const unknown = Object.keys(entry).filter(k => !RULE_KEYS.has(k));
  if (entry.slug !== undefined && entry.prefix !== undefined) return { problem: 'a rule has prefix (a folder) or slug (one page), not both' };
  const prefixError = entry.slug !== undefined ? slugProblem(entry.slug) : prefixProblem(entry.prefix);
  const prefix = prefixError ? undefined : (entry.slug ?? entry.prefix) as string;
  if (unknown.length) return { problem: `unknown key ${unknown.map(k => JSON.stringify(k)).join(', ')}; a rule has id, prefix or slug, readable_by and an optional covers_derived`, prefix };
  if (prefixError) return { problem: prefixError };
  const readers = readersOf(entry.readable_by);
  if ('problem' in readers) return { problem: readers.problem, prefix };
  const id = entry.id === undefined ? ruleIdForPrefix(prefix!) : entry.id;
  if (typeof id !== 'string' || !ACCESS_ID_RE.test(id)) return { problem: `id ${JSON.stringify(id)} is not a rule id (lower-case letters, digits, '.', '_' and '-', 1-64 characters)`, prefix };
  if (entry.covers_derived !== undefined && typeof entry.covers_derived !== 'boolean') return { problem: `covers_derived must be true or false (found ${JSON.stringify(entry.covers_derived)})`, prefix };
  return { rule: { id, prefix: prefix!, readable_by: readers.readers, ...(entry.covers_derived === false ? { covers_derived: false as const } : {}) } };
}

/** Rules sorted by id with duplicate ids or prefixes reported. */
function checkUnique(rules: Array<{ rule: FolderRule; line: number | null }>): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const ids = new Map<string, number | null>();
  const prefixes = new Map<string, string>();
  for (const { rule, line } of rules) {
    if (ids.has(rule.id)) problems.push({ line, message: `rule id "${rule.id}" appears twice; ids are unique within a source` });
    else ids.set(rule.id, line);
    const other = prefixes.get(rule.prefix);
    if (other !== undefined) problems.push({ line, message: `prefix ${rule.prefix} appears in rules "${other}" and "${rule.id}"; merge their readers into one rule` });
    else prefixes.set(rule.prefix, rule.id);
  }
  return problems;
}

/** The 1-based line of each top-level entry of the `rules:` list, by position (null when not found). */
function ruleLines(text: string): Array<number> {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^rules\s*:/.test(l));
  if (start < 0) return [];
  let indent: number | null = null;
  const out: number[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l) && !l.startsWith('-') && !l.startsWith('#')) break;
    const m = /^(\s*)-\s/.exec(l) ?? /^(\s*)-$/.exec(l);
    if (!m) continue;
    if (indent === null) indent = m[1]!.length;
    if (m[1]!.length === indent) out.push(i + 1);
  }
  return out;
}

/** Parses a policy file's text (YAML, JSON schema only: no tags, anchors resolve to plain data). */
export function parsePolicyYaml(text: string): ParsedPolicy {
  let doc: unknown;
  try {
    doc = loadBoundedYaml(text, { schema: JSON_SCHEMA });
  } catch (e) {
    const mark = (e as { mark?: { line?: number } }).mark;
    return { ok: false, problems: [{ line: typeof mark?.line === 'number' ? mark.line + 1 : null, message: `not valid YAML: ${(e as Error).message.split('\n')[0]}` }], prefixes: null };
  }
  if (doc === undefined || doc === null) return { ok: true, rules: [] };
  if (typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, problems: [{ line: 1, message: 'the file must be a mapping with version: 1 and rules: [...]' }], prefixes: null };
  const top = doc as Record<string, unknown>;
  const problems: PolicyProblem[] = [];
  for (const key of Object.keys(top)) if (key !== 'version' && key !== 'rules') problems.push({ line: null, message: `unknown top-level key ${JSON.stringify(key)}; the file has version and rules` });
  if (top.version !== POLICY_VERSION) problems.push({ line: null, message: `version must be ${POLICY_VERSION} (found ${JSON.stringify(top.version ?? null)})` });
  const rawRules = top.rules ?? [];
  if (!Array.isArray(rawRules)) return { ok: false, problems: [...problems, { line: null, message: 'rules must be a list' }], prefixes: null };
  if (rawRules.length > MAX_RULES) problems.push({ line: null, message: `${rawRules.length} rules; a source holds at most ${MAX_RULES}` });
  const lines = ruleLines(text);
  const parsed: Array<{ rule: FolderRule; line: number | null }> = [];
  const prefixes = new Set<string>();
  let allPrefixesKnown = true;
  rawRules.forEach((raw, i) => {
    const line = lines[i] ?? null;
    const r = normalizeRule(raw);
    if ('rule' in r) { parsed.push({ rule: r.rule, line }); prefixes.add(r.rule.prefix); return; }
    if (r.prefix) prefixes.add(r.prefix); else allPrefixesKnown = false;
    problems.push({ line, message: `rule ${i + 1}: ${r.problem}` });
  });
  problems.push(...checkUnique(parsed));
  if (problems.length) return { ok: false, problems, prefixes: allPrefixesKnown ? [...prefixes].sort() : null };
  return { ok: true, rules: sortRules(parsed.map(p => p.rule)) };
}

export function sortRules(rules: readonly FolderRule[]): FolderRule[] {
  return [...rules].map(r => ({ id: r.id, prefix: r.prefix, readable_by: [...new Set(r.readable_by)].sort(), ...(r.covers_derived === false ? { covers_derived: false as const } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether a rule closes the lineage of the pages and facts derived from the pages it covers (covers_derived, default true). */
export function coversDerived(rule: Pick<FolderRule, 'covers_derived'>): boolean {
  return rule.covers_derived !== false;
}

/** The file text for a rulebook: the same grammar parsePolicyYaml reads, members written bare. */
export function serializePolicyYaml(rules: readonly FolderRule[], comment?: string): string {
  const plain = (v: string) => (/^[a-z][a-z0-9._/:-]*$/.test(v) && !['true', 'false', 'null'].includes(v) ? v : JSON.stringify(v));
  const reader = (p: string) => plain(p.startsWith('member:') ? p.slice(7) : p);
  const lines = [...(comment ? comment.split('\n').map(l => `# ${l}`) : []), `version: ${POLICY_VERSION}`];
  const sorted = sortRules(rules);
  if (!sorted.length) return [...lines, 'rules: []', ''].join('\n');
  lines.push('rules:');
  for (const r of sorted) {
    lines.push(`  - id: ${plain(r.id)}`, r.prefix.endsWith('/') ? `    prefix: ${plain(r.prefix)}` : `    slug: ${plain(r.prefix)}`, `    readable_by: [${r.readable_by.map(reader).join(', ')}]`);
    if (!coversDerived(r)) lines.push('    covers_derived: false');
  }
  return [...lines, ''].join('\n');
}

/** A content digest of a rulebook (sha256 over its canonical JSON); equal rulebooks have equal digests. A rule that covers derived pages hashes as it did before covers_derived existed. */
export function rulebookDigest(rules: readonly FolderRule[]): string {
  return createHash('sha256').update(JSON.stringify(sortRules(rules).map(r => coversDerived(r) ? [r.id, r.prefix, r.readable_by] : [r.id, r.prefix, r.readable_by, false]))).digest('hex');
}

/** Rules read back from a stored JSON value (revisions, exports); anything malformed is refused, never repaired. */
export function rulesFromJson(value: unknown): FolderRule[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) throw new Error('stored rulebook is not a list');
  return sortRules(raw.map(r => {
    const rule = r as FolderRule;
    if (!rule || typeof rule.id !== 'string' || !ACCESS_ID_RE.test(rule.id) || typeof rule.prefix !== 'string' || !validPrefix(rule.prefix)
      || !Array.isArray(rule.readable_by) || !rule.readable_by.every(p => typeof p === 'string' && normalizePrincipal(p) === p)
      || (rule.covers_derived !== undefined && typeof rule.covers_derived !== 'boolean')) {
      throw new Error('stored rulebook holds a malformed rule');
    }
    return rule;
  }));
}

export type ChangeKind = 'added' | 'removed' | 'readers_removed' | 'readers_added' | 'prefix_moved' | 'prefix_released' | 'derived_released' | 'derived_covered';

const HELD_RULE_RE = /\.held-[0-9a-f]{8}$/;

/** The id that keeps rule `id`'s old `prefix` restricted after the rule moved, until an operator approves the release. */
export function heldRuleId(id: string, prefix: string): string {
  return `${id.slice(0, 50).replace(/[._-]+$/, '')}.held-${createHash('sha256').update(`${id}\u0000${prefix}`).digest('hex').slice(0, 8)}`;
}

export interface RuleChange {
  rule: string;
  kind: ChangeKind;
  narrowing: boolean;
  prefix: string;
  /** For reader changes: the principals removed or added. */
  readers?: string[];
}

export interface Classification {
  /** What to apply now: the applied rulebook with every narrowing change and none of the widening ones. */
  target: FolderRule[];
  changes: RuleChange[];
  /** The widening changes the target leaves out (held for gbrain access apply). */
  held: RuleChange[];
  kind: 'narrowing' | 'widening' | 'mixed' | 'unchanged';
}

/** Classifies the move from the applied rulebook to a desired one, rule by rule (see the module comment). */
export function classifyRulebook(applied: readonly FolderRule[], desired: readonly FolderRule[]): Classification {
  const before = new Map(sortRules(applied).map(r => [r.id, r]));
  const after = new Map(sortRules(desired).map(r => [r.id, r]));
  const target: FolderRule[] = [];
  const changes: RuleChange[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) { target.push(a); changes.push({ rule: id, kind: 'added', narrowing: true, prefix: a.prefix }); continue; }
    if (b.prefix !== a.prefix) {
      const held = { id: heldRuleId(id, b.prefix), prefix: b.prefix, readable_by: b.readable_by, ...(coversDerived(b) ? {} : { covers_derived: false as const }) };
      if (before.has(held.id) || after.has(held.id)) { target.push(b); changes.push({ rule: id, kind: 'prefix_moved', narrowing: false, prefix: a.prefix }); continue; }
      target.push(a, held);
      changes.push({ rule: id, kind: 'prefix_moved', narrowing: true, prefix: a.prefix }, { rule: held.id, kind: 'prefix_released', narrowing: false, prefix: b.prefix });
      continue;
    }
    const removed = b.readable_by.filter(p => !a.readable_by.includes(p));
    const added = a.readable_by.filter(p => !b.readable_by.includes(p));
    const rawOnly = !coversDerived(b) && !coversDerived(a);
    target.push({ id, prefix: b.prefix, readable_by: b.readable_by.filter(p => a.readable_by.includes(p)), ...(rawOnly ? { covers_derived: false as const } : {}) });
    if (removed.length) changes.push({ rule: id, kind: 'readers_removed', narrowing: true, prefix: b.prefix, readers: removed });
    if (added.length) changes.push({ rule: id, kind: 'readers_added', narrowing: false, prefix: b.prefix, readers: added });
    if (coversDerived(b) && !coversDerived(a)) changes.push({ rule: id, kind: 'derived_released', narrowing: false, prefix: b.prefix });
    if (!coversDerived(b) && coversDerived(a)) changes.push({ rule: id, kind: 'derived_covered', narrowing: true, prefix: b.prefix });
  }
  for (const [id, b] of before) {
    if (after.has(id)) continue;
    target.push(b);
    changes.push({ rule: id, kind: HELD_RULE_RE.test(id) ? 'prefix_released' : 'removed', narrowing: false, prefix: b.prefix });
  }
  // A desired rule that takes the prefix of a rule the target still holds (an id renamed) leaves two rules on one prefix
  // until the removal is approved; both have to pass, which is never wider than either.
  const held = changes.filter(c => !c.narrowing);
  const kind = !changes.length ? 'unchanged' : !held.length ? 'narrowing' : held.length === changes.length ? 'widening' : 'mixed';
  return { target: sortRules(target), changes, held, kind };
}

/** The rule ids (unqualified) whose rule covers `slug` (ruleCovers), sorted; null when none (the row twin of gbrain_access_folder_rules). */
export function matchingRuleIds(slug: string, rules: readonly FolderRule[]): string[] | null {
  const ids = rules.filter(r => ruleCovers(slug, r.prefix)).map(r => r.id).sort();
  return ids.length ? ids : null;
}

/** Whether a caller with `identity` passes every rule matching `slug` (the row twin of the folder part of the predicate). */
export function folderRulesAllow(slug: string, rules: readonly FolderRule[], identity: readonly string[]): boolean {
  return rules.filter(r => ruleCovers(slug, r.prefix)).every(r => r.readable_by.some(p => identity.includes(p)));
}
