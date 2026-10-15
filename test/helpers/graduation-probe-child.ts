// Isolated subprocess fixture: module mocks never enter the parent test runner.
import { mock } from 'bun:test';
const actual = await import('../../src/core/pglite-lock.ts');
const missing = process.argv[2];
if (missing !== 'boot' && missing !== 'namespace') throw new Error('Unknown probe fixture');
mock.module('../../src/core/pglite-lock.ts', () => ({ ...actual,
  readBootId: () => missing === 'boot' ? null : 'recorded-boot',
  readPidNs: () => missing === 'namespace' ? null : 'recorded-namespace',
}));
const { markerLiveness } = await import('../../src/core/persistence/graduation-custody.ts');
const result = markerLiveness({ pid: process.ppid, runId: 'example-run', bootId: 'recorded-boot', pidNs: 'recorded-namespace' } as Parameters<typeof markerLiveness>[0]);
if (result !== 'unknown') throw new Error('Expected unknown, got ' + result);
