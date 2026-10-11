/**
 * #5061: the admin Dashboard's 30 s stats/health poll pauses while the tab is
 * hidden. The helper takes its document and timers as parameters, so this
 * drives it with a fake document and a deterministic fake clock (no DOM, no
 * real timers) and reads Dashboard.tsx to pin that the page actually uses it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { startVisibilityPoll, type PollDocument, type PollTimers } from '../admin/src/lib/visibility-poll.ts';

class FakeClock implements PollTimers {
  now = 0;
  private next = 1;
  readonly intervals = new Map<number, { handler: () => void; ms: number; due: number }>();
  setInterval(handler: () => void, ms: number): unknown {
    const id = this.next++;
    this.intervals.set(id, { handler, ms, due: this.now + ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const soonest = [...this.intervals.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!soonest || soonest[1].due > end) break;
      this.now = soonest[1].due;
      soonest[1].due += soonest[1].ms;
      soonest[1].handler();
    }
    this.now = end;
  }
}

class FakeDocument implements PollDocument {
  hidden = false;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void { this.listeners.delete(listener); }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

describe('startVisibilityPoll (#5061)', () => {
  test('ticks every interval while visible, stops while hidden, and refreshes once on return', () => {
    const clock = new FakeClock();
    const doc = new FakeDocument();
    let ticks = 0;
    const stop = startVisibilityPoll(() => { ticks++; }, 30_000, doc, clock);

    clock.advance(90_000);
    expect(ticks).toBe(3);

    doc.setHidden(true);
    expect(clock.intervals.size).toBe(0);
    clock.advance(10 * 60_000);
    expect(ticks).toBe(3);

    doc.setHidden(false);
    expect(ticks).toBe(4);
    clock.advance(30_000);
    expect(ticks).toBe(5);

    stop();
    expect(clock.intervals.size).toBe(0);
    expect(doc.listeners.size).toBe(0);
    clock.advance(60_000);
    doc.setHidden(false);
    expect(ticks).toBe(5);
  });

  test('a poll started on a hidden tab does nothing until the tab is shown', () => {
    const clock = new FakeClock();
    const doc = new FakeDocument();
    doc.hidden = true;
    let ticks = 0;
    const stop = startVisibilityPoll(() => { ticks++; }, 30_000, doc, clock);
    clock.advance(120_000);
    expect(ticks).toBe(0);
    expect(clock.intervals.size).toBe(0);
    doc.setHidden(false);
    expect(ticks).toBe(1);
    expect(clock.intervals.size).toBe(1);
    stop();
  });

  test('repeated visibilitychange events never stack intervals', () => {
    const clock = new FakeClock();
    const doc = new FakeDocument();
    let ticks = 0;
    const stop = startVisibilityPoll(() => { ticks++; }, 30_000, doc, clock);
    doc.setHidden(false);
    doc.setHidden(false);
    expect(clock.intervals.size).toBe(1);
    clock.advance(30_000);
    expect(ticks).toBe(3);
    stop();
  });

  test('Dashboard.tsx polls through the helper with the real document, not a bare setInterval', () => {
    // test-reads-source-ok[structural]: the Dashboard component cannot mount hermetically here; the helper's behavior is tested above and this pins that the bare setInterval does not creep back (#5061).
    const src = readFileSync('admin/src/pages/Dashboard.tsx', 'utf8');
    expect(src).toMatch(/startVisibilityPoll\(\s*refresh\s*,\s*30000\s*,\s*document\s*\)/);
    expect(src).not.toMatch(/setInterval\(/);
  });
});
