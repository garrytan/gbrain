/**
 * #5575 blocking write gate: decides whether attacker-controllable text may
 * become durable memory. Separate from `guardrails.ts` (observe-only, never
 * imported here).
 *
 * Deterministic and model-free (P8 zero-LLM write contract): the detector is
 * the bounded pattern table in `write-gate-patterns.ts`, run over windows of
 * normalized text. Precision comes from routing by trust tier, not from the
 * detector: the gate never runs on `user_confirmed`, `operator_curated` or
 * `tool_observed` writes. Defaults (`write_gate.*` config, DX-13), set by the
 * preregistered paid eval (gbrain-evals docs/benchmarks/2026-10-08-memory-trust-results-paid.md:
 * quarantine and suppression cut no attack success on top of trust labels):
 *   - `external_untrusted`: instruction-like -> `flag` (or `quarantine` /
 *     `reject` / `off` by `write_gate.external_mode`; quarantine is the owner's
 *     opt-in); a detector error -> `quarantine` (fail-closed).
 *   - `agent_written` and `unknown`: instruction-like -> `flag` (or `off` by
 *     `write_gate.agent_mode`); a detector error -> `allow` (fail-open).
 *
 * The assessment covers every attacker-controllable persisted text (ENG-9):
 * page title, body, frontmatter strings and origin fields; fact text,
 * context, value and provenance; take claim, source and evidence; timeline
 * summary, detail and source. Callers compute the tier (it is never guessed
 * here) and persist receipts and holds through `write-gate-store.ts`.
 */
import { createHash } from 'node:crypto';
import type { Action } from './agent-output.ts';
import { opError, type OperationError } from './ops/contract.ts';
import { isTrustTier, type TrustTier } from './trust/tier.ts';
import { MAX_MATCH_CHARS, MAX_PRECEDING_CHARS, WRITE_GATE_PATTERNS, WRITE_GATE_REASON_FAMILIES, type WriteGatePattern, type WriteGateReasonFamily } from './write-gate-patterns.ts';
import { analyzeRegexSource } from './write-gate-regex.ts';

export type { WriteGateReasonFamily } from './write-gate-patterns.ts';

import { WRITE_GATE_DETECTOR_VERSION } from './write-gate-schema.ts';

export { WRITE_GATE_DETECTOR_VERSION };

/** The trust-tier vocabulary lives in `trust/tier.ts`; the gate takes the effective tier the writer computed there. */
export { TRUST_TIERS as WRITE_GATE_TIERS } from './trust/tier.ts';
export type WriteGateTier = TrustTier;

export type WriteGateVerdict = 'allow' | 'flag' | 'quarantine' | 'reject';
export type WriteGateExternalMode = 'quarantine' | 'flag' | 'reject' | 'off';
export type WriteGateAgentMode = 'flag' | 'off';

export interface WriteGateConfig {
  externalMode: WriteGateExternalMode;
  agentMode: WriteGateAgentMode;
}

export const DEFAULT_WRITE_GATE_CONFIG: Readonly<WriteGateConfig> = { externalMode: 'flag', agentMode: 'flag' };

/** Structured origin of a write (`write_origin`); every string here is scanned as data. */
export interface WriteGateOrigin {
  channel?: string | null;
  connector?: string | null;
  source_uri?: string | null;
  source_kind?: string | null;
  ingested_via?: string | null;
}

/**
 * What a caller passes to gate one write (a `trust/tier.ts` `WriteTrust` fits as is). Absent on a write
 * path means the gate does not run there.
 */
export interface WriteGateInput {
  tier: WriteGateTier;
  origin?: WriteGateOrigin | null;
  /** `persistence_requests.id` (or another request id) recorded on receipts and holds. */
  requestId?: string | null;
}

export type WriteGateField =
  | 'title' | 'body' | 'frontmatter' | 'origin'
  | 'fact' | 'context' | 'value' | 'provenance' | 'source_text'
  | 'claim' | 'source' | 'evidence'
  | 'summary' | 'detail';

export interface WriteGateHit { family: WriteGateReasonFamily; pattern: string; field: WriteGateField }

export interface WriteGateAssessment {
  verdict: WriteGateVerdict;
  tier: WriteGateTier;
  /** False when the tier or mode skips the gate (the verdict is then `allow`). */
  ran: boolean;
  families: WriteGateReasonFamily[];
  hits: WriteGateHit[];
  /** The detector threw; the verdict is the tier's fail-closed / fail-open default. */
  detectorError: boolean;
  detectorVersion: number;
  /** sha256 over the scanned fields (receipts dedupe on it); null for `allow`, which records nothing. */
  contentHash: string | null;
}

/** DX-1: the one gate outcome shape `remember`, `put_page` and `capture` return as `gate`. */
export interface WriteGateOutcome {
  verdict: WriteGateVerdict;
  /** `h<id>` for a hold, `wgr<id>` for a receipt, null when nothing was recorded. */
  receipt_ref: string | null;
  /** Reason families only, never matched patterns (remote callers see this). */
  reason_families: WriteGateReasonFamily[];
  /** False when the content is held, rejected, or stored but not active until the owner confirms. */
  active: boolean;
  next: Action | null;
}

const VALID_EXTERNAL: ReadonlySet<string> = new Set(['quarantine', 'flag', 'reject', 'off']);
const VALID_AGENT: ReadonlySet<string> = new Set(['flag', 'off']);

/**
 * Parse `write_gate.external_mode` / `write_gate.agent_mode`. An unset,
 * unreadable or invalid mode falls back to the default (`flag` for both).
 */
export function parseWriteGateConfig(raw: { external_mode?: unknown; agent_mode?: unknown } = {}): WriteGateConfig {
  const ext = typeof raw.external_mode === 'string' ? raw.external_mode.trim().toLowerCase() : '';
  const agent = typeof raw.agent_mode === 'string' ? raw.agent_mode.trim().toLowerCase() : '';
  return {
    externalMode: VALID_EXTERNAL.has(ext) ? ext as WriteGateExternalMode : DEFAULT_WRITE_GATE_CONFIG.externalMode,
    agentMode: VALID_AGENT.has(agent) ? agent as WriteGateAgentMode : DEFAULT_WRITE_GATE_CONFIG.agentMode,
  };
}

export const isWriteGateTier: (value: unknown) => value is WriteGateTier = isTrustTier;

/** True when a write at `tier` is assessed under `cfg` (owner tiers and `off` modes are not). */
export function writeGateApplies(tier: WriteGateTier, cfg: WriteGateConfig): boolean {
  if (tier === 'external_untrusted') return cfg.externalMode !== 'off';
  if (tier === 'agent_written' || tier === 'unknown') return cfg.agentMode !== 'off';
  return false;
}

// Zero-width, bidi-control, soft-hyphen and BOM characters an attacker can use to split a phrase,
// plus Unicode tag characters (U+E0020..E007E, as surrogate pairs), which mirror ASCII invisibly and
// are decoded so hidden text is scanned.
const HIDDEN_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]|\udb40[\udc20-\udc7e]/g;
const revealHidden = (ch: string) => ch.length === 2 ? String.fromCharCode(ch.charCodeAt(1) - 0xdc00) : '';

// Characters NFKC folds into ASCII letters: letterlike and enclosed forms, CJK compatibility,
// ligatures, fullwidth forms and mathematical alphanumerics. (Unicode spaces need no folding:
// the patterns' \s already matches them.)
const COMPAT_RE = /[\u2100-\u214f\u2460-\u24ff\u3300-\u33ff\ufb00-\ufb4f\uff00-\uffef]|\ud835/;

// UTF-16 code units that start something normalizeForGate changes: the hidden set, the compatibility
// forms, and the high surrogates of tag characters (U+DB40) and mathematical alphanumerics (U+D835).
const NEEDS_NORMALIZING = new Uint8Array(65536);
for (const [lo, hi] of [[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x2100, 0x214f], [0x2460, 0x24ff], [0x3164, 0x3164], [0x3300, 0x33ff], [0xd835, 0xd835],
  [0xdb40, 0xdb40], [0xfb00, 0xfb4f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xff00, 0xffef]] as const) NEEDS_NORMALIZING.fill(1, lo, hi + 1);
const needsNormalizing = (text: string) => { for (let i = 0; i < text.length; i++) if (NEEDS_NORMALIZING[text.charCodeAt(i)]) return true; return false; };

/**
 * The text the patterns see: Unicode tag characters decoded to the ASCII they
 * mirror, invisible characters removed, and NFKC applied when compatibility
 * forms are present (fullwidth letters fold to ASCII). Plain ASCII passes
 * through untouched. Case, spacing and line breaks are left alone: every
 * pattern is case-insensitive, matches whitespace runs (line breaks
 * included) and lets a sentence gap cross a hard-wrapped line.
 */
export function normalizeForGate(text: string): string {
  if (!/[^\x00-\x7f]/.test(text) || !needsNormalizing(text)) return text;
  const revealed = text.replace(HIDDEN_RE, revealHidden);
  return COMPAT_RE.test(revealed) ? revealed.normalize('NFKC') : revealed;
}

const FENCE_OPEN = '<!--- gbrain:';

/**
 * Drop gbrain-managed facts/takes fence table rows from page text: those rows
 * get the row-level gate when they are projected. Non-row lines inside a
 * fence (free text an attacker could add) stay in the page scan. Linear: one
 * forward pass with `indexOf`, no backtracking regex.
 */
export function stripManagedFenceRows(body: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = body.indexOf(FENCE_OPEN, pos);
    if (open < 0) break;
    const nameEnd = body.indexOf(':begin -->', open + FENCE_OPEN.length);
    const name = nameEnd < 0 ? '' : body.slice(open + FENCE_OPEN.length, nameEnd);
    if (!/^[a-z_-]{1,40}$/.test(name)) { out += body.slice(pos, open + FENCE_OPEN.length); pos = open + FENCE_OPEN.length; continue; }
    const closeMarker = `${FENCE_OPEN}${name}:end -->`;
    const close = body.indexOf(closeMarker, nameEnd);
    if (close < 0) break;
    out += body.slice(pos, open);
    out += body.slice(nameEnd + ':begin -->'.length, close).split('\n').filter(line => !line.trimStart().startsWith('|')).join('\n');
    pos = close + closeMarker.length;
  }
  return out + body.slice(pos);
}

/** Scan windows: wide enough to amortize the prefilter, overlapping by the longest possible match. */
export const WRITE_GATE_WINDOW_CHARS = 4096;

const NEGATED_BEFORE_RE = /\b(?:never|not|n't|no)\s{1,4}$/i;
/** Global clones, for searching from an offset and walking every match (the table's own regexes stay stateless). */
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- global copies of WRITE_GATE_PATTERNS, vetted by scripts/check-write-gate-regex.ts
const ITERATORS: ReadonlyMap<string, RegExp> = new Map(WRITE_GATE_PATTERNS.map(p => [p.name, new RegExp(p.rx.source, `${p.rx.flags}g`)]));

/**
 * True when `p.rx` matches somewhere its context rules hold: not directly
 * negated, and `preceded` matching the text before it without its `neg` group. Walks every match in
 * `scan` (a prefix of the window) from offset `from` (bounded by its length), so padding with
 * rejected matches cannot hide a real one; contexts read the whole window.
 */
function matchesInContext(p: WriteGatePattern, window: string, atTextStart: boolean, from: number, scan: string): boolean {
  const rx = ITERATORS.get(p.name)!;
  rx.lastIndex = from;
  for (let m = rx.exec(scan); m; m = rx.exec(scan)) {
    const at = m.index;
    // Resume one character later, not at the match end: a rejected match can overlap the one that holds.
    rx.lastIndex = at + 1;
    if (p.negatable && NEGATED_BEFORE_RE.test(window.slice(Math.max(0, at - 10), at))) continue;
    if (!p.preceded) return true;
    // The text start counts as a line start for `preceded` (a pattern may require one).
    const before = at > MAX_PRECEDING_CHARS ? window.slice(at - MAX_PRECEDING_CHARS, at) : `${atTextStart ? '\n' : ''}${window.slice(0, at)}`;
    const context = p.preceded.exec(before);
    if (context && !context.groups?.neg) return true;
  }
  return false;
}

type Detector = (fields: ReadonlyArray<readonly [WriteGateField, string]>) => WriteGateHit[];

/** FNV-1a over a lowercased ASCII word; collisions only widen the prefilter (the regex still decides). */
function wordHash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** An anchor's prefilter key: `@`, or the hash of its longest word. */
function anchorKey(anchor: string): number | '@' {
  if (anchor === '@') return '@';
  const words = anchor.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return wordHash(words.reduce((long, w) => w.length > long.length ? w : long, ''));
}

const ANCHOR_KEYS: ReadonlyMap<string, number | '@'> = new Map(
  [...new Set(WRITE_GATE_PATTERNS.flatMap(p => [...p.anchors, ...(p.requires ?? [])]))].map(a => [a, anchorKey(a)]));
const ANCHOR_HASHES: readonly number[] = [...new Set([...ANCHOR_KEYS.values()].filter((k): k is number => k !== '@'))];
/** Dense index per anchor hash; `@` takes the last slot. Presence per window is a count per index. */
const ANCHOR_INDEX: ReadonlyMap<number, number> = new Map(ANCHOR_HASHES.map((h, i) => [h, i]));
const AT_INDEX = ANCHOR_HASHES.length;
const KEY_COUNT = AT_INDEX + 1;

// Word characters for the anchor scan, case-folded: ASCII digits and letters map to their lowercase code, every other UTF-16 unit to 0.
const WORD_CHAR = new Uint8Array(65536);
for (let c = 48; c <= 57; c++) WORD_CHAR[c] = c;
for (let c = 97; c <= 122; c++) { WORD_CHAR[c] = c; WORD_CHAR[c - 32] = c; }
// 16-bit filter over anchor hashes: most words miss it and skip the Set lookup.
const ANCHOR_FILTER = new Uint8Array(65536);
for (const h of ANCHOR_HASHES) ANCHOR_FILTER[h & 0xffff] = 1;

/**
 * One allocation-light pass over the whole text: the end offset and anchor
 * index of every anchor word (ASCII letters and digits, case-folded, whole
 * words) and of every `@`, in text order, and whether normalizeForGate would
 * change it.
 */
function anchorOccurrences(text: string): { at: number[]; key: number[]; needsNormalizing: boolean } {
  const at: number[] = [];
  const key: number[] = [];
  let normalize = false;
  const len = text.length;
  let i = 0;
  while (i < len) {
    let code = text.charCodeAt(i);
    let c = WORD_CHAR[code]!;
    if (c) {
      // A whole word in one tight loop; the text end counts as a separator.
      let h = 0x811c9dc5;
      do {
        h = Math.imul(h ^ c, 0x01000193);
        code = ++i < len ? text.charCodeAt(i) : 32;
        c = WORD_CHAR[code]!;
      } while (c);
      const word = h >>> 0;
      if (ANCHOR_FILTER[word & 0xffff]) {
        const index = ANCHOR_INDEX.get(word);
        if (index !== undefined) { at.push(i); key.push(index); }
      }
      if (i >= len) break;
    }
    if (code === 64) { at.push(i + 1); key.push(AT_INDEX); }
    else if (code >= 0xad && NEEDS_NORMALIZING[code]) normalize = true;
    i++;
  }
  return { at, key, needsNormalizing: normalize };
}

const keysOf = (anchors: readonly string[]) => [...new Set(anchors.map(a => { const k = ANCHOR_KEYS.get(a)!; return k === '@' ? AT_INDEX : ANCHOR_INDEX.get(k)!; }))];
/** Per pattern (same order as WRITE_GATE_PATTERNS): the anchor indexes, and the `requires` indexes or null. */
const PATTERN_KEYS: ReadonlyArray<{ anchors: number[]; requires: number[] | null }> =
  WRITE_GATE_PATTERNS.map(p => ({ anchors: keysOf(p.anchors), requires: p.requires ? keysOf(p.requires) : null }));

function hasAny(keys: readonly number[], present: Int32Array): boolean {
  for (const k of keys) if (present[k]! > 0) return true;
  return false;
}

/**
 * Patterns whose matches need not contain one of their anchor words: the anchor can sit in the
 * `preceded` context (the exfiltration rules), or a match can glue it to neighbouring letters
 * ("xignore", "apikeys", "ecosystem:"). They scan whole windows. test/write-gate-anchor-ranges.test.ts
 * samples every other pattern's matches and proves each contains an anchor word.
 */
export const WHOLE_WINDOW_PATTERNS: ReadonlySet<string> = new Set([
  'ignore-prior', 'forget-everything', 'disregard', 'system-prompt', 'print-system', 'exfil-standing-lead', 'exfil-agent-addressed',
  'exfil-private-data', 'exfil-passive-now', 'exfil-private-data-passive', 'exfil-templated-url', 'credential-request',
]);
/** Per pattern: its longest match, or 0 when it scans whole windows. */
const REACH: readonly number[] = WRITE_GATE_PATTERNS.map(p => WHOLE_WINDOW_PATTERNS.has(p.name) ? 0 : analyzeRegexSource(p.rx.source).maxLength);
/** Per pattern: 1 at each of its own anchor indexes. */
const OWN_ANCHOR: readonly Uint8Array[] = PATTERN_KEYS.map(k => { const own = new Uint8Array(KEY_COUNT); for (const a of k.anchors) own[a] = 1; return own; });
// Regex word characters (`\w`): `\b` at a window cut reads differently than in the whole text when the character beyond the cut is one.
const REGEX_WORD = new Uint8Array(65536);
for (let c = 48; c <= 57; c++) REGEX_WORD[c] = 1;
for (let c = 65; c <= 90; c++) { REGEX_WORD[c] = 1; REGEX_WORD[c + 32] = 1; }
REGEX_WORD[95] = 1;
const ranges: number[] = [];

/** One field's scan state at one window: anchor occurrences in (start, start + window length] are [left, entered). */
interface WindowScan { text: string; window: string; start: number; at: number[]; key: number[]; present: Int32Array; left: number; entered: number }

/**
 * Whether pattern `i` matches in the scan's window, searching only where a match can lie. Every match
 * contains one of the pattern's anchor words and is at most REACH long, so it sits within REACH of that
 * word's end offset; a window cut where the character beyond it is a word character adds the cut edge,
 * where `\b` reads differently than in the whole text. Each merged range is searched from its start in
 * the window cut at its end, moved past word characters so the cut reads like the text there. Same
 * result as searching the whole window, which it does when the ranges would cover most of it anyway.
 */
function matchesInWindow(p: WriteGatePattern, i: number, s: WindowScan): boolean {
  const { window, start, text } = s;
  const context = p.negatable || p.preceded;
  const reach = REACH[i]!;
  const len = window.length;
  let anchors = 0;
  if (reach) for (const k of PATTERN_KEYS[i]!.anchors) anchors += s.present[k]!;
  if (!reach || anchors * 2 * reach >= len) return context ? matchesInContext(p, window, start === 0, 0, window) : p.rx.test(window);
  const own = OWN_ANCHOR[i]!;
  ranges.length = 0;
  // The open range is [lo, hi); anchor ends come in order, so a range only ever grows to the right.
  let lo = 0;
  let hi = start > 0 && REGEX_WORD[text.charCodeAt(start - 1)] ? reach : -1;
  for (let j = s.left; j < s.entered && hi < len; j++) {
    if (!own[s.key[j]!]) continue;
    const at = s.at[j]! - start;
    if (at - reach > hi) { if (hi >= 0) ranges.push(lo, hi); lo = Math.max(0, at - reach); }
    hi = Math.min(len, at + reach);
  }
  if (start + len < text.length && REGEX_WORD[text.charCodeAt(start + len)]) {
    if (len - reach > hi) { if (hi >= 0) ranges.push(lo, hi); lo = Math.max(0, len - reach); }
    hi = len;
  }
  if (hi >= 0) ranges.push(lo, hi);
  const rx = ITERATORS.get(p.name)!;
  for (let r = 0; r < ranges.length; r += 2) {
    let to = ranges[r + 1]!;
    while (to < len && REGEX_WORD[window.charCodeAt(to)]) to++;
    const scan = to === len ? window : window.slice(0, to);
    if (context) { if (matchesInContext(p, window, start === 0, ranges[r]!, scan)) return true; continue; }
    rx.lastIndex = ranges[r]!;
    if (rx.test(scan)) return true;
  }
  return false;
}

/** Pure detector: every (family, pattern, field) the pattern table finds in the fields. */
export function detectInstructionLike(fields: ReadonlyArray<readonly [WriteGateField, string]>): WriteGateHit[] {
  const hits: WriteGateHit[] = [];
  for (const [field, raw] of fields) {
    if (!raw) continue;
    let text = raw;
    let occ = anchorOccurrences(text);
    if (occ.needsNormalizing) { text = normalizeForGate(raw); occ = anchorOccurrences(text); }
    const found = new Set<string>();
    // Anchor counts over the occurrences in (start, end]: windows only move forward, so each occurrence
    // is added once and removed once instead of every overlapping window rebuilding its key set.
    const { at, key } = occ;
    const present = new Int32Array(KEY_COUNT);
    let entered = 0;
    let left = 0;
    const s: WindowScan = { text, window: '', start: 0, at, key, present, left, entered };
    const step = WRITE_GATE_WINDOW_CHARS - MAX_MATCH_CHARS - MAX_PRECEDING_CHARS;
    for (let start = 0; start < text.length; start += step) {
      const end = start + WRITE_GATE_WINDOW_CHARS;
      while (entered < at.length && at[entered]! <= end) present[key[entered++]!]!++;
      while (left < at.length && at[left]! <= start) present[key[left++]!]!--;
      s.start = start;
      s.window = text.slice(start, end);
      s.left = left;
      s.entered = entered;
      for (let i = 0; i < WRITE_GATE_PATTERNS.length; i++) {
        const p = WRITE_GATE_PATTERNS[i]!;
        const keys = PATTERN_KEYS[i]!;
        if (found.has(p.name) || !hasAny(keys.anchors, present) || (keys.requires && !hasAny(keys.requires, present))) continue;
        if (!matchesInWindow(p, i, s)) continue;
        found.add(p.name);
        hits.push({ family: p.family, pattern: p.name, field });
      }
      if (end >= text.length) break;
    }
  }
  return hits;
}

let detector: Detector = detectInstructionLike;

/** Test seam: replace the detector (e.g. with one that throws, to prove fail-closed). `null` restores it. */
export function __setWriteGateDetectorForTests(fn: Detector | null): void {
  detector = fn ?? detectInstructionLike;
}

function hashFields(fields: ReadonlyArray<readonly [WriteGateField, string]>): string {
  const h = createHash('sha256');
  // Same bytes as hashing `${field}\u0000${value}\u0001`, without copying the value into a new string.
  for (const [field, value] of fields) h.update(`${field}\u0000`).update(value).update('\u0001');
  return h.digest('hex');
}

/** Assess raw fields for a write at `input.tier` under `cfg`. Never throws. */
export function assessWriteGate(fields: ReadonlyArray<readonly [WriteGateField, string | null | undefined]>, input: WriteGateInput, cfg: WriteGateConfig): WriteGateAssessment {
  const present = fields.filter((f): f is readonly [WriteGateField, string] => typeof f[1] === 'string' && f[1].length > 0);
  const scanned = [...present, ...originFields(input.origin)];
  const base = { tier: input.tier, detectorVersion: WRITE_GATE_DETECTOR_VERSION };
  if (!writeGateApplies(input.tier, cfg)) return { ...base, verdict: 'allow', ran: false, families: [], hits: [], detectorError: false, contentHash: null };
  const external = input.tier === 'external_untrusted';
  let hits: WriteGateHit[];
  try {
    hits = detector(scanned);
  } catch {
    return { ...base, verdict: external ? 'quarantine' : 'allow', ran: true, families: [], hits: [], detectorError: true, contentHash: hashFields(scanned) };
  }
  const families = WRITE_GATE_REASON_FAMILIES.filter(f => hits.some(h => h.family === f));
  const verdict: WriteGateVerdict = !hits.length ? 'allow' : external ? cfg.externalMode as Exclude<WriteGateExternalMode, 'off'> : 'flag';
  return { ...base, verdict, ran: true, families, hits, detectorError: false, contentHash: verdict === 'allow' ? null : hashFields(scanned) };
}

/** Origin strings, scanned as the `origin` field (labels and origins are rendered to models as data). */
export function originFields(origin: WriteGateOrigin | null | undefined): Array<readonly [WriteGateField, string]> {
  if (!origin) return [];
  return [origin.channel, origin.connector, origin.source_uri, origin.source_kind, origin.ingested_via]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(v => ['origin', v] as const);
}

// Gate-owned and bookkeeping keys the gate itself or gbrain writes; never attacker text worth scanning.
const UNSCANNED_FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['quarantine', 'content_flag', 'embed_skip', 'atoms_scan_hash', 'quarantine_override', 'title']);

/** Frontmatter string leaves (bounded depth and count) joined one per line. */
export function frontmatterText(frontmatter: Record<string, unknown> | null | undefined): string {
  if (!frontmatter) return '';
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (out.length >= 512 || depth > 4) return;
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  for (const [key, value] of Object.entries(frontmatter)) if (!UNSCANNED_FRONTMATTER_KEYS.has(key)) walk(value, 0);
  return out.join('\n');
}

export function assessPageForGate(
  page: { title?: string | null; compiled_truth: string; timeline?: string | null; frontmatter?: Record<string, unknown> | null },
  input: WriteGateInput, cfg: WriteGateConfig,
): WriteGateAssessment {
  return assessWriteGate([
    ['title', page.title],
    ['body', stripManagedFenceRows(`${page.compiled_truth}\n\n${page.timeline ?? ''}`)],
    ['frontmatter', frontmatterText(page.frontmatter)],
  ], input, cfg);
}

/**
 * A fact row. Facts extraction rewrites strict injection hits to
 * `[redacted]` before the row exists, so pass the pre-sanitized source turn
 * as `source_text` when the caller has it; `[redacted]` itself also counts.
 */
export interface GateFactRow { fact: string; context?: string | null; value?: string | null; source?: string | null; source_text?: string | null }

export function assessFactForGate(row: GateFactRow, input: WriteGateInput, cfg: WriteGateConfig): WriteGateAssessment {
  return assessWriteGate([
    ['fact', row.fact], ['context', row.context], ['value', row.value], ['provenance', row.source], ['source_text', row.source_text],
  ], input, cfg);
}

export interface GateTakeRow { claim: string; source?: string | null; evidence?: string | null; source_text?: string | null }

export function assessTakeForGate(row: GateTakeRow, input: WriteGateInput, cfg: WriteGateConfig): WriteGateAssessment {
  return assessWriteGate([['claim', row.claim], ['source', row.source], ['evidence', row.evidence], ['source_text', row.source_text]], input, cfg);
}

export interface GateTimelineRow { summary: string; detail?: string | null; source?: string | null }

export function assessTimelineForGate(row: GateTimelineRow, input: WriteGateInput, cfg: WriteGateConfig): WriteGateAssessment {
  return assessWriteGate([['summary', row.summary], ['detail', row.detail], ['source', row.source]], input, cfg);
}

/** Human-safe one-line detail for markers and notices: families, detector version and tier, never matched text. */
export function writeGateDetail(a: WriteGateAssessment): string {
  const why = a.detectorError ? 'detector error (fail-closed)' : `instruction-like content (${a.families.join(', ')})`;
  return `write gate: ${why}; tier ${a.tier}, detector v${a.detectorVersion}`;
}

/** DX-1 outcome for a verdict. `ref` is the hold (`h<id>`) or receipt (`wgr<id>`) the caller recorded. */
export function writeGateOutcome(a: WriteGateAssessment, ref: string | null): WriteGateOutcome {
  const base = { verdict: a.verdict, receipt_ref: ref, reason_families: [...a.families] };
  if (a.verdict === 'allow') return { ...base, active: true, next: null };
  if (a.verdict === 'reject') {
    return { ...base, active: false, next: { argv: ['gbrain', 'config', 'get', 'write_gate.external_mode'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'The operator set write_gate.external_mode to reject, so external instruction-like content is refused on every retry; changing that setting is the user\'s decision.' } };
  }
  const target = ref ?? '<ref>';
  if (a.verdict === 'quarantine') {
    return { ...base, active: false, next: { argv: ['gbrain', 'trust', 'release', target], consent: [], actor: 'user', requires_exclusive: false,
      user_message: `Memory from an untrusted source looked like an instruction, so it was held for your review (${target}). Run the command if you want to keep it.`,
      why: 'Releasing held content raises its trust; only the owner can do that, after reviewing it.' } };
  }
  return { ...base, active: false, next: { argv: ['gbrain', 'trust', 'confirm', target], consent: [], actor: 'user', requires_exclusive: false,
    user_message: `An agent saved something that reads like a standing instruction (${target}). It is stored but not acted on until you confirm it.`,
    why: 'Confirming makes agent-written instruction-like memory active; only the owner can confirm.' } };
}

function primaryReason(a: WriteGateAssessment): string {
  return a.detectorError ? 'detector_error' : a.families[0] ?? 'override';
}

/** Verb error for a held (quarantined) fact or take: never `inserted`, fix tells the user to review the hold. */
export function writeHeldError(a: WriteGateAssessment, holdRef: string): OperationError {
  const outcome = writeGateOutcome({ ...a, verdict: 'quarantine' }, holdRef);
  return opError('write_held', `Held for owner review as ${holdRef}: ${writeGateDetail(a)}.`,
    'Do not retry: the same content re-opens the same hold. Tell the user it was held and relay the release command; releasing it is their decision.',
    { reason: primaryReason(a), detail: `hold ${holdRef}; reason families: ${a.families.join(', ') || 'none'}`, ...(outcome.next ? { fix: outcome.next } : {}) });
}

/** Refusal under `write_gate.external_mode=reject`. */
export function writeGateRejectedError(a: WriteGateAssessment): OperationError {
  const outcome = writeGateOutcome({ ...a, verdict: 'reject' }, null);
  return opError('write_gate_rejected', `Refused by the write gate: ${writeGateDetail(a)}.`,
    'The operator set write_gate.external_mode to reject, so this content refuses on every retry. Tell the user; changing the setting is their decision.',
    { reason: primaryReason(a), detail: `reason families: ${a.families.join(', ') || 'none'}`, ...(outcome.next ? { fix: outcome.next } : {}) });
}
