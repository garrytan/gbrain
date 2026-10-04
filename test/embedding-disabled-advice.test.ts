/**
 * The keyless guard's advice comes from readiness's embeddingEnablement:
 * never the refused `gbrain config set embedding_model`, always the resolved
 * datastore path, and it asks the user (credentials + paid).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { assertEmbeddingEnabled, EmbeddingDisabledError } from '../src/core/embedding-dim-check.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';

const keyless = { engine: 'pglite' as const, embedding_disabled: true, database_path: '/tmp/gbrain-example/brain.pglite' };

function thrown(): EmbeddingDisabledError {
  try { assertEmbeddingEnabled(keyless as never); } catch (e) { return e as EmbeddingDisabledError; }
  throw new Error('expected EmbeddingDisabledError');
}

describe('assertEmbeddingEnabled advice', () => {
  test('an enabled brain passes', () => {
    expect(() => assertEmbeddingEnabled({ engine: 'pglite' } as never)).not.toThrow();
    expect(() => assertEmbeddingEnabled(null)).not.toThrow();
  });

  test('never recommends the refused config set embedding_model', async () => {
    await withEnv({ OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_HOME: '/tmp/gbrain-example-home' }, async () => {
      const e = thrown();
      expect(e.message).not.toContain('config set embedding_model');
      expect(e.message).toContain('gbrain init --force --embedding-model');
      expect(e.fix).toMatchObject({ consent: ['credentials', 'paid'], requires_exclusive: true });
      expect(e.fix?.argv).toContain('--path');
    });
  });

  test('normalises to embedding_disabled with the enablement fix; the agent asks first', async () => {
    await withEnv({ VOYAGE_API_KEY: 'test-key', GBRAIN_HOME: '/tmp/gbrain-example-home' }, async () => {
      const env = toAgentError(thrown(), { transport: 'cli', command: 'embed', render: cliRenderContext() });
      expect(env).toMatchObject({ error: 'embedding_disabled', code: 'embedding_disabled', reason: 'disabled_by_choice', fix: { next: 'ask_user' } });
      expect(env.fix?.command).toContain('gbrain init --force --embedding-model');
    });
  });
});
