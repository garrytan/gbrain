import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('dashboard lets EventSource retry and closes it only on cleanup', () => {
  const statuses: unknown[] = [];
  const timers: Array<() => void> = [];
  let cleanup!: () => void;
  let stream!: FakeSource;
  class FakeSource {
    static CLOSED = 2;
    readyState = 0;
    onopen?: () => void; onerror?: () => void; onmessage?: (e: { data: string }) => void;
    closed = false;
    constructor() { stream = this; }
    close() { this.closed = true; }
  }
  let stateIndex = 0;
  const react = {
    createElement: () => null,
    useState: (initial: unknown) => {
      const index = stateIndex++;
      return [initial, (value: unknown) => { if (index === 3) statuses.push(value); }];
    },
    useRef: () => ({ current: null }),
    useEffect: (effect: () => () => void) => { cleanup = effect(); },
  };
  const module = { exports: {} as { DashboardPage?: () => unknown } };
  // test-reads-source-ok[structural]: transpiles and runs the real DashboardPage effect against a fake EventSource; the admin package has no component test harness.
  const code = ts.transpileModule(readFileSync(new URL('../admin/src/pages/Dashboard.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => id === 'react' ? react : id === '../api'
      ? { api: { stats: async () => ({}), health: async () => ({}) } }
      : { startVisibilityPoll: () => () => {} },
    EventSource: FakeSource, document: {},
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
  });
  module.exports.DashboardPage!();
  stream.onopen!();
  stream.onerror!();
  timers.splice(0).forEach(callback => callback());
  expect(stream.closed).toBe(false);
  expect(statuses.at(-1)).toBe('connecting');
  stream.onopen!();
  expect(statuses.at(-1)).toBe('connected');
  stream.readyState = FakeSource.CLOSED;
  stream.onerror!();
  expect(statuses.at(-1)).toBe('disconnected');
  cleanup();
  expect(stream.closed).toBe(true);
});
