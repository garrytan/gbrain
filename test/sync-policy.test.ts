/**
 * #4399: isSyncDisabledConfig — the shared predicate for
 * config.syncEnabled === false, read by autopilot's freshness dispatcher
 * and the `sync --all` fan-out filter (sync-cost-gate.ts's separate inline
 * check is deliberately untouched — see sync-policy.ts's module doc).
 */
import { describe, expect, test } from 'bun:test';
import { isSyncDisabledConfig } from '../src/core/sync-policy.ts';

describe('isSyncDisabledConfig', () => {
  test('true when config.syncEnabled is explicitly false', () => {
    expect(isSyncDisabledConfig({ syncEnabled: false })).toBe(true);
  });

  test('false when syncEnabled is absent (the common case)', () => {
    expect(isSyncDisabledConfig({})).toBe(false);
    expect(isSyncDisabledConfig(undefined)).toBe(false);
    expect(isSyncDisabledConfig(null)).toBe(false);
  });

  test('false when syncEnabled is explicitly true', () => {
    expect(isSyncDisabledConfig({ syncEnabled: true })).toBe(false);
  });

  test('false when other unrelated config keys are set', () => {
    expect(isSyncDisabledConfig({ remote_url: 'https://example.com/repo.git', strategy: 'code' })).toBe(false);
  });

  test('handles a PGLite-shaped JSON-string config (parseSourceConfig unwraps it)', () => {
    // PGLite's driver can hand back config as a JSON string scalar rather
    // than an already-parsed object (see sourceConfigHasRemoteUrl's doc
    // comment in sources-load.ts for the same pattern) — the predicate must
    // unwrap it the same way, not just check `typeof config === 'object'`.
    expect(isSyncDisabledConfig(JSON.stringify({ syncEnabled: false }))).toBe(true);
    expect(isSyncDisabledConfig(JSON.stringify({ syncEnabled: true }))).toBe(false);
  });
});
