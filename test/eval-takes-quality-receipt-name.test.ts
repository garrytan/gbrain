/**
 * takes-quality-eval/receipt-name — naming + identity tests.
 */
import { describe, test, expect } from 'bun:test';
import {
  corpusSha8,
  modelSetSha8,
  buildReceiptFilename,
  buildReceiptPath,
  parseReceiptFilename,
} from '../src/core/takes-quality-eval/receipt-name.ts';

describe('corpusSha8', () => {
  test('deterministic: same input → same sha', () => {
    expect(corpusSha8('hello world')).toBe(corpusSha8('hello world'));
  });

  test('different inputs → different shas', () => {
    expect(corpusSha8('a')).not.toBe(corpusSha8('b'));
  });

  test('output is exactly 8 hex chars', () => {
    const s = corpusSha8('any');
    expect(s).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('modelSetSha8', () => {
  test('order-independent: [a,b] === [b,a]', () => {
    const a = modelSetSha8(['openai:gpt-4o', 'anthropic:claude-opus-4-7']);
    const b = modelSetSha8(['anthropic:claude-opus-4-7', 'openai:gpt-4o']);
    expect(a).toBe(b);
  });

  test('different sets → different shas', () => {
    const a = modelSetSha8(['openai:gpt-4o']);
    const b = modelSetSha8(['anthropic:claude-opus-4-7']);
    expect(a).not.toBe(b);
  });

  test('output is exactly 8 hex chars', () => {
    expect(modelSetSha8(['x'])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('buildReceiptFilename — 4-sha shape (codex review #3)', () => {
  test('produces takes-quality-<corpus>-<prompt>-<models>-<rubric>.json', () => {
    const name = buildReceiptFilename({
      corpus_sha8: 'aaaa1111',
      prompt_sha8: 'bbbb2222',
      models_sha8: 'cccc3333',
      rubric_sha8: 'dddd4444',
    });
    expect(name).toBe('takes-quality-aaaa1111-bbbb2222-cccc3333-dddd4444.json');
  });

  test('round-trip via parseReceiptFilename returns original identity', () => {
    const id = {
      corpus_sha8: 'aaaa1111',
      prompt_sha8: 'bbbb2222',
      models_sha8: 'cccc3333',
      rubric_sha8: 'dddd4444',
    };
    const name = buildReceiptFilename(id);
    expect(parseReceiptFilename(name)).toEqual(id);
  });

  test('parseReceiptFilename returns null for non-matching filenames', () => {
    expect(parseReceiptFilename('not-a-receipt.json')).toBeNull();
    expect(parseReceiptFilename('takes-quality-too-short.json')).toBeNull();
    // Wrong sha length (9 chars):
    expect(parseReceiptFilename('takes-quality-aaaaaaaaa-bbbbbbbb-cccccccc-dddddddd.json')).toBeNull();
  });
});

describe('buildReceiptPath', () => {
  test('returns an absolute path under ~/.gbrain/eval-receipts', () => {
    const path = buildReceiptPath({
      corpus_sha8: 'aaaa1111',
      prompt_sha8: 'bbbb2222',
      models_sha8: 'cccc3333',
      rubric_sha8: 'dddd4444',
    });
    expect(path).toContain('eval-receipts');
    expect(path.endsWith('.json')).toBe(true);
  });
});
