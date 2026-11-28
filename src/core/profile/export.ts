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
const MARKER_RE = /^\s*<!--\s*gbrain:profile\s+(begin|end)\b/;

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
/** A fact a tool or an outside source wrote keeps that label in the other assistant's memory, so it never reads as something you said. */
const claimText = (f: ProfileFact) => oneLine(f.claim)
  + (f.content_origin === 'tool_output' ? ' (from a tool, not confirmed by you)' : f.trust_tier === 'external_untrusted' ? ' (from an outside source, not confirmed by you)' : '');
const day = (f: ProfileFact) => f.valid_from.slice(0, 10);
const group = (facts: ProfileFact[]) => {
  const by = new Map<string, ProfileFact[]>();
  for (const f of facts) { const k = f.facet ? facetKind(f.facet) : 'preference'; by.set(k, [...(by.get(k) ?? []), f]); }
  return [...ORDER, 'preference'].filter(k => by.has(k)).map(k => [k, by.get(k)!] as const);
};
const bullet = (f: ProfileFact) => {
  const item = f.facet?.startsWith('size.') ? f.facet.slice(5) : null;
  return `- ${item ? `${item}: ` : ''}${claimText(f)}`;
};

/** `[YYYY-MM-DD] - fact`, one per line: the list Claude's memory import reads. */
export function renderMemoryText(facts: ProfileFact[]): string {
  return facts.map(f => `${f.valid_from ? `[${day(f)}] ` : ''}- ${claimText(f)}`).join('\n') + (facts.length ? '\n' : '');
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
 * The one gbrain:profile block's begin and end line indexes, or null when there is none. Refuses, so the caller changes
 * nothing, when a marker line is malformed, repeated, unpaired, or an end comes before its begin. A marker inside a
 * fenced code block is an example, not a marker.
 */
function museBlock(lines: string[], refusal: string, fix: string): { begin: number; end: number } | null {
  let fence: string | null = null;
  const inFence = lines.map(l => {
    const open = /^\s*(`{3,}|~{3,})/.exec(l)?.[1];
    if (!open) return fence !== null;
    if (fence === null) { fence = open[0]!; return true; }
    if (open[0] === fence) fence = null;
    return true;
  });
  const marks = lines.flatMap((l, i) => !inFence[i] && MARKER_RE.test(l) ? [{ i, kind: MARKER_RE.exec(l)![1]!, ok: l.trim() === MUSE_END || MUSE_BEGIN_RE.test(l.trim()) }] : []);
  const begins = marks.filter(m => m.kind === 'begin');
  const ends = marks.filter(m => m.kind === 'end');
  const bad = marks.find(m => !m.ok);
  if (bad || begins.length > 1 || ends.length > 1 || begins.length !== ends.length || (begins[0] && begins[0].i > ends[0]!.i)) {
    const why = bad ? `line ${bad.i + 1} is not a well-formed gbrain:profile marker`
      : begins.length !== ends.length ? `it has ${begins.length} begin and ${ends.length} end marker(s)`
      : begins.length > 1 ? `it has ${begins.length} gbrain:profile blocks` : 'its end marker comes before its begin marker';
    throw opError('invalid_params', refusal.replace('%s', why), fix);
  }
  return begins.length ? { begin: begins[0]!.i, end: ends[0]!.i } : null;
}

/**
 * The destination's text with the Muse block in place: the previous block replaced, or the block appended when there
 * is none. Refuses, changing nothing, when a marker line is malformed, repeated, or an end comes before its begin.
 */
export function mergeMuseBlock(existing: string, block: string): string {
  const lines = existing.split('\n');
  const at = museBlock(lines, "profile export: the destination's GBrain block is damaged (%s); the file was left untouched.",
    'Delete the damaged gbrain:profile lines (from the begin marker through the end marker) and export again.');
  if (!at) {
    const head = existing.replace(/\n*$/, '');
    return (head ? head + '\n\n' : '') + block + '\n';
  }
  return [...lines.slice(0, at.begin), ...block.split('\n'), ...lines.slice(at.end + 1)].join('\n');
}

/**
 * The 1-based lines of the gbrain:profile block, which an import skips so an exported profile is never re-imported.
 * A damaged block is refused the same way export refuses it, so no line of the file is skipped by guesswork.
 */
export function museBlockLines(text: string): Set<number> {
  const at = museBlock(text.split(/\r?\n/), "profile import: the file's GBrain block is damaged (%s); nothing was previewed.",
    'Delete the damaged gbrain:profile lines (from the begin marker through the end marker) and preview again.');
  const out = new Set<number>();
  for (let i = at?.begin ?? 0; at && i <= at.end; i++) out.add(i + 1);
  return out;
}
