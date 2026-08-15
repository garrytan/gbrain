/**
 * W0 ship-review coverage — anyAbortSignal behavioral tests (the combined
 * external-caller + lock-steal signal). Previously pinned only by a
 * source-string contract assertion.
 */

import { test, expect } from 'bun:test';
import { anyAbortSignal } from '../src/core/cycle.ts';

test('pre-aborted input aborts the combined signal immediately with the same reason', () => {
  const c = new AbortController();
  const why = new Error('already done');
  c.abort(why);
  const combined = anyAbortSignal([c.signal, new AbortController().signal]);
  try {
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(why);
  } finally {
    combined.dispose();
  }
});

test('a real signal aborting later propagates reason to the combined signal', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = anyAbortSignal([a.signal, b.signal]);
  try {
    expect(combined.signal.aborted).toBe(false);
    const why = new Error('steal');
    b.abort(why);
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe(why);
  } finally {
    combined.dispose();
  }
});

test('duck-typed stub (no addEventListener) is observed via the 50ms poll', async () => {
  const stub = { aborted: false } as unknown as AbortSignal;
  const real = new AbortController();
  const combined = anyAbortSignal([stub, real.signal]);
  try {
    expect(combined.signal.aborted).toBe(false);
    (stub as { aborted: boolean }).aborted = true;
    const deadline = Date.now() + 2_000;
    while (!combined.signal.aborted && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(combined.signal.aborted).toBe(true);
  } finally {
    combined.dispose();
  }
});

test('dispose() detaches the forward listener from the CALLER signal (the daemon leak class)', () => {
  const daemonSignal = new AbortController();
  // Simulate many cycle ticks against one daemon-lifetime signal.
  for (let i = 0; i < 50; i++) {
    const combined = anyAbortSignal([daemonSignal.signal, new AbortController().signal]);
    combined.dispose();
  }
  // After dispose, aborting the daemon signal must not touch the (disposed)
  // combined controllers — and no listener buildup means no
  // MaxListenersExceededWarning. Behavioral proxy: a fresh combine still
  // works and the abort propagates exactly once.
  const last = anyAbortSignal([daemonSignal.signal]);
  try {
    daemonSignal.abort(new Error('shutdown'));
    expect(last.signal.aborted).toBe(true);
  } finally {
    last.dispose();
  }
});

test('dispose() clears the stub poll interval (no immortal timers)', async () => {
  const stub = { aborted: false } as unknown as AbortSignal;
  const combined = anyAbortSignal([stub]);
  combined.dispose();
  // Flip after dispose: the poll must be dead — combined never aborts.
  (stub as { aborted: boolean }).aborted = true;
  await new Promise(r => setTimeout(r, 150));
  expect(combined.signal.aborted).toBe(false);
});
