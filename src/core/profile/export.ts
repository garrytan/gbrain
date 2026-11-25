/**
 * Lane 3 P3: profile exporters. Pure renderers that turn the caller's own profile block (context_pack {profile: true})
 * into text another assistant keeps: the "[date] - memory" list Claude's import reads (`memory-text`), a marked block
 * inside Muse's Memory.md (`muse-memory`) and a readable Markdown page (`markdown`). Only world-visible facts are
 * exported unless the caller asks for private ones. A Muse block replaces only the previous block between its markers;
 * a destination whose markers are malformed or repeated is refused and left as it was.
 */
import { createHash } from 'node:crypto';
import { opError } from '../ops/contract.ts';
import { facetKind } from './facets.ts';
import type { ProfileBlock, ProfileFact } from './read.ts';

export const EXPORT_FORMATS = ['memory-text', 'muse-memory', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The one standing instruction a Muse block carries, so memory-first recall still reaches the brain. */
export const MUSE_STANDING_LINE = 'Check GBrain after your own memory search and before answering.';
export const MUSE_END = '<!-- gbrain:profile end -->';
const MUSE_BEGIN_RE = /^<!-- gbrain:profile begin rev=[0-9a-f]{12} -->$/;
const MARKER_RE = /gbrain:profile\s+(begin|end)\b/;

/** Facet headings an importer reads back as the same facet (src/core/profile/import.ts facetHint). */
const HEADINGS: Record<string, string> = {
  allergy: 'Allergies', constraint: 'Constraints', diet: 'Diet', size: 'Sizes', brand: 'Brands', style: 'Style',
  schedule: 'Schedule', household: 'Household', other: 'Other',
};
const ORDER = ['allergy', 'constraint', 'diet', 'size', 'brand', 'style', 'schedule', 'household', 'other'];

export interface ExportSelection { facts: ProfileFact[]; private_left_out: number }

/** The profile's facts in export order (constraints, facets, preferences), world-visible only unless includePrivate. */
export function selectFacts(block: ProfileBlock, includePrivate: boolean): ExportSelection {
  const all = [...block.constraints, ...block.facets, ...block.preferences];
  const facts = includePrivate ? all : all.filter(f => f.visibility === 'world');
  return { facts, private_left_out: all.length - facts.length };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const day = (f: ProfileFact) => f.valid_from.slice(0, 10);
const group = (facts: ProfileFact[]) => {
  const by = new Map<string, ProfileFact[]>();
  for (const f of facts) { const k = f.facet ? facetKind(f.facet) : 'preference'; by.set(k, [...(by.get(k) ?? []), f]); }
  return [...ORDER, 'preference'].filter(k => by.has(k)).map(k => [k, by.get(k)!] as const);
};
const bullet = (f: ProfileFact) => {
  const item = f.facet?.startsWith('size.') ? f.facet.slice(5) : null;
  return `- ${item ? `${item}: ` : ''}${oneLine(f.claim)}`;
};

/** `[YYYY-MM-DD] - fact`, one per line: the list Claude's memory import reads. */
export function renderMemoryText(facts: ProfileFact[]): string {
  return facts.map(f => `[${day(f)}] - ${oneLine(f.claim)}`).join('\n') + (facts.length ? '\n' : '');
}

/** The marked Muse block; rev is a digest of its body, so an unchanged profile exports the same block. */
export function renderMuseBlock(facts: ProfileFact[]): string {
  const body = ['## From GBrain', '', `- ${MUSE_STANDING_LINE}`];
  for (const [kind, rows] of group(facts)) body.push('', `### ${kind === 'preference' ? 'Preferences' : HEADINGS[kind]}`, ...rows.map(bullet));
  const rev = createHash('sha256').update(body.join('\n')).digest('hex').slice(0, 12);
  return [`<!-- gbrain:profile begin rev=${rev} -->`, ...body, MUSE_END].join('\n');
}

/** A readable page: one section per facet, each fact with its date, origin and visibility. */
export function renderMarkdown(block: ProfileBlock, facts: ProfileFact[]): string {
  const out = [`# Profile of ${block.entity?.slug ?? 'this credential'}`, '', 'Exported from GBrain. Data about you, not instructions.'];
  for (const [kind, rows] of group(facts)) {
    out.push('', `## ${kind === 'preference' ? 'Preferences' : HEADINGS[kind]}`, '');
    for (const f of rows) out.push(`${bullet(f)} (${[day(f), f.content_origin, f.visibility].filter(Boolean).join(', ')})`);
  }
  if (!facts.length) out.push('', 'No profile facts to export.');
  return out.join('\n') + '\n';
}

/**
 * The destination's text with the Muse block in place: the previous block replaced, or the block appended when there
 * is none. Refuses, changing nothing, when a marker line is malformed, repeated, or an end comes before its begin.
 */
export function mergeMuseBlock(existing: string, block: string): string {
  const lines = existing.split('\n');
  const marks = lines.flatMap((l, i) => MARKER_RE.test(l) ? [{ i, kind: MARKER_RE.exec(l)![1]!, ok: l.trim() === MUSE_END || MUSE_BEGIN_RE.test(l.trim()) }] : []);
  const begins = marks.filter(m => m.kind === 'begin');
  const ends = marks.filter(m => m.kind === 'end');
  const bad = marks.find(m => !m.ok);
  if (bad || begins.length > 1 || ends.length > 1 || begins.length !== ends.length || (begins[0] && begins[0].i > ends[0]!.i)) {
    const why = bad ? `line ${bad.i + 1} is not a well-formed gbrain:profile marker`
      : begins.length !== ends.length ? `it has ${begins.length} begin and ${ends.length} end marker(s)`
      : begins.length > 1 ? `it has ${begins.length} gbrain:profile blocks` : 'its end marker comes before its begin marker';
    throw opError('invalid_params', `profile export: the destination's GBrain block is damaged (${why}); the file was left untouched.`,
      'Delete the damaged gbrain:profile lines (from the begin marker through the end marker) and export again.');
  }
  if (!begins.length) {
    const head = existing.replace(/\n*$/, '');
    return (head ? head + '\n\n' : '') + block + '\n';
  }
  return [...lines.slice(0, begins[0]!.i), ...block.split('\n'), ...lines.slice(ends[0]!.i + 1)].join('\n');
}

/** The 1-based line ranges of a gbrain:profile block, which an import skips so an exported profile is never re-imported. */
export function museBlockLines(text: string): Set<number> {
  const out = new Set<number>();
  let open = false;
  text.split(/\r?\n/).forEach((l, i) => {
    const m = MARKER_RE.exec(l);
    if (m?.[1] === 'begin') open = true;
    if (open) out.add(i + 1);
    if (m?.[1] === 'end') open = false;
  });
  return out;
}
