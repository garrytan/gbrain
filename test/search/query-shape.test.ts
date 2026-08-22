/**
 * #1663 — query-shape router (factual vs open) + the structural-tier gate.
 * Pure functions; fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import { classifyQueryShape, isLookupShapedQuery } from '../../src/core/search/query-intent.ts';

describe('classifyQueryShape (#1663)', () => {
  test('wh-lookups are factual', () => {
    expect(classifyQueryShape('who is alice-example')).toBe('factual');
    expect(classifyQueryShape('when did the widget-co seed round close')).toBe('factual');
    expect(classifyQueryShape('where is the 2026 offsite')).toBe('factual');
    expect(classifyQueryShape('which fund led acme-seed')).toBe('factual');
  });

  test('attribute possessives and quoted names are factual', () => {
    expect(classifyQueryShape("alice-example's email")).toBe('factual');
    expect(classifyQueryShape('the url of the design doc')).toBe('factual');
    expect(classifyQueryShape('"Hall of Light"')).toBe('factual');
  });

  test('slug-ish tokens are factual', () => {
    expect(classifyQueryShape('acme-example series A')).toBe('factual');
    expect(classifyQueryShape('people/alice-example')).toBe('factual');
  });

  test('how/why/explain/summarize/compare are open', () => {
    expect(classifyQueryShape('how does the sync checkpoint work')).toBe('open');
    expect(classifyQueryShape('why did we pick pglite as the default engine')).toBe('open');
    expect(classifyQueryShape('explain the trust boundary')).toBe('open');
    expect(classifyQueryShape('summarize what happened at the offsite')).toBe('open');
    expect(classifyQueryShape('compare fund-a and fund-b on follow-on behavior')).toBe('open');
    expect(classifyQueryShape('tell me about the ownership economy')).toBe('open');
  });

  test('"what do we know about" is open (synthesis-shaped)', () => {
    expect(classifyQueryShape('what do we know about founder liquidity trends')).toBe('open');
  });

  test('explicit factual lead wins over an embedded open verb', () => {
    expect(classifyQueryShape('who explained the outage postmortem')).toBe('factual');
  });

  test('unmatched short queries default factual; long multi-clause defaults open', () => {
    expect(classifyQueryShape('offsite dinner plan')).toBe('factual');
    expect(
      classifyQueryShape('all the different things we could possibly try next quarter given the team constraints and roadmap'),
    ).toBe('open');
  });

  test('empty query is open (nothing to look up)', () => {
    expect(classifyQueryShape('   ')).toBe('open');
  });
});

describe('isLookupShapedQuery (#1663)', () => {
  test('slug-shaped single tokens always qualify', () => {
    expect(isLookupShapedQuery('people/alice-example')).toBe(true);
    expect(isLookupShapedQuery('projects/mingtang')).toBe(true);
  });

  test('short queries qualify; long ones do not', () => {
    expect(isLookupShapedQuery('Hall of Light')).toBe(true);
    expect(isLookupShapedQuery('alice example')).toBe(true);
    expect(isLookupShapedQuery('what were the three big objections raised in the partner meeting')).toBe(false);
  });

  test('empty query never qualifies', () => {
    expect(isLookupShapedQuery('')).toBe(false);
    expect(isLookupShapedQuery('   ')).toBe(false);
  });
});
