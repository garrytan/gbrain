/**
 * The fence reason table (#6188, D13): every reason the spec names has one
 * entry with a docs anchor, tier, manual-only flag and a location-only fix
 * template; the message grammar renders locations, never values.
 */
import { describe, expect, test } from 'bun:test';
import {
  FENCE_REASON_CODES, FENCE_REASONS, GATE_REASONS, fenceMessage, renderFenceFix,
} from '../src/core/fence-repair/reasons.ts';
import type { FenceReason } from '../src/core/fence-repair/types.ts';
import { OWNER_UNAVAILABLE_REASONS } from '../src/core/persistence/owner-refusal.ts';

const SPEC_MANUAL: FenceReason[] = [
  'missing_begin', 'split_rows', 'repeated_marker', 'takes_in_facts', 'superseded_ambiguous', 'enum_unmapped',
  'weight_missing', 'confidence_out_of_range', 'claim_value_invalid', 'takes_kind_unsupported',
];
/** Manual-only residuals this module adds where the spec says "residual" without naming one. */
const ADDED_MANUAL: FenceReason[] = ['marker_near_miss', 'holder_missing', 'unclosed_ambiguous_tail'];
/**
 * Manual since the Tier 3 eval (#6188 T4): a row whose extra cells empty-cell removal cannot line up, and a facts kind
 * cell that holds text rather than a kind word; no gate can tell a claim cut by an unescaped `|` from a misplaced cell.
 */
const EVAL_MANUAL: FenceReason[] = ['extra_cells', 'claim_split'];
const SPEC_TIER3: FenceReason[] = ['header_unmapped', 'no_header', 'row_before_header', 'short_row', 'unclosed_trailing_content'];
/** #6377: the user's hash-bound approval to close a fence ahead of trailing text on a world-visible page; nothing retries it by itself. */
const APPROVAL: FenceReason[] = ['tail_exposure_approval'];
/** #6278: the owner conditions the `owner_unavailable` reasons matrix names (persistence/owner-refusal.ts); `owner_unavailable` stays the generic fallback. */
const OWNER_CONDITIONS: FenceReason[] = ['host_mismatch', 'transfer_in_progress', 'clone_in_progress', 'incarnation_changed', 'local_path_missing', 'coordination_path_missing'];
const SPEC_OTHERS: FenceReason[] = [
  'holder_unresolved',
  'unparseable', 'row_collision', 'quoted_fence_rows', 'stored_row_collision', 'withdrawn_claim_in_malformed_fence',
  'target_fence_malformed', 'prepare_time', 'normalizer_failed',
  'llm_unavailable', 'llm_empty', 'llm_refused', 'llm_malformed', 'llm_truncated', 'llm_declined', 'llm_disabled', 'no_measured_model', 'budget_exhausted',
  'no_pricing', 'ledger_unavailable', 'owner_unavailable', 'owner_cli_required', 'sync_in_progress', 'time_budget',
  'changed_since_read', 'changed_since_preview',
  'still_invalid', 'claim_changed', 'row_number_changed', 'visibility_loosened', 'row_count_changed', 'cell_changed', 'protection_loosened',
];

describe('FENCE_REASONS', () => {
  test('holds exactly the reasons the spec names (plus the documented additions)', () => {
    expect([...FENCE_REASON_CODES].sort()).toEqual([...SPEC_MANUAL, ...ADDED_MANUAL, ...EVAL_MANUAL, ...SPEC_TIER3, ...APPROVAL, ...OWNER_CONDITIONS, ...SPEC_OTHERS].sort());
  });

  test('owner conditions match the owner_unavailable reasons matrix: host_admin acts, only the in-progress ones retry by themselves', () => {
    expect(OWNER_CONDITIONS.every(reason => (OWNER_UNAVAILABLE_REASONS as readonly string[]).includes(reason))).toBe(true);
    for (const reason of OWNER_CONDITIONS) {
      expect([reason, FENCE_REASONS[reason].actor, FENCE_REASONS[reason].stage, FENCE_REASONS[reason].tier]).toEqual([reason, 'host_admin', 'repair', null]);
      expect([reason, FENCE_REASONS[reason].autoRetry]).toEqual([reason, reason === 'transfer_in_progress' || reason === 'clone_in_progress']);
      expect(FENCE_REASONS[reason].fix).toContain('gbrain sources writer status --source <source> --json');
    }
    expect(FENCE_REASONS.host_mismatch.fix).toContain('never copy or regenerate host.json');
  });

  test('screen residual classes carry the spec\'s tier and manual-only flag', () => {
    for (const reason of [...SPEC_MANUAL, ...ADDED_MANUAL, ...EVAL_MANUAL]) {
      expect([reason, FENCE_REASONS[reason].tier, FENCE_REASONS[reason].manualOnly, FENCE_REASONS[reason].autoRetry]).toEqual([reason, 'manual', true, false]);
    }
    for (const reason of APPROVAL) expect([reason, FENCE_REASONS[reason].manualOnly, FENCE_REASONS[reason].autoRetry, FENCE_REASONS[reason].actor]).toEqual([reason, false, false, 'user']);
    for (const reason of SPEC_TIER3) expect([reason, FENCE_REASONS[reason].tier, FENCE_REASONS[reason].manualOnly]).toEqual([reason, 'llm', false]);
    expect(FENCE_REASONS.holder_unresolved.tier).toBe('resolver');
    expect(FENCE_REASONS.stored_row_collision.manualOnly).toBe(true);
  });

  test('gate reasons map to their letters', () => {
    expect(Object.entries(GATE_REASONS).map(([letter, reason]) => [letter, FENCE_REASONS[reason].gate])).toEqual(
      [['a', 'a'], ['b', 'b'], ['c', 'c'], ['d', 'd'], ['e', 'e'], ['f', 'f'], ['g', 'g']]);
  });

  test('each reason has its own write-refusals anchor', () => {
    const anchors = FENCE_REASON_CODES.map(r => FENCE_REASONS[r].docs);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const reason of FENCE_REASON_CODES) expect(FENCE_REASONS[reason].docs).toBe(`docs/guides/write-refusals.md#fence-${reason}`);
  });

  test('fix templates use only location placeholders and every rendered fix is complete', () => {
    for (const reason of FENCE_REASON_CODES) {
      const placeholders = FENCE_REASONS[reason].fix.match(/\{\w+\}/g) ?? [];
      for (const p of placeholders) expect(['{fence}', '{section}', '{rows}', '{columns}', '{line}', '{allowed}']).toContain(p);
      const rendered = renderFenceFix({ reason, fence: 'facts', section: 'body', rows: [3], columns: ['kind'], line: 12 });
      expect(rendered).not.toMatch(/\{\w+\}/);
      expect(rendered.length).toBeGreaterThan(20);
    }
  });

  test('paid reasons are exactly the ones whose fix raises spend or enables the model', () => {
    expect(FENCE_REASON_CODES.filter(r => FENCE_REASONS[r].paid).sort()).toEqual(['budget_exhausted', 'llm_disabled', 'no_measured_model', 'no_pricing']);
  });
});

describe('message grammar', () => {
  test('Fence <reason>: in the <fence> fence (<section>), rows, columns, line, then the fix', () => {
    const message = fenceMessage({ reason: 'short_row', fence: 'takes', section: 'timeline', rows: [4, 9], columns: [], line: 30 });
    expect(message.startsWith('Fence short_row: in the takes fence (timeline), rows 4, 9, at line 30. Row(s) 4, 9 of the takes fence in the timeline')).toBe(true);
    expect(fenceMessage({ reason: 'enum_unmapped', fence: 'facts', section: 'body', rows: [2], columns: ['notability'], line: 8, allowed: ['high', 'medium', 'low'] }))
      .toContain('row 2, column notability, at line 8. ');
  });
});
