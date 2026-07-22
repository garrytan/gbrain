// v0.42 — Receipt-writer unit tests.
//
// Pins:
//   - D-EXTRACT-17 slug shape: extracts/{date}/{kind}/{source_id}/{run_id_short}/round-{N}.md
//   - D-EXTRACT-19 belt+suspenders: type:extract_receipt + dream_generated:true
//     are BOTH stamped in frontmatter regardless of caller input
//   - Stable run_id_short (8 chars) so resumed runs land under same dir
//   - Optional eval_pass / eval_score / model_id frontmatter only on
//     LLM-backed extractors that supplied them
//   - Body is human-readable + machine-readable frontmatter is the
//     load-bearing surface

import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  receiptSlug,
  shortRunId,
  dateFromIso,
  writeReceipt,
  type ExtractReceiptInput,
} from '../../src/core/extract/receipt-writer.ts';

const BASE_INPUT: ExtractReceiptInput = {
  kind: 'facts.conversation',
  source_id: 'default',
  run_id: 'a1b2c3d4e5f6789abcdef',
  round: 'full',
  extracted_at: '2026-05-27T14:30:00.000Z',
  total_rows: 47,
  cost_usd: 0.0042,
};

describe('receiptSlug — D-EXTRACT-17 shape', () => {
  test('emits canonical extracts/{date}/{kind}/{source_id}/{short}/round-{N}', () => {
    const slug = receiptSlug(BASE_INPUT);
    expect(slug).toBe('extracts/2026-05-27/facts.conversation/default/a1b2c3d4/round-full');
  });

  test('different round forms produce different slugs (trial / ramp_100 / single)', () => {
    expect(receiptSlug({ ...BASE_INPUT, round: 'trial' })).toBe(
      'extracts/2026-05-27/facts.conversation/default/a1b2c3d4/round-trial',
    );
    expect(receiptSlug({ ...BASE_INPUT, round: 'ramp_100' })).toBe(
      'extracts/2026-05-27/facts.conversation/default/a1b2c3d4/round-ramp_100',
    );
    expect(receiptSlug({ ...BASE_INPUT, round: 'single' })).toBe(
      'extracts/2026-05-27/facts.conversation/default/a1b2c3d4/round-single',
    );
  });

  test('all rounds for same run share the run_id_short directory', () => {
    const trial = receiptSlug({ ...BASE_INPUT, round: 'trial' });
    const full = receiptSlug({ ...BASE_INPUT, round: 'full' });
    // Both under same {short}/ prefix
    const trialDir = trial.split('/').slice(0, -1).join('/');
    const fullDir = full.split('/').slice(0, -1).join('/');
    expect(trialDir).toBe(fullDir);
    expect(trialDir).toBe('extracts/2026-05-27/facts.conversation/default/a1b2c3d4');
  });

  test('different source_id changes the slug', () => {
    const a = receiptSlug({ ...BASE_INPUT, source_id: 'src-a' });
    const b = receiptSlug({ ...BASE_INPUT, source_id: 'src-b' });
    expect(a).not.toBe(b);
    expect(a).toContain('/src-a/');
    expect(b).toContain('/src-b/');
  });
});

describe('shortRunId / dateFromIso — pure helpers', () => {
  test('shortRunId truncates to 8 chars', () => {
    expect(shortRunId('a1b2c3d4e5f6789abcdef')).toBe('a1b2c3d4');
    expect(shortRunId('a1b2c3d4')).toBe('a1b2c3d4');
    expect(shortRunId('short')).toBe('short');
    expect(shortRunId('')).toBe('');
  });

  test('shortRunId preserves dashes / underscores within the 8 chars', () => {
    expect(shortRunId('run-1234-rest')).toBe('run-1234');
    expect(shortRunId('op_check_abc')).toBe('op_check');
  });

  test('dateFromIso extracts YYYY-MM-DD prefix', () => {
    expect(dateFromIso('2026-05-27T14:30:00Z')).toBe('2026-05-27');
    expect(dateFromIso('2026-05-27T14:30:00.123456Z')).toBe('2026-05-27');
    expect(dateFromIso('2026-12-31T23:59:59Z')).toBe('2026-12-31');
  });
});

describe('writeReceipt — frontmatter D-EXTRACT-19 belt+suspenders', () => {
  // Canonical PGLite block per CLAUDE.md test-isolation R3+R4.
  // One engine per file; TRUNCATE between tests is ~2 orders of magnitude
  // faster than re-running 99 migrations per test.
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

  test('stamps type:extract_receipt + dream_generated:true regardless of input', async () => {
    const { slug, page } = await writeReceipt(engine, BASE_INPUT);
    expect(slug).toBe('extracts/2026-05-27/facts.conversation/default/a1b2c3d4/round-full');
    expect(page.type).toBe('extract_receipt');
    // belt + suspenders: both anti-loop flags are present
    expect(page.frontmatter?.type).toBe('extract_receipt');
    expect(page.frontmatter?.dream_generated).toBe(true);
  });

  test('stamps optional model_id + eval_pass + eval_score when supplied', async () => {
    const { page } = await writeReceipt(engine, {
      ...BASE_INPUT,
      run_id: 'eval-pass-run-id',
      model_id: 'claude-haiku-4-5',
      eval_pass: true,
      eval_score: 8.7,
    });
    expect(page.frontmatter?.model_id).toBe('claude-haiku-4-5');
    expect(page.frontmatter?.eval_pass).toBe(true);
    expect(page.frontmatter?.eval_score).toBe(8.7);
  });

  test('omits eval_pass / model_id when not supplied (deterministic extractor)', async () => {
    const { page } = await writeReceipt(engine, {
      ...BASE_INPUT,
      run_id: 'deterministic-run-id',
      kind: 'links',
      cost_usd: 0,
    });
    expect(page.frontmatter?.model_id).toBeUndefined();
    expect(page.frontmatter?.eval_pass).toBeUndefined();
    expect(page.frontmatter?.eval_score).toBeUndefined();
    // Anti-loop flags STILL present even on deterministic extractors
    expect(page.frontmatter?.type).toBe('extract_receipt');
    expect(page.frontmatter?.dream_generated).toBe(true);
  });

  test('idempotent on resume: same run_id+round overwrites prior receipt', async () => {
    const first = await writeReceipt(engine, {
      ...BASE_INPUT,
      run_id: 'idem-run',
      total_rows: 10,
    });
    const second = await writeReceipt(engine, {
      ...BASE_INPUT,
      run_id: 'idem-run',
      total_rows: 47, // updated count on resume
    });
    expect(first.slug).toBe(second.slug);
    // Read back: row count is the latest write
    expect(second.page.frontmatter?.total_rows).toBe(47);
  });

  test('body contains human-readable summary + machine-readable fields', async () => {
    const { page } = await writeReceipt(engine, {
      ...BASE_INPUT,
      run_id: 'body-test-run',
      summary: 'Extracted 47 facts from 6 conversation pages.',
      model_id: 'claude-haiku-4-5',
      eval_pass: true,
      eval_score: 9.1,
    });
    expect(page.compiled_truth).toContain('facts.conversation');
    expect(page.compiled_truth).toContain('Extracted 47 facts from 6 conversation pages.');
    expect(page.compiled_truth).toContain('default');
    expect(page.compiled_truth).toContain('claude-haiku-4-5');
    expect(page.compiled_truth).toMatch(/PASS/);
  });
});
