import { describe, test, expect } from 'bun:test';
import {
  compareAnthropicVersions,
  newerAnthropicModel,
  parseAnthropicModelId,
} from '../../src/core/ai/anthropic-model-ids.ts';

describe('parseAnthropicModelId', () => {
  test('parses family, major, minor and the 8-digit date segment', () => {
    expect(parseAnthropicModelId('anthropic:claude-haiku-4-5-20251001')).toEqual({
      id: 'claude-haiku-4-5-20251001', family: 'haiku', major: 4, minor: 5, date: '20251001',
    });
    expect(parseAnthropicModelId('claude-sonnet-5')).toEqual({ id: 'claude-sonnet-5', family: 'sonnet', major: 5, minor: 0 });
    expect(parseAnthropicModelId('anthropic/claude-opus-4-7')).toEqual({ id: 'claude-opus-4-7', family: 'opus', major: 4, minor: 7 });
  });

  test('an 8-digit segment after the major is a date, not a minor', () => {
    expect(parseAnthropicModelId('claude-sonnet-5-20260101')).toEqual({
      id: 'claude-sonnet-5-20260101', family: 'sonnet', major: 5, minor: 0, date: '20260101',
    });
  });

  test('fable, non-Anthropic providers and unknown shapes parse to null', () => {
    for (const id of [
      'anthropic:claude-fable-5-1',
      'openrouter:anthropic/claude-sonnet-4-6',
      'openai:gpt-5.6',
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-latest',
      'claude-sonnet-4-6-extra',
      '',
    ]) {
      expect(parseAnthropicModelId(id)).toBeNull();
    }
  });
});

describe('compareAnthropicVersions', () => {
  test('orders by major then minor and ignores snapshot dates', () => {
    const p = (id: string) => parseAnthropicModelId(id)!;
    expect(compareAnthropicVersions(p('claude-sonnet-5'), p('claude-sonnet-4-6'))).toBeGreaterThan(0);
    expect(compareAnthropicVersions(p('claude-opus-4-7'), p('claude-opus-4-8'))).toBeLessThan(0);
    expect(compareAnthropicVersions(p('claude-haiku-4-5'), p('claude-haiku-4-5-20251001'))).toBe(0);
  });
});

describe('newerAnthropicModel', () => {
  test('returns the newest priced same-family recipe id when the model is older', () => {
    expect(newerAnthropicModel('anthropic:claude-sonnet-4-6')?.id).toBe('claude-sonnet-5-5');
    expect(newerAnthropicModel('anthropic:claude-sonnet-5')?.id).toBe('claude-sonnet-5-5');
    expect(newerAnthropicModel('anthropic:claude-opus-4-7')?.id).toBe('claude-opus-5');
  });

  test('dated and undated forms of the current version get no hint', () => {
    expect(newerAnthropicModel('claude-haiku-4-5')).toBeNull();
    expect(newerAnthropicModel('anthropic:claude-haiku-4-5-20251001')).toBeNull();
  });

  test('current, newer-than-recipe, fable, non-Anthropic and unparseable ids get none', () => {
    for (const id of [
      'anthropic:claude-sonnet-5-5',
      'anthropic:claude-sonnet-6',
      'anthropic:claude-opus-5-2',
      'anthropic:claude-fable-5',
      'openai:gpt-5.6',
      'not-a-model',
    ]) {
      expect(newerAnthropicModel(id)).toBeNull();
    }
  });

  test('unpriced recipe ids are never suggested', () => {
    const ids = ['claude-sonnet-4-6', 'claude-sonnet-6'];
    expect(newerAnthropicModel('claude-sonnet-4-6', ids, (id) => id !== 'claude-sonnet-6')).toBeNull();
    expect(newerAnthropicModel('claude-sonnet-4-6', ids, () => true)?.id).toBe('claude-sonnet-6');
  });
});
