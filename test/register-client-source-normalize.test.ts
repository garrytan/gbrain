/**
 * normalizeSourceInput / normalizeFederatedReadInput contract.
 *
 * The `/admin/api/register-client` HTTP endpoint historically hardcoded
 * source_id='default' (and federated_read=[source_id]) — only the CLI
 * (`--source` / `--federated-read`) could bind a client to a non-default
 * brain source. These two normalizers let the HTTP endpoint accept the same
 * inputs from the request body while preserving the historical default when
 * the fields are omitted.
 *
 * Hermetic — pure-function unit tests, no engine, no HTTP.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeSourceInput, normalizeFederatedReadInput } from '../src/core/source-id.ts';

describe('normalizeSourceInput', () => {
  test('undefined → "default" (backward compat)', () => {
    expect(normalizeSourceInput(undefined)).toBe('default');
  });

  test('null → "default" (backward compat)', () => {
    expect(normalizeSourceInput(null)).toBe('default');
  });

  test('valid source_id passes through', () => {
    expect(normalizeSourceInput('mind-agent-brain')).toBe('mind-agent-brain');
  });

  test('single-char source_id is valid', () => {
    expect(normalizeSourceInput('a')).toBe('a');
  });

  test('invalid source_id (underscore) throws', () => {
    expect(() => normalizeSourceInput('mind_agent_brain')).toThrow(/Invalid source_id/);
  });

  test('invalid source_id (uppercase) throws', () => {
    expect(() => normalizeSourceInput('Mind')).toThrow(/Invalid source_id/);
  });

  test('invalid source_id (edge hyphen) throws', () => {
    expect(() => normalizeSourceInput('-mind')).toThrow(/Invalid source_id/);
  });

  test('non-string (number) throws', () => {
    expect(() => normalizeSourceInput(42)).toThrow(/Invalid source_id/);
  });
});

describe('normalizeFederatedReadInput', () => {
  test('undefined → undefined (let registerClientManual default to [sourceId])', () => {
    expect(normalizeFederatedReadInput(undefined)).toBeUndefined();
  });

  test('null → undefined', () => {
    expect(normalizeFederatedReadInput(null)).toBeUndefined();
  });

  test('valid single-element array passes through', () => {
    expect(normalizeFederatedReadInput(['mind-agent-brain'])).toEqual(['mind-agent-brain']);
  });

  test('valid multi-element array passes through (read across both sources)', () => {
    expect(normalizeFederatedReadInput(['default', 'mind-agent-brain'])).toEqual([
      'default',
      'mind-agent-brain',
    ]);
  });

  test('empty array throws (ambiguous — omit the field instead)', () => {
    expect(() => normalizeFederatedReadInput([])).toThrow(/Invalid federatedRead/);
  });

  test('non-array (string) throws', () => {
    expect(() => normalizeFederatedReadInput('default')).toThrow(/Invalid federatedRead/);
  });

  test('array with an invalid source_id element throws', () => {
    expect(() => normalizeFederatedReadInput(['default', 'bad_id'])).toThrow(/Invalid source_id/);
  });
});
