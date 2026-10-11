import { describe, expect, test } from 'bun:test';
import { streamOllamaNativeChat, unwrapOllamaQwenResult } from '../../src/core/ai/ollama-native.ts';

describe('streamOllamaNativeChat thinking fallback', () => {
  test('assistant requests never promote reasoning-only output into an answer',async()=>{
    const server=Bun.serve({port:0,fetch:()=>new Response(JSON.stringify({message:{content:'',thinking:'内部思考'},done:true,done_reason:'stop'})+'\n',{headers:{'content-type':'application/x-ndjson'}})});
    try{const result=await streamOllamaNativeChat({baseURL:server.url.href,model:'qwen3.6:latest',messages:[{role:'user',content:'回答'}],maxTokens:128,allowReasoningFallback:false});expect(result.text).toBe('');}finally{server.stop(true);}
  });
  test('promotes thinking text when content is empty', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response([
          JSON.stringify({ message: { role: 'assistant', content: '', thinking: '{"answer":"' }, done: false }),
          JSON.stringify({
            message: { role: 'assistant', content: '', thinking: 'ok","citations":[],"gaps":[]}' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 2,
            eval_count: 4,
          }),
        ].join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
      },
    });

    try {
      const result = await streamOllamaNativeChat({
        baseURL: `${server.url.toString().replace(/\/$/, '')}/v1`,
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 128,
      });
      expect(result.text).toBe('{"answer":"ok","citations":[],"gaps":[]}');
    } finally {
      server.stop(true);
    }
  });

  test('keeps content when both content and thinking are present', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Response(JSON.stringify({
          message: { role: 'assistant', content: '{"answer":"visible"}', thinking: 'hidden' },
          done: true,
          done_reason: 'stop',
        }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
      },
    });

    try {
      const result = await streamOllamaNativeChat({
        baseURL: `${server.url.toString().replace(/\/$/, '')}/v1`,
        model: 'qwen3:4b',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 128,
      });
      expect(result.text).toBe('{"answer":"visible"}');
    } finally {
      server.stop(true);
    }
  });
});

describe('unwrapOllamaQwenResult', () => {
  test('unwraps a complete knowledge-synthesis envelope', () => {
    expect(unwrapOllamaQwenResult(
      '{"result":{"answer":"喵喵","citations":[],"gaps":[]}}',
      true,
    )).toBe('{"answer":"喵喵","citations":[],"gaps":[]}');
  });

  test('salvages a truncated envelope instead of throwing Unterminated string', () => {
    const truncated = '{"result":{"answer":"我家猫叫喵喵，是奶牛猫","citations":[{"page_slug":"wiki/pets';
    expect(() => JSON.parse(truncated)).toThrow(/Unterminated string/);
    const unwrapped = unwrapOllamaQwenResult(truncated, true);
    expect(JSON.parse(unwrapped)).toEqual({
      answer: '我家猫叫喵喵，是奶牛猫',
      citations: [],
      gaps: [],
    });
  });

  test('returns raw truncated text when no answer field can be salvaged', () => {
    const truncated = '{"result":{"citations":[{"page_slug":"wiki/pets';
    expect(unwrapOllamaQwenResult(truncated, true)).toBe(truncated);
  });

  test('complete envelopes stay byte-identical so hosted-style JSON is not rewritten twice', () => {
    const inner = '{"answer":"靓靓","citations":[{"page_slug":"wiki/a","row_num":null}],"gaps":["x"]}';
    expect(unwrapOllamaQwenResult(`{"result":${inner}}`, true)).toBe(inner);
  });
});
