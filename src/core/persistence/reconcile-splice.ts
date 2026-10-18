import { dump } from 'js-yaml';
import type { ParsedPage } from '../import-file.ts';
import { findTimelineSplitIndex, parseMarkdown } from '../markdown.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { digest, stableJson } from './digest.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { reconcileFileReading, type ReconcileState } from './reconcile-state.ts';

/**
 * The text a reconcile that keeps the file's bytes (repair file-drift --prefer file) writes, or null to render the
 * result instead. A file that already reads as the reviewed result is kept as it is. Otherwise only what reconcile
 * changed is rewritten in place: each changed top-level frontmatter key (new tags are appended to the file's own
 * list) and each changed body half; the splice is used only when it reads back as the reviewed result.
 */
export function keptFileText(state: ReconcileState, result: ParsedPage, resultDigest: string): string | null {
  const raw = state.raw.toString('utf8');
  if (digest(state.file) === resultDigest) return raw;
  const spliced = spliceReconciledFile(raw, state.file, result);
  if (spliced === null) return null;
  const reading = reconcileFileReading(spliced, state.importPath, state.snapshot.page);
  const parsed = parseMarkdown(reading.content, `${state.pins.slug}.md`, { validate: true, expectedSlug: state.pins.slug });
  if (reading.inferred) parsed.type = state.snapshot.page.type;
  return !parsed.errors?.length && digest(reconcileCanonical(parsed, parsed.tags)) === resultDigest ? spliced : null;
}

function spliceReconciledFile(raw: string, file: ParsedPage, result: ParsedPage): string | null {
  if (raw.includes('\r')) return null;
  const lines = raw.split('\n');
  const close = lines.indexOf('---', 1);
  if (lines[0] !== '---' || close === -1) return null;
  const body = spliceBody(lines.slice(close + 1).join('\n'), file, result);
  if (body === null) return null;
  let head = lines.slice(1, close);
  const before: Record<string, unknown> = { ...file.frontmatter, type: file.type, title: file.title, tags: file.tags };
  const after: Record<string, unknown> = { ...result.frontmatter, type: result.type, title: result.title, tags: result.tags };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.hasOwn(before, key) && Object.hasOwn(after, key) && stableJson(before[key]) === stableJson(after[key])) continue;
    head = (key === 'tags' && appendedTags(head, file.tags, result.tags)) || spliceKey(head, key, after[key]);
  }
  return ['---', ...head, '---', body].join('\n');
}

/** The [start, end) lines of top-level key `key`: its own line plus the indented, list and blank lines under it. */
function keyRange(head: string[], key: string): [number, number] | null {
  const start = head.findIndex(line => [`${key}:`, `"${key}":`, `'${key}':`].some(prefix => line.startsWith(prefix)));
  if (start === -1) return null;
  let end = start + 1;
  while (end < head.length && /^([ \t]|-(\s|$)|$)/.test(head[end]!)) end++;
  while (end > start + 1 && head[end - 1]!.trim() === '') end--;
  return [start, end];
}

function spliceKey(head: string[], key: string, value: unknown): string[] {
  const [start, end] = keyRange(head, key) ?? [head.length, head.length];
  const rendered = value === undefined ? [] : dumpFrontmatterYaml({ [key]: value }, { lineWidth: -1 }).trimEnd().split('\n');
  return [...head.slice(0, start), ...rendered, ...head.slice(end)];
}

/** The head with the tags only `next` holds appended to the file's block list or one-line flow list, or null. */
function appendedTags(head: string[], prior: string[], next: string[]): string[] | null {
  const range = keyRange(head, 'tags');
  if (!range || !prior.every(tag => next.includes(tag))) return null;
  // Each tag rendered as a flow-sequence item, which is valid in both list styles.
  const added = next.filter(tag => !prior.includes(tag)).map(tag => dump([tag], { flowLevel: 0, lineWidth: -1 }).trim().slice(1, -1));
  const [start, end] = range;
  const flow = head[start]!.match(/^(.*\[)(.*?)(\s*\]\s*)$/);
  if (flow && end === start + 1) {
    const items = [...(flow[2]!.trim() ? [flow[2]!.replace(/,\s*$/, '')] : []), ...added];
    return [...head.slice(0, start), `${flow[1]}${items.join(', ')}${flow[3]}`, ...head.slice(end)];
  }
  const item = head.slice(start + 1, end).reverse().find(line => /^\s*-\s/.test(line))?.match(/^\s*-\s+/)?.[0];
  if (!item || head[start]!.slice(head[start]!.indexOf(':') + 1).trim()) return null;
  return [...head.slice(0, end), ...added.map(tag => item + tag), ...head.slice(end)];
}

/** The body with each changed half's trimmed text replaced, keeping the whitespace around it, or null. */
function spliceBody(body: string, file: ParsedPage, result: ParsedPage): string | null {
  if (file.compiled_truth === result.compiled_truth && file.timeline === result.timeline) return body;
  const swap = (region: string, prior: string, next: string) => {
    if (prior === next) return region;
    const start = region.length - region.trimStart().length;
    return region.slice(0, start) + next + region.slice(Math.max(start, region.trimEnd().length));
  };
  const lines = body.split('\n');
  const split = findTimelineSplitIndex(lines);
  if (split !== -1) {
    return [swap(lines.slice(0, split).join('\n'), file.compiled_truth, result.compiled_truth), lines[split],
      swap(lines.slice(split + 1).join('\n'), file.timeline, result.timeline)].join('\n');
  }
  // A timeline read from a bare `## Timeline` section has no sentinel to splice at.
  if (file.timeline) return null;
  const truth = swap(body, file.compiled_truth, result.compiled_truth);
  return result.timeline ? `${truth}${truth.endsWith('\n') ? '' : '\n'}\n<!-- timeline -->\n\n${result.timeline}\n` : truth;
}
