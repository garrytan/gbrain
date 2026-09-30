/**
 * Fix wave 4 lane B: the connector item-hold helper's counting rules,
 * classification table, circuit breaker, backoff schedule, cap and legacy
 * carry-over, with an injected clock. Pure logic; no engine.
 */
import { describe, expect, test } from 'bun:test';
import { CredentialError } from '../src/core/creds/errors.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { LockStolenError } from '../src/core/db-lock.ts';
import { ConnectorWaitBudgetStop } from '../src/core/persistence/connector-sync.ts';
import { invalidConnectorText } from '../src/core/connectors/connector-text.ts';
import {
  carryLegacyFailCounts, classifyConnectorError, emptyItemHolds, heldItems, HOLD_BACKOFF_MS, HOLD_CAP, HOLD_DAILY_MS, HOLD_TRANSIENT_WINDOW_MS,
  ItemHoldsRun, type ItemHoldsState,
} from '../src/core/connectors/item-holds.ts';

const HOUR = 3_600_000;
const clock = () => { let now = Date.parse('2026-09-01T00:00:00Z'); return { now: () => now, advance: (ms: number) => { now += ms; } }; };
const transientError = () => new Error('GitHub API HTTP 502 on /repos/acme-example/app/issues/7');
const contentError = () => new Error('GitHub API HTTP 422 on /repos/acme-example/app/issues/7');

/** One run over `items`: `failing` items fail with `error()`, the rest succeed. */
function run(state: ItemHoldsState, now: () => number, items: string[], failing: Set<string>, error: () => unknown = transientError, retryKeys: string[] = []) {
  const holds = new ItemHoldsRun(state, { now, retryKeys });
  const skipped: string[] = [];
  for (const key of items) {
    if (!holds.shouldAttempt(key)) { skipped.push(key); continue; }
    if (failing.has(key)) holds.fail(key, error()); else holds.succeed(key);
  }
  return { ...holds.finish(), skipped };
}

describe('classifyConnectorError (the one classification table)', () => {
  test('source-scoped, rate-limit and item-scoped codes', () => {
    const cases: Array<[unknown, string, string, string?]> = [
      [new OperationError('writer_coordinator_required', 'x'), 'writer_coordinator_required', 'source'],
      [new OperationError('owner_unavailable', 'x'), 'owner_unavailable', 'source'],
      [new OperationError('queue_capacity', 'x'), 'queue_capacity', 'source'],
      [new OperationError('write_pending', 'x'), 'write_pending', 'source'],
      [new OperationError('connector_account_changed', 'x'), 'connector_account_changed', 'source'],
      [new LockStolenError('lock'), 'lock_stolen', 'source'],
      [new ConnectorWaitBudgetStop(), 'write_pending', 'source'],
      [Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), 'statement_timeout', 'source'],
      [Object.assign(new Error('lock timeout'), { code: '55P03' }), 'lock_timeout', 'source'],
      [Object.assign(new Error('serialization'), { code: '40001' }), 'database_contention', 'source'],
      [new CredentialError('not_connected'), 'not_connected', 'source'],
      [new CredentialError('rate_limited'), 'rate_limited', 'rate_limit'],
      [new Error('GitHub API HTTP 429 on /repos/x/y/issues/1'), 'rate_limited', 'rate_limit'],
      [new Error('GitHub API HTTP 403 on /x (not rate-limited; check token permissions)'), 'auth', 'source'],
      [new CredentialError('upstream', ': HTTP 500 on gmail (backend error)'), 'http_5xx', 'item', 'transient'],
      [new CredentialError('upstream', ': HTTP 400 on gmail (bad)'), 'http_4xx', 'item', 'content'],
      [new CredentialError('upstream', ': unreachable gmail'), 'network', 'item', 'transient'],
      [transientError(), 'http_5xx', 'item', 'transient'],
      [contentError(), 'http_4xx', 'item', 'content'],
      [invalidConnectorText('message_ids'), 'invalid_connector_text', 'item', 'content'],
      [new OperationError('invalid_params', 'bad item'), 'invalid_params', 'item', 'content'],
      [Object.assign(new OperationError('storage_error', 'x'), { writeError: 'storage_error' }), 'storage_error', 'item', 'transient'],
      [new TypeError('fetch failed'), 'network', 'item', 'transient'],
      [new Error('something odd'), 'unknown', 'item', 'transient'],
    ];
    for (const [error, code, scope, klass] of cases) {
      const got = classifyConnectorError(error);
      expect({ code: got.code, scope: got.scope }).toEqual({ code, scope: scope as never });
      if (klass) expect(got.class).toBe(klass as never);
    }
  });
});

describe('ItemHoldsRun counting', () => {
  test('a singleton item failing transiently is held after 3 attempted runs, then skipped', () => {
    const c = clock();
    let state = emptyItemHolds();
    for (let i = 1; i <= 3; i++) {
      const r = run(state, c.now, ['a'], new Set(['a']));
      state = r.state;
      expect(state.items.a).toMatchObject({ attempts: i, state: i < 3 ? 'failing' : 'held' });
      expect(r.newlyHeld).toEqual(i === 3 ? ['a'] : []);
      c.advance(60_000);
    }
    expect(run(state, c.now, ['a'], new Set(['a'])).skipped).toEqual(['a']);
    expect(heldItems(state).map(r => r.key)).toEqual(['a']);
  });

  test('a source-scoped or rate-limited failure repeated 3 times holds nothing', () => {
    const c = clock();
    for (const error of [() => new OperationError('owner_unavailable', 'x'), () => new CredentialError('rate_limited')]) {
      let state = emptyItemHolds();
      for (let i = 0; i < 3; i++) state = run(state, c.now, ['a'], new Set(['a']), error).state;
      expect(state.items).toEqual({});
    }
  });

  test('one deterministic code failing every item of a 20-item run holds nothing (circuit breaker)', () => {
    const c = clock();
    const items = Array.from({ length: 20 }, (_, i) => `i${i}`);
    let state = emptyItemHolds();
    for (let i = 0; i < 3; i++) {
      const r = run(state, c.now, items, new Set(items), contentError);
      expect(r.outage).toBe(true);
      state = r.state;
    }
    expect(state.items).toEqual({});
  });

  test('a correlated transient outage (half of 10) trips the breaker; 5 transient failures among 1,000 successes count', () => {
    const c = clock();
    const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const r = run(emptyItemHolds(), c.now, ten, new Set(ten.slice(0, 5)));
    expect(r.outage).toBe(true);
    expect(r.state.items).toEqual({});
    const many = Array.from({ length: 1_005 }, (_, i) => `m${i}`);
    const counted = run(emptyItemHolds(), c.now, many, new Set(many.slice(0, 5)));
    expect(counted.outage).toBe(false);
    expect(Object.keys(counted.state.items)).toHaveLength(5);
  });

  test('success clears a count or a hold; an upstream-deleted item drops its count', () => {
    const c = clock();
    let state = run(emptyItemHolds(), c.now, ['a', 'b'], new Set(['a', 'b'])).state;
    state = run(state, c.now, ['a'], new Set()).state;
    expect(Object.keys(state.items)).toEqual(['b']);
    const holds = new ItemHoldsRun(state, { now: c.now });
    holds.drop('b');
    expect(holds.finish().state.items).toEqual({});
  });

  test('consecutive means the same upstream version; a changed version starts over, and a held item re-attempts once on change', () => {
    const c = clock();
    const once = (state: ItemHoldsState, version: string, fails = true) => {
      const holds = new ItemHoldsRun(state, { now: c.now });
      if (!holds.shouldAttempt('a', version)) return { state, attempted: false };
      if (fails) holds.fail('a', contentError(), { version }); else holds.succeed('a');
      return { state: holds.finish().state, attempted: true };
    };
    let state = once(emptyItemHolds(), 'v1').state;
    state = once(state, 'v1').state;
    state = once(state, 'v2').state;
    expect(state.items.a).toMatchObject({ attempts: 1, state: 'failing', upstream_version: 'v2' });
    state = once(once(state, 'v2').state, 'v2').state;
    expect(state.items.a.state).toBe('held');
    expect(once(state, 'v2').attempted).toBe(false);
    const changed = once(state, 'v3');
    expect(changed.attempted).toBe(true);
    expect(changed.state.items.a).toMatchObject({ state: 'held', upstream_version: 'v3' });
    expect(once(changed.state, 'v3').attempted).toBe(false);
    expect(once(changed.state, 'v4', false).state.items).toEqual({});
  });

  test('a transient hold is reconsidered on the backoff schedule (1 h, 6 h, 24 h, then daily) for 7 days; a backoff skip leaves the count', () => {
    const c = clock();
    let state = emptyItemHolds();
    for (let i = 0; i < 3; i++) state = run(state, c.now, ['a'], new Set(['a'])).state;
    const heldAt = Date.parse(state.items.a.held_at!);
    expect(Date.parse(state.items.a.next_attempt_at!) - heldAt).toBe(HOLD_BACKOFF_MS[0]);
    const attempts = state.items.a.attempts;
    c.advance(HOLD_BACKOFF_MS[0] - 1);
    const early = run(state, c.now, ['a'], new Set(['a']));
    expect(early.skipped).toEqual(['a']);
    expect(early.state.items.a.attempts).toBe(attempts);
    const gaps: number[] = [];
    for (;;) {
      const due = state.items.a.next_attempt_at;
      if (!due) break;
      c.advance(Date.parse(due) - c.now());
      const before = c.now();
      state = run(state, c.now, ['a'], new Set(['a'])).state;
      if (state.items.a.next_attempt_at) gaps.push(Date.parse(state.items.a.next_attempt_at) - before);
    }
    expect(gaps.slice(0, 3)).toEqual([HOLD_BACKOFF_MS[1], HOLD_BACKOFF_MS[2], HOLD_DAILY_MS]);
    expect(c.now() - heldAt).toBeLessThanOrEqual(HOLD_TRANSIENT_WINDOW_MS);
    c.advance(30 * 24 * HOUR);
    expect(run(state, c.now, ['a'], new Set(['a'])).skipped).toEqual(['a']);
    // The service recovers on a retry-held request: the hold clears.
    expect(run(state, c.now, ['a'], new Set(), transientError, ['a']).state.items).toEqual({});
  });

  test('a content hold is not reconsidered automatically; retry-held re-attempts it', () => {
    const c = clock();
    let state = emptyItemHolds();
    for (let i = 0; i < 3; i++) state = run(state, c.now, ['a'], new Set(['a']), contentError).state;
    expect(state.items.a).toMatchObject({ state: 'held', class: 'content', next_attempt_at: null });
    c.advance(10 * 24 * HOUR);
    expect(run(state, c.now, ['a'], new Set(['a']), contentError).skipped).toEqual(['a']);
    const retried = run(state, c.now, ['a'], new Set(['a']), contentError, ['a']);
    expect(retried.skipped).toEqual([]);
    expect(retried.state.items.a.state).toBe('held');
  });

  test('sync --full resets holds by re-attempting every held item: success clears, a failure stays held', () => {
    const c = clock();
    let state = emptyItemHolds();
    for (let i = 0; i < 3; i++) state = run(state, c.now, ['a', 'b'], new Set(['a', 'b']), contentError).state;
    const full = new ItemHoldsRun(state, { now: c.now, full: true });
    expect(full.shouldAttempt('a') && full.shouldAttempt('b')).toBe(true);
    full.succeed('a');
    full.fail('b', contentError());
    const after = full.finish().state;
    expect(after.items.a).toBeUndefined();
    expect(after.items.b).toMatchObject({ state: 'held', attempts: 4 });
    // A --full run that never reached a held item keeps it held and visible.
    expect(new ItemHoldsRun(state, { now: c.now, full: true }).finish().state.items.a.state).toBe('held');
  });

  test(`the ${HOLD_CAP + 1}st hold is refused: the run reports exhausted and keeps the item counting`, () => {
    const c = clock();
    const items = Array.from({ length: HOLD_CAP + 1 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    let state = emptyItemHolds();
    // Spread the failures over enough successes that the breaker never trips.
    const filler = Array.from({ length: 1_000 }, (_, i) => `ok${i}`);
    for (let i = 0; i < 3; i++) {
      const r = run(state, c.now, [...filler, ...items], new Set(items));
      expect(r.outage).toBe(false);
      state = r.state;
      if (i === 2) expect(r.exhausted).toBe(true);
    }
    expect(heldItems(state)).toHaveLength(HOLD_CAP);
    expect(Object.values(state.items).filter(r => r.state === 'failing')).toHaveLength(1);
  });

  test('legacy gmail_fail_counts carry over: 3 or more becomes a legacy hold with unknown metadata', () => {
    const state = carryLegacyFailCounts(emptyItemHolds(), { t1: 3, t2: 1, t3: 7 }, id => `gmail:${id}`, '2026-09-01T00:00:00.000Z');
    expect(state.items['gmail:t1']).toMatchObject({ state: 'held', legacy: true, code: 'legacy_poison', meta: { sender: null, subject: null, upstream_at: null } });
    expect(state.items['gmail:t2']).toMatchObject({ state: 'failing', attempts: 1, legacy: true });
    expect(state.items['gmail:t3']).toMatchObject({ state: 'held', attempts: 3 });
  });
});
