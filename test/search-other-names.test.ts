/**
 * Declared other names in returned evidence ("Account code: MULI") are
 * reported when the query uses only one of the two names, and saved facts
 * stored under the other name still match. gbrain-evals Cat 40.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { aliasDeclarations } from '../src/core/ops/search.ts';
import { asOwner } from './helpers/owner-tier.ts';

describe('aliasDeclarations', () => {
  const rows = [{ slug: 'crm/murari-logistics', title: 'CRM record: Murari Logistics', chunk_text: 'Account record. Account code: MULI. Owner: someone.' }];
  test('a query naming the full name learns the code', () => {
    expect(aliasDeclarations(rows, 'Murari Logistics payment terms')).toEqual([{ name: 'Murari Logistics', alias: 'MULI', slug: 'crm/murari-logistics' }]);
  });
  test('a query naming the code learns the full name', () => {
    expect(aliasDeclarations(rows, 'next MULI invoice')).toHaveLength(1);
  });
  test('a query naming both, or neither, gets nothing', () => {
    expect(aliasDeclarations(rows, 'Murari Logistics MULI')).toEqual([]);
    expect(aliasDeclarations(rows, 'unrelated question')).toEqual([]);
  });
  test('lowercase words after a label are not names', () => {
    expect(aliasDeclarations([{ slug: 'x', title: 'Note: Thing', chunk_text: 'aka the usual' }], 'Thing')).toEqual([]);
  });
});

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await asOwner(engine, tx => importFromContent(tx, 'crm/numbat-labs', serializeMarkdown({}, 'Account record. Account code: NULA. Billing contact: Old Person.', '', { type: 'crm', title: 'CRM record: Numbat Labs', tags: [] }), { noEmbed: true, forceRechunk: true }));
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES
    ('default', 'numbat-labs', 'The billing contact for Numbat Labs is New Person.', 'fact', 'world', 'user update')`);
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

describe('MCP search with other names', () => {
  test('a code-only query reports the full name and finds the fact saved under it', async () => {
    const r = await dispatchToolCall(engine, 'search', { query: 'NULA billing contact' }, { remote: true, transport: 'http', sourceId: 'default' });
    const extra = r.content.slice(1).map(c => c.text ?? '').join('\n');
    expect(extra).toContain('NULA = Numbat Labs');
    expect(extra).toContain('New Person');
  });
});

describe('search fans out to the other declared name', () => {
  test('a page that uses only the code is returned for a full-name query', async () => {
    await importFromContent(engine, 'contracts/numbat-labs-msa', serializeMarkdown({}, 'Master services agreement with Numbat Labs (account code NULA). Payment terms: Net 45.', '', { type: 'contract', title: 'MSA: Numbat Labs', tags: [] }), { noEmbed: true, forceRechunk: true });
    await importFromContent(engine, 'contracts/amendment-one', serializeMarkdown({}, 'Executed amendment for NULA: payment terms change to Net 30.', '', { type: 'amendment', title: 'Amendment No. 1: NULA', tags: [] }), { noEmbed: true, forceRechunk: true });
    const r = await dispatchToolCall(engine, 'search', { query: 'Numbat Labs payment terms' }, { remote: true, transport: 'http', sourceId: 'default' });
    const slugs = (JSON.parse(r.content[0].text!) as Array<{ slug: string }>).map(x => x.slug);
    expect(slugs).toContain('contracts/amendment-one');
  });
});

describe('fan-out keeps every original result', () => {
  test('pages from the first search are never displaced by the other-name search', async () => {
    const before = await dispatchToolCall(engine, 'search', { query: 'NULA payment' }, { remote: true, transport: 'http', sourceId: 'default' });
    const slugs = (JSON.parse(before.content[0].text!) as Array<{ slug: string }>).map(x => x.slug);
    expect(slugs).toContain('contracts/amendment-one');
    expect(slugs).toContain('contracts/numbat-labs-msa');
  });
});
