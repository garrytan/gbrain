/**
 * GST-2468: a label-only maintenance page write (`managed_maintenance_page` with `label_edit`) changes the page's
 * privacy labels and nothing else, so its canonical file keeps its own bytes: only the label lines are removed, replaced
 * or appended to the frontmatter block (page-prepare.ts labelEditFile). The edit names `set` (a key and its plain
 * scalar value) and `remove` (keys), both among LABEL_KEYS. The editor reads no YAML: a label line it cannot edit
 * as one line (a block or multi-line value, a duplicate key, a value that needs quoting, no frontmatter block) returns
 * null, and the write refuses instead of re-rendering the file.
 */
import { opError } from '../ops/contract.ts';

/** The frontmatter keys a label edit may touch: visibility and the privacy aliases (search/private-visibility.ts PRIVACY_ALIASES). */
export const LABEL_KEYS: readonly string[] = ['visibility', 'access', 'confidentiality'];
const PLAIN_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A value a label edit can write as one unquoted line. */
export const isPlainLabelValue = (value: unknown): value is string => typeof value === 'string' && PLAIN_VALUE.test(value);

export interface LabelEdit { set: Record<string, string>; remove: string[] }

/** The intent's label_edit, validated, or undefined when the intent carries none. */
export function readLabelEdit(value: unknown): LabelEdit | undefined {
  if (value === undefined || value === null) return undefined;
  const edit = value as { set?: unknown; remove?: unknown };
  const set = edit.set ?? {}, remove = edit.remove ?? [];
  const valid = typeof set === 'object' && set !== null && !Array.isArray(set) && Array.isArray(remove)
    && Object.entries(set).every(([key, v]) => LABEL_KEYS.includes(key) && isPlainLabelValue(v))
    && remove.every(key => typeof key === 'string' && LABEL_KEYS.includes(key) && !Object.hasOwn(set, key));
  if (!valid) throw opError('invalid_params', 'The label edit names a key or value a label edit cannot write.',
    `A label edit sets or removes only ${LABEL_KEYS.join(', ')}, each value a plain word. This is a gbrain planning defect: report it with the gbrain version; nothing was written.`);
  return { set: { ...set as Record<string, string> }, remove: [...new Set(remove as string[])] };
}

/** frontmatter with the edit applied (key order kept, a new key last). */
export function labelEditedFrontmatter(frontmatter: Record<string, unknown>, edit: LabelEdit): Record<string, unknown> {
  return Object.assign(Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !edit.remove.includes(key))), edit.set);
}

const KEY_LINES: Record<string, RegExp> = {
  visibility: /^visibility[ \t]*:(?:[ \t]|\r?\n|$)/, access: /^access[ \t]*:(?:[ \t]|\r?\n|$)/, confidentiality: /^confidentiality[ \t]*:(?:[ \t]|\r?\n|$)/,
};
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
    if (at >= 0) kept[at] = `${key}: ${value}${kept[at]!.endsWith('\r\n') ? '\r\n' : '\n'}`;
    else kept.push(`${key}: ${value}${eol}`);
  }
  const head = bom + lines[0] + kept.join('') + lines[close];
  return { text: head + lines.slice(close + 1).join(''), head };
}
