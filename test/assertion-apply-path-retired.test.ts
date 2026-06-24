import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { operationsByName } from '../src/core/operations.ts';

// Workstream F1 (ADR 2026-06-22): the dormant assertion / governed-write APPLY path is
// retired. This test forbids the dormant middle state from quietly returning — the dead
// writer ops must not reappear in the registry, and the deleted modules must stay deleted.

describe('retired assertion apply path (F1)', () => {
  test('dormant preview/explain assertion ops are not registered', () => {
    for (const name of [
      'preview_assertion_claim_extraction',
      'preview_assertion_resolution',
      'explain_assertion',
      'explain_projection',
    ]) {
      expect(operationsByName[name]).toBeUndefined();
    }
  });

  test('the live assertion retrieval + grant ops remain', () => {
    for (const name of [
      'list_retrievable_assertions',
      'evaluate_session_source_grant',
      'evaluate_session_write_grant',
      'build_session_grant_policy_input',
    ]) {
      expect(operationsByName[name]).toBeDefined();
    }
  });

  test('the dead apply-path modules stay deleted', () => {
    for (const path of [
      'src/core/services/governed-canonical-write-service.ts',
      'src/core/assertions/canonical-write-audit-store.ts',
      'src/core/assertions/assertion-resolution-store.ts',
      'src/core/assertions/assertion-resolution-audit-store.ts',
      'src/core/assertions/assertion-lineage-store.ts',
    ]) {
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(false);
    }
  });
});
