/**
 * #7058: an extract receipt must not store the parser-reserved `type` key
 * inside its frontmatter. Every extraction run writes a receipt, so a reserved
 * key there makes doctor's `stale_frontmatter_keys` grow each run, and the
 * `gbrain repair frontmatter-keys` sweep can never keep it at zero. The page's
 * `type` column (protection 1 of the anti-loop pair) still reads
 * `extract_receipt`, and `dream_generated: true` (protection 2) stays.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { writeReceipt } from '../src/core/extract/receipt-writer.ts';
import { staleFrontmatterKeysCheck } from '../src/commands/doctor/checks/frontmatter-keys.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

test('#7058: a fresh receipt keeps stale_frontmatter_keys ok and its page type is extract_receipt', async () => {
  const { slug } = await writeReceipt(engine, { kind: 'atoms', source_id: 'default', run_id: 'run-abcdef1234', round: 'single',
    extracted_at: '2026-10-15T00:00:00.000Z', total_rows: 2, cost_usd: 0 });
  const check = await staleFrontmatterKeysCheck(engine);
  expect(check.status).toBe('ok');
  const [row] = await engine.executeRaw<{ type: string; dream_generated: string | null; fm_type: string | null }>(
    `SELECT type, frontmatter->>'dream_generated' AS dream_generated, frontmatter->>'type' AS fm_type FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
  expect(row).toEqual({ type: 'extract_receipt', dream_generated: 'true', fm_type: null });
});
