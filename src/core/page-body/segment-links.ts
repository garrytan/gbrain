/**
 * Segmented page storage (Wave B, spec 8.2 links): link extraction over a segmented page's body, one block at a time
 * (segment-blocks.ts), with the result extractPageLinks gives for the joined body. The full pass
 * (extractSegmentedPageLinks) does O(page) work in O(segment) memory; the incremental mode (openSegmentedLinkSession,
 * PR 4) derives only the runs whose inputs changed and merges the rest from page_segment_derivations.
 *
 * Each block is extracted in a window (`bodyWindows`) and only references
 * starting in the block are kept, at their page offsets. The candidates are
 * merged in extractPageLinks' order (pass, then offset) with its
 * first-occurrence dedup, then the frontmatter's. The page-role priors read
 * the role phrases a first pass over the blocks found (rolePriorPhrases), and
 * one pack-regex budget serves the page (the incremental mode: one per call).
 *
 * Exact for every rule that stays inside a window; a construct the segmenter
 * does not keep inside a segment (an HTML comment or a mid-line ``` run
 * crossing a cut, an attendees section longer than a window) is read within
 * its window.
 */
import type { BrainEngine } from '../engine.ts';
import {
  candidateKey, dedupeCandidates, extractBodyLinks, frontmatterLinks, LINK_EXTRACTOR_VERSION_TS, rolePriorPhrases, stripCodeBlocks,
  type BodyLinkCandidate, type ExtractPageLinksOptions, type PageLinksResult, type SlugResolver,
} from '../link-extraction.ts';
import { canonicalJson } from '../belief/keys.ts';
import { datedLines, narrativeRefs } from '../link-temporal-evidence.ts';
import { rangedRelationLines } from '../link-effective.ts';
import type { TemporalBody } from '../link-temporal-apply.ts';
import { PageRegexBudget } from '../schema-pack/redos-guard.ts';
import type { PageType } from '../types.ts';
import { bodyBlocks, detachedValue, segmentedPassWork, type BodyBlock, type BodyBlockOptions } from './segment-blocks.ts';
import { commitRuns, derivationScope, keyDigest, planRuns, readRuns, runIdentity, SEGMENT_PIPELINE_VERSIONS, type DeriveRun } from './segment-derive.ts';

/** Context a window carries after its block (an excerpt reaches 120 chars past a link) and, at least, before it. */
const CONTEXT_CHARS = 4096;
const HEADING = /^(#{1,6})[ \t]/;

export interface SegmentedLinkPage { id: number; slug: string; source_id: string; type: PageType; frontmatter: Record<string, unknown> }

/** A block in its window: `text[start, end)` is the block, at page offset `start + offset`. */
export interface BodyWindow { text: string; start: number; end: number; offset: number; block: BodyBlock }

/** Track the headings still open after `text`, by level (a heading closes every deeper one). */
export function openHeadings(text: string, open: string[]): void {
  const masked = stripCodeBlocks(text);
  let at = 0;
  for (const line of masked.split('\n')) {
    const m = HEADING.exec(line);
    if (m) {
      open.length = m[1]!.length;
      open[m[1]!.length - 1] = text.slice(at, at + line.length);
    }
    at += line.length + 1;
  }
}

/**
 * Cuts a stream of blocks into windows (bodyWindows): push each block, then flush. A cutter started mid-body takes the
 * headings open where it starts; its first windows lack the text before them, so a caller keeps only windows whose
 * blocks have CONTEXT_CHARS of pushed text before them (or start the body).
 */
export class WindowCutter {
  private readonly ahead: BodyBlock[] = [];
  private readonly before: BodyBlock[] = [];
  private beforeChars = 0;

  constructor(private readonly headings: string[] = []) {}

  private windowOf(own: BodyBlock): BodyWindow {
    const lead = this.before[0]?.at ?? own.at;
    const head = (lead === 0 ? '' : `\n${this.headings.filter(Boolean).map(h => `${h}\n`).join('')}`) + this.before.map(b => b.text).join('');
    let after = '';
    for (const b of this.ahead) {
      if (after.length >= CONTEXT_CHARS) break;
      after += b.text.slice(0, CONTEXT_CHARS - after.length);
    }
    segmentedPassWork.windows += head.length + own.text.length + after.length;
    return { text: head + own.text + after, start: head.length, end: head.length + own.text.length, offset: own.at - head.length, block: own };
  }

  private done(own: BodyBlock): void {
    this.before.push(own);
    this.beforeChars += own.text.length;
    while (this.before.length > 1 && this.beforeChars - this.before[0]!.text.length >= CONTEXT_CHARS) {
      const gone = this.before.shift()!;
      this.beforeChars -= gone.text.length;
      openHeadings(gone.text, this.headings);
    }
  }

  *push(block: BodyBlock): Iterable<BodyWindow> {
    this.ahead.push(block);
    while (this.ahead.length > 1 && this.ahead.slice(1).reduce((n, b) => n + b.text.length, 0) >= CONTEXT_CHARS) {
      const own = this.ahead.shift()!;
      yield this.windowOf(own);
      this.done(own);
    }
  }

  *flush(): Iterable<BodyWindow> {
    while (this.ahead.length) {
      const own = this.ahead.shift()!;
      yield this.windowOf(own);
      this.done(own);
    }
  }
}

/**
 * Each block of a segmented body in a window: whole preceding blocks of at least CONTEXT_CHARS before it (a window
 * starts where parsers start fresh), the next CONTEXT_CHARS after it and, ahead of all, the headings still open
 * there, so section-scoped rules (role-prior suppression, machine sections, attendance sections) see the block's
 * section. A window that does not start the body opens with a blank line, so it never starts with frontmatter.
 */
export async function* bodyWindows(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): AsyncIterable<BodyWindow> {
  const cutter = new WindowCutter();
  for await (const block of bodyBlocks(engine, page, opts)) yield* cutter.push(block);
  yield* cutter.flush();
}

/** The page-role phrases of a segmented body (rolePriorPhrases over every block), as ExtractPageLinksOptions.roleText. */
export async function segmentedRoleText(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): Promise<string> {
  const found: Array<string | null> = [null, null, null];
  for await (const block of bodyBlocks(engine, page, opts)) {
    rolePriorPhrases(block.text).forEach((phrase, i) => { found[i] ??= phrase; });
    if (found.every(Boolean)) break;
  }
  return found.filter(Boolean).join('\n');
}

/**
 * extractPageLinks(slug, `${compiled_truth}\n${timeline}`, ...) of a segmented page, streamed; `regions` narrows the
 * body (the remote mention effect reads the compiled truth only). With `temporal`, also collects the body's temporal
 * inputs (dated lines, narrative references, ranged relation lines) for publication. `onBlock` sees each block once,
 * in order, so a caller can parse the same read for something else.
 */
export async function extractSegmentedPageLinks(engine: BrainEngine, page: SegmentedLinkPage, resolver: SlugResolver,
  opts: ExtractPageLinksOptions & BodyBlockOptions & { temporal?: boolean; onBlock?: (block: BodyBlock) => void } = {}): Promise<PageLinksResult & { temporalBody?: TemporalBody }> {
  const roleText = opts.roleText ?? await segmentedRoleText(engine, page, opts);
  const regexBudget = opts.regexBudget ?? new PageRegexBudget();
  const kept = new Map<string, BodyLinkCandidate & { seq: number }>();
  const temporalBody: TemporalBody = { lines: [], narrative: [], ranged: [] };
  let seq = 0;
  let attendanceComplete = true;
  for await (const w of bodyWindows(engine, page, opts)) {
    const body = await extractBodyLinks(page.slug, w.text, page.type, resolver,
      { ...opts, roleText, regexBudget, window: { start: w.start, end: w.end, offset: w.offset } });
    attendanceComplete &&= body.attendanceComplete;
    opts.onBlock?.(w.block);
    for (const link of body.links) {
      const key = candidateKey(link.candidate);
      const prior = kept.get(key);
      if (!prior || link.pass < prior.pass || (link.pass === prior.pass && link.index < prior.index)) kept.set(key, { ...detachedValue(link), seq: seq++ });
    }
    if (!opts.temporal) continue;
    temporalBody.lines.push(...detachedValue(datedLines(w.block.text)));
    if (w.block.region === 'truth') temporalBody.narrative.push(...detachedValue(narrativeRefs(w.block.text)));
    for (const line of rangedRelationLines(w.text)) if (line.start >= w.start && line.start < w.end) temporalBody.ranged.push(detachedValue({ ...line, start: line.start + w.offset }));
  }
  const fm = await frontmatterLinks(page.slug, page.frontmatter, page.type, resolver, opts);
  const body = [...kept.values()].sort((a, b) => a.pass - b.pass || a.index - b.index || a.seq - b.seq).map(link => link.candidate);
  return { candidates: dedupeCandidates([...body, ...fm.candidates]), unresolved: fm.unresolved,
    attendanceComplete: attendanceComplete && fm.attendanceComplete, ...(opts.temporal ? { temporalBody } : {}) };
}

/** What one run contributes to its page's links: the links row's output (offsets and authored-ref keys run-local). */
interface LinkRunOutput {
  /** UTF-16 units of the run's text. */
  chars: number;
  /** rolePriorPhrases over the run's blocks, the first per phrase. */
  roles: Array<string | null>;
  /** The headings open before the run and after it (openHeadings over every block up to its end). */
  headsIn: Array<string | null>;
  headsOut: Array<string | null>;
  /** Digest of the run's first CONTEXT_CHARS units: what a window before it reads past its block. */
  head: string;
  /** Digest of the run's last blocks totalling CONTEXT_CHARS (or all of them), with the headings open before them: what a window after it reads. */
  tail: string;
  links: BodyLinkCandidate[];
  attendance: boolean;
  temporal: TemporalBody;
  /** The answers the extraction read, so a run is reused only while they hold: basename matches and target types. */
  basenames: Array<[string, string[]]>;
  types: Array<[string, string | null, string | null]>;
}

type RunInfo = Pick<LinkRunOutput, 'chars' | 'roles' | 'headsIn' | 'headsOut' | 'head' | 'tail'>;

const heads = (open: ReadonlyArray<string | null | undefined>): Array<string | null> => Array.from(open, h => h ?? null);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const REF_KEY = /^ref:(-?\d+)$/;

/** A candidate moved `by` units from its run-local offset: its index and its authored-ref key move together. */
function shifted(link: BodyLinkCandidate, by: number): BodyLinkCandidate {
  const ref = link.candidate.authoredRef;
  const m = ref ? REF_KEY.exec(ref.key) : null;
  return { ...link, index: link.index + by, candidate: m ? { ...link.candidate, authoredRef: { ...ref!, key: `ref:${Number(m[1]) + by}` } } : link.candidate };
}

/** Options the incremental mode cannot honour (it reads the default regions, keeps no explain hook): those use the full pass. */
function incrementalOptions(opts: ExtractPageLinksOptions & BodyBlockOptions): boolean {
  return !opts.explain && !opts.regions && opts.separator === undefined && !opts.want && !opts.roleText && !opts.window;
}

export interface SegmentedLinkSession {
  /**
   * Every body and frontmatter link candidate with the due runs extracted untyped (no targetType): the targets a caller
   * reads endpoints for. Only the targets are the typed result's; link types and attendance may differ from it.
   */
  targets(opts: ExtractPageLinksOptions): Promise<PageLinksResult>;
  /** The typed result (extractSegmentedPageLinks with `temporal`), deriving only the due runs and storing them. */
  finish(opts: ExtractPageLinksOptions & { targetType: NonNullable<ExtractPageLinksOptions['targetType']> }): Promise<PageLinksResult & { temporalBody: TemporalBody }>;
}

/**
 * The incremental mode of extractSegmentedPageLinks (spec 8.2 links), for the write path's typed extraction with
 * temporal inputs: each run's candidates, role phrases, headings and temporal inputs are stored on its links rows, and
 * a run is derived again only when its text, its window (the runs whose text its windows read: at least CONTEXT_CHARS
 * before and after it), the headings open where that window starts, the page's role phrases, the page inputs (slug,
 * type, pack, extractor version, resolution options) or an answer its extraction read (a basename match, a target type)
 * changed. The page result is merged from the run outputs exactly as the full pass merges windows. Null when the page
 * is not segmented or the options ask for something only the full pass does. A body that moves under it throws
 * SegmentDerivationRaced (the caller falls back to the full pass); nothing is stored then.
 */
export async function openSegmentedLinkSession(engine: BrainEngine, page: SegmentedLinkPage, resolver: SlugResolver,
  base: ExtractPageLinksOptions & BodyBlockOptions): Promise<SegmentedLinkSession | null> {
  if (!incrementalOptions(base)) return null;
  const scope = await derivationScope(engine, page);
  if (!scope) return null;
  const rows = await engine.readSegmentDerivations(scope.pageId, { kind: 'links' });
  const byOccurrence = new Map(rows.map(row => [row.occurrenceId, row]));
  const stored = new Map<number, LinkRunOutput>();
  for (const run of scope.runs) {
    const output = byOccurrence.get(run.occurrences[0]!)?.output as LinkRunOutput | null | undefined;
    const ownValid = run.occurrences.every((id, i) => {
      const row = byOccurrence.get(id);
      return row !== undefined && row.state === 'done' && row.version === SEGMENT_PIPELINE_VERSIONS.links && sameBytes(row.segmentSha256, run.shas[i]!);
    });
    if (ownValid && output && Array.isArray(output.links)) stored.set(run.index, output);
  }

  // The chain: each run's chars, role phrases, headings and context digests, read only where no stored output holds
  // for the headings open before it.
  const info = new Map<number, RunInfo>();
  let open: Array<string | null> = [];
  type Reading = { run: DeriveRun; info: RunInfo; head: string; tail: string[]; tailChars: number; tailHeads: Array<string | null>; shifted: boolean };
  let reading: Reading | null = null;
  const close = () => {
    if (!reading) return;
    const { run, info: into, head, tail, tailHeads, shifted } = reading;
    into.headsOut = heads(open);
    into.head = keyDigest(head);
    into.tail = keyDigest(JSON.stringify([heads(tailHeads), tail, !shifted && run.index === 0 && run.region === 'truth']));
    info.set(run.index, into);
    reading = null;
  };
  await readRuns(engine, scope, run => {
    close();
    const output = stored.get(run.index);
    if (output && sameJson(output.headsIn, heads(open))) {
      info.set(run.index, { chars: output.chars, roles: output.roles, headsIn: output.headsIn, headsOut: output.headsOut, head: output.head, tail: output.tail });
      open = [...output.headsOut];
      return false;
    }
    reading = { run, info: { chars: 0, roles: [null, null, null], headsIn: heads(open), headsOut: [], head: '', tail: '' },
      head: '', tail: [], tailChars: 0, tailHeads: heads(open), shifted: false };
    return true;
  }, (run, block) => {
    const r = run && reading;
    if (r) {
      r.info.chars += block.text.length;
      rolePriorPhrases(block.text).forEach((phrase, i) => { r.info.roles[i] ??= phrase === null ? null : detachedValue(phrase); });
      if (r.head.length < CONTEXT_CHARS) r.head += block.text.slice(0, CONTEXT_CHARS - r.head.length);
      r.tail.push(block.text);
      r.tailChars += block.text.length;
      while (r.tail.length > 1 && r.tailChars - r.tail[0]!.length >= CONTEXT_CHARS) {
        const gone = r.tail.shift()!;
        r.tailChars -= gone.length;
        openHeadings(gone, r.tailHeads as string[]);
        r.shifted = true;
      }
    }
    openHeadings(block.text, open as string[]);
  });
  close();

  const found: Array<string | null> = [null, null, null];
  for (const run of scope.runs) info.get(run.index)!.roles.forEach((phrase, i) => { found[i] ??= phrase; });
  const roleText = found.filter(Boolean).join('\n');
  const separator = '\n';
  const lastTruth = scope.runs.filter(run => run.region === 'truth').length - 1;
  const charsOf = (index: number) => info.get(index)!.chars;
  // The runs whose text the windows of run k read: back and forward until CONTEXT_CHARS (the separator counts as a block).
  const range = (k: number): [number, number] => {
    let from = k, to = k;
    for (let acc = 0; from > 0 && acc < CONTEXT_CHARS;) { acc += charsOf(from - 1) + (from - 1 === lastTruth ? separator.length : 0); from--; }
    for (let acc = 0; to < scope.runs.length - 1 && acc < CONTEXT_CHARS;) { acc += charsOf(to + 1) + (to === lastTruth ? separator.length : 0); to++; }
    return [from, to];
  };
  const pageInputs = { extractor: LINK_EXTRACTOR_VERSION_TS, slug: page.slug, type: page.type, pack: base.pack ? keyDigest(canonicalJson(base.pack)) : null,
    globalBasename: !!base.globalBasename, lineGrammar: base.lineGrammar ?? null, roleText, separator };
  // A run's windows read the last blocks of the first run in its range (with the headings open before them), every run
  // between, and the first units of the last one. The separator's place is marked, as it is a block of its own.
  const sepBefore = (index: number) => index === lastTruth + 1;
  const between = (a: number, b: number) => [...scope.runs.slice(a + 1, b).flatMap(r => [...(sepBefore(r.index) ? ['sep'] : []), runIdentity(r)]),
    ...(sepBefore(b) ? ['sep'] : [])];
  const inputsOf = (run: DeriveRun) => {
    const [from, to] = range(run.index);
    return { ...pageInputs, before: from < run.index ? [info.get(from)!.tail, ...between(from, run.index)] : null,
      after: to > run.index ? [...between(run.index, to), info.get(to)!.head] : null };
  };
  const plan = await planRuns<LinkRunOutput>(engine, 'links', scope, inputsOf, rows);
  for (const [index, output] of [...plan.current]) {
    for (const [name, matches] of output.basenames) {
      if (sameJson(await resolver.resolveBasenameMatches?.(name) ?? null, matches)) continue;
      plan.current.delete(index);
      plan.todo.push(scope.runs[index]!);
      break;
    }
  }

  /** Extract the runs in `todo` (their windows read with their context runs) under `opts`, recording what each read. */
  const derive = async (todo: readonly DeriveRun[], opts: ExtractPageLinksOptions): Promise<Map<number, LinkRunOutput>> => {
    const wanted = new Set<number>();
    for (const run of todo) {
      const [from, to] = range(run.index);
      for (let i = from; i <= to; i++) wanted.add(i);
    }
    const outputs = new Map<number, LinkRunOutput>();
    for (const run of todo) outputs.set(run.index, { ...info.get(run.index)!, links: [], attendance: true, temporal: { lines: [], narrative: [], ranged: [] }, basenames: [], types: [] });
    type Recording = { basenames: Map<string, string[]>; types: Map<string, [string, string | null, string | null]> };
    let recording: Recording | null = null;
    const records = new Map<number, Recording>();
    const recorded: SlugResolver = { resolve: resolver.resolve.bind(resolver),
      ...(resolver.resolveAttendance ? { resolveAttendance: resolver.resolveAttendance.bind(resolver) } : {}),
      ...(resolver.resolveBasenameMatches ? { resolveBasenameMatches: async (name: string) => {
        const matches = await resolver.resolveBasenameMatches!(name);
        recording?.basenames.set(name, [...matches]);
        return matches;
      } } : {}) };
    const typed = opts.targetType;
    const targetType = typed && ((slug: string, sourceId?: string) => {
      const type = typed(slug, sourceId);
      recording?.types.set(`${sourceId ?? ''}\u0000${slug}`, [slug, sourceId ?? null, type ?? null]);
      return type;
    });
    const regexBudget = new PageRegexBudget();
    const local = new Map<BodyBlock, { run: DeriveRun; at: number }>();
    const used = new Map<number, number>();
    let cutter = new WindowCutter();
    let last = -2;
    const position = (run: DeriveRun | null) => run === null ? lastTruth + 1 : run.index + (run.region === 'timeline' ? 1 : 0);
    const onWindow = async (w: BodyWindow) => {
      const own = local.get(w.block);
      local.delete(w.block);
      const output = own && outputs.get(own.run.index);
      if (!own || !output) return;
      const offset = own.at - w.start;
      recording = records.get(own.run.index) ?? { basenames: new Map(), types: new Map() };
      records.set(own.run.index, recording);
      const body = await extractBodyLinks(page.slug, w.text, page.type, recorded,
        { ...opts, ...(targetType ? { targetType } : {}), roleText, regexBudget, window: { start: w.start, end: w.end, offset } });
      recording = null;
      output.attendance &&= body.attendanceComplete;
      output.links.push(...detachedValue(body.links));
      output.temporal.lines.push(...detachedValue(datedLines(w.block.text)));
      if (w.block.region === 'truth') output.temporal.narrative.push(...detachedValue(narrativeRefs(w.block.text)));
      for (const line of rangedRelationLines(w.text)) if (line.start >= w.start && line.start < w.end) output.temporal.ranged.push(detachedValue({ ...line, start: line.start + offset }));
    };
    await readRuns(engine, scope, wanted, async (run, block) => {
      const at = position(run);
      if (at !== last && at !== last + 1) {
        for (const w of cutter.flush()) await onWindow(w);
        const next = run ?? scope.runs[lastTruth + 1];
        cutter = new WindowCutter([...(next ? info.get(next.index)!.headsIn : open)] as string[]);
      }
      last = at;
      if (run) {
        local.set(block, { run, at: used.get(run.index) ?? 0 });
        used.set(run.index, (used.get(run.index) ?? 0) + block.text.length);
      }
      for (const w of cutter.push(block)) await onWindow(w);
    });
    for (const w of cutter.flush()) await onWindow(w);
    for (const [index, record] of records) {
      const output = outputs.get(index)!;
      output.basenames = [...record.basenames];
      output.types = [...record.types.values()];
    }
    return outputs;
  };

  /** The page's body candidates merged from every run, as the full pass merges its windows. */
  const merge = (outputs: ReadonlyMap<number, LinkRunOutput>) => {
    const kept = new Map<string, BodyLinkCandidate & { seq: number }>();
    const temporalBody: TemporalBody = { lines: [], narrative: [], ranged: [] };
    let seq = 0, at = 0, attendance = true;
    for (const run of scope.runs) {
      if (run.index === lastTruth + 1) at += separator.length;
      const output = outputs.get(run.index) ?? plan.current.get(run.index)!;
      attendance &&= output.attendance;
      for (const raw of output.links) {
        const link = shifted(raw, at);
        const key = candidateKey(link.candidate);
        const prior = kept.get(key);
        if (!prior || link.pass < prior.pass || (link.pass === prior.pass && link.index < prior.index)) kept.set(key, { ...link, seq: seq++ });
      }
      temporalBody.lines.push(...output.temporal.lines);
      temporalBody.narrative.push(...output.temporal.narrative);
      temporalBody.ranged.push(...output.temporal.ranged.map(line => ({ ...line, start: line.start + at })));
      at += output.chars;
    }
    const body = [...kept.values()].sort((a, b) => a.pass - b.pass || a.index - b.index || a.seq - b.seq).map(link => link.candidate);
    return { body, attendance, temporalBody };
  };

  return {
    async targets(opts) {
      const fresh = await derive(plan.todo, { ...base, ...opts });
      const { body, attendance } = merge(fresh);
      const fm = await frontmatterLinks(page.slug, page.frontmatter, page.type, resolver, { ...base, ...opts });
      return { candidates: dedupeCandidates([...body, ...fm.candidates]), unresolved: fm.unresolved, attendanceComplete: attendance && fm.attendanceComplete };
    },
    async finish(opts) {
      const todo = [...plan.todo];
      for (const [index, output] of [...plan.current]) {
        if (output.types.every(([slug, sourceId, type]) => (opts.targetType(slug, sourceId ?? undefined) ?? null) === type)) continue;
        plan.current.delete(index);
        todo.push(scope.runs[index]!);
      }
      todo.sort((a, b) => a.index - b.index);
      const fresh = await derive(todo, { ...base, ...opts });
      await commitRuns(engine, 'links', scope, fresh, inputsOf);
      const { body, attendance, temporalBody } = merge(fresh);
      const fm = await frontmatterLinks(page.slug, page.frontmatter, page.type, resolver, { ...base, ...opts });
      return { candidates: dedupeCandidates([...body, ...fm.candidates]), unresolved: fm.unresolved, attendanceComplete: attendance && fm.attendanceComplete, temporalBody };
    },
  };
}
