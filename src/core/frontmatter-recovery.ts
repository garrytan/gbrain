/**
 * Recovery for frontmatter blocks js-yaml refuses (#5988).
 *
 * `parseMarkdown` calls `recoverFrontmatter` only after its unconditional
 * pre-quote pass and a strict parse have failed, so a block that parses today
 * is never re-read. Rules touch only the suspect run (the key line nearest the
 * parser's error mark plus its non-key continuation lines); every other line
 * stays byte-identical, and each line keeps its own CRLF ending.
 *
 * `quote` keeps the value text exactly and re-emits it as one double-quoted
 * scalar, so it is the only kind an import accepts. `fold`, `dup` and
 * `unclosed` guess at meaning: the block is classified `needs_interpretation`
 * and the proposed block is kept for an approved repair, never imported.
 * Protected keys (who may read a page, where it came from) are never
 * rewritten, folded into or guessed; identity keys are never resolved from a
 * duplicate.
 */
import { load } from 'js-yaml';
import { FRONTMATTER_SCHEMA } from './data-frontmatter.ts';

/** Bump when a rule widens; older holds are re-screened. */
export const RECOVERY_VERSION = 1;

/**
 * Keys read by access-control and provenance code (`search/private-visibility.ts`,
 * `repair/visibility.ts`, connector publication). `test/frontmatter-recovery.test.ts`
 * greps those readers so a new key cannot be missed.
 */
export const PROTECTED_FRONTMATTER_KEYS: readonly string[] = ['visibility', 'derived_from', 'source_slug', 'synthesized_by', 'concepts', 'captured_via', 'event'];
/** Keys that decide which page a file is. A duplicate is never resolved. */
export const IDENTITY_FRONTMATTER_KEYS: readonly string[] = ['slug', 'type', 'id', 'source_id'];

export type RecoveryKind = 'quote' | 'fold' | 'dup' | 'unclosed';
export type FrontmatterRecoveryStatus =
  | 'clean' | 'recovered' | 'needs_interpretation' | 'ambiguous_identity_key' | 'ambiguous_protected_key' | 'unrecoverable';

export interface FrontmatterRecoveryStep {
  kind: RecoveryKind;
  key: string;
  /** File line of the rewritten key line (for `dup`, the later occurrence, which wins). */
  line: number;
  /** For `dup`: the earlier occurrence, which the proposal drops. */
  otherLine?: number;
  original: string;
  replacement: string | null;
}

export interface FrontmatterRecovery {
  status: FrontmatterRecoveryStatus;
  /** `recovered`: the block to import. `needs_interpretation`: the proposed block. Otherwise the input. */
  block: string;
  steps: FrontmatterRecoveryStep[];
  key?: string;
  line?: number;
  column?: number;
  /** js-yaml's reason phrase for the last failure; it never quotes the document. */
  yamlReason?: string;
  recovery_version: number;
}

const KEY_LINE = /^([A-Za-z_][\w-]*):(?=[ \t]|$)/;

interface Row { text: string; eol: string }
interface YamlFailure { reason: string; line: number | null; column: number | null }

function loadBlock(text: string): { ok: true; data: unknown } | { ok: false; failure: YamlFailure } {
  try {
    return { ok: true, data: load(text, { schema: FRONTMATTER_SCHEMA }) };
  } catch (error) {
    const e = error as { reason?: string; mark?: { line?: number; column?: number } };
    return { ok: false, failure: { reason: e.reason ?? 'malformed YAML', line: e.mark?.line ?? null, column: e.mark?.column ?? null } };
  }
}

function toRows(block: string): Row[] {
  return block.split('\n').map(raw => raw.endsWith('\r') ? { text: raw.slice(0, -1), eol: '\r' } : { text: raw, eol: '' });
}

function fromRows(rows: Row[]): string {
  return rows.map(row => row.text + row.eol).join('\n');
}

function keyOf(text: string): string | null {
  return KEY_LINE.exec(text)?.[1] ?? null;
}

/** Location only: js-yaml's reason phrase plus line and column, never a document excerpt. */
export function yamlLocationMessage(reason: string, line: number | null | undefined, column?: number | null): string {
  return `${reason}${typeof line === 'number' ? ` at line ${line}${typeof column === 'number' ? `, column ${column}` : ''}` : ''}`;
}

/** A value whose meaning is fixed, re-emitted as one double-quoted scalar. */
function quotedScalarText(value: string): string {
  const q = value[0];
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
    const inner = value.slice(1, -1);
    if (new RegExp(q === '"' ? '(^|[^\\\\])"' : "'").test(inner)) return inner;
  }
  return value;
}

interface Rule { kind: RecoveryKind; replace: Row[]; removeThrough: number }

function ruleFor(rows: Row[], k: number, end: number): Rule | null {
  const match = KEY_LINE.exec(rows[k]!.text)!;
  const key = match[1]!;
  const value = rows[k]!.text.slice(match[0].length).trim();
  const continuation = rows.slice(k + 1, end);
  const lastContent = continuation.reduce((last, row, i) => row.text.trim() === '' ? last : i, -1);
  const content = continuation.slice(0, lastContent + 1);
  const unindented = content.filter(row => row.text.trim() !== '' && !/^[ \t]/.test(row.text) && !/^-(?:[ \t]|$)/.test(row.text) && !row.text.startsWith('#'));
  const standaloneOk = value === '' || loadBlock(`${key}: ${value}`).ok;
  const emit = (text: string): Row[] => [{ text: `${key}: ${JSON.stringify(text)}`, eol: rows[k]!.eol }];
  if (unindented.length > 0) {
    if (unindented.length !== content.filter(row => row.text.trim() !== '').length) return null;
    const head = standaloneOk && /^["']/.test(value) ? String((loadBlock(`v: ${value}`) as { data: { v: unknown } }).data.v) : value;
    return { kind: 'fold', replace: emit([head, ...unindented.map(row => row.text)].filter(part => part !== '').join('\n')), removeThrough: k + 1 + lastContent };
  }
  if (standaloneOk || content.length > 0) return null;
  if (/^["']/.test(value)) return { kind: 'quote', replace: emit(quotedScalarText(value)), removeThrough: k };
  if (/^[[{]/.test(value)) return { kind: 'unclosed', replace: emit(value), removeThrough: k };
  if (value.includes(': ') || value.endsWith(':') || /^[@`]/.test(value)) return { kind: 'quote', replace: emit(value), removeThrough: k };
  return null;
}

/**
 * Recover one frontmatter block (the text between the fences). `lineOffset`
 * is the file line before the block's first row, so reported lines are file
 * lines. Callers run it only after a strict parse failed.
 */
export function recoverFrontmatter(block: string, lineOffset = 0): FrontmatterRecovery {
  let rows = toRows(block);
  const steps: FrontmatterRecoveryStep[] = [];
  const seen = new Set<string>();
  let interpretive = false;
  const done = (status: FrontmatterRecoveryStatus, extra: Partial<FrontmatterRecovery> = {}): FrontmatterRecovery =>
    ({ status, block: status === 'recovered' || status === 'needs_interpretation' ? fromRows(rows) : block, steps, recovery_version: RECOVERY_VERSION, ...extra });
  const keyLines = rows.filter(row => keyOf(row.text) !== null).length;
  for (let pass = 0; pass <= keyLines + 1; pass++) {
    const loaded = loadBlock(fromRows(rows));
    if (loaded.ok) return done(steps.length === 0 ? 'clean' : interpretive ? 'needs_interpretation' : 'recovered');
    const failure = loaded.failure;
    const mark = Math.min(Math.max(failure.line ?? rows.length - 1, 0), rows.length - 1);
    const location = { yamlReason: failure.reason, column: failure.column === null ? undefined : failure.column + 1 };
    let nearest = mark;
    while (nearest > 0 && keyOf(rows[nearest]!.text) === null) nearest--;
    const nearestKey = keyOf(rows[nearest]!.text) ?? undefined;
    const at = { ...location, key: nearestKey, line: lineOffset + (nearestKey ? nearest : mark) + 1 };
    if (/duplicated mapping key/.test(failure.reason) && nearestKey) {
      const line = lineOffset + nearest + 1;
      if (PROTECTED_FRONTMATTER_KEYS.includes(nearestKey)) return done('ambiguous_protected_key', { ...at, line });
      if (IDENTITY_FRONTMATTER_KEYS.includes(nearestKey)) return done('ambiguous_identity_key', { ...at, line });
      const earlier = rows.findIndex((row, i) => i < nearest && keyOf(row.text) === nearestKey);
      if (earlier < 0 || seen.has(`dup:${nearestKey}`)) return done('unrecoverable', at);
      seen.add(`dup:${nearestKey}`);
      let earlierEnd = earlier + 1;
      while (earlierEnd < rows.length && keyOf(rows[earlierEnd]!.text) === null && /^([ \t]|-(?:[ \t]|$))/.test(rows[earlierEnd]!.text)) earlierEnd++;
      steps.push({ kind: 'dup', key: nearestKey, line: lineOffset + nearest + 1, otherLine: lineOffset + earlier + 1, original: rows[earlier]!.text, replacement: null });
      interpretive = true;
      rows = [...rows.slice(0, earlier), ...rows.slice(earlierEnd)];
      continue;
    }
    let chosen: { k: number; rule: Rule } | null = null;
    for (let k = mark; k >= 0 && !chosen; k--) {
      const key = keyOf(rows[k]!.text);
      if (key === null || seen.has(`line:${k}:${rows[k]!.text}`)) continue;
      let end = k + 1;
      while (end < rows.length && keyOf(rows[end]!.text) === null) end++;
      const rule = ruleFor(rows, k, end);
      if (rule) chosen = { k, rule };
    }
    if (!chosen) return done('unrecoverable', at);
    const { k, rule } = chosen;
    const key = keyOf(rows[k]!.text)!;
    const line = lineOffset + k + 1;
    if (PROTECTED_FRONTMATTER_KEYS.includes(key)) return done('ambiguous_protected_key', { ...location, key, line });
    if (rule.kind !== 'quote' && IDENTITY_FRONTMATTER_KEYS.includes(key)) return done('ambiguous_identity_key', { ...location, key, line });
    seen.add(`line:${k}:${rule.replace[0]!.text}`);
    steps.push({ kind: rule.kind, key, line, original: rows[k]!.text, replacement: rule.replace[0]!.text });
    if (rule.kind !== 'quote') interpretive = true;
    rows = [...rows.slice(0, k), ...rule.replace, ...rows.slice(rule.removeThrough + 1)];
  }
  return done('unrecoverable', { yamlReason: 'too many recovery passes' });
}

/**
 * A successfully parsed block can still hide who may read the page: a
 * protected value the pre-quote pass rewrote (`visibility: private # note: x`
 * imports as a different string), or a protected or identity key line that a
 * multi-line quoted scalar swallowed. `quotedKeys` are the key names the
 * pre-quote pass rewrote.
 */
export function frontmatterKeyHazard(
  block: string,
  data: Record<string, unknown>,
  quotedKeys: ReadonlySet<string>,
  lineOffset = 0,
): { status: 'ambiguous_protected_key' | 'ambiguous_identity_key'; key: string; line: number } | null {
  const rows = toRows(block);
  for (let i = 0; i < rows.length; i++) {
    const key = keyOf(rows[i]!.text);
    if (key === null) continue;
    const line = lineOffset + i + 1;
    const present = Object.prototype.hasOwnProperty.call(data, key);
    if (PROTECTED_FRONTMATTER_KEYS.includes(key) && (quotedKeys.has(key) || !present)) return { status: 'ambiguous_protected_key', key, line };
    if (IDENTITY_FRONTMATTER_KEYS.includes(key) && !present) return { status: 'ambiguous_identity_key', key, line };
  }
  return null;
}

/**
 * An unclosed fence imports with no frontmatter at all, which would drop a
 * protected key such as `visibility`. `lines` are the file lines after the
 * opening fence; only the leading YAML-shaped run is inspected.
 */
export function unclosedFenceProtectedKey(lines: readonly string[], lineOffset = 0): { key: string; line: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.replace(/\r$/, '');
    const key = keyOf(text);
    if (key !== null) {
      if (PROTECTED_FRONTMATTER_KEYS.includes(key)) return { key, line: lineOffset + i + 1 };
      continue;
    }
    if (text.trim() === '' || /^[ \t]/.test(text) || /^-(?:[ \t]|$)/.test(text) || text.startsWith('#')) continue;
    return null;
  }
  return null;
}

/**
 * `title: #1 thing` is valid YAML whose value is a comment, so the key reads
 * as null. Detection only: the parse is unchanged. `description: # TODO`
 * (a space after `#`) is an ordinary empty value and is not reported.
 */
export function commentValueKeys(block: string, data: Record<string, unknown>, lineOffset = 0): Array<{ key: string; line: number }> {
  const found: Array<{ key: string; line: number }> = [];
  toRows(block).forEach((row, i) => {
    const m = /^([A-Za-z_][\w-]*):[ \t]+#\S/.exec(row.text);
    if (m && Object.prototype.hasOwnProperty.call(data, m[1]!) && data[m[1]!] === null) found.push({ key: m[1]!, line: lineOffset + i + 1 });
  });
  return found;
}
