/**
 * The entity-lookup warning names only the failure class, never the error's text.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: when an entity lookup read fails (the card, the name-variant probe, the possible-duplicates read), the
 *     one-per-process warning on stderr says the lookup failed and the class (`timeout` or `provider_error`) and nothing
 *     else. A database driver's message can carry a connection string or password. The degraded marker the caller
 *     gets is unchanged.
 *  2. Regression: `${err.message}` interpolated into that warning in src/core/verbs/entity-variants.ts
 *     (`lookupReadFailed`).
 *  3. Existing coverage misses it: entity-card-loops and entity-name-variants read the degraded marker and the
 *     results; nothing reads what the warning prints.
 *  4. Seam: `lookupReadFailed` called directly with an error whose message holds a URL query value (VALUECANARY) and
 *     whose code is SQLSTATE 57P01. The canary has no `user:password@` part so the secrets scan stays clean.
 *     console.warn and console.error captured and restored in finally.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lookupReadFailed } from '../src/core/verbs/entity-variants.ts';
import type { DegradedStageEntry } from '../src/core/types.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';

const CANARY = 'VALUECANARY';
const driverError = () => Object.assign(new Error(`connection terminated postgresql://db.example/brain?app=${CANARY}`), { code: '57P01' });
const timeoutError = () => Object.assign(new Error(`canceling statement due to statement timeout postgresql://db.example/brain?app=${CANARY}`), { code: '57014' });

describe('entity lookup warning prints the failure class only', () => {
  const origWarn = console.warn;
  const origError = console.error;
  let printed: string[] = [];

  beforeEach(() => {
    _resetWarnOnceForTests();
    printed = [];
    console.warn = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  });
  afterEach(() => {
    console.warn = origWarn;
    console.error = origError;
    _resetWarnOnceForTests();
  });

  const expectClassOnly = (cls: string) => {
    const line = printed.find(l => l.includes('entity lookup read failed'));
    expect(line).toBeDefined();
    expect(line).toContain(cls);
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain('://');
    expect(line).not.toContain('57P01');
    expect(line).not.toContain('57014');
    expect(printed.join('\n')).not.toContain(CANARY);
  };

  test('a driver failure names provider_error, not the message or code, and the degraded marker is unchanged', () => {
    const degraded: DegradedStageEntry[] = [];
    lookupReadFailed(driverError(), degraded);
    expectClassOnly('provider_error');
    expect(degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'provider_error' }]);
  });

  test('a statement timeout names timeout, not the message or SQLSTATE, and the degraded marker is unchanged', () => {
    const degraded: DegradedStageEntry[] = [];
    lookupReadFailed(timeoutError(), degraded);
    expectClassOnly('timeout');
    expect(degraded).toEqual([{ stage: 'entity_lookup_failed', reason: 'timeout' }]);
  });

  test('a non-Error throw prints no text of its own either', () => {
    const degraded: DegradedStageEntry[] = [];
    lookupReadFailed(`postgresql://db.example/brain?app=${CANARY}`, degraded);
    expectClassOnly('provider_error');
  });

  test('a caller that reports nothing prints nothing', () => {
    lookupReadFailed(driverError(), undefined);
    expect(printed).toEqual([]);
  });
});
