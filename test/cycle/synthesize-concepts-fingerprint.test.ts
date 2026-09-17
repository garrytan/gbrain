// Unit tests for the synthesize_concepts change-detection helpers:
// conceptMemberFingerprint (order-independent, membership- and tier-sensitive)
// and resolveConceptsBudgetUsd (configured value wins, invalid → default).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  conceptMemberFingerprint,
  resolveConceptsBudgetUsd,
  CONCEPTS_BUDGET_CONFIG_KEY,
} from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '');
});

describe('conceptMemberFingerprint', () => {
  test('is independent of member order', () => {
    const a = conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/b', 'atoms/a', 'atoms/c'] });
    const b = conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/c', 'atoms/b', 'atoms/a'] });
    expect(a).toBe(b);
  });

  test('changes with membership and with tier', () => {
    const base = conceptMemberFingerprint({ tier: 'T2', atomSlugs: ['atoms/a', 'atoms/b'] });
    expect(conceptMemberFingerprint({ tier: 'T2', atomSlugs: ['atoms/a', 'atoms/c'] })).not.toBe(base);
    expect(conceptMemberFingerprint({ tier: 'T1', atomSlugs: ['atoms/a', 'atoms/b'] })).not.toBe(base);
  });

  test('counts a repeated member, so it tracks mention_count', () => {
    const once = conceptMemberFingerprint({ tier: 'T3', atomSlugs: ['atoms/a', 'atoms/b'] });
    const twice = conceptMemberFingerprint({ tier: 'T3', atomSlugs: ['atoms/a', 'atoms/b', 'atoms/b'] });
    expect(twice).not.toBe(once);
  });
});

describe('resolveConceptsBudgetUsd', () => {
  test('unset falls back to the default ceiling', async () => {
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
  });

  test('a configured value wins, including 0', async () => {
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '12.5');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(12.5);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '0');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(0);
  });

  test('an invalid or negative value falls back to the default', async () => {
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, 'lots');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
    await engine.setConfig(CONCEPTS_BUDGET_CONFIG_KEY, '-1');
    expect(await resolveConceptsBudgetUsd(engine)).toBe(1.5);
  });
});
