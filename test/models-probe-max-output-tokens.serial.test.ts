/**
 * #3657(a) — `gbrain models doctor` must probe chat models with a
 * max-output-tokens value the provider will actually accept.
 *
 * Pre-fix, probeModel() sent `maxTokens: 1`. OpenAI rejects
 * max_output_tokens below 16 with a 400 ("Invalid 'max_output_tokens':
 * integer below minimum value. Expected a value >= 16, but got 1 instead."),
 * so the probe failed for EVERY OpenAI-family chat model whether or not it
 * was reachable — which is the whole job of the check. A dead model and a
 * healthy one both reported unreachable, and the surrounding sunset/upgrade
 * guidance keyed off that verdict.
 *
 * The floor is a property of the provider's API, not of gbrain, so the mock
 * enforces it exactly as OpenAI documents it: reject when the request's
 * max-output-tokens field is present and < 16, otherwise answer normally.
 * That makes this test fail against the old `maxTokens: 1` and pass against
 * the fix, without needing a real API key.
 *
 * Real spawned CLI against a tmpdir PGLite brain, with the openai provider
 * pointed at a local mock via OPENAI_BASE_URL — so the SDK emits its genuine
 * wire shape (`POST /v1/responses` with `max_output_tokens`) and no real key
 * or network is involved. Asserts the machine-readable `--json` report and
 * the process exit code, not source text.
 *
 * Serial: spawns subprocesses + binds a local port + writes tmpdirs.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIMS = 16;

/** OpenAI's documented minimum for max_output_tokens. */
const MIN_MAX_OUTPUT_TOKENS = 16;

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

describe('models doctor chat probe respects the provider max-output-tokens floor (#3657)', () => {
  test('chat + expansion probe as reachable against a provider that enforces the >= 16 floor', async () => {
    // Records what the probe actually asked for, so a failure message can say
    // WHY it failed rather than just that it did.
    const seenMaxTokens: Array<number | undefined> = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        // OpenAI's SDK uses the Responses API (`/responses`,
        // `max_output_tokens`); the chat-completions path is kept so the test
        // does not depend on which one the SDK version picks.
        if (url.pathname.endsWith('/responses') || url.pathname.endsWith('/chat/completions')) {
          const body = await req.json() as Record<string, unknown>;
          const raw = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
          const cap = typeof raw === 'number' ? raw : undefined;
          seenMaxTokens.push(cap);

          if (cap !== undefined && cap < MIN_MAX_OUTPUT_TOKENS) {
            // Verbatim shape of OpenAI's real rejection.
            return new Response(JSON.stringify({
              error: {
                message: `Invalid 'max_output_tokens': integer below minimum value. ` +
                  `Expected a value >= ${MIN_MAX_OUTPUT_TOKENS}, but got ${cap} instead.`,
                type: 'invalid_request_error',
                param: 'max_output_tokens',
                code: 'integer_below_min_value',
              },
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }

          if (url.pathname.endsWith('/responses')) {
            return new Response(JSON.stringify({
              id: 'resp_mock', object: 'response', created_at: 1, model: 'gpt-4o-mini',
              status: 'completed', error: null, incomplete_details: null,
              output: [{
                type: 'message', id: 'msg_mock', status: 'completed', role: 'assistant',
                content: [{ type: 'output_text', text: 'ok', annotations: [] }],
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }

          return new Response(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (url.pathname.endsWith('/embeddings')) {
          const body = await req.json() as { input: string | string[] };
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          const vec = Array.from({ length: DIMS }, () => 0.1);
          return new Response(JSON.stringify({
            data: inputs.map((_, i) => ({ object: 'embedding', index: i, embedding: vec })),
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        // /v1/models probe shape.
        return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const home = mkdtempSync(join(tmpdir(), 'gbrain-3657-probe-'));
    try {
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(
        join(home, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'pglite',
          database_path: join(home, '.gbrain', 'brain.pglite'),
          embedding_model: 'llama-server:test-model',
          embedding_dimensions: DIMS,
        }) + '\n',
      );

      const base = `http://127.0.0.1:${server.port}`;
      const env = {
        HOME: home,
        GBRAIN_HOME: home,
        LLAMA_SERVER_BASE_URL: `${base}/v1`,
        // The bug is in the OpenAI chat probe, so the test drives the real
        // openai provider and lets its SDK emit its genuine wire shape
        // (Responses API, `max_output_tokens`). OPENAI_BASE_URL pins every
        // request to 127.0.0.1, so the key below is never sent anywhere real
        // and the test needs no network.
        OPENAI_API_KEY: 'sk-test-not-a-real-key',
        OPENAI_BASE_URL: `${base}/v1`,
      };

      const init = await runCli(['init', '--migrate-only'], env, 120_000);
      expect(init.exitCode).toBe(0);

      // Route chat + expansion at the mocked openai provider. `models.default`
      // lives in the DB config plane, so it has to be set through the CLI
      // rather than written into config.json (the file plane does not merge
      // this key).
      const route = await runCli(
        ['config', 'set', 'models.default', 'openai:gpt-4o-mini'],
        env,
        60_000,
      );
      expect(route.exitCode).toBe(0);

      // --skip the reranker + embedding providers: this test makes a claim
      // about the CHAT probe, and unrelated providers would contribute
      // failures the assertions below say nothing about. What remains is the
      // two zero-network config probes plus chat and expansion, so the exit
      // code is a clean function of the thing under test.
      const doctor = await runCli(
        ['models', 'doctor', '--json', '--skip=zeroentropyai', '--skip=llama-server'],
        env,
        120_000,
      );

      if (doctor.exitCode !== 0) {
        console.error('--- models doctor stdout ---\n' + doctor.stdout);
        console.error('--- models doctor stderr ---\n' + doctor.stderr);
        console.error('--- max-output-tokens seen by the mock: ' +
          JSON.stringify(seenMaxTokens) + ' ---');
      }

      const report = JSON.parse(doctor.stdout) as {
        probes: Array<{ touchpoint: string; status: string; message: string }>;
        summary: { ok: number; total: number; failed: number };
      };

      // THE #3657(a) PIN: the chat probe must come back reachable. With
      // `maxTokens: 1` the mock returns OpenAI's real 400 and this is
      // 'error' with the below-minimum message.
      const chat = report.probes.find(p => p.touchpoint === 'chat');
      expect(chat).toBeDefined();
      expect(chat!.status).toBe('ok');

      const expansion = report.probes.find(p => p.touchpoint === 'expansion');
      expect(expansion).toBeDefined();
      expect(expansion!.status).toBe('ok');

      expect(report.summary.failed).toBe(0);
      expect(doctor.exitCode).toBe(0);

      // The probe must have actually exercised the wire (otherwise a change
      // that stopped sending the request at all would pass the above).
      expect(seenMaxTokens.length).toBeGreaterThan(0);
      for (const cap of seenMaxTokens) {
        expect(cap === undefined || cap >= MIN_MAX_OUTPUT_TOKENS).toBe(true);
      }
    } finally {
      server.stop(true);
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 480_000);
});
