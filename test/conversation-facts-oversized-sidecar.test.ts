/**
 * Large pages T2 (conversation facts part): the conversation body cap applies
 * to what the parser reads. A `raw_transcript` sidecar over it is refused from
 * its size before any read, counted as a size skip, and leaves a durable
 * receipt that doctor's extraction_input_truncated reports; a later run under
 * the cap clears the receipt.
 *
 * 1. Protects: a huge sidecar never reaches readFileSync or the parser, and
 *    the skip is visible after the run (not only one stderr line).
 * 2. Regression that fails it: the sidecar read with no size check (the pre-fix
 *    cap only measured compiled_truth + timeline), or no receipt.
 * 3. Existing sidecar tests use small files; nothing exercises the cap.
 * 4. No new seam: a sparse file makes the oversized sidecar without
 *    allocating it, and spyOn watches the real fs call.
 *
 * PGLite, plus Postgres when DATABASE_URL is set. Stub model ($0).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { MAX_PAGE_BODY_BYTES, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { extractionInputTruncatedEntry } from '../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/oversized-sidecar-example';
const SIDECAR = 'meetings/oversized-sidecar-example.raw/transcript.txt';

async function receipt(engine: BrainEngine): Promise<Record<string, unknown> | null> {
  const [row] = await engine.executeRaw<{ input_truncated: Record<string, unknown> | string | null }>(
    `SELECT s.input_truncated FROM page_extraction_state s JOIN pages p ON p.id=s.page_id
      WHERE p.slug=$1 AND s.pipeline='conversation_facts'`, [SLUG]);
  const value = row?.input_truncated ?? null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

describe('conversation facts: an oversized raw_transcript sidecar is skipped unread with a durable receipt', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  const repoDir = fs.mkdtempSync(join(tmpdir(), 'gbrain-oversized-sidecar-'));
  let chatCalls = 0;

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      chatCalls++;
      return { text: '{"facts":[]}', blocks: [{ type: 'text', text: '{"facts":[]}' }], stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
    });
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    resetGateway();
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test('the cap is derived from the page ceiling and never sits below it', () => {
    expect(MAX_PAGE_BODY_BYTES).toBeGreaterThanOrEqual(PAGE_MAX_BYTES);
    expect(MAX_PAGE_BODY_BYTES).toBe(25 * 1024 * 1024);
  });

  test('over the cap: no read, no model call, a size skip and a doctor warning; under it: the receipt clears', async () => {
    const sidecar = join(repoDir, SIDECAR);
    fs.mkdirSync(join(sidecar, '..'), { recursive: true });
    for (const { backend, engine } of engines) {
      await engine.setConfig('facts.extraction_enabled', 'true');
      await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
      await engine.setConfig('sync.repo_path', repoDir);
      await engine.putPage(SLUG, { type: 'meeting', title: 'Oversized sidecar', timeline: '',
        compiled_truth: '## Summary\n- A short polished note; the transcript lives in the sidecar.',
        frontmatter: { date: '2026-06-01', raw_transcript: SIDECAR } });
      // Sparse: one byte over the cap on disk, no memory allocated.
      fs.writeFileSync(sidecar, '');
      fs.truncateSync(sidecar, MAX_PAGE_BODY_BYTES + 1);

      const reads = spyOn(fs, 'readFileSync');
      chatCalls = 0;
      let skipped;
      try {
        skipped = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, types: ['meeting'], sleepMs: 0 });
        expect(reads.mock.calls.filter(([path]) => String(path).endsWith('transcript.txt')), backend).toEqual([]);
      } finally {
        reads.mockRestore();
      }
      expect(skipped, backend).toMatchObject({ pages_skipped_too_large: 1, pages_processed: 0, pages_marked_non_extractable: 0 });
      expect(chatCalls, backend).toBe(0);
      expect(await receipt(engine), backend).toMatchObject({ kind: 'skipped_too_large', pipeline: 'conversation_facts', origin: 'sidecar',
        processed_chars: 0, total_bytes: MAX_PAGE_BODY_BYTES + 1, cap_bytes: MAX_PAGE_BODY_BYTES });

      const checks = await extractionInputTruncatedEntry.run({ engine } as unknown as DoctorContext) as Check[];
      const check = checks.find(c => c.name === 'extraction_input_truncated')!;
      expect(check.status, backend).toBe('warn');
      expect(check.message, backend).toContain(`default:${SLUG}`);
      expect(check.message, backend).toContain('conversation_facts/skipped_too_large');

      fs.writeFileSync(sidecar, ['Speaker A: We shipped the parser fix.', 'Speaker B: Good, rerun extraction.',
        'Speaker A: The fallback flag is on.', 'Speaker B: Perfect.'].join('\n'));
      const processed = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: SLUG, types: ['meeting'], sleepMs: 0 });
      expect(processed.pages_skipped_too_large, backend).toBe(0);
      expect(await receipt(engine), backend).toBeNull();
    }
  }, 120_000);
});
