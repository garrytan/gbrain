/**
 * GST-2468: a label-only maintenance page write (`managed_maintenance_page` with `label_edit`) changes the page's
 * privacy labels and nothing else, so its canonical file keeps its own bytes: only the label lines are removed, replaced
 * or appended to the frontmatter block (page-prepare.ts labelEditFile). The edit names `set` (a key and its plain
 * scalar value, or for `readable_by` its readers as a one-line flow list, GST-2476) and `remove` (keys), both among
 * LABEL_KEYS and READERS_KEY. The editor reads no YAML: a label line it cannot edit as one line (a block or multi-line
 * value, a duplicate key, a value that needs quoting, no frontmatter block) returns null, and the write refuses instead
 * of re-rendering the file.
 */
import { opError } from '../ops/contract.ts';
import { ACCESS_ID_RE } from '../access/principals.ts';
import { loadBoundedYaml } from '../data-frontmatter.ts';

/** The frontmatter keys a label edit may touch: visibility and the privacy aliases (search/private-visibility.ts PRIVACY_ALIASES). */
export const LABEL_KEYS: readonly string[] = ['visibility', 'access', 'confidentiality'];
const PLAIN_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A value a label edit can write as one unquoted line. */
export const isPlainLabelValue = (value: unknown): value is string => typeof value === 'string' && PLAIN_VALUE.test(value);

/** GST-2476: the readers key, written as `readable_by: [alice-example, group:team-a]` (repair/readers.ts). */
export const READERS_KEY = 'readable_by';
const EDIT_KEYS: readonly string[] = [...LABEL_KEYS, READERS_KEY];
const READER = new RegExp(`^(?:group:|member:)?${ACCESS_ID_RE.source.slice(1, -1)}$`);
/** Readers a label edit can write as one flow-list line: 1-256 member ids or group:<id>, each in its canonical spelling. */
export const isPlainReaders = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= 256
  && value.every(entry => typeof entry === 'string' && READER.test(entry));
const plainValue = (key: string, value: unknown) => key === READERS_KEY ? isPlainReaders(value) : isPlainLabelValue(value);

export interface LabelEdit { set: Record<string, string | string[]>; remove: string[] }

/** The intent's label_edit, validated, or undefined when the intent carries none. */
export function readLabelEdit(value: unknown): LabelEdit | undefined {
  if (value === undefined || value === null) return undefined;
  const edit = value as { set?: unknown; remove?: unknown };
  const set = edit.set ?? {}, remove = edit.remove ?? [];
  const valid = typeof set === 'object' && set !== null && !Array.isArray(set) && Array.isArray(remove)
    && Object.entries(set).every(([key, v]) => EDIT_KEYS.includes(key) && plainValue(key, v))
    && remove.every(key => typeof key === 'string' && EDIT_KEYS.includes(key) && !Object.hasOwn(set, key));
  if (!valid) throw opError('invalid_params', 'The label edit names a key or value a label edit cannot write.',
    `A label edit sets or removes only ${EDIT_KEYS.join(', ')}, each value a plain word (${READERS_KEY}: a list of member ids and group: ids). This is a gbrain planning defect: report it with the gbrain version; nothing was written.`);
  return { set: Object.fromEntries(Object.entries(set as LabelEdit['set']).map(([key, v]) => [key, Array.isArray(v) ? [...v] : v])), remove: [...new Set(remove as string[])] };
}

/** frontmatter with the edit applied (key order kept, a new key last). */
export function labelEditedFrontmatter(frontmatter: Record<string, unknown>, edit: LabelEdit): Record<string, unknown> {
  return Object.assign(Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !edit.remove.includes(key))), edit.set);
}

const KEY_LINES: Record<string, RegExp> = {
  visibility: /^visibility[ \t]*:(?:[ \t]|\r?\n|$)/, access: /^access[ \t]*:(?:[ \t]|\r?\n|$)/, confidentiality: /^confidentiality[ \t]*:(?:[ \t]|\r?\n|$)/,
  readable_by: /^readable_by[ \t]*:(?:[ \t]|\r?\n|$)/,
};
/**
 * GST-2519: `text`, a file under a declared storage.db_only path about to be imported over its page, with each privacy
 * label the stored page holds and the file does not state, so an import there never widens who reads the page; a label
 * the file states (narrower or wider) is the owner's and applies. Null when there is nothing to keep.
 */
export function withStoredLabels(text: string, stored: Record<string, unknown> | null | undefined, incoming: Record<string, unknown>): string | null {
  const kept = storedLabelsToKeep(stored, incoming);
  if (!kept.length) return null;
  const lines = kept.map(key => `${key}: ${JSON.stringify(stored![key])}\n`).join('');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const lead = /^(?:[ \t\r]*\n)*/.exec(body)![0];
  const open = /^---[ \t]*\r?\n/.exec(body.slice(lead.length));
  const close = open ? /^---[ \t]*(?:\r?\n|$)/m.exec(body.slice(lead.length + open[0].length)) : null;
  let mapping = false;
  if (open && close) {
    try {
      const block = loadBoundedYaml(body.slice(lead.length + open[0].length, lead.length + open[0].length + close.index));
      mapping = block == null || (typeof block === 'object' && !Array.isArray(block));
    } catch { mapping = false; }
  }
  if (!open || !close || !mapping) return `${bom}---\n${lines}---\n${body}`;
  const from = lead.length + open[0].length, at = from + close.index;
  const blank = (line: string) => kept.includes(BLANK_LABEL_LINE.exec(line)?.[1] ?? '');
  const block = body.slice(from, at).split('\n').filter((line, i, all) => !(i < all.length - 1 && blank(line))).join('\n');
  return bom + body.slice(0, from) + block + lines + body.slice(at);
}

const BLANK_LABEL_LINE = /^(visibility|access|confidentiality|readable_by)[ \t]*:[ \t]*(?:~|null|Null|NULL|''|"")?[ \t]*\r?$/;

/** GST-2519: the privacy labels the stored page holds that the incoming frontmatter does not state (absent, null or blank). */
export function storedLabelsToKeep(stored: Record<string, unknown> | null | undefined, incoming: Record<string, unknown>): string[] {
  return EDIT_KEYS.filter(key => stored?.[key] != null && (incoming[key] == null || incoming[key] === ''));
}

const listEntry = (entry: string) => (loadBoundedYaml(`[${entry}]`) as unknown[])[0] === entry ? entry : `'${entry}'`;
const valueText = (value: string | string[]) => Array.isArray(value) ? `[${value.map(listEntry).join(', ')}]` : value;
const keyLine = (key: string) => KEY_LINES[key] ?? /(?!)/;

/**
 * text with the edit applied to its frontmatter lines, and the file's head through the closing --- line, or null when
 * a label line cannot be edited as one line. Every other byte is kept: key order, other keys, comments, line endings, the body.
 */
export function spliceLabelLines(text: string, edit: LabelEdit): { text: string; head: string } | null {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = text.slice(bom.length).split(/(?<=\n)/);
  if (!/^---[ \t]*\r?\n$/.test(lines[0] ?? '')) return null;
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*(?:\r?\n)?$/.test(line));
  if (close < 0) return null;
  const block = lines.slice(1, close);
  for (const key of [...edit.remove, ...Object.keys(edit.set)]) {
    const at = block.flatMap((line, index) => keyLine(key).test(line) ? [index] : []);
    if (at.length > 1) return null;
    if (!at.length) continue;
    const value = block[at[0]!]!.slice(block[at[0]!]!.indexOf(':') + 1).trim();
    if (!value || /^[|>&*!]/.test(value) || /^[ \t]+\S/.test(block[at[0]! + 1] ?? '')) return null;
  }
  const kept = block.filter(line => !edit.remove.some(key => keyLine(key).test(line)));
  const eol = lines[0]!.endsWith('\r\n') ? '\r\n' : '\n';
  for (const [key, value] of Object.entries(edit.set)) {
    const at = kept.findIndex(line => keyLine(key).test(line));
    if (at >= 0) kept[at] = `${key}: ${valueText(value)}${kept[at]!.endsWith('\r\n') ? '\r\n' : '\n'}`;
    else kept.push(`${key}: ${valueText(value)}${eol}`);
  }
  const head = bom + lines[0] + kept.join('') + lines[close];
  return { text: head + lines.slice(close + 1).join(''), head };
}
