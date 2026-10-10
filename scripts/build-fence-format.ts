#!/usr/bin/env bun
/**
 * Generated region of docs/guides/fence-format.md (#6188, D23): the facts and
 * takes fence format, rendered from the parser and repair constants so the
 * reference cannot drift from what gbrain accepts and rewrites.
 *
 *   bun run scripts/build-fence-format.ts          rewrite the region
 *   bun run scripts/build-fence-format.ts --check  exit 1 when the committed region is stale
 *
 * Sources: markers (facts-fence.ts, takes-fence.ts), columns, layouts, value
 * vocabularies, header aliases and Tier 1 synonym tables
 * (fence-repair/schema.ts), the holder grammar (`isValidHolder`), the reason
 * table (fence-repair/reasons.ts) and the gate letters. Both examples are
 * parsed with the strict parsers here; a render fails when either draws a
 * warning. Drift test: test/fence-format-reference.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, isValidHolder, parseTakesFence } from '../src/core/takes-fence.ts';
import {
  ALLOWED, BASE_WIDTH, BRAIN_ALIASES, CANONICAL_HEADER, COLUMN_DEFAULTS, COLUMNS, FACT_KIND_SYNONYMS, FACTS_COLUMNS,
  HEADER_ALIASES, MIN_CELLS, NAMED_COLUMNS, NOTABILITY_SYNONYMS, PRIVATE_SYNONYMS, TAKE_KIND_SYNONYMS, TAKES_COLUMNS,
  TOLERATED_TRAILING, appendOriginalKind, confidenceFormat, holderAlias,
} from '../src/core/fence-repair/schema.ts';
import { FENCE_REASON_CODES, FENCE_REASONS, GATE_REASONS } from '../src/core/fence-repair/reasons.ts';
import type { FenceKind, FenceTier, FixClass, GateLetter } from '../src/core/fence-repair/types.ts';

export const FENCE_FORMAT_PATH = join(import.meta.dir, '..', 'docs', 'guides', 'fence-format.md');
const BEGIN = /<!-- BEGIN GENERATED fence-format[^>]*-->\n/;
const BEGIN_LINE = '<!-- BEGIN GENERATED fence-format (bun run scripts/build-fence-format.ts; drift test: test/fence-format-reference.test.ts) -->\n';
const END = '<!-- END GENERATED fence-format -->';
const REFUSALS = 'write-refusals.md';

const code = (text: string) => `\`${text}\``;
const codes = (values: Iterable<string>) => [...values].map(code).join(', ');

const FACTS_TEXT: Record<(typeof FACTS_COLUMNS)[number], string> = {
  '#': 'Row number.',
  claim: 'The statement, free text. `~~claim~~` marks a row that is no longer active.',
  kind: 'What the claim is.',
  confidence: 'How sure the brain is.',
  visibility: 'Who may read the row.',
  notability: 'How much it matters.',
  valid_from: 'When it became true (`YYYY-MM-DD`), or empty.',
  valid_until: 'When it stopped being true, or empty.',
  source: 'Where it came from, free text.',
  context: 'Free text. `superseded by #N` names the row that replaced a struck row; `forgotten: ...` marks a row withdrawn with `forget`.',
  claim_metric: 'Metric of a typed claim (`mrr`, `team_size`, ...), or empty.',
  claim_value: 'Value of a typed claim.',
  claim_unit: 'Unit (`USD`, `people`, ...), or empty.',
  claim_period: 'Period (`monthly`, `annual`, ...), or empty.',
};

const TAKES_TEXT: Record<(typeof TAKES_COLUMNS)[number], string> = {
  '#': 'Row number.',
  claim: 'The position, free text. `~~claim~~` marks a row that is no longer active.',
  kind: 'What the take is.',
  who: 'Who holds the position (see [holders](#holders)): who said or clearly implied it, not who it is about.',
  weight: 'How strongly it is held; stored on the 0.05 grid. There is no default.',
  since: 'When the holder took the position (`YYYY-MM-DD` or `YYYY-MM`; `start → end` for a range).',
  source: 'Where it came from. `superseded by #N` names the row that replaced a struck row.',
  resolved: 'When the take was resolved.',
  quality: 'How the take turned out.',
  evidence: 'What resolved it.',
  value: 'Resolved value.',
  unit: 'Unit of the resolved value.',
  by: 'Who resolved it.',
};

const COLUMN_TEXT: Record<FenceKind, Readonly<Record<string, string>>> = { facts: FACTS_TEXT, takes: TAKES_TEXT };

const GATE_TEXT = {
  a: 'The result parses with no warning: no repeated marker, unique row numbers.',
  b: 'Every claim cell is unchanged (struck claims included).',
  c: 'Every row number that was valid and unique still names the same claim.',
  d: 'No row becomes more visible: `private` never turns `world`.',
  e: 'No row is added or dropped, and every row of the fence stays inside it; under `merge_fences` the only rows dropped are the exact duplicates its mapping names.',
  f: 'A cell valid in its column keeps its text; a misaligned cell may only move, and text changes only through a named rule.',
  g: 'Text the privacy boundary hid before the repair stays hidden after it, except the trailing lines a `close_fence_trailing` fix shows (admitted only on a private page or under the user\'s approval).',
} satisfies Record<GateLetter, string>;

const TIER_TEXT: Record<Exclude<FenceTier, 'deterministic'>, string> = {
  resolver: 'Tier 2, verified holder lookup, free',
  llm: 'Tier 3, the repair model rewrites only the named rows, or answers HOLD when a row has two readings',
  manual: 'a person edits the fence; gbrain never guesses',
};

/** Synthetic examples; both must parse with zero warnings. */
const FACTS_EXAMPLE = [
  FACTS_FENCE_BEGIN,
  CANONICAL_HEADER.facts.narrow,
  CANONICAL_HEADER.facts.narrowSep,
  '| 1 | Acme Example plans to open its widget API in 2026 | event | 0.9 | private | high | 2026-03-01 |  | meetings/2026-04-03 |  |',
  '| 2 | ~~Acme Example has 12 engineers~~ | fact | 1.0 | private | medium | 2025-06-01 | 2026-01-15 | companies/acme-example | superseded by #3 |',
  '| 3 | Acme Example has 18 engineers | fact | 1.0 | private | medium | 2026-01-15 |  | companies/acme-example |  |',
  FACTS_FENCE_END,
].join('\n');

const TAKES_EXAMPLE = [
  TAKES_FENCE_BEGIN,
  CANONICAL_HEADER.takes.narrow,
  CANONICAL_HEADER.takes.narrowSep,
  '| 1 | Acme Example reaches profitability in 2027 | bet | people/alice-example | 0.65 | 2026-04 | meetings/2026-04-03 |',
  '| 2 | Widget pricing drives most churn | take | brain | 0.55 | 2026-04 |  |',
  '| 3 | Acme Example sells developer tools | fact | world | 1.0 | 2026-01 | companies/acme-example |',
  TAKES_FENCE_END,
].join('\n');

const HOLDER_PROBES = [
  'world', 'brain', 'people/alice-example', 'companies/acme-example', 'alice-example',
  'System', 'Alice Example', 'people/Alice-Example', 'world/alice-example', 'users/alice-example',
];

function checkExamples(): void {
  const facts = parseFactsFence(FACTS_EXAMPLE);
  const takes = parseTakesFence(TAKES_EXAMPLE);
  if (facts.warnings.length || facts.facts.length !== 3) throw new Error(`facts example no longer parses clean: ${facts.warnings.length} warning(s), ${facts.facts.length} row(s)`);
  if (takes.warnings.length || takes.takes.length !== 3) throw new Error(`takes example no longer parses clean: ${takes.warnings.length} warning(s), ${takes.takes.length} row(s)`);
}

function columnTable(kind: FenceKind): string {
  const rows = COLUMNS[kind].map((column, i) => {
    const allowed = ALLOWED[kind][column];
    const values = !allowed ? 'free text' : allowed.every(value => !/\s/.test(value)) ? codes(allowed) : allowed.join('; ');
    const notes = [COLUMN_TEXT[kind][column]];
    if (NAMED_COLUMNS[kind].has(column)) notes.push('Read by header name.');
    const fallback = COLUMN_DEFAULTS[kind][column];
    return `| ${i + 1} | ${code(column)} | ${values} | ${TOLERATED_TRAILING[kind].has(column) ? 'yes' : 'no'} | ${fallback ? code(fallback) : '-'} | ${notes.join(' ')} |`;
  });
  return ['| Position | Column | Values | May be left off the row end | Default when the header lacks it | Meaning |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

function layouts(kind: FenceKind): string {
  const all = COLUMNS[kind];
  const dropped = all.slice(MIN_CELLS[kind], BASE_WIDTH[kind]);
  const wide = all.slice(BASE_WIDTH[kind]);
  return [
    `- **Narrow, ${BASE_WIDTH[kind]} cells** (what gbrain writes unless a row needs a wide column):`,
    '',
    '  ```text',
    `  ${CANONICAL_HEADER[kind].narrow}`,
    `  ${CANONICAL_HEADER[kind].narrowSep}`,
    '  ```',
    '',
    `- **Wide, ${all.length} cells** (adds ${codes(wide)}):`,
    '',
    '  ```text',
    `  ${CANONICAL_HEADER[kind].wide}`,
    `  ${CANONICAL_HEADER[kind].wideSep}`,
    '  ```',
    '',
    `- **Shortest row, ${MIN_CELLS[kind]} cells:** the narrow row without ${codes(dropped)}. A row that is short anywhere else is \`short_row\`.`,
  ].join('\n');
}

function headerSpellings(kind: FenceKind): string {
  const rows = Object.entries(HEADER_ALIASES[kind])
    .map(([column, aliases]) => [column, aliases.filter(alias => alias !== column)] as const)
    .filter(([, aliases]) => aliases.length)
    .map(([column, aliases]) => `| ${code(column)} | ${codes(aliases)} |`);
  return [`| ${kind} column | Also accepted in a header |`, '| --- | --- |', ...rows].join('\n');
}

function holderTable(): string {
  const rows = HOLDER_PROBES.map(holder => {
    const valid = isValidHolder(holder);
    const alias = holderAlias(holder);
    const legacy = valid && !/^(world|brain|people\/|companies\/)/.test(holder);
    const outcome = valid
      ? (legacy ? 'Accepted (an older bare-slug form); write `people/<slug>` or `companies/<slug>` instead.' : 'Accepted.')
      : alias ? `Rewritten to ${code(alias)} (\`holder_alias\`).` : 'Not a holder: `holder_unresolved`. Tier 2 resolves it only to one verified page; otherwise a person fixes it.';
    return `| ${code(holder)} | ${valid ? 'yes' : 'no'} | ${outcome} |`;
  });
  return ['| Written | Valid | What gbrain does |', '| --- | --- | --- |', ...rows].join('\n');
}

function synonymLines(table: Readonly<Record<string, string>>): string {
  const byTarget = new Map<string, string[]>();
  for (const [word, target] of Object.entries(table)) byTarget.set(target, [...(byTarget.get(target) ?? []), word]);
  return [...byTarget].map(([target, words]) => `${codes(words)} → ${code(target)}`).join('; ');
}

/** One row per fix class; the type binding fails typecheck when a class is added or removed. */
function normalizedTable(): string {
  const brainWords = [...BRAIN_ALIASES].filter(word => word !== 'brain');
  const text = {
    merge_fences: 'A section with more than one fence of a kind becomes one fence when every fence has both markers, the same canonical header and nothing but table lines inside: the later fences\' rows are appended to the first in document order, a later row whose cells (every column but `#`) equal a kept row\'s as written is dropped, a number that now collides is renumbered (see [row numbers](#row-numbers)) and a `superseded by #N` reference follows its own fence\'s row N, and the later markers, tables and a repeated section heading above them are removed. Anything else stays `repeated_marker` and a person merges the fences.',
    close_fence: 'A fence with no end marker gets one directly after its table, when nothing but blank lines follows the last row up to the end of the section.',
    close_fence_trailing: 'A fence with no end marker whose table is followed by page text gets the end marker directly after its last row, so the text that followed becomes visible, when every trailing line is prose (no `|`, no fence marker; a line with a `|` only after the repair model read the tail as prose) and either the page is private (its body is never shown to remote readers, so nothing new is disclosed) or the user approved those exact lines through the hash-bound apply the preview prints. A world-visible page with no approval is `tail_exposure_approval`; a tail the model read as rows, or a marker mention, is `unclosed_ambiguous_tail` and a person closes the fence.',
    marker_form: 'Two-dash takes markers (`<!-- gbrain:takes:begin -->`) directly above a takes table become the three-dash markers. Two-dash facts markers are not a fence and are left alone.',
    stray_empty_cell: 'A row with more cells than its header (with no header: than the narrow layout, or 14 facts cells) loses empty cells, only when exactly one choice of empty cells to remove leaves every checked column (`#`, kind, confidence, visibility, notability, `claim_value`; takes kind, holder, weight) valid. Otherwise the row is `extra_cells` and a person fixes it.',
    renumber: 'A row number that is zero, negative, not a number or a duplicate gets a new number (see [row numbers](#row-numbers)).',
    column_default: `A required facts column missing from the whole header gets its write default: ${Object.entries(COLUMN_DEFAULTS.facts).map(([c, v]) => `${code(c)} ${code(v)}`).join(', ')}. Takes have no defaults; a takes fence with no weight is \`weight_missing\`.`,
    header_alias: 'A header whose every column has a known spelling (see [header spellings](#header-spellings)) becomes the canonical header, and each row\'s cells move into canonical order unchanged.',
    enum_synonym: `Facts notability ${synonymLines(NOTABILITY_SYNONYMS)}; visibility ${codes(PRIVATE_SYNONYMS)} → \`private\`, and \`public\` → \`world\` only on a world-visible page (\`private\` otherwise); case and spacing variants of a canonical value. Any other word is \`enum_unmapped\`.`,
    kind_map: `Facts: ${synonymLines(FACT_KIND_SYNONYMS)}; any other word → \`fact\`, with the word kept in \`context\` (for example ${code(appendOriginalKind('', 'partnership'))}). A facts kind cell longer than three words, or with sentence punctuation, a link or strikethrough, is not read as a kind: it is \`claim_split\`, usually the end of a claim an unescaped \`|\` cut in two. Takes: ${synonymLines(TAKE_KIND_SYNONYMS)}; any other word is \`takes_kind_unsupported\`, because gbrain never chooses a takes kind.`,
    holder_alias: `Takes holder ${codes(brainWords)} (any case) → \`brain\`.`,
    confidence_format: `A percent or a number with stray spaces in \`confidence\` or \`weight\` becomes a decimal: \`85%\` → ${code(confidenceFormat('85%')!)}, \`0. 8\` → ${code(confidenceFormat('0. 8')!)}. A number outside 0 to 1 is \`confidence_out_of_range\`.`,
    holder_verified: 'Tier 2, not Tier 1: a takes holder written as a name becomes the one `people/` or `companies/` page it resolves to exactly. On a world-visible page a private page never matches. Anything less certain stays `holder_unresolved`.',
  } satisfies Record<FixClass, string>;
  const rows = Object.entries(text).map(([cls, what]) => `| ${code(cls)} | ${what} |`);
  return ['| Class | What it rewrites |', '| --- | --- |', ...rows].join('\n');
}

function reasonsByTier(): string {
  const screen = FENCE_REASON_CODES.filter(reason => FENCE_REASONS[reason].stage === 'screen');
  return (['llm', 'resolver', 'manual'] as const).map(tier => {
    const reasons = screen.filter(reason => FENCE_REASONS[reason].tier === tier);
    return `- **${tier}** (${TIER_TEXT[tier]}): ${reasons.map(r => `[${code(r)}](${REFUSALS}#fence-${r})`).join(', ')}.`;
  }).join('\n');
}

function gateTable(): string {
  const rows = (Object.keys(GATE_REASONS) as GateLetter[]).map(letter => `| (${letter}) | [${code(GATE_REASONS[letter])}](${REFUSALS}#fence-${GATE_REASONS[letter]}) | ${GATE_TEXT[letter]} |`);
  return ['| Gate | Reason when it fails | What must hold |', '| --- | --- | --- |', ...rows].join('\n');
}

/** The generated region's body. */
export function renderFenceFormatRegion(): string {
  checkExamples();
  return [
    '<a id="markers"></a>',
    '## Markers',
    '',
    `A facts fence sits between ${code(FACTS_FENCE_BEGIN)} and ${code(FACTS_FENCE_END)}; a takes fence between ${code(TAKES_FENCE_BEGIN)} and ${code(TAKES_FENCE_END)} (three dashes after \`<!\`). The body and the timeline section of a page each hold at most one fence of each kind. A marker inside a code block or an inline code span is an example, not a fence. Inside the fence the first table line is the header, which names \`claim\` and \`kind\`, then a separator line, then one line per row. A \`|\` inside a cell is written \`\\|\`.`,
    '',
    '<a id="facts-columns"></a>',
    '## Facts columns',
    '',
    'Facts cells are read by position.',
    '',
    columnTable('facts'),
    '',
    '<a id="facts-layouts"></a>',
    layouts('facts'),
    '',
    '<a id="takes-columns"></a>',
    '## Takes columns',
    '',
    `Takes cells are read by position, except ${codes(NAMED_COLUMNS.takes)}, which are read by header name.`,
    '',
    columnTable('takes'),
    '',
    '<a id="takes-layouts"></a>',
    layouts('takes'),
    '',
    '<a id="holders"></a>',
    '## Holders',
    '',
    `A takes \`who\` cell is one of ${codes(ALLOWED.takes.who!)}. Slugs are lowercase.`,
    '',
    holderTable(),
    '',
    '<a id="row-numbers"></a>',
    '## Row numbers',
    '',
    `- \`#\` is ${ALLOWED.facts['#']![0]}, unique per fence kind across the whole page: the body and the timeline count together.`,
    '- A struck row keeps its number, and `superseded by #N` must name a row on the page.',
    '- gbrain renumbers a row whose number is zero, negative, not a number or a duplicate. When two rows share a number, the row that matches the stored row keeps it. A new number is one above every number on the page (live and struck, both sections) and every stored row number of the page, so a freed number is not reused. A number whose only trace was deleted before this release is not known and could be reused.',
    '- gbrain does not renumber a duplicate that a `superseded by #N` reference names (`superseded_ambiguous`), or rows hidden from a remote caller.',
    '',
    '<a id="examples"></a>',
    '## Examples',
    '',
    'A valid facts fence (narrow layout; row 2 was superseded by row 3):',
    '',
    '```markdown',
    FACTS_EXAMPLE,
    '```',
    '',
    'A valid takes fence (narrow layout):',
    '',
    '```markdown',
    TAKES_EXAMPLE,
    '```',
    '',
    '<a id="normalized"></a>',
    '## What gbrain fixes by itself',
    '',
    'These rules run on every write path for free. They edit or move cell text and never re-render a table. A fence they fix completely is written back in fixed form; each fix is reported by its class, row and column.',
    '',
    normalizedTable(),
    '',
    '<a id="header-spellings"></a>',
    '### Header spellings',
    '',
    'Header cells are compared case-insensitively, with spaces, `_` and `-` treated alike. A column not listed accepts only its own name.',
    '',
    headerSpellings('facts'),
    '',
    headerSpellings('takes'),
    '',
    '<a id="never-guessed"></a>',
    '## What gbrain never guesses',
    '',
    'A problem the rules above cannot fix exactly is held or refused with a reason. The reason says which tier clears it:',
    '',
    reasonsByTier(),
    '',
    '<a id="gates"></a>',
    '### Gates every repair passes',
    '',
    'No tier writes a fence until all of these hold, and the result is one the rules above would leave unchanged. A Tier 3 proposal that fails one stays held with the gate and rows named.',
    '',
    gateTable(),
  ].join('\n');
}

/** The document with its generated region replaced by a fresh render. */
export function renderFenceFormatDoc(current: string): string {
  const begin = BEGIN.exec(current);
  const endAt = current.indexOf(END);
  if (!begin || endAt < begin.index) throw new Error(`${FENCE_FORMAT_PATH}: generated region markers are missing`);
  return `${current.slice(0, begin.index)}${BEGIN_LINE}${renderFenceFormatRegion()}\n${current.slice(endAt)}`;
}

if (import.meta.main) {
  const current = readFileSync(FENCE_FORMAT_PATH, 'utf8');
  const fresh = renderFenceFormatDoc(current);
  if (process.argv.includes('--check')) {
    if (fresh !== current) {
      console.error('docs/guides/fence-format.md is stale. Run: bun run scripts/build-fence-format.ts');
      process.exit(1);
    }
    console.log('fence-format.md: up to date');
  } else {
    writeFileSync(FENCE_FORMAT_PATH, fresh);
    console.log(`wrote ${FENCE_FORMAT_PATH}`);
  }
}
