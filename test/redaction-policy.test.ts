/**
 * Redaction policy parsing and publication (src/core/redaction-policy.ts +
 * the config snapshot hook in src/core/config-snapshot.ts).
 *
 * Protects: a brain with no redaction.* rows has the default (all off)
 * policy; each key parses strictly (an unknown class or mode falls back to
 * that field's default, never widening); `gbrain config set` refuses bad
 * values; and reading a brain's config snapshot publishes its policy to the
 * process. Regression it catches: a typo in a class list silently enabling
 * or disabling a class, or the snapshot loader no longer publishing (every
 * enforcement point would then read the default). No existing test covers
 * these keys. Seam: __setRedactionPolicyForTests (restore only).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfigSnapshot } from '../src/core/config-snapshot.ts';
import {
  DEFAULT_REDACTION_POLICY, REDACTION_CONFIG_KEYS, __setRedactionPolicyForTests, parseRedactionClasses, parseRedactionPolicy,
  redactionConfigValueRefusal, redactionPolicy, redactionPolicyActive,
} from '../src/core/redaction-policy.ts';

afterEach(() => __setRedactionPolicyForTests(null));

describe('parsing', () => {
  test('class lists: comma/plus/space separated, case-blind, deduplicated; none/off/empty is the empty list; unknown is invalid', () => {
    expect(parseRedactionClasses('identifier')).toEqual(['identifier']);
    expect(parseRedactionClasses('Identifier, contact,identifier')).toEqual(['identifier', 'contact']);
    expect(parseRedactionClasses('credential+identifier')).toEqual(['credential', 'identifier']);
    for (const empty of ['', ' ', 'none', 'off', null, undefined]) expect(parseRedactionClasses(empty)).toEqual([]);
    expect(parseRedactionClasses('identifiers')).toBeNull();
    expect(parseRedactionClasses('identifier,phi')).toBeNull();
  });
  test('no rows -> the default policy; a bad value keeps that field at its default', () => {
    expect(parseRedactionPolicy(null)).toBe(DEFAULT_REDACTION_POLICY);
    expect(parseRedactionPolicy({})).toEqual(DEFAULT_REDACTION_POLICY);
    const p = parseRedactionPolicy({ [REDACTION_CONFIG_KEYS.projection]: 'identifier', [REDACTION_CONFIG_KEYS.egress]: 'bogus', [REDACTION_CONFIG_KEYS.onWrite]: 'ALL', [REDACTION_CONFIG_KEYS.onWriteClasses]: 'none' });
    expect(p).toEqual({ projection: ['identifier'], egress: [], onWrite: 'all', onWriteClasses: [] });
    expect(parseRedactionPolicy({ [REDACTION_CONFIG_KEYS.onWrite]: 'maybe' }).onWrite).toBe('off');
  });
  test('config set refusals name the accepted values; the sealed marker is not hand-set', () => {
    expect(redactionConfigValueRefusal(REDACTION_CONFIG_KEYS.projection, 'identifier,contact')).toBeNull();
    expect(redactionConfigValueRefusal(REDACTION_CONFIG_KEYS.projection, 'phi')).toContain('credential, identifier, contact');
    expect(redactionConfigValueRefusal(REDACTION_CONFIG_KEYS.onWrite, 'facts')).toBeNull();
    expect(redactionConfigValueRefusal(REDACTION_CONFIG_KEYS.onWrite, 'yes')).toContain('off, facts, all');
    expect(redactionConfigValueRefusal(REDACTION_CONFIG_KEYS.sealedProjection, 'x')).toContain('not set by hand');
    expect(redactionConfigValueRefusal('redaction.other', 'x')).toContain('Unknown redaction key');
    expect(redactionConfigValueRefusal('search.mode', 'x')).toBeNull();
  });
});

describe('publication', () => {
  test('reading a config snapshot publishes that brain\'s policy; an engine without getAllConfig leaves it untouched', async () => {
    expect(redactionPolicy()).toBe(DEFAULT_REDACTION_POLICY);
    expect(redactionPolicyActive()).toBe(false);
    const rows = { [REDACTION_CONFIG_KEYS.egress]: 'identifier', other_key: 'x' };
    expect(await loadConfigSnapshot({ getConfig: async () => null, getAllConfig: async () => rows })).toEqual(rows);
    expect(redactionPolicy().egress).toEqual(['identifier']);
    expect(redactionPolicyActive()).toBe(true);
    expect(await loadConfigSnapshot({ getConfig: async () => null })).toBeNull();
    expect(redactionPolicy().egress).toEqual(['identifier']);
    expect(await loadConfigSnapshot({ getConfig: async () => null, getAllConfig: async () => ({}) })).toEqual({});
    expect(redactionPolicy()).toEqual(DEFAULT_REDACTION_POLICY);
  });
});
