import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  parseFtsLanguageFromProsrc,
  computeFtsLanguageCheck,
  checkFtsLanguageDrift,
} from '../src/commands/doctor.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

describe('parseFtsLanguageFromProsrc', () => {
  test('extracts the first to_tsvector literal', () => {
    const prosrc = `
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('portuguese', COALESCE(NEW.title, '')), 'A') ||
          setweight(to_tsvector('portuguese', COALESCE(NEW.compiled_truth, '')), 'B');
        RETURN NEW;
      END`;
    expect(parseFtsLanguageFromProsrc(prosrc)).toBe('portuguese');
  });

  test('accepts custom config names (pt_br)', () => {
    expect(parseFtsLanguageFromProsrc(`to_tsvector('pt_br', x)`)).toBe('pt_br');
  });

  test('returns null on a body with no to_tsvector literal (never guesses)', () => {
    expect(parseFtsLanguageFromProsrc('BEGIN RETURN NEW; END')).toBeNull();
    // parameterized/odd shapes don't match either
    expect(parseFtsLanguageFromProsrc('to_tsvector(lang_var, x)')).toBeNull();
  });
});

describe('computeFtsLanguageCheck', () => {
  const fn = (proname: string, lang: string | null) => ({ proname, lang });

  test('consistent stored + runtime → ok naming the language', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector', 'english'),
      fn('update_chunk_search_vector', 'english'),
    ]);
    expect(c.status).toBe('ok');
    expect(c.message).toContain("'english'");
  });

  test('runtime differs from stored → warn with both remediations', () => {
    const c = computeFtsLanguageCheck('portuguese', [
      fn('update_page_search_vector', 'english'),
      fn('update_chunk_search_vector', 'english'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain("queries with 'portuguese'");
    expect(c.message).toContain("built with 'english'");
    expect(c.message).toContain('GBRAIN_FTS_LANGUAGE=english');
    expect(c.message).toContain('reindex-search-vector');
  });

  test('trigger functions disagreeing with each other → warn (partial reindex)', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector', 'english'),
      fn('update_chunk_search_vector', 'portuguese'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('disagree');
    expect(c.message).toContain('reindex-search-vector');
  });

  test('no functions found → ok not-applicable (pre-FTS-language schema)', () => {
    const c = computeFtsLanguageCheck('english', []);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('not applicable');
  });

  test('unparseable body → ok skip, never a false warn', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector', null),
      fn('update_chunk_search_vector', 'english'),
    ]);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('update_page_search_vector');
  });
});

describe('checkFtsLanguageDrift — live introspection on a bootstrapped PGLite brain', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    resetFtsLanguageCache();
  });

  test('default env resolves english on both sides → ok', async () => {
    resetFtsLanguageCache();
    delete process.env.GBRAIN_FTS_LANGUAGE;
    const c = await checkFtsLanguageDrift(engine);
    expect(c.name).toBe('fts_language_drift');
    expect(c.status).toBe('ok');
    expect(c.message).toContain("'english'");
  });

  test('runtime env flipped after bootstrap → warn split-brain', async () => {
    resetFtsLanguageCache();
    process.env.GBRAIN_FTS_LANGUAGE = 'portuguese';
    try {
      const c = await checkFtsLanguageDrift(engine);
      expect(c.status).toBe('warn');
      expect(c.message).toContain('split-brain');
    } finally {
      delete process.env.GBRAIN_FTS_LANGUAGE;
      resetFtsLanguageCache();
    }
  });
});
