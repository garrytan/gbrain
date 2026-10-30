/**
 * #7247: put a page's timeline back in date order, without the database.
 *
 * Pure text in, text out: `orderTimeline` takes a page's two halves
 * (`compiled_truth` above the timeline sentinel, `timeline` below it) and
 * returns the repaired halves with what changed, or the reason it would not
 * touch the page. `gbrain repair timeline-order` (repair/timeline-order.ts)
 * publishes the result through a revision-bound `put_page`.
 *
 * A timeline section is the headingless lead of the timeline half, or an
 * exact `## Timeline` / `## History` H2 section on either side of the
 * sentinel, holding at least one Format-1 bullet (`- **YYYY-MM-DD** | source —
 * summary`); it ends at the next H1 or H2 outside code fences and comments.
 * Inside a section:
 *
 *   - a Format-1 bullet moves with its indented continuation lines and with the
 *     #5567 materialized marker directly above it (the marker belongs to it);
 *   - every other line (prose, sub-headings, comments, fences, tables) is an
 *     anchor that never moves, so bullets are sorted only within the runs of
 *     bullets and blank lines between anchors; blank lines keep their slots;
 *   - a line that cannot be classified safely (a lazy continuation, odd
 *     indentation, a bullet paragraph after a blank line, a dated bullet in
 *     another format, an unclosed fence or comment) keeps the whole page as
 *     it is and reports it for a person.
 *
 * Sorting is stable and follows the page's own direction: descending only when
 * more neighbouring bullets of a run descend than ascend. Exact duplicates (the same
 * block, byte for byte after trimming trailing whitespace) within one run keep
 * the first copy. Bullets with the same date whose summaries differ only in
 * case and punctuation are counted, never merged. Several timeline sections are
 * joined into the first one (its position and heading) only when every later
 * section holds nothing but bullets and the first holds one run of them, and
 * only when the joined body reads back in the same order.
 */
import { FENCE_TOGGLE_RE, isTimelineHeadingAfterDash, splitBody } from './markdown.ts';
import { isMaterializedMarkerLine } from './timeline-marker.ts';
import { extractTimelineFromContent } from './timeline-extract.ts';

const BULLET_RE = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|/;
const DATED_BULLET_RE = /^\s*[-*+]\s+\**\d{4}\b/;
const CONTINUATION_RE = /^\s{2,}\S/;
const SECTION_END_RE = /^ {0,3}#{1,2}\s+\S/;
const SAFE_FOLLOWER_RE = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|<!--)/;

export type TimelineOrderHold = 'unclosed_fence' | 'unclosed_comment' | 'lazy_continuation' | 'ambiguous_indent' | 'detached_continuation'
  | 'mixed_bullet_format' | 'join_not_lossless' | 'not_conserved';

export type TimelineOrderResult =
  | { status: 'unchanged'; near_duplicates: number }
  | { status: 'needs_human'; reason: TimelineOrderHold; near_duplicates: number }
  | { status: 'changed'; compiled_truth: string; timeline: string; direction: 'ascending' | 'descending';
      moved: number; duplicates: number; sections_joined: number; near_duplicates: number };

interface Bullet { date: string; lines: string[] }
interface Run { lead: number; bullets: Bullet[]; gaps: number[]; trail: number }
type Block = { kind: 'blank' } | { kind: 'anchor'; lines: string[] } | { kind: 'run'; run: Run };
interface Section { region: 0 | 1; start: number; end: number; heading: boolean; blocks: Block[] }

class Hold extends Error { constructor(readonly reason: TimelineOrderHold) { super(reason); } }

/** Whether a line opens an HTML comment it does not close. */
const opensComment = (line: string) => { const at = line.lastIndexOf('<!--'); return at >= 0 && line.indexOf('-->', at + 4) < 0; };

/** Indices of section-ending headings (H1/H2) outside fences and multi-line comments. */
function headingLines(lines: string[]): number[] {
  const found: number[] = [];
  let fence = false, comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (FENCE_TOGGLE_RE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (opensComment(line)) { comment = true; continue; }
    if (SECTION_END_RE.test(line)) found.push(i);
  }
  return found;
}

/** Line ranges of the timeline sections in one half: `[start, end)`, heading line included when there is one. */
function sectionRanges(lines: string[], region: 0 | 1): Array<{ start: number; end: number; heading: boolean }> {
  const headings = headingLines(lines);
  const ranges: Array<{ start: number; end: number; heading: boolean }> = [];
  const hasBullet = (start: number, end: number) => lines.slice(start, end).some(line => BULLET_RE.test(line));
  const leadEnd = headings[0] ?? lines.length;
  if (region === 1 && hasBullet(0, leadEnd)) ranges.push({ start: 0, end: leadEnd, heading: false });
  headings.forEach((at, n) => {
    const end = headings[n + 1] ?? lines.length;
    if (isTimelineHeadingAfterDash(lines[at]!.trim()) && hasBullet(at + 1, end)) ranges.push({ start: at, end, heading: true });
  });
  return ranges;
}

/** Last line (exclusive) of the indented continuation lines that start at `from`. */
function continuationEnd(lines: string[], from: number): number {
  let end = from;
  while (end < lines.length && CONTINUATION_RE.test(lines[end]!)) end++;
  return end;
}

/** End (exclusive) of a fenced block or multi-line comment that opens at `at`; throws Hold when it never closes. */
function closingEnd(lines: string[], at: number, closes: (line: string) => boolean, reason: TimelineOrderHold): number {
  let end = at + 1;
  while (end < lines.length && !closes(lines[end]!)) end++;
  if (end >= lines.length) throw new Hold(reason);
  return end + 1;
}

/** A section's content as blank lines, anchors and runs of bullets; throws Hold on a line it cannot place safely. */
function tokenize(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let run: Run | null = null, blanks = 0, afterBullet = false;
  const closeRun = () => {
    if (run) { run.trail = blanks; blocks.push({ kind: 'run', run }); }
    else for (let n = 0; n < blanks; n++) blocks.push({ kind: 'blank' });
    run = null; blanks = 0;
  };
  const anchor = (taken: string[]) => { closeRun(); blocks.push({ kind: 'anchor', lines: taken }); afterBullet = false; };
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { blanks++; i++; continue; }
    if (/^\s/.test(line)) {
      if (afterBullet) throw new Hold(blanks ? 'detached_continuation' : 'ambiguous_indent');
      const end = continuationEnd(lines, i + 1);
      anchor(lines.slice(i, end)); i = end; continue;
    }
    if (afterBullet && !blanks && !BULLET_RE.test(line) && !isMaterializedMarkerLine(line) && !FENCE_TOGGLE_RE.test(line) && !SAFE_FOLLOWER_RE.test(line)) {
      throw new Hold('lazy_continuation');
    }
    const bulletAt = isMaterializedMarkerLine(line) && BULLET_RE.test(lines[i + 1] ?? '') ? i + 1 : i;
    const date = BULLET_RE.exec(lines[bulletAt]!)?.[1];
    if (date) {
      const end = continuationEnd(lines, bulletAt + 1);
      const bullet = { date, lines: lines.slice(i, end) };
      if (run) { run.gaps.push(blanks); run.bullets.push(bullet); }
      else run = { lead: blanks, bullets: [bullet], gaps: [], trail: 0 };
      blanks = 0; afterBullet = true; i = end; continue;
    }
    if (DATED_BULLET_RE.test(line)) throw new Hold('mixed_bullet_format');
    const closed = FENCE_TOGGLE_RE.test(line) ? closingEnd(lines, i, text => FENCE_TOGGLE_RE.test(text), 'unclosed_fence')
      : opensComment(line) ? closingEnd(lines, i, text => text.includes('-->'), 'unclosed_comment') : i + 1;
    const end = continuationEnd(lines, closed);
    anchor(lines.slice(i, end)); i = end;
  }
  closeRun();
  return blocks;
}

const runsOf = (section: Section) => section.blocks.flatMap(block => block.kind === 'run' ? [block.run] : []);
const blockKey = (bullet: Bullet) => bullet.lines.map(line => line.trimEnd()).join('\n');
const blankLines = (count: number) => Array.from({ length: count }, () => '');

function render(section: Section, lines: string[]): string[] {
  const out = section.heading ? [lines[section.start]!] : [];
  for (const block of section.blocks) {
    if (block.kind === 'blank') out.push('');
    else if (block.kind === 'anchor') out.push(...block.lines);
    else {
      const { lead, bullets, gaps, trail } = block.run;
      out.push(...blankLines(lead));
      bullets.forEach((bullet, index) => out.push(...blankLines(index ? gaps[index - 1]! : 0), ...bullet.lines));
      out.push(...blankLines(trail));
    }
  }
  return out;
}

/** Date plus summary of a Format-1 bullet for near-duplicate counting: lower case, no punctuation or symbols, single spaces. */
function nearKey(bullet: Bullet): string | null {
  const [entry] = extractTimelineFromContent(bullet.lines.find(text => BULLET_RE.test(text))!, '');
  if (!entry) return null;
  return `${bullet.date} ${entry.summary.toLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim()}`;
}

/** Bullets that repeat an earlier bullet's date and near summary without being an exact copy in the same run. */
function countNearDuplicates(sections: Section[]): number {
  const seen = new Set<string>();
  let near = 0;
  for (const run of sections.flatMap(runsOf)) for (const bullet of run.bullets) {
    const key = nearKey(bullet);
    if (key === null) continue;
    if (seen.has(key)) near++;
    else seen.add(key);
  }
  return near;
}

/** Appends every later section's bullets to the first section's only run; returns how many sections were joined. */
function joinSections(sections: Section[]): number {
  if (sections.length < 2) return 0;
  const [first, ...later] = sections;
  const target = runsOf(first!);
  if (target.length !== 1 || later.some(section => section.blocks.some(block => block.kind === 'anchor'))) throw new Hold('join_not_lossless');
  const run = target[0]!;
  for (const moved of later.flatMap(runsOf)) {
    const gap = run.gaps[run.gaps.length - 1] ?? moved.gaps[0] ?? 0;
    moved.bullets.forEach((bullet, index) => { run.gaps.push(index ? moved.gaps[index - 1]! : gap); run.bullets.push(bullet); });
  }
  return later.length;
}

/** Drops later exact copies of a block within one run; the gap above a dropped copy goes with it. */
function dropDuplicates(run: Run): number {
  const seen = new Set<string>();
  let dropped = 0;
  for (let index = 0; index < run.bullets.length;) {
    const key = blockKey(run.bullets[index]!);
    if (!seen.has(key)) { seen.add(key); index++; continue; }
    run.bullets.splice(index, 1);
    run.gaps.splice(index - 1, 1);
    dropped++;
  }
  return dropped;
}

/** Stable sort by date in the page's direction; returns how many bullets changed position. */
function sortRun(run: Run, descending: boolean): number {
  const before = run.bullets.slice();
  run.bullets = before.map((bullet, index) => ({ bullet, index }))
    .sort((a, b) => (descending ? b.bullet.date.localeCompare(a.bullet.date) : a.bullet.date.localeCompare(b.bullet.date)) || a.index - b.index)
    .map(entry => entry.bullet);
  return run.bullets.filter((bullet, index) => bullet !== before[index]).length;
}

/** Non-blank lines of a body without timeline sentinels: what a reader sees, in order. */
const visibleLines = (text: string) => text.split('\n').map(line => line.trimEnd()).filter(line => line && line.trim() !== '<!-- timeline -->').join('\n');

function holdOf(error: unknown): TimelineOrderHold {
  if (error instanceof Hold) return error.reason;
  throw error;
}

export function orderTimeline(page: { compiled_truth: string; timeline?: string | null }): TimelineOrderResult {
  const halves = [page.compiled_truth ?? '', page.timeline ?? ''].map(text => text.split('\n'));
  let sections: Section[];
  try {
    sections = ([0, 1] as const).flatMap(region => sectionRanges(halves[region]!, region).map(range => ({ region, ...range,
      blocks: tokenize(halves[region]!.slice(range.start + (range.heading ? 1 : 0), range.end)) })));
  } catch (error) { return { status: 'needs_human', reason: holdOf(error), near_duplicates: 0 }; }
  let up = 0, down = 0;
  for (const { bullets } of sections.flatMap(runsOf)) for (let i = 1; i < bullets.length; i++) {
    if (bullets[i]!.date > bullets[i - 1]!.date) up++;
    else if (bullets[i]!.date < bullets[i - 1]!.date) down++;
  }
  const descending = down > up;
  let joined: number;
  try { joined = joinSections(sections); } catch (error) { return { status: 'needs_human', reason: holdOf(error), near_duplicates: countNearDuplicates(sections) }; }
  const kept = joined ? [sections[0]!] : sections;
  let duplicates = 0, moved = 0;
  for (const run of kept.flatMap(runsOf)) { duplicates += dropDuplicates(run); moved += sortRun(run, descending); }
  const near = countNearDuplicates(kept);
  if (!joined && !duplicates && !moved) return { status: 'unchanged', near_duplicates: near };

  const next = halves.map(lines => lines.slice());
  for (const section of [...sections].sort((a, b) => b.region - a.region || b.start - a.start)) {
    const lines = next[section.region]!;
    if (joined && section !== sections[0]) {
      let start = section.start;
      if (section.end >= lines.length) while (start > 0 && !lines[start - 1]!.trim()) start--;
      lines.splice(start, section.end - start);
    } else lines.splice(section.start, section.end - section.start, ...render(section, halves[section.region]!));
  }
  const [truth, timeline] = next.map((lines, region) => {
    if (halves[region]![halves[region]!.length - 1]?.trim()) while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    return lines.join('\n');
  }) as [string, string];
  const body = timeline.trim() ? `${truth}\n\n<!-- timeline -->\n\n${timeline}` : truth;
  // A parser reads the published body back into halves; a read that moves content past other sections is not lossless.
  const reread = splitBody(body);
  if (visibleLines(`${reread.compiled_truth}\n${reread.timeline}`) !== visibleLines(body)) return { status: 'needs_human', reason: 'not_conserved', near_duplicates: near };
  const halvesOut = timeline.trim() ? { compiled_truth: truth, timeline } : reread;
  return { status: 'changed', ...halvesOut, direction: descending ? 'descending' : 'ascending', moved, duplicates, sections_joined: joined, near_duplicates: near };
}
