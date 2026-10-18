/**
 * #6627 (D30): the nightly probe's judge grades DIRECTNESS ("without hedging
 * or padding"), and the eval reader's default notes protocol makes the whole
 * notes-plus-reasoning text the hypothesis, so healthy answers failed
 * directness. The probe asks for the direct reader; the shared reader prompts
 * (pinned by READER_PROMPT_SHA in benchmark receipts) stay unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { buildLongMemEvalProbeCall, PROBE_QA_DIMENSIONS } from '../src/core/cycle/nightly-probe-adapters.ts';
import { READER_MAX_TOKENS, READER_SYSTEM_TEXT, resolveReaderConfig } from '../src/eval/longmemeval/reader.ts';

const flagValue = (argv: string[], flag: string) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};

describe('#6627 nightly probe reader mode', () => {
  test('the probe passes --reader-mode direct, with and without brain-resolved model routes', () => {
    const base = { fixturePath: '/f.jsonl', outputPath: '/o.jsonl' };
    const routes = { reader: { model: 'anthropic:claude-x' }, extractor: { model: 'anthropic:claude-y' } } as never;
    for (const args of [base, { ...base, modelRoutes: routes }]) {
      const { argv } = buildLongMemEvalProbeCall(args);
      expect(flagValue(argv, '--reader-mode')).toBe('direct');
      expect(argv.filter(a => a === '--reader-mode')).toHaveLength(1);
      expect(argv[0]).toBe('/f.jsonl');
    }
  });

  test('direct mode is the original terse reader prompt and budget, so the directness rubric can pass it', () => {
    const { argv } = buildLongMemEvalProbeCall({ fixturePath: '/f.jsonl', outputPath: '/o.jsonl' });
    const config = resolveReaderConfig({ mode: flagValue(argv, '--reader-mode') });
    expect(config.system).toBe(READER_SYSTEM_TEXT);
    expect(config.system).not.toContain('First extract all the relevant information');
    expect(config.maxTokens).toBe(READER_MAX_TOKENS);
    expect(PROBE_QA_DIMENSIONS.some(d => d.startsWith('DIRECTNESS'))).toBe(true);
  });
});
