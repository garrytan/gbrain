/**
 * `--log-read-params` (src/mcp/read-log.ts): readable activity for READ operations.
 *
 * Pins:
 *   1. Only read operations qualify (not mutating, `read` scope): writes and admin ops never log values.
 *   2. Read params keep declared keys only, PII-scrubbed and capped; unknown keys are counted, never named
 *      (the F8 attacker-controlled-key rule still holds).
 *   3. The result summary carries slugs and fact ids only, never page bodies or fact text, and is built from the
 *      real dispatchToolCall output.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isReadOperation, readParamsLog, readResultLog } from '../src/mcp/read-log.ts';
import type { AuthInfo } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example',
    compiled_truth: 'Alice runs the zebra-marker launch. Private body text.', timeline: '', frontmatter: {} },
    { sourceId: 'default' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const auth = { token: 't', clientId: 'reader', principal: { kind: 'oauth_client', id: 'reader' },
  scopes: ['read'], sourceId: 'default' } as AuthInfo;
const HTTP = { remote: true, transport: 'http' as const, sourceId: 'default', auth };

describe('isReadOperation', () => {
  test('reads qualify', () => {
    for (const op of ['search', 'query', 'get_page', 'recall', 'list_pages', 'entity', 'context_pack', 'get_backlinks']) {
      expect(isReadOperation(op)).toBe(true);
    }
  });
  test('writes, admin ops and unknown ops never do', () => {
    for (const op of ['put_page', 'remember', 'delete_page', 'forget', 'think', 'get_stats', 'run_doctor', 'nope']) {
      expect(isReadOperation(op)).toBe(false);
    }
  });
});

describe('readParamsLog', () => {
  test('declared params kept, PII scrubbed', () => {
    const log = readParamsLog('search', { query: 'what did alice@example.com say about pricing', limit: 5 })!;
    expect(log.read).toBe(true);
    expect(log.params.limit).toBe(5);
    expect(String(log.params.query)).toContain('what did');
    expect(String(log.params.query)).not.toContain('alice@example.com');
    expect(log.unknown_key_count).toBe(0);
  });
  test('unknown keys are counted, never named', () => {
    const log = readParamsLog('get_page', { slug: 'people/alice-example', 'wiki/people/secret-name': 'x' })!;
    expect(log.params).toEqual({ slug: 'people/alice-example' });
    expect(log.unknown_key_count).toBe(1);
    expect(JSON.stringify(log)).not.toContain('secret-name');
  });
  test('long strings are capped', () => {
    const log = readParamsLog('search', { query: 'q'.repeat(5000) })!;
    expect(String(log.params.query).length).toBeLessThanOrEqual(2001);
  });
  test('non-object params log nothing', () => {
    expect(readParamsLog('search', null)).toBeNull();
    expect(readParamsLog('search', ['a'])).toBeNull();
  });
});

describe('readResultLog', () => {
  test('get_page through the real dispatcher: the slug, never the body', async () => {
    const r = await dispatchToolCall(engine, 'get_page', { slug: 'people/alice-example' }, HTTP);
    expect(r.isError).toBeFalsy();
    const log = readResultLog(r);
    expect(log.slugs).toContain('people/alice-example');
    expect(JSON.stringify(log)).not.toContain('Private body text');
  });
  test('list_pages through the real dispatcher: the slugs that came back', async () => {
    const r = await dispatchToolCall(engine, 'list_pages', {}, HTTP);
    expect(r.isError).toBeFalsy();
    const log = readResultLog(r);
    expect(log.slugs).toContain('people/alice-example');
    expect(log.items).toBeGreaterThanOrEqual(1);
  });
  test('search-shaped results (content[0] is the hit array; notices follow as later blocks)', () => {
    const hits = JSON.stringify([{ slug: 'people/alice-example', chunk_id: 7, score: 0.9, chunk_text: 'Private body text' }]);
    const log = readResultLog({ content: [{ type: 'text', text: hits }, { type: 'text', text: '[gbrain notice x]' }] });
    expect(log).toEqual({ slugs: ['people/alice-example'], pages: [{ slug: 'people/alice-example', source_id: null }],
      fact_ids: [], items: 1 });
  });
  test('fact rows yield ids, never the fact text', () => {
    const text = JSON.stringify({ facts: [{ id: 41, fact: 'Signed the LOI on Friday', entity: 'companies/acme' },
      { id: 42, fact: 'Wire sent', entity: 'companies/acme' }], results: [{ slug: 'companies/acme', score: 1 }] });
    const log = readResultLog({ content: [{ type: 'text', text }] });
    expect(log.fact_ids).toEqual([41, 42]);
    expect(log.slugs).toEqual(['companies/acme']);
    expect(log.items).toBe(3);
    expect(JSON.stringify(log)).not.toContain('LOI');
  });
  test('lists are capped and flagged', () => {
    const text = JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ slug: `notes/n${i}` })));
    const log = readResultLog({ content: [{ type: 'text', text }] });
    expect(log.slugs.length).toBe(50);
    expect(log.truncated).toBe(true);
    expect(log.items).toBe(80);
  });
  test('a non-JSON result summarizes to nothing, never throws', () => {
    expect(readResultLog({ content: [{ type: 'text', text: '# Just markdown' }] })).toEqual({ slugs: [], pages: [], fact_ids: [], items: null });
    expect(readResultLog({})).toEqual({ slugs: [], pages: [], fact_ids: [], items: null });
  });
  test('each page keeps its source; the same slug from two sources is two pages', () => {
    const hits = JSON.stringify([{ slug: 'permission-test/x', source_id: 'person-matt' },
      { slug: 'permission-test/x', source_id: 'data-leadership' }, { slug: 'people/a', source_id: 'person-matt' }]);
    const log = readResultLog({ content: [{ type: 'text', text: hits }] });
    expect(log.slugs).toEqual(['permission-test/x', 'people/a']);
    expect(log.pages).toEqual([{ slug: 'permission-test/x', source_id: 'person-matt' },
      { slug: 'permission-test/x', source_id: 'data-leadership' }, { slug: 'people/a', source_id: 'person-matt' }]);
  });
  test('saved facts search attached (structured _meta) are counted with their entities, never their text', () => {
    const log = readResultLog({ content: [{ type: 'text', text: '[]' }, { type: 'text', text: 'Saved facts (remember)…' }],
      _meta: { retrieval: { saved_facts: [
        { fact: 'Signed the LOI', entity_slug: 'people/alex-viada', valid_from: '2026-10-09', source: 'chat' },
        { fact: 'Weekly sync moved', entity_slug: 'people/alex-viada', valid_from: '2026-10-10', source: 'chat' },
        { fact: 'Loose note', entity_slug: null, valid_from: '2026-10-10', source: 'chat' }] } } });
    expect(log.saved_facts).toEqual({ n: 3, entities: ['people/alex-viada'] });
    expect(JSON.stringify(log)).not.toContain('LOI');
  });
});
