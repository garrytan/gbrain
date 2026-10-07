/**
 * Fence schema for repair (#6188): canonical columns, header aliases, the
 * strict parsers' per-cell checks and the Tier 1 value rules.
 *
 * The cell checks mirror `parseFactsFence` / `parseTakesFence` exactly (the
 * numeric patterns are private there, so they are restated here);
 * `test/fence-repair-raw-rows.test.ts` proves the mirror over every fence
 * fixture in the test suite. The rules map one written value to one
 * canonical value and never look at other cells, so the validator can
 * recompute what a rule may output for a given before value.
 */
import { isValidHolder, TAKE_KIND_VALUES } from '../takes-fence.ts';
import type { FenceKind } from './types.ts';

export const FACTS_COLUMNS = [
  '#', 'claim', 'kind', 'confidence', 'visibility', 'notability', 'valid_from', 'valid_until', 'source', 'context',
  'claim_metric', 'claim_value', 'claim_unit', 'claim_period',
] as const;
export const TAKES_COLUMNS = [
  '#', 'claim', 'kind', 'who', 'weight', 'since', 'source', 'resolved', 'quality', 'evidence', 'value', 'unit', 'by',
] as const;

/** Columns per kind, in canonical order. */
export const COLUMNS: Record<FenceKind, readonly string[]> = { facts: FACTS_COLUMNS, takes: TAKES_COLUMNS };
/** The narrow canonical layout (facts 10, takes 7); the wide one adds the remaining columns. */
export const BASE_WIDTH: Record<FenceKind, number> = { facts: 10, takes: 7 };
/** Fewest cells the strict parser reads (facts 9 = no context, takes 6 = no source). */
export const MIN_CELLS: Record<FenceKind, number> = { facts: 9, takes: 6 };
/** Columns read by header name rather than position (takes resolution columns). */
export const NAMED_COLUMNS: Record<FenceKind, ReadonlySet<string>> = {
  facts: new Set(),
  takes: new Set(['resolved', 'quality', 'evidence', 'value', 'unit', 'by']),
};
/** Columns a row may omit at its end and still parse. */
export const TOLERATED_TRAILING: Record<FenceKind, ReadonlySet<string>> = {
  facts: new Set(['context', 'claim_metric', 'claim_value', 'claim_unit', 'claim_period']),
  takes: new Set(['source', 'resolved', 'quality', 'evidence', 'value', 'unit', 'by']),
};
/** Write defaults for a required facts column absent from the whole header (`column_default`, T6). */
export const COLUMN_DEFAULTS: Record<FenceKind, Readonly<Record<string, string>>> = {
  facts: { confidence: '1.0', notability: 'medium', visibility: 'private' },
  takes: {},
};

/** Header and separator text exactly as `renderFactsTable` / `renderTakesFence` emit them. */
export const CANONICAL_HEADER: Record<FenceKind, { narrow: string; wide: string; narrowSep: string; wideSep: string }> = {
  facts: {
    narrow: '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    wide: '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |',
    narrowSep: '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    wideSep: '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|',
  },
  takes: {
    narrow: '| # | claim | kind | who | weight | since | source |',
    wide: '| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |',
    narrowSep: '|---|-------|------|-----|--------|-------|--------|',
    wideSep: '|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|',
  },
};

const ROW_NUM_ALIASES = ['#', 'row', 'row #', 'row num', 'row number', 'no', 'no.', 'num'];
/** Header spellings each canonical column accepts (`header_alias`), before `lookupKey` folding. */
export const HEADER_ALIASES: Record<FenceKind, Readonly<Record<string, readonly string[]>>> = {
  facts: {
    '#': ROW_NUM_ALIASES,
    claim: ['claim', 'fact', 'statement'],
    kind: ['kind', 'type', 'category'],
    confidence: ['confidence', 'conf', 'weight'],
    visibility: ['visibility', 'vis'],
    notability: ['notability', 'importance'],
    valid_from: ['valid from', 'since', 'date', 'from'],
    valid_until: ['valid until', 'until', 'to'],
    source: ['source', 'src'],
    context: ['context', 'notes', 'note'],
    claim_metric: ['claim metric', 'metric'],
    claim_value: ['claim value', 'value'],
    claim_unit: ['claim unit', 'unit'],
    claim_period: ['claim period', 'period'],
  },
  takes: {
    '#': ROW_NUM_ALIASES,
    claim: ['claim', 'take', 'statement'],
    kind: ['kind', 'type'],
    who: ['who', 'holder'],
    weight: ['weight', 'confidence', 'conf'],
    since: ['since', 'date', 'as of'],
    source: ['source', 'src'],
    resolved: ['resolved'],
    quality: ['quality'],
    evidence: ['evidence'],
    value: ['value'],
    unit: ['unit'],
    by: ['by'],
  },
};

/** Lowercase, trim, and fold runs of whitespace, `_` and `-` to one space. */
export function lookupKey(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

const ALIAS_INDEX: Record<FenceKind, Map<string, string>> = {
  facts: aliasIndex('facts'),
  takes: aliasIndex('takes'),
};

function aliasIndex(kind: FenceKind): Map<string, string> {
  const index = new Map<string, string>();
  for (const [column, aliases] of Object.entries(HEADER_ALIASES[kind])) {
    index.set(lookupKey(column), column);
    for (const alias of aliases) index.set(lookupKey(alias), column);
  }
  return index;
}

/** The canonical column a header cell names, or null when it maps to none. */
export function canonicalColumn(kind: FenceKind, headerCell: string): string | null {
  return ALIAS_INDEX[kind].get(lookupKey(headerCell)) ?? null;
}

const FACT_KINDS: ReadonlySet<string> = new Set(['event', 'preference', 'commitment', 'belief', 'fact', 'idea']);
const VISIBILITIES: ReadonlySet<string> = new Set(['private', 'world']);
const NOTABILITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const PLAIN_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUMERIC_CELL_RE = /^([+-]?)[$€£]?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)((?:[eE][+-]?\d+)?)\s*([kmb]?)$/i;

/** Schema vocabulary per column, for `FenceIssue.allowed`. */
export const ALLOWED: Record<FenceKind, Readonly<Record<string, readonly string[]>>> = {
  facts: {
    kind: [...FACT_KINDS],
    visibility: [...VISIBILITIES],
    notability: [...NOTABILITIES],
    confidence: ['a number from 0 to 1'],
    claim_value: ['a number, optionally with 1,234 separators or a k/M/B suffix'],
    '#': ['a positive whole number'],
  },
  takes: {
    kind: [...TAKE_KIND_VALUES],
    who: ['world', 'brain', 'people/<slug>', 'companies/<slug>'],
    weight: ['a number from 0 to 1'],
    '#': ['a positive whole number'],
  },
};

/** The strict parser's row-number read (`parseInt`, positive). */
export function parseRowNum(text: string): number | null {
  const n = parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True when the strict parser accepts `text` in `column`; free-text columns always pass. */
export function cellValid(kind: FenceKind, column: string, text: string): boolean {
  const lower = text.trim().toLowerCase();
  switch (kind === 'facts' ? column : `takes:${column}`) {
    case '#': case 'takes:#': return parseRowNum(text) !== null;
    case 'kind': return FACT_KINDS.has(lower);
    case 'visibility': return VISIBILITIES.has(lower);
    case 'notability': return NOTABILITIES.has(lower);
    case 'confidence': return confidenceValid(text);
    case 'claim_value': return !text.trim() || NUMERIC_CELL_RE.test(text.trim());
    case 'takes:kind': return TAKE_KIND_VALUES.has(lower);
    case 'takes:who': return isValidHolder(text.trim());
    case 'takes:weight': return Number.isFinite(parseFloat(text));
    default: return true;
  }
}

function confidenceValid(text: string): boolean {
  const trimmed = text.trim();
  if (!PLAIN_NUMBER_RE.test(trimmed)) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

/** `kind_map` for facts: written word to kind (any other word maps to `fact`). */
export const FACT_KIND_SYNONYMS: Readonly<Record<string, string>> = {
  proposal: 'idea', suggestion: 'idea', hypothesis: 'idea',
  opinion: 'belief', view: 'belief', insight: 'belief', assessment: 'belief', frame: 'belief',
  promise: 'commitment', pledge: 'commitment',
  meeting: 'event', launch: 'event', announcement: 'event', milestone: 'event',
};
/** `kind_map` for takes: the only words mapped; any other word is `takes_kind_unsupported`. */
export const TAKE_KIND_SYNONYMS: Readonly<Record<string, string>> = {
  assessment: 'take', recommendation: 'take', 'strategic position': 'take', opinion: 'take', view: 'take',
  prediction: 'bet', forecast: 'bet',
  guess: 'hunch', intuition: 'hunch',
};
/** `enum_synonym`: visibility words read as `private`. */
export const PRIVATE_SYNONYMS: ReadonlySet<string> = new Set(['internal', 'team', 'confidential', 'restricted', 'secret', 'shared']);
/** `enum_synonym`: notability words mapped to a canonical level. */
export const NOTABILITY_SYNONYMS: Readonly<Record<string, string>> = {
  critical: 'high', 'very high': 'high', highest: 'high', 'very low': 'low', minor: 'low',
};
/** `holder_alias`: holder words read as `brain`. */
export const BRAIN_ALIASES: ReadonlySet<string> = new Set(['system', 'assistant', 'ai', 'agent', 'gbrain', 'model', 'brain']);

/** `kind_map` for facts: any word maps (unknown words to `fact`). */
export function factsKindMap(word: string): string {
  const key = lookupKey(word);
  if (FACT_KINDS.has(key)) return key;
  return FACT_KIND_SYNONYMS[key] ?? 'fact';
}

/** `kind_map` for takes: only the explicit synonym table; a pack-declared kind never maps. */
export function takesKindMap(word: string, packKinds: readonly string[] = []): string | null {
  const key = lookupKey(word);
  if (packKinds.some(kind => lookupKey(kind) === key)) return null;
  return TAKE_KIND_SYNONYMS[key] ?? null;
}

/** `enum_synonym` for visibility and notability; null when the word has no mapping. */
export function enumSynonym(column: string, word: string, pageVisibility: 'private' | 'world'): string | null {
  const key = lookupKey(word);
  if (column === 'visibility') {
    if (VISIBILITIES.has(key)) return key;
    if (PRIVATE_SYNONYMS.has(key)) return 'private';
    if (key === 'public') return pageVisibility === 'world' ? 'world' : 'private';
    return null;
  }
  if (column === 'notability') return NOTABILITIES.has(key) ? key : NOTABILITY_SYNONYMS[key] ?? null;
  return null;
}

/** `holder_alias`: assistant-style holders to `brain`; case variants of `brain`/`world`. */
export function holderAlias(holder: string): 'brain' | 'world' | null {
  const key = lookupKey(holder);
  if (key === 'world') return 'world';
  return BRAIN_ALIASES.has(key) ? 'brain' : null;
}

/**
 * `confidence_format`: the number a confidence/weight cell means (`85%` is
 * 0.85; stray inner whitespace dropped), or null when it is not numeric.
 */
export function confidenceNumber(text: string): number | null {
  const compact = text.replace(/\s+/g, '');
  const percent = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/.exec(compact);
  if (percent) return Number(percent[1]) / 100;
  return PLAIN_NUMBER_RE.test(compact) ? Number(compact) : null;
}

/** Canonical text for a 0..1 number (the renderers' `1.0` / `0.85` form). */
export function formatConfidence(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(1);
  return String(parseFloat(n.toFixed(6)));
}

/** The `confidence_format` output for a cell, or null when the rule does not apply. */
export function confidenceFormat(text: string): string | null {
  const n = confidenceNumber(text);
  return n !== null && n >= 0 && n <= 1 ? formatConfidence(n) : null;
}

/** The facts context after `kind_map` keeps the original word (after any existing text); an empty word adds nothing. */
export function appendOriginalKind(context: string, word: string): string {
  if (!word.trim()) return context;
  const note = `original kind: ${word.trim()}`;
  return context.trim() ? `${context.trim()}; ${note}` : note;
}

/** The `superseded by #N` reference a facts context or takes source cell carries. */
export function supersededRef(text: string): number | null {
  const m = /superseded by #(\d+)/i.exec(text);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return n > 0 ? n : null;
}

/** Whitespace-collapsed text for comparisons. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
