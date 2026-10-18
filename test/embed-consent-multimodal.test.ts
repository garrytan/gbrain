/**
 * Fix wave 13 P1.18 [R4]: `embed --stale --images` spends with the multimodal
 * embedding model and, when OCR is on, the OCR model. Consent skipped the ask
 * whenever the TEXT provider was free, so a paid multimodal or OCR model ran
 * with a null Authorization and no cap.
 * Protects: free text provider + paid multimodal model → consent asks (exit-3
 * refusal without approval); free text provider + OCR on with a paid OCR model
 * → asks; free text provider with no paid image model → no ask, as before; a
 * text-only run is unchanged.
 * Seams: GBRAIN_EMBEDDING_IMAGE_OCR via withEnv; PGLite.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { requireEmbedBackfillConsent } from '../src/core/embed-consent.ts';
import { isConsentRefusal } from '../src/core/consent.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => resetGateway());

const consent = (images: boolean) => requireEmbedBackfillConsent(engine, {
  command: 'embed', argv: ['gbrain', 'embed', '--stale', ...(images ? ['--images'] : [])], args: [], scope: { unestimated: true, ...(images ? { images: true } : {}) },
}).then(auth => ({ asked: false, auth }), (e: unknown) => { if (isConsentRefusal(e)) return { asked: true, auth: null }; throw e; });

test('a paid multimodal model behind a free text provider asks for approval', () => withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: undefined }, async () => {
  configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: 768, embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { VOYAGE_API_KEY: 'test-key' } });
  expect((await consent(true)).asked).toBe(true);
  expect(await consent(false)).toEqual({ asked: false, auth: null });
}));

test('OCR on with a paid OCR model asks; OCR off with no paid image model does not', async () => {
  configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: 768, expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'sk-test-fake' } });
  await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => { expect((await consent(true)).asked).toBe(true); });
  await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: undefined }, async () => { expect(await consent(true)).toEqual({ asked: false, auth: null }); });
});
