/**
 * #4399: isSyncDisabledConfig — the shared predicate for
 * config.syncEnabled === false, read by autopilot's freshness dispatcher
 * and the `sync --all` fan-out filter (sync-cost-gate.ts's separate inline
 * check is deliberately untouched — see sync-policy.ts's module doc).
 */
import { describe, expect, test } from 'bun:test';
import {
  activationPendingSkipMessage,
  firstActivationPendingSkip,
  isSyncDisabledConfig,
  loadActivationPendingSourceIds,
  skipActivationPendingSync,
} from '../src/core/sync-policy.ts';

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

describe('#5198: activation-pending sync skip', () => {
  test('returns the bound source ids the query yields', async () => {
    const engine = { executeRaw: async () => [{ source_id: 'alpha' }, { source_id: 'beta' }] };
    expect(await loadActivationPendingSourceIds(engine as never)).toEqual(new Set(['alpha', 'beta']));
  });

  test('fails open to an empty set when the persistence tables are unreadable', async () => {
    const engine = { executeRaw: async () => { throw new Error('relation "persistence_source_bindings" does not exist'); } };
    expect(await loadActivationPendingSourceIds(engine as never)).toEqual(new Set());
  });

  test('reports each source once per process', () => {
    expect(firstActivationPendingSkip('policy-once-a')).toBe(true);
    expect(firstActivationPendingSkip('policy-once-a')).toBe(false);
    expect(firstActivationPendingSkip('policy-once-b')).toBe(true);
  });

  test('skipActivationPendingSync skips only pending sources and writes the reason once', () => {
    const lines: string[] = [];
    const pending = new Set(['policy-guard-a']);
    expect(skipActivationPendingSync(pending, 'policy-guard-b', 'x_skipped', true, l => lines.push(l))).toBe(false);
    expect(skipActivationPendingSync(pending, 'policy-guard-a', 'x_skipped', true, l => lines.push(l))).toBe(true);
    expect(skipActivationPendingSync(pending, 'policy-guard-a', 'x_skipped', true, l => lines.push(l))).toBe(true);
    expect(lines.map(l => JSON.parse(l))).toEqual([{ event: 'x_skipped', source_id: 'policy-guard-a', reason: 'activation_pending' }]);
  });

  test('the skip message names the source, the refusal code and where to look', () => {
    const message = activationPendingSkipMessage('alpha');
    expect(message).toContain('source=alpha');
    expect(message).toContain('writer_coordinator_required');
    expect(message).toContain('gbrain sources writer status');
  });
});
