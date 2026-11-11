/**
 * #8913: the Dashboard's Live Activity stream must survive a dropped
 * connection. EventSource reconnects on its own after an error (readyState
 * CONNECTING); closing it from onerror ends that retry for good, so the feed
 * froze on "connecting" until a reload. The page's real effect is run here
 * against a fake EventSource, fake timers and a minimal React stand-in.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = FakeEventSource.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() { FakeEventSource.last = this; }
  close(): void { this.closeCalls++; this.readyState = FakeEventSource.CLOSED; }
}

function mountDashboard() {
  const statuses: string[] = [];
  const timers: Array<() => void> = [];
  let unmount: (() => void) | undefined;
  const react = {
    createElement: () => null,
    Fragment: 'fragment',
    useRef: (current: unknown) => ({ current }),
    // The stream status is the page's only string-valued state.
    useState: (initial: unknown) => [initial, (next: unknown) => { if (typeof initial === 'string') statuses.push(next as string); }],
    useEffect: (effect: () => (() => void) | void) => { unmount = effect() ?? undefined; },
  };
  const modules: Record<string, unknown> = {
    react: { ...react, default: react },
    '../api': { api: { stats: async () => ({}), health: async () => ({}) } },
    '../lib/visibility-poll': { startVisibilityPoll: () => () => {} },
  };
  // test-reads-source-ok[structural]: the admin app has no component harness, so its real Dashboard effect is transpiled and run against fakes.
  const source = readFileSync('admin/src/pages/Dashboard.tsx', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { DashboardPage?: () => unknown } };
  runInNewContext(js, {
    module, exports: module.exports, require: (id: string) => modules[id],
    EventSource: FakeEventSource, document: {}, Date, JSON,
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
  });
  module.exports.DashboardPage!();
  const es = FakeEventSource.last!;
  const runTimers = () => { for (const fn of timers.splice(0)) fn(); };
  return { es, statuses, runTimers, unmount: () => unmount?.() };
}

describe('#8913 Dashboard live stream reconnects', () => {
  test('a transient error leaves the EventSource open to retry and shows connecting', () => {
    const { es, statuses, runTimers } = mountDashboard();
    es.readyState = FakeEventSource.OPEN;
    es.onopen!();
    expect(statuses.at(-1)).toBe('connected');
    es.readyState = FakeEventSource.CONNECTING;
    es.onerror!();
    runTimers();
    expect(es.closeCalls).toBe(0);
    expect(statuses.at(-1)).toBe('connecting');
    es.readyState = FakeEventSource.OPEN;
    es.onopen!();
    expect(statuses.at(-1)).toBe('connected');
  });

  test('a stream the browser gave up on shows disconnected; unmount closes it', () => {
    const { es, statuses, runTimers, unmount } = mountDashboard();
    es.readyState = FakeEventSource.CLOSED;
    es.onerror!();
    runTimers();
    expect(statuses.at(-1)).toBe('disconnected');
    unmount();
    expect(es.closeCalls).toBe(1);
  });
});
