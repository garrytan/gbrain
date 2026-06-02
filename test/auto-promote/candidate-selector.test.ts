import { describe, it, expect } from 'bun:test';
import { selectAutoPromoteCandidates } from '../../src/core/auto-promote/candidate-selector.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';

const base = {
  id: 'c', scope_id: 'workspace:default', candidate_type: 'fact',
  proposed_content: 'x', source_refs: ['user:msg:1'], generated_by: 'agent',
  extraction_kind: 'manual', confidence_score: 0.9, importance_score: 0.5,
  recurrence_score: 0, sensitivity: 'work', status: 'candidate',
  target_object_type: 'curated_note', target_object_id: 'brain/concepts/x',
} as any;

describe('selectAutoPromoteCandidates', () => {
  const policy = defaultAutoPromoteConfig();
  it('routes a manual work-sensitivity targeted candidate to low_risk', () => {
    const r = selectAutoPromoteCandidates([{ ...base }], policy);
    expect(r.low_risk).toHaveLength(1);
  });
  it('routes inferred candidate to risky', () => {
    const r = selectAutoPromoteCandidates([{ ...base, extraction_kind: 'inferred' }], policy);
    expect(r.risky).toHaveLength(1);
  });
  it('excludes secret sensitivity', () => {
    const r = selectAutoPromoteCandidates([{ ...base, sensitivity: 'secret' }], policy);
    expect(r.excluded[0].reason).toContain('sensitivity');
  });
  it('excludes target_object_type other / missing target id', () => {
    expect(selectAutoPromoteCandidates([{ ...base, target_object_type: 'other' }], policy).excluded).toHaveLength(1);
    expect(selectAutoPromoteCandidates([{ ...base, target_object_id: null }], policy).excluded).toHaveLength(1);
  });
  it('excludes non-page-backed targets until dedicated context loaders exist', () => {
    expect(selectAutoPromoteCandidates([{ ...base, target_object_type: 'profile_memory' }], policy).excluded[0].reason).toBe('target_not_page_backed');
    expect(selectAutoPromoteCandidates([{ ...base, target_object_type: 'personal_episode' }], policy).excluded[0].reason).toBe('target_not_page_backed');
  });
  it('skips already-terminal candidates (promoted/rejected)', () => {
    const r = selectAutoPromoteCandidates([{ ...base, status: 'promoted' }], policy);
    expect(r.low_risk).toHaveLength(0);
    expect(r.risky).toHaveLength(0);
    expect(r.excluded).toHaveLength(0);
  });
});
