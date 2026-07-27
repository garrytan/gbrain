/**
 * Adversarial: D13 read-only tool allowlist invariant.
 *
 * The optimizer's rollouts must NOT be able to call write-flavored ops
 * (put_page, submit_job, file_upload). This is the D13 safety contract.
 *
 * Tests assert the READ_ONLY_BRAIN_TOOLS export EXCLUDES write ops AND
 * INCLUDES every read-flavored op from BRAIN_TOOL_ALLOWLIST.
 */

import { describe, expect, test } from 'bun:test';
import { READ_ONLY_BRAIN_TOOLS } from '../../../src/core/skillopt/rollout.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../../../src/core/minions/tools/brain-allowlist.ts';

describe('adversarial: D13 read-only tool sandbox', () => {
  test('put_page is NOT in the SkillOpt allowlist', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('put_page')).toBe(false);
  });

  test('submit_job is NOT in the SkillOpt allowlist (not in base set either)', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('submit_job')).toBe(false);
  });

  test('file_upload is NOT in the SkillOpt allowlist', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('file_upload')).toBe(false);
  });

  test('read-flavored ops ARE in the SkillOpt allowlist', () => {
    expect(READ_ONLY_BRAIN_TOOLS.has('search')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('query')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('get_page')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('list_pages')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('get_backlinks')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('traverse_graph')).toBe(true);
    expect(READ_ONLY_BRAIN_TOOLS.has('resolve_slugs')).toBe(true);
  });

  test('every entry in the SkillOpt allowlist comes from BRAIN_TOOL_ALLOWLIST', () => {
    for (const name of READ_ONLY_BRAIN_TOOLS) {
      expect(BRAIN_TOOL_ALLOWLIST.has(name)).toBe(true);
    }
  });

  test('REGRESSION GUARD: if a future write op lands in BRAIN_TOOL_ALLOWLIST, this test fires', () => {
    // Hard-coded list of every op that MUST be excluded from the SkillOpt
    // allowlist. Adding a new mutating op to BRAIN_TOOL_ALLOWLIST without
    // also adding it here will cause this test to fail loud — forcing the
    // contributor to explicitly decide whether SkillOpt rollouts should
    // be able to call it.
    const FORBIDDEN_IN_SKILLOPT_ROLLOUTS: ReadonlySet<string> = new Set([
      'put_page',
      'submit_job',
      'file_upload',
      // Future mutating ops: add here when they ship in BRAIN_TOOL_ALLOWLIST.
    ]);
    for (const forbidden of FORBIDDEN_IN_SKILLOPT_ROLLOUTS) {
      expect(READ_ONLY_BRAIN_TOOLS.has(forbidden)).toBe(false);
    }
  });

  test('SkillOpt allowlist size = BRAIN_TOOL_ALLOWLIST size minus 1 (put_page)', () => {
    expect(READ_ONLY_BRAIN_TOOLS.size).toBe(BRAIN_TOOL_ALLOWLIST.size - 1);
  });
});
