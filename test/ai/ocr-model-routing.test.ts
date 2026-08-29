/**
 * #4107 — `embedding_image_ocr_model` routing.
 *
 * The config key was declared, env-merged, DB-merged, and allowlisted
 * (src/core/config.ts), but generateOcrText() unconditionally resolved the
 * EXPANSION model, so the configured OCR model never received a single
 * request. Pins:
 *   - getImageOcrModel() accessor: configured value wins; expansion fallback
 *     when unset; getExpansionModel() unaffected either way
 *   - wire routing: generateOcrText() posts body.model = the OCR model while
 *     expand() still posts the expansion model (the two route independently)
 *   - fail-closed: an OCR model on a provider without an expansion touchpoint
 *     yields '' with ZERO network calls (never silently OCRs with the
 *     expansion model)
 *   - key independence: OCR works when the OCR model's provider is keyed even
 *     if the expansion model's provider is not
 *
 * Hermetic: globalThis.fetch stubbed (gateway.test.ts Voyage-shim precedent),
 * restored in afterEach; provider env passes explicitly via configureGateway
 * (the provider-keys preload strips ambient keys). DeepSeek is used because
 * it is openai-compatible with an expansion touchpoint, so assertTouchpoint
 * passes and the wire body is a plain JSON chat completion; model ids are
 * the recipe's current (non-retired) v4 names.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  generateOcrText,
  expand,
  getExpansionModel,
} from '../../src/core/ai/gateway.ts';

// Looked up dynamically so this file still RUNS (and fails at the assertion
// level, not import time) against pre-#4107 builds missing the export.
async function callGetImageOcrModel(): Promise<string> {
  const mod = (await import('../../src/core/ai/gateway.ts')) as {
    getImageOcrModel?: () => string;
  };
  if (typeof mod.getImageOcrModel !== 'function') {
    throw new Error('getImageOcrModel is not exported from the gateway');
  }
  return mod.getImageOcrModel();
}

const EXPANSION_MODEL = 'deepseek:deepseek-v4-flash';
const OCR_MODEL = 'deepseek:deepseek-v4-pro';

const realFetch = globalThis.fetch;

beforeEach(() => resetGateway());
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

/** Stub the wire, capturing every JSON request body, answering `content`. */
function stubChatCompletions(
  captured: Array<Record<string, unknown>>,
  content: string,
): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    // The SDK downloads the data: image URL through fetch too — serve it with
    // the real fetch so `captured` holds only chat-completion POST bodies.
    if (urlStr.startsWith('data:')) return realFetch(url as never, init as never);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    captured.push(body);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: String(body.model ?? ''),
        choices: [
          { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('getImageOcrModel accessor (#4107)', () => {
  test('configured embedding_image_ocr_model wins; expansion model unchanged', async () => {
    configureGateway({
      expansion_model: EXPANSION_MODEL,
      embedding_image_ocr_model: OCR_MODEL,
      env: { DEEPSEEK_API_KEY: 'sk-test-ocr' },
    });
    expect(await callGetImageOcrModel()).toBe(OCR_MODEL);
    expect(getExpansionModel()).toBe(EXPANSION_MODEL);
  });

  test('falls back to the expansion model when unset', async () => {
    configureGateway({
      expansion_model: EXPANSION_MODEL,
      env: { DEEPSEEK_API_KEY: 'sk-test-ocr' },
    });
    expect(await callGetImageOcrModel()).toBe(EXPANSION_MODEL);
  });
});

describe('generateOcrText wire routing (#4107)', () => {
  test('OCR posts the OCR model; expand() still posts the expansion model', async () => {
    const captured: Array<Record<string, unknown>> = [];
    stubChatCompletions(captured, 'HELLO');
    configureGateway({
      expansion_model: EXPANSION_MODEL,
      embedding_image_ocr_model: OCR_MODEL,
      env: { DEEPSEEK_API_KEY: 'sk-test-ocr' },
    });

    const text = await generateOcrText(Buffer.from('x'), 'image/png');
    expect(text).toBe('HELLO');
    expect(captured.length).toBe(1);
    expect(captured[0].model).toBe('deepseek-v4-pro');

    // expand() is best-effort: a non-JSON answer degrades to [query], but the
    // request it sent still proves which model the expansion path resolved.
    await expand('probe query');
    expect(captured.length).toBe(2);
    expect(captured[1].model).toBe('deepseek-v4-flash');
  });

  test('fail-closed: OCR model on a provider without an expansion touchpoint yields "" and no wire call', async () => {
    const captured: Array<Record<string, unknown>> = [];
    stubChatCompletions(captured, 'HELLO');
    configureGateway({
      expansion_model: EXPANSION_MODEL,
      // voyage has no expansion touchpoint — isAvailable must gate on the
      // OCR model, never silently OCR with the expansion model instead.
      embedding_image_ocr_model: 'voyage:voyage-3-large',
      env: { DEEPSEEK_API_KEY: 'sk-test-ocr', VOYAGE_API_KEY: 'pa-test' },
    });

    const text = await generateOcrText(Buffer.from('x'), 'image/png');
    expect(text).toBe('');
    expect(captured.length).toBe(0);
  });

  test('key independence: OCR works when only the OCR model\'s provider is keyed', async () => {
    const captured: Array<Record<string, unknown>> = [];
    stubChatCompletions(captured, 'OCR TEXT');
    configureGateway({
      // Expansion pinned to an unkeyed provider: pre-#4107 the gate checked
      // THIS model's availability and silently disabled OCR.
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      embedding_image_ocr_model: OCR_MODEL,
      env: { DEEPSEEK_API_KEY: 'sk-test-ocr' },
    });

    const text = await generateOcrText(Buffer.from('x'), 'image/png');
    expect(text).toBe('OCR TEXT');
    expect(captured.length).toBe(1);
    expect(captured[0].model).toBe('deepseek-v4-pro');
  });
});
