/**
 * v0.40.3.0 — RemediationStep (D6 refactor + factory tests)
 *
 * The canonical RemediationStep type lives at src/core/remediation-step.ts
 * (lifted from brain-score-recommendations.ts). This file pins the
 * factory's content-stable invariance (codex D12 Bug 2) + the back-compat
 * re-exports so other doctor checks can adopt the type without breaking
 * existing brain-score-recommendations imports.
 *
 * Coverage:
 *   - canonicalJson: deterministic across key orderings + nested objects
 *   - idempotencyKey: shape + content invariance
 *   - makeRemediationStep: defaults, full opt set, id derivation,
 *     canonical-JSON invariance (codex D12 Bug 2)
 *   - back-compat: import { Remediation } from brain-score-recommendations
 *     still resolves to RemediationStep (same type)
 */

import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  idempotencyKey,
  makeRemediationStep,
  type RemediationStep,
} from '../src/core/remediation-step.ts';
import type { Remediation } from '../src/core/brain-score-recommendations.ts';

describe('canonicalJson (D12 Bug 2 canonical serialization)', () => {
  test('object key ordering is deterministic', () => {
    const a = canonicalJson({ a: 1, b: 2, c: 3 });
    const b = canonicalJson({ c: 3, b: 2, a: 1 });
    const c = canonicalJson({ b: 2, a: 1, c: 3 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('nested objects also sort keys', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, top: 'x' });
    const b = canonicalJson({ top: 'x', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  test('arrays preserve order (not sorted)', () => {
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  test('null + primitives serialize via JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
  });

  test('handles arrays of objects with key reordering inside', () => {
    const a = canonicalJson([{ a: 1, b: 2 }, { c: 3 }]);
    const b = canonicalJson([{ b: 2, a: 1 }, { c: 3 }]);
    expect(a).toBe(b);
  });
});

describe('idempotencyKey', () => {
  test('shape: <source>:<job>:<8-hex>', () => {
    const k = idempotencyKey('default', 'sync', { repoPath: '/x' });
    expect(k).toMatch(/^default:sync:[0-9a-f]{8}$/);
  });

  test('same inputs produce identical key', () => {
    const k1 = idempotencyKey('default', 'sync', { repoPath: '/x', sourceId: 'y' });
    const k2 = idempotencyKey('default', 'sync', { repoPath: '/x', sourceId: 'y' });
    expect(k1).toBe(k2);
  });

  test('key ordering invariance (codex D12 Bug 2)', () => {
    const k1 = idempotencyKey('default', 'sync', { a: 1, b: 2 });
    const k2 = idempotencyKey('default', 'sync', { b: 2, a: 1 });
    expect(k1).toBe(k2);
  });

  test('different source produces different key', () => {
    expect(
      idempotencyKey('A', 'sync', { x: 1 }),
    ).not.toBe(idempotencyKey('B', 'sync', { x: 1 }));
  });

  test('different job produces different key', () => {
    expect(
      idempotencyKey('default', 'sync', { x: 1 }),
    ).not.toBe(idempotencyKey('default', 'embed', { x: 1 }));
  });

  test('different params produce different key', () => {
    expect(
      idempotencyKey('default', 'sync', { x: 1 }),
    ).not.toBe(idempotencyKey('default', 'sync', { x: 2 }));
  });
});

describe('makeRemediationStep', () => {
  test('default id is the idempotency key', () => {
    const step = makeRemediationStep({
      job: 'lint-fix',
      params: { slug: 'wiki/foo' },
      severity: 'low',
      est_seconds: 30,
      rationale: 'lint issues on foo',
    });
    expect(step.id).toBe(step.idempotency_key);
    expect(step.idempotency_key).toMatch(/^default:lint-fix:[0-9a-f]{8}$/);
  });

  test('explicit id overrides default', () => {
    const step = makeRemediationStep({
      id: 'sync.repo',
      job: 'sync',
      params: {},
      severity: 'medium',
      est_seconds: 60,
      rationale: 'sync repo',
    });
    expect(step.id).toBe('sync.repo');
    // idempotency_key still gets the content-hash format.
    expect(step.idempotency_key).toMatch(/^default:sync:[0-9a-f]{8}$/);
  });

  test('default status is "remediable"', () => {
    const step = makeRemediationStep({
      job: 'x', params: {}, severity: 'low', est_seconds: 1, rationale: '',
    });
    expect(step.status).toBe('remediable');
  });

  test('canonical JSON invariance: {a:1, b:2} and {b:2, a:1} produce IDENTICAL ids', () => {
    const stepA = makeRemediationStep({
      job: 'sync', params: { a: 1, b: 2 }, severity: 'low', est_seconds: 1, rationale: '',
    });
    const stepB = makeRemediationStep({
      job: 'sync', params: { b: 2, a: 1 }, severity: 'low', est_seconds: 1, rationale: '',
    });
    expect(stepA.id).toBe(stepB.id);
    expect(stepA.idempotency_key).toBe(stepB.idempotency_key);
  });

  test('all opts thread through to the output', () => {
    const step = makeRemediationStep({
      id: 'custom-id',
      job: 'embed',
      params: { stale: true },
      severity: 'high',
      est_seconds: 600,
      est_usd_cost: 1.5,
      depends_on: ['sync.repo'],
      rationale: 'embed stale pages',
      protected: true,
      source: 'team-source',
      status: 'remediable',
    });
    expect(step.id).toBe('custom-id');
    expect(step.job).toBe('embed');
    expect(step.params).toEqual({ stale: true });
    expect(step.severity).toBe('high');
    expect(step.est_seconds).toBe(600);
    expect(step.est_usd_cost).toBe(1.5);
    expect(step.depends_on).toEqual(['sync.repo']);
    expect(step.rationale).toBe('embed stale pages');
    expect(step.protected).toBe(true);
    expect(step.status).toBe('remediable');
    // source threads into idempotency_key namespace
    expect(step.idempotency_key).toMatch(/^team-source:embed:/);
  });
});

describe('back-compat re-export (D6)', () => {
  test('Remediation alias from brain-score-recommendations is RemediationStep', () => {
    // This is a compile-time test: if the import doesn't resolve, tsc fails.
    // Runtime check: assigning a RemediationStep into a Remediation slot.
    const step: RemediationStep = makeRemediationStep({
      job: 'x', params: {}, severity: 'low', est_seconds: 1, rationale: '',
    });
    const legacy: Remediation = step;
    expect(legacy.id).toBe(step.id);
  });
});
