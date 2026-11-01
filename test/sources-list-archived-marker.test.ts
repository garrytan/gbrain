// Protect the CLI archive marker across archive/restore. Existing archive tests
// cover idempotency, not list rendering. Reading the dropped entry flag breaks
// this test; no production seam or provider is needed.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { runSources } from '../src/commands/sources.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    await engine.connect({});
    await engine.initSchema();
  });
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
     ('source-a', 'Source A', '{"federated":true}'),
     ('source-b', 'Source B', '{"federated":false}')`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

test('sources list marks archived sources and preserves live federation labels', async () => {
  const logs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  const list = async () => {
    logs.length = 0;
    await runSources(engine, ['list']);
    return logs.join('\n');
  };
  try {
    const before = await list();
    expect(before).toMatch(/source-a\s+federated/);
    expect(before).toMatch(/source-b\s+isolated/);
    expect(before).not.toContain('⚠ archived');

    await runSources(engine, ['archive', 'source-a']);
    const archived = await list();
    expect(archived).toMatch(/source-a\s+⚠ archived/);
    expect(archived).toMatch(/source-b\s+isolated/);

    await runSources(engine, ['restore', 'source-a']);
    const restored = await list();
    expect(restored).toMatch(/source-a\s+federated/);
    expect(restored).not.toContain('⚠ archived');
  } finally {
    logSpy.mockRestore();
  }
});
