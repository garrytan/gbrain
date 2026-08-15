import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getFtsLanguage, resetFtsLanguageCache } from '../src/core/fts-language.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

describe('getFtsLanguage', () => {
  test('defaults to english when env is unset', () => {
    expect(getFtsLanguage()).toBe('english');
  });

  test('defaults to english when env is empty string', () => {
    process.env[ENV_KEY] = '';
    expect(getFtsLanguage()).toBe('english');
  });

  test('defaults to english when env is whitespace', () => {
    process.env[ENV_KEY] = '   ';
    expect(getFtsLanguage()).toBe('english');
  });

  test('reads valid pt_br config', () => {
    process.env[ENV_KEY] = 'pt_br';
    expect(getFtsLanguage()).toBe('pt_br');
  });

  test('reads valid simple language name', () => {
    process.env[ENV_KEY] = 'spanish';
    expect(getFtsLanguage()).toBe('spanish');
  });

  test('reads name with underscores and digits', () => {
    process.env[ENV_KEY] = 'custom_lang_v2';
    expect(getFtsLanguage()).toBe('custom_lang_v2');
  });

  test('rejects names with quotes (SQL injection guard)', () => {
    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    expect(getFtsLanguage()).toBe('english');
  });

  test('rejects names with spaces', () => {
    process.env[ENV_KEY] = 'pt br';
    expect(getFtsLanguage()).toBe('english');
  });

  test('rejects names with hyphens', () => {
    process.env[ENV_KEY] = 'pt-br';
    expect(getFtsLanguage()).toBe('english');
  });

  test('rejects names starting with digit', () => {
    process.env[ENV_KEY] = '1lang';
    expect(getFtsLanguage()).toBe('english');
  });

  test('rejects uppercase (Postgres config names are lowercase)', () => {
    process.env[ENV_KEY] = 'English';
    expect(getFtsLanguage()).toBe('english');
  });

  test('caches after first read', () => {
    process.env[ENV_KEY] = 'pt_br';
    expect(getFtsLanguage()).toBe('pt_br');

    // Mutate env after first read \u2014 cached value wins.
    process.env[ENV_KEY] = 'spanish';
    expect(getFtsLanguage()).toBe('pt_br');
  });

  test('resetFtsLanguageCache clears cache', () => {
    process.env[ENV_KEY] = 'pt_br';
    expect(getFtsLanguage()).toBe('pt_br');

    resetFtsLanguageCache();
    process.env[ENV_KEY] = 'spanish';
    expect(getFtsLanguage()).toBe('spanish');
  });

  test('trims surrounding whitespace from valid value', () => {
    process.env[ENV_KEY] = '  pt_br  ';
    expect(getFtsLanguage()).toBe('pt_br');
  });
});
