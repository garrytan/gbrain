/**
 * GBRA-437 PR 1: the thin client's `gbrain think --model` shows why the brain host ignored the model.
 *
 * 1. Protects: a thin-client think whose model the remote brain does not allow prints the
 *    model_override_ignored notice (in --json, under `notices`), with the host model's answer.
 * 2. Fails when: the thin client drops the server's MODEL_OVERRIDE_IGNORED warning silently.
 * 3. Existing coverage: test/think-remote-model.test.ts pins the server side on both engines.
 * 4. Real seams: the real think op through MCP dispatch (remote=true) on PGLite stands in for the
 *    remote server; callRemoteTool and isThinClient are mocked so the CLI takes its thin-client branch.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const engine = new PGLiteEngine();

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({ ...realConfig, loadConfig: () => ({ engine: 'pglite' }), isThinClient: () => true }));
const realClient = await import('../src/core/mcp-client.ts');
mock.module('../src/core/mcp-client.ts', () => ({
  ...realClient,
  callRemoteTool: async (_cfg: unknown, tool: string, params: Record<string, unknown>) =>
    dispatchToolCall(engine, tool, Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)), { remote: true, transport: 'http', sourceId: 'default', sessionId: 'thin-client-server' }),
}));

const { runThinkCli } = await import('../src/commands/think.ts');

class ExitSentinel extends Error { constructor(readonly code: number) { super('exit ' + code); } }

async function runCli(args: string[]) {
  const out: string[] = [];
  const savedLog = console.log, savedError = console.error, savedExit = process.exit;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = () => {};
  (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => { throw new ExitSentinel(c ?? 0); }) as never;
  try { await runThinkCli(null as never, args); return { code: 0, out }; }
  catch (e) { if (e instanceof ExitSentinel) return { code: e.code, out }; throw e; }
  finally { console.log = savedLog; console.error = savedError; (process as unknown as { exit: typeof savedExit }).exit = savedExit; }
}

describe('thin-client think --model', () => {
  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('models.think', 'openai:gpt-6.1-sol');
    configureGateway({ chat_model: 'openai:gpt-6.1-sol', env: { OPENAI_API_KEY: 'fake-openai' } });
    __setGenerateTextTransportForTests((async (args: { model: { modelId: string } }) => ({
      content: [{ type: 'text', text: JSON.stringify({ answer: 'answered by ' + args.model.modelId, citations: [], gaps: [] }) }],
      finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 },
    })) as never);
  }, 120_000);
  afterAll(async () => { __setGenerateTextTransportForTests(null); resetGateway(); await engine.disconnect(); });

  test('a model the host does not allow answers on the host model and the CLI shows model_override_ignored', async () => {
    const r = await runCli(['who', 'founded', 'acme-example', '--model', 'openai:gpt-5.5', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out.join('\n'));
    expect(doc.modelUsed).toBe('openai:gpt-6.1-sol');
    expect(doc.warnings).toContain('MODEL_OVERRIDE_IGNORED:not_allowed');
    expect(JSON.stringify(doc.notices ?? [])).toContain('model_override_ignored');
  });

  test('without --model the CLI shows no model_override_ignored notice', async () => {
    const r = await runCli(['who', 'founded', 'acme-example', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.out.join('\n')).notices ?? [])).not.toContain('model_override_ignored');
  });
});
