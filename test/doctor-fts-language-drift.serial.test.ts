import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  parseFtsLanguagesFromProsrc,
  computeFtsLanguageCheck,
  checkFtsLanguageDrift,
} from '../src/commands/doctor.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

describe('parseFtsLanguagesFromProsrc', () => {
  test('extracts the unique to_tsvector literals', () => {
    const prosrc = `
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('portuguese', COALESCE(NEW.title, '')), 'A') ||
          setweight(to_tsvector('portuguese', COALESCE(NEW.compiled_truth, '')), 'B');
        RETURN NEW;
      END`;
    expect(parseFtsLanguagesFromProsrc(prosrc)).toEqual(['portuguese']);
  });

  test('accepts custom config names, pg_catalog qualification, and whitespace', () => {
    expect(parseFtsLanguagesFromProsrc(`to_tsvector('pt_br', x)`)).toEqual(['pt_br']);
    expect(parseFtsLanguagesFromProsrc(`pg_catalog.to_tsvector ('english'::regconfig, x)`)).toEqual(['english']);
    expect(parseFtsLanguagesFromProsrc(`pg_catalog . to_tsvector( 'spanish', x)`)).toEqual(['spanish']);
  });

  test('surfaces mixed languages within one body', () => {
    expect(parseFtsLanguagesFromProsrc(`to_tsvector('english', a) || to_tsvector('portuguese', b)`))
      .toEqual(['english', 'portuguese']);
  });

  test('returns empty on a body with no to_tsvector literal (never guesses)', () => {
    expect(parseFtsLanguagesFromProsrc('BEGIN RETURN NEW; END')).toEqual([]);
    // parameterized/odd shapes don't match either
    expect(parseFtsLanguagesFromProsrc('to_tsvector(lang_var, x)')).toEqual([]);
  });
});

describe('computeFtsLanguageCheck', () => {
  const fn = (proname: string, ...langs: Array<string>) => ({ proname, langs });

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

  test('one trigger function missing while sibling exists → warn schema anomaly', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector', 'english'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('update_chunk_search_vector');
    expect(c.message).toContain('missing');
  });

  test('mixed languages within one function body → warn corrupted trigger', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector', 'english', 'portuguese'),
      fn('update_chunk_search_vector', 'english'),
    ]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('mixes');
  });

  test('unparseable body → ok skip, never a false warn', () => {
    const c = computeFtsLanguageCheck('english', [
      fn('update_page_search_vector'),
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
