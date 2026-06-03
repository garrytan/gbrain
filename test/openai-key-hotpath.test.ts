import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const savedEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEY_FILE: process.env.OPENAI_API_KEY_FILE,
  GBRAIN_HOME: process.env.GBRAIN_HOME,
};

function restoreEnv(key: keyof typeof savedEnv) {
  const value = savedEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY_FILE;
  process.env.GBRAIN_HOME = 'relative-path-would-throw-if-loaded';
});

afterEach(() => {
  restoreEnv('OPENAI_API_KEY');
  restoreEnv('OPENAI_API_KEY_FILE');
  restoreEnv('GBRAIN_HOME');
});

async function makeContext(): Promise<{ ctx: OperationContext; engine: PGLiteEngine }> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const ctx: OperationContext = {
    engine,
    config: { engine: 'pglite' },
    logger: console,
    dryRun: false,
    remote: true,
  };
  return { ctx, engine };
}

describe('OpenAI API key hot-path config reuse', () => {
  test('query reuses ctx.config instead of loading config.json', async () => {
    const { ctx, engine } = await makeContext();
    try {
      await engine.putPage('people/alice-example', {
        type: 'person',
        title: 'Alice Example',
        compiled_truth: 'Alice Example is a test person.',
      });

      const out = await operationsByName.query.handler(ctx, { query: 'alice', limit: 5 });
      expect(Array.isArray(out)).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });

  test('put_page reuses ctx.config instead of loading config.json', async () => {
    const { ctx, engine } = await makeContext();
    try {
      const out = await operationsByName.put_page.handler(ctx, {
        slug: 'notes/hotpath-config-reuse',
        content: '# Hotpath Config Reuse\n\nThis write should skip embedding without loading config.json.',
      });

      expect(out).toMatchObject({ slug: 'notes/hotpath-config-reuse' });
    } finally {
      await engine.disconnect();
    }
  });
});
