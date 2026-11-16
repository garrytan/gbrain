/**
 * GBRA-437 PR 1: a remote think runs the brain host's think model.
 *
 * 1. Protects: a remote caller's `model` runs only when it is the host's own think model or the host lists it in
 *    think.remote_models; anything else (including a listed model the host cannot run) answers on the host think
 *    model with a model_override_ignored notice, never an error. Remote `rounds` runs one round. The local
 *    operation keeps #1698: an explicit model runs as named and an unusable one throws. A keyless brain answers
 *    remote think the same way with or without `model`.
 * 2. Fails when: a remote caller picks an unlisted (pricier) model on the host's key, a remote model choice errors,
 *    the notice is missing or fires on a keyless brain, or the local path loses its explicit-model behavior.
 * 3. Existing coverage: test/think-pipeline.test.ts pins runThink's #1698 explicit-model error.
 * 4. Real seams: MCP dispatch with remote=true on a repo-less brain, the real gateway with a stub chat transport.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const HOST = 'openai:gpt-6.1-sol';
const OTHER = 'openai:gpt-5.5';
const NO_KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_MODEL: undefined };

for (const kind of testBackends()) {
  describe('remote think runs the host think model (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const called: string[] = [];

    async function remoteThink(params: Record<string, unknown>) {
      const out = await dispatchToolCall(engine, 'think', { question: 'who founded acme-example', ...params }, { remote: true, transport: 'http', sourceId: 'default', sessionId: randomUUID() });
      const body = JSON.parse(out.content[0]!.text);
      const notices = ((out._meta as { gbrain_notices?: Array<{ code: string; why: string }> } | undefined)?.gbrain_notices ?? []);
      return { isError: out.isError === true, body, notices, codes: notices.map(n => n.code), first: out.content[0]!.text };
    }

    function keyed() {
      configureGateway({ chat_model: HOST, env: { OPENAI_API_KEY: 'fake-openai' } });
      __setGenerateTextTransportForTests((async (args: { model: { modelId: string } }) => {
        called.push(args.model.modelId);
        return { content: [{ type: 'text', text: JSON.stringify({ answer: 'answered by ' + args.model.modelId, citations: [], gaps: [] }) }], finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
      }) as never);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.setConfig('models.think', HOST);
    }, 120_000);

    afterEach(async () => {
      __setGenerateTextTransportForTests(null);
      resetGateway();
      called.length = 0;
      await engine.unsetConfig('think.remote_models');
    });

    afterAll(async () => { await close?.(); });

    test('an unlisted remote model answers on the host model with a notice, not an error', async () => {
      keyed();
      const r = await remoteThink({ model: OTHER });
      expect(r.isError).toBe(false);
      expect(called).toEqual(['gpt-6.1-sol']);
      expect(r.body.modelUsed).toBe(HOST);
      expect(r.body.warnings).toContain('MODEL_OVERRIDE_IGNORED:not_allowed');
      expect(r.codes).toContain('model_override_ignored');
    });

    test('a model the host lists in think.remote_models runs, with no notice', async () => {
      keyed();
      await engine.setConfig('think.remote_models', 'anthropic:claude-opus-5-5, ' + OTHER);
      const r = await remoteThink({ model: OTHER });
      expect(r.isError).toBe(false);
      expect(called).toEqual(['gpt-5.5']);
      expect(r.body.modelUsed).toBe(OTHER);
      expect(r.codes).not.toContain('model_override_ignored');
    });

    test('a listed model the host cannot run answers on the host model with a notice, not an error', async () => {
      keyed();
      await engine.setConfig('think.remote_models', 'voyage:voyage-3');
      const r = await remoteThink({ model: 'voyage:voyage-3' });
      expect(r.isError).toBe(false);
      expect(called).toEqual(['gpt-6.1-sol']);
      expect(r.body.warnings).toContain('MODEL_OVERRIDE_IGNORED:unusable');
      expect(r.notices.find(n => n.code === 'model_override_ignored')?.why).toContain('cannot run');
      expect(r.notices.find(n => n.code === 'model_override_ignored')?.why).not.toContain('answered');
    });

    test('a listed model whose provider key the host lacks answers on the host model, not with a key error', async () => {
      keyed();
      await engine.setConfig('think.remote_models', 'deepseek:deepseek-chat');
      const r = await remoteThink({ model: 'deepseek:deepseek-chat' });
      expect(r.isError).toBe(false);
      expect(called).toEqual(['gpt-6.1-sol']);
      expect(r.body.synthesis_status).toBe('ok');
      expect(r.body.warnings).toContain('MODEL_OVERRIDE_IGNORED:unusable');
    });

    test('a model param naming the host think model runs it with no notice', async () => {
      keyed();
      const r = await remoteThink({ model: HOST });
      expect(r.isError).toBe(false);
      expect(called).toEqual(['gpt-6.1-sol']);
      expect(r.codes).not.toContain('model_override_ignored');
      expect(r.body.warnings.some((w: string) => w.startsWith('MODEL_OVERRIDE_IGNORED'))).toBe(false);
    });

    test('remote rounds runs one round', async () => {
      keyed();
      const r = await remoteThink({ rounds: 5 });
      expect(r.body.rounds).toBe(1);
    });

    test('the local operation keeps #1698: an explicit model runs as named and an unusable one throws', async () => {
      keyed();
      const ctx = { engine, remote: false, sourceId: 'default', config: {} } as never;
      const ran = await operationsByName.think.handler(ctx, { question: 'who founded acme-example', model: OTHER }) as { modelUsed: string; warnings: string[] };
      expect(ran.modelUsed).toBe(OTHER);
      expect(ran.warnings.some(w => w.startsWith('MODEL_OVERRIDE_IGNORED'))).toBe(false);
      await expect(operationsByName.think.handler(ctx, { question: 'who founded acme-example', model: 'bogusprovider:foo' })).rejects.toThrow(/not usable|unknown_provider/);
    });

    test('a keyless brain gives the same no_llm answer with or without model', async () => {
      await engine.unsetConfig('models.think');
      await withEnv(NO_KEYS, async () => {
        configureGateway({ env: {} });
        const without = await remoteThink({});
        const withModel = await remoteThink({ model: OTHER });
        expect(without.body.synthesis_status).toBe('no_llm');
        expect(withModel.isError).toBe(false);
        expect(withModel.first).toBe(without.first);
        expect(withModel.codes).toEqual(without.codes);
        expect(withModel.codes).not.toContain('model_override_ignored');
      });
      await engine.setConfig('models.think', HOST);
    });
  });
}
