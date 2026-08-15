// v0.41 T11 — minimal scaffold tests for the 3 new eval commands.
//
// Pins the command-surface contract: every command returns a stable
// {schema_version: 1, ok, status, details} envelope that downstream
// tooling can rely on while the real parity-baseline implementations
// land in v0.41.1.

import { describe, test, expect } from 'bun:test';
import { runEvalExtractAtoms } from '../src/commands/eval-extract-atoms.ts';
import { runEvalSynthesizeConcepts } from '../src/commands/eval-synthesize-concepts.ts';
import { runEvalMarkdownGreenfield } from '../src/commands/eval-markdown-greenfield.ts';

describe('v0.41 T11: eval command surfaces', () => {
  test('runEvalExtractAtoms returns stable schema_version=1 envelope', async () => {
    const result = await runEvalExtractAtoms({});
    expect(result.schema_version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('not_yet_implemented');
    expect(result.details).toBeDefined();
  });

  test('runEvalExtractAtoms preserves --parity-baseline + --sample in details', async () => {
    const result = await runEvalExtractAtoms({
      parityBaseline: '~/git/brain/atoms',
      sample: 500,
    });
    expect(result.details.parity_baseline_path).toBe('~/git/brain/atoms');
    expect(result.details.sample_size).toBe(500);
  });

  test('runEvalSynthesizeConcepts returns stable schema_version=1 envelope', async () => {
    const result = await runEvalSynthesizeConcepts({});
    expect(result.schema_version).toBe(1);
    expect(result.status).toBe('not_yet_implemented');
  });

  test('runEvalSynthesizeConcepts preserves --parity-baseline + --sample', async () => {
    const result = await runEvalSynthesizeConcepts({
      parityBaseline: '~/git/brain/concepts',
      sample: 500,
    });
    expect(result.details.parity_baseline_path).toBe('~/git/brain/concepts');
    expect(result.details.sample_size).toBe(500);
  });

  test('runEvalMarkdownGreenfield returns stable schema_version=1 envelope', async () => {
    const result = await runEvalMarkdownGreenfield({});
    expect(result.schema_version).toBe(1);
    expect(result.status).toBe('not_yet_implemented');
  });

  test('runEvalMarkdownGreenfield preserves --pass-rate-floor', async () => {
    const result = await runEvalMarkdownGreenfield({
      passRateFloor: 0.95,
      repoPath: '~/git/brain',
    });
    expect(result.details.pass_rate_floor).toBe(0.95);
    expect(result.details.repo_path).toBe('~/git/brain');
  });

  test('all 3 commands include v0_41_1_followup pointer in details', async () => {
    const r1 = await runEvalExtractAtoms({});
    const r2 = await runEvalSynthesizeConcepts({});
    const r3 = await runEvalMarkdownGreenfield({});
    expect(r1.details.v0_41_1_followup).toBeDefined();
    expect(r2.details.v0_41_1_followup).toBeDefined();
    expect(r3.details.v0_41_1_followup).toBeDefined();
  });
});
