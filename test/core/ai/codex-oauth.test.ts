import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCodexResponsesFetch } from '../../../src/core/ai/codex-oauth.ts';
import { openaiCodex } from '../../../src/core/ai/recipes/openai-codex.ts';

function jwtWithExp(exp: number): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp })}.sig`;
}

describe('openai-codex OAuth fetch wrapper', () => {
  test('advertises only GPT-5.6 models verified on the Codex backend', () => {
    expect(openaiCodex.touchpoints.chat?.models).toContain('gpt-5.6-sol');
    expect(openaiCodex.touchpoints.chat?.models).toContain('gpt-5.6-terra');
    expect(openaiCodex.touchpoints.chat?.models).not.toContain('gpt-5.6-luna');
    expect(openaiCodex.aliases?.['gpt-5.6']).toBe('gpt-5.6-sol');
  });

  test('streams Codex responses, hoists instructions, and returns SDK-parseable JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-oauth-'));
    try {
      mkdirSync(join(dir), { recursive: true });
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({
        credential_pool: {
          'openai-codex': [{
            source: 'manual:device_code',
            access_token: jwtWithExp(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: 'refresh-token',
          }],
        },
      }));

      const priorFetch = globalThis.fetch;
      let captured: any = null;
      let authHeader = '';
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        authHeader = headers.get('authorization') ?? '';
        captured = JSON.parse(String(init?.body));
        const sse = [
          'event: response.output_item.done',
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[],"logprobs":[]}]}}',
          '',
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","model":"gpt-5.5","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;

      try {
        const wrapped = createCodexResponsesFetch({ HERMES_HOME: dir });
        const response = await wrapped('https://chatgpt.com/backend-api/codex/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.5',
            input: [
              { role: 'developer', content: 'Reply exactly OK.' },
              { role: 'user', content: [{ type: 'input_text', text: 'Say OK' }] },
            ],
            max_output_tokens: 10,
          }),
        });
        const json = await response.json() as Record<string, any>;

        const body = captured as Record<string, any>;
        expect(authHeader.startsWith('Bearer ')).toBe(true);
        expect(body.stream).toBe(true);
        expect(body.store).toBe(false);
        expect(body.instructions).toBe('Reply exactly OK.');
        expect(body).not.toHaveProperty('max_output_tokens');
        expect((body.input as unknown[])).toHaveLength(1);
        expect(json.output?.[0]?.content?.[0]?.text).toBe('OK');
      } finally {
        globalThis.fetch = priorFetch;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
