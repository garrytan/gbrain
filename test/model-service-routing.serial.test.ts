import { expect, test } from 'bun:test';
import { chat, configureGateway, resetGateway } from '../src/core/ai/gateway';

test('separate model services send the same model ID to their own endpoint and key', async () => {
  const requests: Array<{ path: string; key: string; model: string }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as { model: string };
    requests.push({ path: new URL(request.url).pathname, key: request.headers.get('authorization') || '', model: body.model });
    return Response.json({ id: 'test', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  try {
    configureGateway({ generative_enabled: true, chat_model: 'service-one:same-model', env: { CUSTOM_OPENAI_API_KEY: 'must-not-be-used' }, base_urls: { 'service-one': `${server.url}one/v1`, 'service-two': `${server.url}two/v1` }, touchpoint_api_keys: { 'service-one': { chat: 'first-test-key' }, 'service-two': { chat: 'second-test-key' } } });
    expect((await chat({ model: 'service-one:same-model', messages: [{ role: 'user', content: 'test' }] })).text).toBe('ok');
    expect((await chat({ model: 'service-two:same-model', messages: [{ role: 'user', content: 'test' }] })).text).toBe('ok');
    expect(requests).toEqual([{ path: '/one/v1/chat/completions', key: 'Bearer first-test-key', model: 'same-model' }, { path: '/two/v1/chat/completions', key: 'Bearer second-test-key', model: 'same-model' }]);
  } finally { resetGateway(); server.stop(true); }
});
