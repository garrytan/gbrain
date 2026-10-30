/**
 * Facts saved with remember are not page chunks, so page search never returned
 * them. search/query now append the active facts that share most of the
 * query's words, under recall's scope and visibility rules. Found by
 * gbrain-evals Cat 40 (write-back tasks).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'crm/numbat-labs', serializeMarkdown({}, 'Account record. Billing contact: Old Person.', '', { type: 'crm', title: 'CRM record: Numbat Labs', tags: [] }), { noEmbed: true, forceRechunk: true });
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES
    ('default', 'companies/numbat-labs', 'The billing contact for Numbat Labs is New Person as of 2026-09-15.', 'fact', 'world', 'user update'),
    ('default', 'companies/numbat-labs', 'Numbat Labs prefers invoices by email.', 'preference', 'private', 'user update'),
    ('default', 'companies/quokka-co', 'The billing contact for Quokka Co is Someone Else.', 'fact', 'world', 'user update')`);
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

const call = (name: string, args: Record<string, unknown>, remote = true) => dispatchToolCall(engine, name, args, { remote, transport: 'http', sourceId: 'default' });
const extra = (r: { content: Array<{ text?: string }> }) => r.content.slice(1).map(c => c.text ?? '').join('\n');

describe('search surfaces remembered facts', () => {
  test('a matching world fact is appended to remote search results', async () => {
    const text = extra(await call('search', { query: 'Numbat Labs billing contact' }));
    expect(text).toContain('New Person');
    expect(text).not.toContain('Someone Else');
  });
  test('private facts stay hidden from remote callers', async () => {
    const text = extra(await call('search', { query: 'Numbat Labs invoices email' }));
    expect(text).not.toContain('prefers invoices by email');
  });
  test('an older fact matching every term is not crowded out by newer facts matching one', async () => {
    // 250 newer world facts share only "lanternfish"; the one fact naming all three terms is the oldest.
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
      VALUES ('default', 'notes/ledger-example', 'The lanternfish quibble ledger was reconciled by Example Person.', 'fact', 'world', 'user update', now() - interval '400 days')`);
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
      SELECT 'default', 'notes/school-' || g, 'A lanternfish school was sighted on survey ' || g || '.', 'fact', 'world', 'user update', now() - (g || ' minutes')::interval
      FROM generate_series(1, 250) AS g`);
    const text = extra(await call('search', { query: 'lanternfish quibble ledger' }));
    expect(text).toContain('reconciled by Example Person');
    expect(text).not.toContain('school was sighted');
  });
  test('a query sharing too few words returns no facts block', async () => {
    const text = extra(await call('search', { query: 'Numbat roadmap webinar dashboard filters' }));
    expect(text).not.toContain('Saved facts');
  });
});
