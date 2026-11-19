/** GST-3199 on PGLite: the requester-scope grace boundary inside one second. Cases: test/helpers/serves-since-same-second.ts. */
import { describe } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sameSecondTests } from './helpers/serves-since-same-second.ts';

describe('requester-scope grace within one second (PGLite)', () => {
  sameSecondTests(async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    return { engine, close: () => engine.disconnect() };
  });
});
