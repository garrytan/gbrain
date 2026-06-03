/**
 * v0.42.20.0 (#1762) — background-work registry unit tests.
 *
 * Pure, no DB / no engine: drives the registry via the __registerDrainerForTest
 * seam. Pins the contracts the reliability wave depends on:
 *   - drains in explicit (order, name) order — facts (0) first
 *   - a drainer reporting unfinished>0 has its abort() AWAITED
 *   - a throwing drainer doesn't block the others
 *   - empty registry is a fast no-op
 *   - Map idempotency: re-registering the same name REPLACES (no duplicate)
 *   - the unregister handle removes it
 */
import { describe, test, expect } from 'bun:test';
import {
  drainAllBackgroundWorkForCliExit,
  __registerDrainerForTest,
  __listDrainerNamesForTest,
  type BackgroundWorkDrainer,
} from '../../src/core/background-work.ts';

function makeRecorder() {
  const calls: string[] = [];
  return { calls };
}

describe('background-work registry', () => {
  test('drains in explicit (order, name) order; facts-order-0 first', async () => {
    const { calls } = makeRecorder();
    const mk = (name: string, order: number): [BackgroundWorkDrainer, () => void] => {
      const d: BackgroundWorkDrainer = {
        name,
        order,
        drain: async () => { calls.push(`drain:${name}`); return { unfinished: 0 }; },
      };
      return [d, __registerDrainerForTest(d)];
    };
    const [, u1] = mk('zzz', 2);
    const [, u0] = mk('facts', 0);
    const [, u15] = mk('mid', 1);
    try {
      await drainAllBackgroundWorkForCliExit({ timeoutMs: 50 });
      // Only assert ordering among the ones we registered (production sinks may
      // also be registered when their modules were imported).
      const ours = calls.filter((c) => ['drain:facts', 'drain:mid', 'drain:zzz'].includes(c));
      expect(ours).toEqual(['drain:facts', 'drain:mid', 'drain:zzz']);
    } finally {
      u0(); u15(); u1();
    }
  });

  test('abort() is AWAITED only when unfinished>0', async () => {
    const seq: string[] = [];
    const withUnfinished: BackgroundWorkDrainer = {
      name: 'test-straggler',
      order: 0,
      drain: async () => { seq.push('drain'); return { unfinished: 3 }; },
      abort: async () => {
        await new Promise((r) => setTimeout(r, 5));
        seq.push('abort-done');
      },
    };
    const noUnfinished: BackgroundWorkDrainer = {
      name: 'test-clean',
      order: 1,
      drain: async () => { seq.push('drain-clean'); return { unfinished: 0 }; },
      abort: async () => { seq.push('abort-clean-SHOULD-NOT-RUN'); },
    };
    const u1 = __registerDrainerForTest(withUnfinished);
    const u2 = __registerDrainerForTest(noUnfinished);
    try {
      await drainAllBackgroundWorkForCliExit({ timeoutMs: 50 });
      // straggler: drain then abort (awaited → abort-done present); clean: no abort.
      expect(seq).toContain('drain');
      expect(seq).toContain('abort-done');
      expect(seq).toContain('drain-clean');
      expect(seq).not.toContain('abort-clean-SHOULD-NOT-RUN');
      // abort-done comes after its own drain (awaited).
      expect(seq.indexOf('abort-done')).toBeGreaterThan(seq.indexOf('drain'));
    } finally {
      u1(); u2();
    }
  });

  test('a throwing drainer does not block the others', async () => {
    const seen: string[] = [];
    const boom: BackgroundWorkDrainer = {
      name: 'test-boom',
      order: 0,
      drain: async () => { throw new Error('drain blew up'); },
    };
    const ok: BackgroundWorkDrainer = {
      name: 'test-ok-after-boom',
      order: 1,
      drain: async () => { seen.push('ok'); return { unfinished: 0 }; },
    };
    const u1 = __registerDrainerForTest(boom);
    const u2 = __registerDrainerForTest(ok);
    try {
      // Must not reject despite the throwing drainer.
      await drainAllBackgroundWorkForCliExit({ timeoutMs: 50 });
      expect(seen).toContain('ok');
    } finally {
      u1(); u2();
    }
  });

  test('Map idempotency: re-registering the same name replaces, no duplicate', () => {
    const before = __listDrainerNamesForTest().filter((n) => n === 'test-dup').length;
    expect(before).toBe(0);
    const d1: BackgroundWorkDrainer = { name: 'test-dup', order: 0, drain: async () => ({ unfinished: 0 }) };
    const d2: BackgroundWorkDrainer = { name: 'test-dup', order: 9, drain: async () => ({ unfinished: 0 }) };
    const u1 = __registerDrainerForTest(d1);
    const u2 = __registerDrainerForTest(d2);
    try {
      const count = __listDrainerNamesForTest().filter((n) => n === 'test-dup').length;
      expect(count).toBe(1); // replaced, not duplicated
    } finally {
      u1(); u2();
    }
  });

  test('unregister handle removes the drainer', () => {
    const d: BackgroundWorkDrainer = { name: 'test-unreg', order: 0, drain: async () => ({ unfinished: 0 }) };
    const unreg = __registerDrainerForTest(d);
    expect(__listDrainerNamesForTest()).toContain('test-unreg');
    unreg();
    expect(__listDrainerNamesForTest()).not.toContain('test-unreg');
  });

  test('empty registry (no test drainers) resolves fast', async () => {
    // Production sinks may be registered, but they fast-path on empty pending
    // sets. This just asserts the call resolves without throwing.
    await drainAllBackgroundWorkForCliExit({ timeoutMs: 10 });
    expect(true).toBe(true);
  });
});
