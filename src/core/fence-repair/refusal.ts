/**
 * #6188: the one fence check every coordinated writer shares. `scanCanonicalFences`
 * decides what the canonical projection refuses (a repeated marker outside code,
 * any strict-parser warning, a row number used twice on the page); the content
 * screen (`fences: 'coordinated'`) and `compileCanonicalProjections` both call it,
 * so a file is held at the screen exactly when preparation would refuse it.
 *
 * The decision comes from the strict parsers; the location (reason, rows,
 * columns, section line) comes from the raw-row view (`raw-rows.ts`), never from
 * parser warning strings, which embed row text. Messages are `fenceMessage`
 * (`reasons.ts`): fence, section, row numbers, column names and lines only, so
 * receipts, holds and logs may keep them. A stored receipt's message, or the
 * versioned `error_detail.fence` that survives receipt compaction, is read back
 * into the same location by `fenceReceiptLocation`.
 */
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, type ParsedTake } from '../takes-fence.ts';
import { codeEndAt, indexOfOutsideCode, scanMarkdownCode, type MarkdownCodeMap } from '../fence-scan.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { FENCE_REASONS, fenceMessage, issueLocation, renderFenceFix, type FenceMessageLocation } from './reasons.ts';
import { extractRawRows, primaryFence, rowNumOf, type RawSection } from './raw-rows.ts';
import { FENCE_RULES_VERSION } from './normalize.ts';
import { ALLOWED, cellValid } from './schema.ts';
import type { FenceIssue, FenceKind, FenceReason, FenceSection } from './types.ts';

/**
 * The screen's version, stored on `invalid_fence` holds as `fence_version`; an
 * older hold is re-screened. It moves when the screen changes what it refuses:
 * 1 was the strict screen alone; Tier 1 (`FENCE_RULES_VERSION`) admits the
 * fences it fixes, so every rule-set bump moves it too.
 */
export const FENCE_VERSION = 1 + FENCE_RULES_VERSION;
/** Row numbers a location carries at most. */
export const FENCE_ROWS_MAX = 20;

const MARKERS: ReadonlyArray<readonly [FenceKind, string]> = [['facts', FACTS_FENCE_BEGIN], ['facts', FACTS_FENCE_END], ['takes', TAKES_FENCE_BEGIN], ['takes', TAKES_FENCE_END]];
const KINDS: readonly FenceKind[] = ['facts', 'takes'];
const SECTIONS: readonly FenceSection[] = ['body', 'timeline'];

/** The `ContentRefusal` the coordinated screen returns. */
export interface FenceRefusal { code: 'invalid_fence'; reason: FenceReason; message: string; fence: FenceMessageLocation }

/** A location read back from a stored receipt: an older gbrain's message never named the fence or section. */
export type ReceiptFenceLocation = Omit<FenceMessageLocation, 'fence' | 'section'> & { fence?: FenceKind; section?: FenceSection };

function repeatsOutsideCode(body: string, marker: string, code: MarkdownCodeMap): boolean {
  const first = indexOfOutsideCode(body, marker, 0, code);
  return first !== -1 && indexOfOutsideCode(body, marker, first + marker.length, code) !== -1;
}

function quotesMarker(body: string, code: MarkdownCodeMap): boolean {
  for (const [, marker] of MARKERS) {
    for (let at = body.indexOf(marker); at !== -1; at = body.indexOf(marker, at + marker.length)) if (codeEndAt(code, at) !== -1) return true;
  }
  return false;
}

const at = (reason: FenceReason, fence: FenceKind, section: FenceSection, line: number | null, rows: number[] = [], columns: string[] = []): FenceMessageLocation =>
  ({ reason, fence, section, rows: rows.slice(0, FENCE_ROWS_MAX), columns, line });

/** The column a data row is refused for, in the strict parser's check order, and the reason it carries. */
const CELL_CHECKS: Record<FenceKind, ReadonlyArray<readonly [column: string, reason: FenceReason]>> = {
  facts: [['kind', 'enum_unmapped'], ['visibility', 'enum_unmapped'], ['notability', 'enum_unmapped'], ['confidence', 'confidence_out_of_range'], ['claim_value', 'claim_value_invalid']],
  takes: [['kind', 'takes_kind_unsupported'], ['weight', 'weight_missing']],
};

/**
 * Location-only issues of one fence kind in one section, from the raw-row view:
 * marker problems, header and row-shape problems, and per data row the first
 * cell the strict parser refuses (or a holder it warns about).
 */
function rawIssues(raw: RawSection, fence: FenceKind): FenceIssue[] {
  const primary = primaryFence(raw, fence);
  const issues = [...raw.issues.filter(issue => issue.fence === fence), ...(primary?.issues.filter(issue => issue.reason !== 'repeated_marker') ?? [])];
  if (!primary) return issues;
  const fenceIssue = (reason: FenceReason, line: number): FenceIssue => ({ fence, section: raw.section, row: null, column: null, line, reason });
  // The strict parser reads no row of a fence whose markers it does not pair, so the marker is the problem to name.
  const nearMiss = primary.begin.nearMiss ? primary.begin : primary.end?.nearMiss ? primary.end : null;
  if (nearMiss) return [fenceIssue('marker_near_miss', nearMiss.line), ...issues];
  if (!primary.end) return [fenceIssue('unparseable', primary.begin.line), ...issues];
  const seen = new Set<number>();
  for (const row of primary.rows) {
    if (row.beforeHeader || row.shape !== 'ok') continue;
    const issue = (reason: FenceReason, column: string | null, rowNum: number | null): FenceIssue => ({ fence, section: raw.section, row: rowNum, column, line: row.line, reason,
      ...(column && ALLOWED[fence][column] && (reason === 'enum_unmapped' || reason === 'takes_kind_unsupported') ? { allowed: ALLOWED[fence][column] } : {}) });
    const rowNum = rowNumOf(primary, row);
    if (rowNum === null) { issues.push(issue('unparseable', '#', null)); continue; }
    if (seen.has(rowNum)) { issues.push(issue('row_collision', null, rowNum)); continue; }
    seen.add(rowNum);
    const failed = CELL_CHECKS[fence].find(([column]) => !cellValid(fence, column, row.byColumn.get(column)?.text ?? ''));
    if (failed) { issues.push(issue(failed[1], failed[0], rowNum)); continue; }
    if (fence === 'takes' && !cellValid('takes', 'who', row.byColumn.get('who')?.text ?? '')) issues.push(issue('holder_unresolved', 'who', rowNum));
  }
  return issues;
}

/**
 * The reasons a strict-parser warning can be located as, read from its code and
 * fixed wording only (warning strings embed row text, which is never copied).
 */
function warningReasons(warning: string): readonly FenceReason[] {
  const split = warning.indexOf(': ');
  const code = split === -1 ? warning : warning.slice(0, split);
  const rest = split === -1 ? '' : warning.slice(split + 2);
  if (/_FENCE_UNBALANCED$/.test(code)) return ['missing_begin', 'marker_near_miss', 'unparseable'];
  if (code === 'TAKES_FENCE_NEAR_MISS') return ['marker_near_miss'];
  if (/_ROW_NUM_COLLISION$/.test(code)) return ['row_collision'];
  if (code === 'TAKES_HOLDER_INVALID') return ['holder_unresolved'];
  if (rest.startsWith('row before header')) return ['row_before_header'];
  if (rest.startsWith('pipe-rows present but no recognizable header')) return ['no_header'];
  if (rest.startsWith('only ')) return ['short_row'];
  if (rest.startsWith('unknown kind')) return ['enum_unmapped', 'takes_kind_unsupported'];
  if (rest.startsWith('unknown visibility') || rest.startsWith('unknown notability')) return ['enum_unmapped'];
  if (rest.startsWith('non-numeric confidence') || rest.startsWith('confidence ')) return ['confidence_out_of_range'];
  if (rest.startsWith('non-numeric claim_value')) return ['claim_value_invalid'];
  if (rest.startsWith('non-numeric weight')) return ['weight_missing'];
  return ['unparseable'];
}

/** The refusal location for a fence the strict parser warns about: its first raw issue a warning accounts for, with every row of that reason. */
function warningLocation(raw: RawSection, fence: FenceKind, section: FenceSection, warnings: string[]): FenceMessageLocation {
  const expected = new Set(warnings.flatMap(warningReasons));
  const issues = rawIssues(raw, fence).filter(issue => expected.has(issue.reason));
  const first = issues[0];
  if (first) {
    const rows = [...new Set(issues.filter(issue => issue.reason === first.reason && issue.row !== null).map(issue => issue.row!))];
    return { ...issueLocation(first), rows: rows.slice(0, FENCE_ROWS_MAX) };
  }
  // The raw view found nothing to name: say which fence, and the duplicated numbers the warnings report as integers.
  const duplicates = [...new Set(warnings.flatMap(w => { const n = /^(?:FACTS|TAKES)_ROW_NUM_COLLISION: duplicate row_num (\d+)$/.exec(w)?.[1]; return n ? [Number(n)] : []; }))];
  return at(duplicates.length === warnings.length ? 'row_collision' : 'unparseable', fence, section, primaryFence(raw, fence)?.begin.line ?? null, duplicates);
}

export interface CanonicalFenceScan {
  /** In the order the projection refuses them: repeated markers, parse problems, then page-wide row collisions. */
  defects: FenceMessageLocation[];
  facts: ParsedFact[];
  takes: ParsedTake[];
  /** Some fence marker sits in markdown code (a quoted fence holds rows readers never see). */
  quoting: boolean;
  /** The section each parsed row came from, for locating a later stored-row refusal. */
  sections: { facts: Map<number, FenceSection>; takes: Map<number, FenceSection> };
}

/** Parse both canonical sections once and list every reason the projection would refuse them. */
export function scanCanonicalFences(page: { compiled_truth: string; timeline?: string | null }): CanonicalFenceScan {
  const fields: Array<[FenceSection, string]> = [['body', page.compiled_truth ?? ''], ['timeline', page.timeline ?? '']];
  const empty: CanonicalFenceScan = { defects: [], facts: [], takes: [], quoting: false, sections: { facts: new Map(), takes: new Map() } };
  // No marker text at all: nothing to parse or refuse (the parsers return nothing either).
  if (!fields.some(([, field]) => field.includes('gbrain:facts:') || field.includes('gbrain:takes:'))) return empty;
  const raws = new Map<FenceSection, RawSection>();
  const rawOf = (section: FenceSection, field: string) => raws.get(section) ?? raws.set(section, extractRawRows(field, section)).get(section)!;
  const defects: FenceMessageLocation[] = [];
  let quoting = false;
  for (const [section, field] of fields) {
    if (!MARKERS.some(([, marker]) => field.includes(marker))) continue;
    // One code scan per section serves every marker check; an example quoted in code is not a second fence.
    const code = scanMarkdownCode(field);
    for (const fence of KINDS) {
      if (!MARKERS.some(([kind, marker]) => kind === fence && repeatsOutsideCode(field, marker, code))) continue;
      const repeat = primaryFence(rawOf(section, field), fence)?.issues.find(issue => issue.reason === 'repeated_marker');
      defects.push(at('repeated_marker', fence, section, repeat?.line ?? null));
    }
    quoting ||= quotesMarker(field, code);
  }
  const parsed = fields.map(([section, field]) => ({ section, field, facts: parseFactsFence(field), takes: parseTakesFence(field) }));
  for (const { section, field, facts, takes } of parsed) {
    for (const [fence, warnings] of [['facts', facts.warnings], ['takes', takes.warnings]] as const) {
      if (warnings.length) defects.push(warningLocation(rawOf(section, field), fence, section, warnings));
    }
  }
  const sections = { facts: new Map<number, FenceSection>(), takes: new Map<number, FenceSection>() };
  for (const fence of KINDS) {
    const duplicates: number[] = [];
    for (const { section, facts, takes } of parsed) {
      for (const row of fence === 'facts' ? facts.facts : takes.takes) {
        if (sections[fence].has(row.rowNum)) duplicates.push(row.rowNum); else sections[fence].set(row.rowNum, section);
      }
    }
    if (duplicates.length) defects.push(at('row_collision', fence, 'timeline', null, [...new Set(duplicates)]));
  }
  return { defects, facts: parsed.flatMap(p => p.facts.facts), takes: parsed.flatMap(p => p.takes.takes), quoting, sections };
}

export function fenceRefusal(location: FenceMessageLocation): FenceRefusal {
  return { code: 'invalid_fence', reason: location.reason, message: fenceMessage(location), fence: location };
}

/**
 * A fence location as prose, in `fenceMessage`'s order: "the takes fence (body), row 2, column who, at line 6"
 * ("a facts or takes fence" when an older receipt never named it).
 */
export function fenceWhere(location: Partial<Pick<ReceiptFenceLocation, 'fence' | 'section' | 'rows' | 'columns' | 'line'>> | undefined): string {
  if (!location?.fence) return 'a facts or takes fence';
  const rows = location.rows ?? [], columns = location.columns ?? [];
  return [`the ${location.fence} fence${location.section ? ` (${location.section})` : ''}`,
    ...(rows.length ? [`${rows.length > 1 ? 'rows' : 'row'} ${rows.join(', ')}`] : []),
    ...(columns.length ? [`${columns.length > 1 ? 'columns' : 'column'} ${columns.join(', ')}`] : []),
    ...(location.line != null ? [`at line ${location.line}`] : [])].join(', ');
}

/** The fix sentence for a location: the reason's template when fence and section are known. */
export function fenceFixText(location: ReceiptFenceLocation): string {
  return location.fence && location.section ? renderFenceFix(location as FenceMessageLocation) : `Fix ${fenceWhere(location)} on this page.`;
}

const MESSAGE = /^Fence ([a-z_]{1,60}): in the (facts|takes) fence \((body|timeline)\)(?:, rows? (\d{1,9}(?:, \d{1,9}){0,49}))?(?:, columns? ([#a-z_]{1,40}(?:, [#a-z_]{1,40}){0,20}))?(?:, at line (\d{1,9}))?\. /;

/** The location a `fenceMessage` names, or null for any other message. */
export function parseFenceMessage(message: string | null | undefined): FenceMessageLocation | null {
  const match = typeof message === 'string' ? MESSAGE.exec(message) : null;
  if (!match || !(match[1]! in FENCE_REASONS)) return null;
  return { reason: match[1] as FenceReason, fence: match[2] as FenceKind, section: match[3] as FenceSection,
    rows: match[4] ? match[4].split(', ').map(Number).slice(0, FENCE_ROWS_MAX) : [], columns: match[5] ? match[5].split(', ') : [],
    line: match[6] ? Number(match[6]) : null };
}

/** The exact messages older gbrain versions stored for the same fence refusals; they named no section. */
const LEGACY_MESSAGES: ReadonlyArray<readonly [code: string, pattern: RegExp, reason: FenceReason, fence?: FenceKind]> = [
  ['invalid_params', /^Each canonical body section must contain at most one facts fence and one takes fence\.$/, 'repeated_marker'],
  ['invalid_params', /^A canonical facts or takes fence cannot be parsed losslessly\.$/, 'unparseable'],
  ['invalid_params', /^Canonical row numbers must be unique across the entire page\.$/, 'row_collision'],
  ['invalid_params', /^A takes or facts fence sits inside markdown code, so this write would remove the rows it holds\.$/, 'quoted_fence_rows'],
  ['invalid_params', /^A malformed fact fence contains a withdrawn claim\.$/, 'withdrawn_claim_in_malformed_fence', 'facts'],
  ['take_row_collision', /^A takes fence row number is already used by a different take that is not in this page's canonical fence\.$/, 'stored_row_collision', 'takes'],
];

/** The wire codes a fence refusal is stored under: `invalid_params` (E3) and `take_row_collision` for stored-row collisions. */
const FENCE_WIRE_CODES = new Set(['invalid_params', 'take_row_collision', 'invalid_fence']);

/** The location in a stored receipt's code and message (current grammar or a legacy message), or null. */
export function fenceLocationFromMessage(code: string | null | undefined, message: string | null | undefined): ReceiptFenceLocation | null {
  if (!code || !FENCE_WIRE_CODES.has(code)) return null;
  const parsed = parseFenceMessage(message);
  if (parsed) return parsed;
  const legacy = LEGACY_MESSAGES.find(([legacyCode, pattern]) => legacyCode === code && pattern.test(message ?? ''));
  return legacy ? { reason: legacy[2], ...(legacy[3] ? { fence: legacy[3] } : {}), rows: [], columns: [], line: null } : null;
}

export const FENCE_DETAIL_VERSION = 1;
/**
 * The bounded, versioned `error_detail` a fence refusal stores; it outlives
 * receipt compaction (which drops the message). `issues` (#6188 D18, at most
 * `FENCE_ISSUES_MAX`) lists every blocking issue, location and class only.
 */
export interface FenceFailureDetail { origin: 'fence'; fence: FenceMessageLocation & { version: typeof FENCE_DETAIL_VERSION; issues?: Array<Record<string, unknown>> } }

/** The durable detail of a typed fence refusal, or undefined for any other error. */
export function fenceFailureDetail(error: Pick<OperationError, 'canonicalCode' | 'message' | 'fenceIssues'>): FenceFailureDetail | undefined {
  if (error.canonicalCode !== 'invalid_fence') return undefined;
  const location = parseFenceMessage(error.message);
  const issues = error.fenceIssues?.slice(0, 20);
  return location ? { origin: 'fence', fence: { version: FENCE_DETAIL_VERSION, ...location, ...(issues?.length ? { issues } : {}) } } : undefined;
}

/** The blocking issues a stored fence detail carries (validated field by field), or []. */
export function fenceIssuesFromDetail(detail: unknown): Array<Record<string, unknown>> {
  if (!fenceLocationFromDetail(detail)) return [];
  const issues = (detail as { fence: { issues?: unknown } }).fence.issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 20).flatMap(issue => {
    if (!issue || typeof issue !== 'object') return [];
    const i = issue as Record<string, unknown>;
    if (!KINDS.includes(i.fence as FenceKind) || !SECTIONS.includes(i.section as FenceSection) || typeof i.class !== 'string' || !/^[a-z_]{1,40}$/.test(i.class)) return [];
    const row = Number.isInteger(i.row) && (i.row as number) > 0 ? i.row as number : null;
    const column = typeof i.column === 'string' && /^[#a-z_]{1,40}$/.test(i.column) ? i.column : null;
    const line = Number.isInteger(i.line) && (i.line as number) > 0 ? i.line as number : null;
    const allowed = Array.isArray(i.allowed) ? i.allowed.filter((a): a is string => typeof a === 'string' && /^[a-z_ ]{1,40}$/.test(a)).slice(0, 20) : [];
    return [{ fence: i.fence, section: i.section, row, column, line, class: i.class, ...(allowed.length ? { allowed } : {}) }];
  });
}

/** The location a stored `error_detail` carries, validated field by field, or null. */
export function fenceLocationFromDetail(detail: unknown): FenceMessageLocation | null {
  if (!detail || typeof detail !== 'object' || (detail as { origin?: unknown }).origin !== 'fence') return null;
  const fence = (detail as { fence?: Record<string, unknown> }).fence;
  if (!fence || fence.version !== FENCE_DETAIL_VERSION || typeof fence.reason !== 'string' || !(fence.reason in FENCE_REASONS)) return null;
  if (!KINDS.includes(fence.fence as FenceKind) || !SECTIONS.includes(fence.section as FenceSection)) return null;
  const rows = Array.isArray(fence.rows) ? fence.rows.filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, FENCE_ROWS_MAX) : [];
  const columns = Array.isArray(fence.columns) ? fence.columns.filter((c): c is string => typeof c === 'string' && /^[#a-z_]{1,40}$/.test(c)).slice(0, 20) : [];
  return { reason: fence.reason as FenceReason, fence: fence.fence as FenceKind, section: fence.section as FenceSection, rows, columns,
    line: Number.isInteger(fence.line) && (fence.line as number) > 0 ? fence.line as number : null };
}

/** The fence location of a failed write receipt: its durable detail first, then its message. */
export function fenceReceiptLocation(row: { error_code?: string | null; error_message?: string | null; error_detail?: unknown }): ReceiptFenceLocation | null {
  return fenceLocationFromDetail(row.error_detail) ?? fenceLocationFromMessage(row.error_code, row.error_message);
}

/**
 * A receipt location completed from the bytes it refused: an older gbrain's
 * message named no section (and for some reasons no fence), so take the first
 * section that holds a fence of that kind, else the body.
 */
export function completeFenceLocation(location: ReceiptFenceLocation, page: { compiled_truth: string; timeline?: string | null }): FenceMessageLocation {
  if (location.fence && location.section) return location as FenceMessageLocation;
  const fields: Array<[FenceSection, string]> = [['body', page.compiled_truth ?? ''], ['timeline', page.timeline ?? '']];
  const has = (kind: FenceKind, field: string) => field.includes(kind === 'facts' ? 'gbrain:facts:' : 'gbrain:takes:');
  const fence = location.fence ?? KINDS.find(kind => fields.some(([, field]) => has(kind, field))) ?? 'facts';
  const section = location.section ?? fields.find(([, field]) => has(fence, field))?.[0] ?? 'body';
  return { ...location, fence, section };
}

/**
 * The typed refusal a coordinated writer throws. The wire `error` stays
 * `invalid_params` (E3), or `take_row_collision` for a stored-row collision,
 * so connector item holds and older receipt readers keep classifying it.
 */
export function fenceOperationError(location: FenceMessageLocation, slug: string | undefined, sourceId: string, opts: { legacy_error?: string } = {}): OperationError {
  const error = opError('invalid_fence', fenceMessage(location),
    `${slug ? `Page ${slug}` : 'The page'} in source ${sourceId} was not written. Fix the fence the message names in the page body, then write the page again with a new request_id.`,
    { legacy_error: opts.legacy_error ?? 'invalid_params', reason: location.reason,
      ...(slug ? { fix: readFix(`Shows page ${slug} with its fences, read-only.`, { argv: ['gbrain', 'get', '--source', sourceId, '--', slug] }) } : {}) });
  error.fence = { ...location };
  return error;
}

/**
 * #6188 (D19): the refusal of a verb whose target page has a stored facts or
 * takes fence that does not compile and that the verb does not normalize
 * (edit_page and forget never do; an append verb does only what Tier 1 fixes).
 * Typed `invalid_fence` / `target_fence_malformed` at the fence's location.
 */
export function targetFenceRefusal(location: FenceMessageLocation, slug: string, sourceId: string, issues: Array<Record<string, unknown>> = []): OperationError {
  const error = fenceOperationError({ ...location, reason: 'target_fence_malformed' }, slug, sourceId);
  error.suggestion = `Page ${slug} in source ${sourceId} was not changed: its stored ${location.fence} fence does not parse. Read the page, fix that fence (or write the whole page with put_page, `
    + 'which normalizes what it can and names every row it cannot), then retry with a new request_id.';
  if (issues.length) error.fenceIssues = issues.slice(0, 20);
  return error;
}
