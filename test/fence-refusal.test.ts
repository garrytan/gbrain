/**
 * #6188 PR1: the shared fence check, its typed refusal and the receipt grammar.
 * A coordinated screen refuses exactly what the canonical projection refuses,
 * the location comes from the raw-row view (never a parser warning string),
 * and a stored receipt (current grammar, a legacy message, or the durable
 * detail that outlives compaction) reads back into the same location, while an
 * arbitrary `invalid_params` never does. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { compileCanonicalProjections } from '../src/core/persistence/canonical-projections.ts';
import { screenImportContent, isContentRefusal, contentRefusalFromReceipt } from '../src/core/import-screen.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fenceMessage, FENCE_REASON_CODES, FENCE_REASONS, type FenceMessageLocation } from '../src/core/fence-repair/reasons.ts';
import type { FenceReason } from '../src/core/fence-repair/types.ts';
import { gitHoldFix, holdRepairSteps } from '../src/core/persistence/sync-holds.ts';
import { prepareTimeFenceHold } from '../src/core/persistence/sync-screen.ts';
import { writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { CODES } from '../src/core/error-registry.ts';
import { completeFenceLocation, fenceFailureDetail, fenceLocationFromDetail, fenceLocationFromMessage, fenceOperationError, fenceReceiptLocation,
  parseFenceMessage, scanCanonicalFences } from '../src/core/fence-repair/refusal.ts';
import { publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { ParsedPage } from '../src/core/import-file.ts';

const F = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->', T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
// Unique strings that must never leave the page: a claim, a holder and a kind.
const CLAIM = 'Sentinelclaimzq7 ships quarterly', HOLDER = 'Sentinelholderzq7 Example', KIND = 'sentinelkindzq7';
const fact = (n: number | string, kind = 'fact', claim = CLAIM) => `| ${n} | ${claim} | ${kind} | 1.0 | private | medium | 2026-01-01 |  | chat |  |`;
const take = (n: number | string, who = 'brain', kind = 'take', claim = CLAIM) => `| ${n} | ${claim} | ${kind} | ${who} | 0.7 | 2026-01 | chat |`;
const facts = (...rows: string[]) => `${F}\n${FH}\n${rows.join('\n')}\n${FE}`;
const takes = (...rows: string[]) => `${T}\n${TH}\n${rows.join('\n')}\n${TE}`;
const page = (body: string, timeline = ''): ParsedPage => ({ compiled_truth: body, timeline } as ParsedPage);
const file = (body: string) => `---\ntitle: Example page\n---\n${body}\n`;

const cases: Array<[name: string, body: string, timeline: string, expected: Record<string, unknown>]> = [
  ['missing end marker', `Intro\n\n${F}\n${FH}\n${fact(1)}\n`, '', { reason: 'unparseable', fence: 'facts', section: 'body', line: 3 }],
  ['two-dash takes markers', `<!-- gbrain:takes:begin -->\n${TH}\n${take(1)}\n<!-- gbrain:takes:end -->`, '', { reason: 'marker_near_miss', fence: 'takes', line: 1 }],
  ['repeated marker', `${facts(fact(1))}\n\n${facts(fact(2))}`, '', { reason: 'repeated_marker', fence: 'facts', section: 'body' }],
  ['unknown facts kind', facts(fact(1, KIND)), '', { reason: 'enum_unmapped', fence: 'facts', rows: [1], columns: ['kind'], line: 4 }],
  ['unknown takes kind', takes(take(2, 'brain', KIND)), '', { reason: 'takes_kind_unsupported', fence: 'takes', rows: [2], columns: ['kind'] }],
  ['invalid holder', takes(take(3, HOLDER)), '', { reason: 'holder_unresolved', fence: 'takes', rows: [3], columns: ['who'] }],
  ['short row', facts(`| 4 | ${CLAIM} | fact |`), '', { reason: 'short_row', fence: 'facts', rows: [4] }],
  ['duplicate row in one fence', takes(take(5), take(5, 'world')), '', { reason: 'row_collision', fence: 'takes', rows: [5] }],
  ['duplicate row across sections', facts(fact(6)), facts(fact(6)), { reason: 'row_collision', fence: 'facts', section: 'timeline', rows: [6] }],
];

/** The cases Tier 1 fixes losslessly (#6188, #6377): a missing end marker with nothing after the table, two-dash takes markers, two balanced fences of a kind, an invented facts kind, duplicate row numbers. */
const TIER1_FIXABLE = new Set(['missing end marker', 'two-dash takes markers', 'repeated marker', 'unknown facts kind', 'duplicate row in one fence', 'duplicate row across sections']);

describe('the shared fence check', () => {
  test('a clean page, a page without fences, a fence quoted in code and a lone end marker (the projection reads none) pass the check', () => {
    for (const body of ['No fences here.', facts(fact(1)), takes(take(1)), `Example:\n\n\`\`\`\n${facts(fact(9, KIND))}\n\`\`\`\n`, `Intro\n\n${FE}\n`]) {
      expect(scanCanonicalFences(page(body)).defects).toEqual([]);
      expect(() => compileCanonicalProjections(page(body), 'notes/example', 'default')).not.toThrow();
    }
  });

  for (const [name, body, timeline, expected] of cases) {
    test(`${name}: the screen and the projection refuse it with the same typed location`, () => {
      const [defect] = scanCanonicalFences(page(body, timeline)).defects;
      expect(defect).toMatchObject(expected);
      let thrown: unknown;
      try { compileCanonicalProjections(page(body, timeline), 'notes/example', 'default'); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(OperationError);
      const error = thrown as OperationError;
      // E3: wire error stays invalid_params; the canonical code and reason are typed.
      expect({ code: error.code, canonical: error.canonicalCode, reason: error.reason }).toEqual({ code: 'invalid_params', canonical: 'invalid_fence', reason: expected.reason as string });
      expect(error.message).toBe(fenceMessage(defect!));
      expect(error.fix?.argv).toEqual(['gbrain', 'get', '--source', 'default', '--', 'notes/example']);
      for (const secret of [CLAIM, HOLDER, KIND, 'Sentinel']) expect(error.message).not.toContain(secret);

      // #6188: with fences.normalize=false the coordinated screen refuses exactly what the projection refuses, at the same location.
      const content = file(timeline ? `${body}\n\n<!-- timeline -->\n\n${timeline}` : body);
      const coordinated = screenImportContent({ content, path: 'notes/example.md', fences: 'coordinated', normalize: false });
      expect(coordinated.status).toBe('refused');
      if (coordinated.status === 'refused') {
        expect(coordinated.refusal).toMatchObject({ code: 'invalid_fence', reason: expected.reason, fence: { reason: expected.reason, fence: expected.fence } });
        expect(JSON.stringify(coordinated.refusal)).not.toMatch(/Sentinel|sentinel/);
      }
      // With normalization on (the default), Tier 1 admits a fence it fixes losslessly and refuses the rest typed.
      const normalized = screenImportContent({ content, path: 'notes/example.md', fences: 'coordinated' });
      if (TIER1_FIXABLE.has(name)) {
        expect(normalized.status).toBe('importable');
        if (normalized.status === 'importable') expect(normalized.fences?.fixes.length).toBeGreaterThan(0);
      } else {
        expect(normalized).toMatchObject({ status: 'refused', refusal: { code: 'invalid_fence', fence: { fence: expected.fence } } });
        expect(JSON.stringify(normalized)).not.toMatch(/Sentinel|sentinel/);
      }
      // T5: legacy (lenient, the default) paths import it as before.
      expect(screenImportContent({ content: file(body), path: 'notes/example.md' }).status).toBe('importable');
    });
  }

  test('a stored-row collision keeps its own wire code', () => {
    const error = fenceOperationError({ reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2], columns: [], line: null }, 'notes/example', 'default',
      { legacy_error: 'take_row_collision' });
    expect({ code: error.code, canonical: error.canonicalCode, reason: error.reason }).toEqual({ code: 'take_row_collision', canonical: 'invalid_fence', reason: 'stored_row_collision' });
  });

  test('the registry entry lists every reason of the shared table and keeps the frozen wire value', () => {
    expect(CODES.invalid_fence).toMatchObject({ class: 'caller', legacy_error: 'invalid_params', reasons: FENCE_REASON_CODES });
  });
});

/**
 * Every reason the screen and the projection can put in a refusal, hold or
 * receipt. #6188 PR4: their holds and source steps route to `gbrain repair
 * fences` (D6), never to frontmatter repair.
 */
const PR1_REASONS: readonly FenceReason[] = ['repeated_marker', 'missing_begin', 'marker_near_miss', 'unparseable', 'no_header', 'row_before_header',
  'short_row', 'extra_cells', 'enum_unmapped', 'takes_kind_unsupported', 'confidence_out_of_range', 'claim_value_invalid', 'weight_missing',
  'holder_unresolved', 'row_collision', 'quoted_fence_rows', 'stored_row_collision', 'withdrawn_claim_in_malformed_fence', 'prepare_time'];
describe('every PR1 reason routes to the fence repair, never to frontmatter repair', () => {
  test('every reason the screen and the projection emit is one PR1 accounts for', () => {
    for (const [, body, timeline] of cases) expect(PR1_REASONS).toContain(scanCanonicalFences(page(body, timeline)).defects[0]!.reason);
  });

  test('every PR1 reason links to an anchor the refusal guide defines', () => {
    const guide = readFileSync(join(import.meta.dir, '..', 'docs/guides/write-refusals.md'), 'utf8');
    for (const reason of PR1_REASONS) {
      const [path, anchor] = FENCE_REASONS[reason].docs.split('#');
      expect(path).toBe('docs/guides/write-refusals.md');
      expect(guide).toContain(`<a id="${anchor}"></a>`);
    }
  });

  test('hold fixes and source steps for every PR1 reason name gbrain repair fences; messages, suggestions and fixes never name frontmatter repair', () => {
    for (const reason of PR1_REASONS) {
      const location: FenceMessageLocation = { reason, fence: 'takes', section: 'body', rows: [2], columns: ['who'], line: 5 };
      const error = fenceOperationError(location, 'notes/example', 'default');
      const receipt = contentRefusalFromReceipt('invalid_params', error.message);
      const hold = prepareTimeFenceHold({ path: 'notes/example.md', sourcePath: 'notes/example.md', working: false }, 'notes/example', 1, location, 'Body.', null);
      const fix = gitHoldFix({ source_id: 'default', path: 'notes/example.md', code: 'invalid_fence', slug: 'notes/example', page_id: 1,
        meta: { reason, recovery_version: RECOVERY_VERSION, fence: location } });
      const steps = holdRepairSteps('default', { fences: 1, others: 0 });
      expect(fix.argv).toEqual(['gbrain', 'repair', 'fences', '--source', 'default', '--only', 'notes/example.md']);
      expect(steps.argv).toEqual(['gbrain', 'repair', 'content', '--source', 'default']); // #6377: the source-level step is the content lane
      const texts = [error.message, error.suggestion, JSON.stringify(error.fix), receipt?.suggestion, hold.message, JSON.stringify(fix),
        writeFailureDiagnostic('invalid_params', error.message).suggestion, steps.text];
      for (const text of texts) expect(text ?? '').not.toContain('repair frontmatter');
    }
  });
});

describe('the receipt grammar', () => {
  const locations = [
    { reason: 'enum_unmapped', fence: 'facts', section: 'body', rows: [1, 3], columns: ['kind'], line: 6 },
    { reason: 'row_collision', fence: 'takes', section: 'timeline', rows: [4], columns: [], line: null },
    { reason: 'repeated_marker', fence: 'facts', section: 'body', rows: [], columns: [], line: 12 },
    { reason: 'stored_row_collision', fence: 'takes', section: 'body', rows: [2], columns: [], line: null },
  ] as const;

  test('every message reads back into its location, from the message and from the durable detail', () => {
    for (const location of locations) {
      const message = fenceMessage({ ...location, rows: [...location.rows], columns: [...location.columns] });
      expect(parseFenceMessage(message)).toEqual({ ...location, rows: [...location.rows], columns: [...location.columns] });
      const wire = location.reason === 'stored_row_collision' ? 'take_row_collision' : 'invalid_params';
      expect(isContentRefusal(wire, message)).toBe(true);
      expect(contentRefusalFromReceipt(wire, message)).toMatchObject({ code: 'invalid_fence', reason: location.reason, fence: { fence: location.fence, section: location.section } });
      const error = fenceOperationError({ ...location, rows: [...location.rows], columns: [...location.columns] }, 'notes/example', 'default', { legacy_error: wire });
      const detail = fenceFailureDetail(error)!;
      expect(detail).toMatchObject({ origin: 'fence', fence: { version: 1, reason: location.reason } });
      // Compaction drops the message; the detail alone still names the location.
      expect(fenceReceiptLocation({ error_code: wire, error_message: null, error_detail: detail })).toEqual({ ...location, rows: [...location.rows], columns: [...location.columns] });
    }
  });

  test('the messages older releases stored convert to the typed reason; an arbitrary invalid_params never does', () => {
    const legacy: Array<[string, string, string]> = [
      ['invalid_params', 'Each canonical body section must contain at most one facts fence and one takes fence.', 'repeated_marker'],
      ['invalid_params', 'A canonical facts or takes fence cannot be parsed losslessly.', 'unparseable'],
      ['invalid_params', 'Canonical row numbers must be unique across the entire page.', 'row_collision'],
      ['invalid_params', 'A takes or facts fence sits inside markdown code, so this write would remove the rows it holds.', 'quoted_fence_rows'],
      ['invalid_params', 'A malformed fact fence contains a withdrawn claim.', 'withdrawn_claim_in_malformed_fence'],
      ['take_row_collision', "A takes fence row number is already used by a different take that is not in this page's canonical fence.", 'stored_row_collision'],
    ];
    for (const [code, message, reason] of legacy) {
      expect(fenceLocationFromMessage(code, message)?.reason as string | undefined).toBe(reason);
      expect(isContentRefusal(code, message)).toBe(true);
      expect(contentRefusalFromReceipt(code, message)).toMatchObject({ code: 'invalid_fence', reason });
    }
    for (const [code, message] of [['invalid_params', 'The value is invalid.'], ['invalid_params', 'Fence not_a_reason: in the facts fence (body). x'],
      ['storage_error', 'A canonical facts or takes fence cannot be parsed losslessly.'], ['invalid_params', null]] as const) {
      expect(fenceLocationFromMessage(code, message)).toBeNull();
      expect(isContentRefusal(code, message)).toBe(false);
    }
    expect(fenceReceiptLocation({ error_code: 'invalid_params', error_message: null, error_detail: null })).toBeNull();
  });

  test('a tampered or foreign detail is never read as a fence location, and the public view drops row numbers', () => {
    expect(fenceLocationFromDetail({ origin: 'database_guard', sqlstate: 'P0001' })).toBeNull();
    expect(fenceLocationFromDetail({ origin: 'fence', fence: { version: 2, reason: 'unparseable', fence: 'facts', section: 'body' } })).toBeNull();
    expect(fenceLocationFromDetail({ origin: 'fence', fence: { version: 1, reason: 'not_a_reason', fence: 'facts', section: 'body' } })).toBeNull();
    expect(fenceLocationFromDetail({ origin: 'fence', fence: { version: 1, reason: 'enum_unmapped', fence: 'facts', section: 'body', rows: [1, 'x', -2], columns: ['kind', 'Bad Col'], line: 'x' } }))
      .toEqual({ reason: 'enum_unmapped', fence: 'facts', section: 'body', rows: [1], columns: ['kind'], line: null });
    const stored = { origin: 'fence', fence: { version: 1, reason: 'row_collision', fence: 'takes', section: 'body', rows: [7], columns: [], line: null }, attempt: { consumer_version: 'x', consumer_host_id: null } };
    expect(publicFailureDetail(stored)).toEqual({ origin: 'fence', fence: { version: 1, reason: 'row_collision', fence: 'takes', section: 'body', columns: [], line: null } });
  });

  test('a receipt an older release stored names its section from the refused bytes', () => {
    expect(completeFenceLocation({ reason: 'stored_row_collision', fence: 'takes', rows: [], columns: [], line: null }, page('Intro.', takes(take(1)))))
      .toMatchObject({ fence: 'takes', section: 'timeline' });
    expect(completeFenceLocation({ reason: 'quoted_fence_rows', rows: [], columns: [], line: null }, page(facts(fact(1)))))
      .toMatchObject({ fence: 'facts', section: 'body' });
  });
});
