// Executed only in an owned subprocess by build-pglite-snapshot.test.ts.
// Kill the process after the real tar rename to exercise interrupted publication.
import { mock } from 'bun:test';
import * as fs from 'node:fs';

const realFs = { ...fs };
mock.module('node:fs', () => ({ ...realFs, renameSync(...args: Parameters<typeof fs.renameSync>) {
  realFs.renameSync(...args);
  if (args[1] === process.argv[3]) process.kill(process.pid, 'SIGKILL');
}}));

const { buildPgliteSnapshot } = await import('../../scripts/build-pglite-snapshot.ts');
await buildPgliteSnapshot('default', {
  fixtureDir: process.argv[2],
  log: () => {},
  buildData: async () => new TextEncoder().encode('complete new tar'),
});
