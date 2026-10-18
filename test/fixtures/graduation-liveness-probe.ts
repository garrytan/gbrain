/**
 * Child-process fixture for test/graduation-custody-probes.test.ts (#6774). It makes one local process-identity
 * probe unavailable with mock.module, in this child only, so every other suite keeps the real probes, then prints
 * markerLiveness for the marker passed as JSON.
 * argv: <bootId|pidNs|none> <marker json>
 */
import { mock } from 'bun:test';
import { join } from 'node:path';
import * as probes from '../../src/core/pglite-lock.ts';

const [missing, markerJson] = process.argv.slice(2);
const real = { ...probes };
mock.module(join(import.meta.dir, '../../src/core/pglite-lock.ts'), () => ({
  ...real,
  readBootId: missing === 'bootId' ? () => null : real.readBootId,
  readPidNs: missing === 'pidNs' ? () => null : real.readPidNs,
}));
const { markerLiveness } = await import('../../src/core/persistence/graduation-custody.ts');
process.stdout.write(markerLiveness(JSON.parse(markerJson!)));
