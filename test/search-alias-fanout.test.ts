/**
 * Search's alias fan-out (Cat 40 Hard fix wave, F1.6): a query that names an
 * entity also searches every other name the entity and its identity siblings
 * go by, keyword-only with the name required, and each spliced row says which
 * name found it.
 *
 * Protects: records filed only under a nickname or a code reach a query that
 * names the account (gbrain-evals Cat 40 Hard: code-only misses with the code
 * on the card); a lowercase common word never fans out; the per-call caps
 * (4 names, 8 rows) hold and say so; a private sibling's names never reach an
 * untrusted caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { aliasPhrase, aliasRankQuery, resolveQueryEntity, searchAliasRequired } from '../src/core/search/alias-fanout.ts';
import { mentionBrain, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
const remote = { remote: true, transport: 'http' as const, sourceId: 'default' };

beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function put(slug: string, type: string, title: string, body: string, fm: Record<string, unknown> = {}) {
  await importFromContent(engine, slug, serializeMarkdown(fm, body, '', { type, title, tags: [] }), { noEmbed: true, forceRechunk: true });
}

async function search(query: string, opts: Record<string, unknown> = remote) {
  const r = await dispatchToolCall(engine, 'search', { query }, opts as never);
  return {
    rows: JSON.parse(r.content[0].text!) as Array<{ slug: string; matched_alias?: string; chunk_text?: string }>,
    fanout: (r._meta?.retrieval as Record<string, unknown> | undefined)?.fanout as Record<string, any> | undefined,
    visible: r.content.map(c => c.text ?? '').join('\n'),
  };
}

const account = async () => {
  await put('accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Segment: freight\nInternal nickname: Copper Fox');
  await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO\nOwner: Dana Example');
  await put('tickets/t1', 'ticket', 'Ticket 1', 'Copper Fox asked for a refund on the March invoice.');
  await put('contracts/a1', 'amendment', 'Amendment 1', 'For WGCO the discount moves to 12 percent, effective 2025-04-01.');
  for (let i = 0; i < 6; i++) await put(`notes/n${i}`, 'note', `Note ${i}`, `Widget Co weekly check-in number ${i}. Discount discussed.`);
  await sweep(engine);
};

describe('alias fan-out', () => {
  test('a query naming the account returns records filed only under its nickname and its code, with matched_alias', async () => {
    await account();
    const { rows, fanout } = await search('Widget Co discount history');
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('contracts/a1');
    expect(slugs).toContain('tickets/t1');
    for (const r of rows.filter(r => r.matched_alias)) expect((r.chunk_text ?? '').toLowerCase()).toContain(r.matched_alias!.toLowerCase());
    expect(rows.find(r => r.slug === 'tickets/t1')?.matched_alias).toBe('Copper Fox');
    expect(fanout!.resolved_entity).toMatch(/widget-co$/);
    expect(fanout!.aliases_searched.map((a: { alias: string }) => a.alias)).toEqual(expect.arrayContaining(['WGCO', 'Copper Fox']));
    expect(fanout!.truncated).toBe(false);
  });

  test('the sibling tie resolves to the group; a lowercase common word never fans out', async () => {
    await account();
    const r = await resolveQueryEntity(engine, 'Widget Co renewal', { sourceId: 'default', excludePrivate: false });
    expect(r!.pages.map(p => p.slug).sort()).toEqual(['accounts/widget-co', 'crm/widget-co']);
    await put('companies/discount', 'company', 'discount', 'A company literally named discount.');
    await sweep(engine);
    expect(await resolveQueryEntity(engine, 'what is the discount', { sourceId: 'default', excludePrivate: false })).toBeNull();
  });

  test('at most 4 names per call, the rest are listed and the model-visible notice names them; spliced rows stop at 8', async () => {
    const names = ['Alpha Kite', 'Beta Kite', 'Gamma Kite', 'Delta Kite', 'Epsilon Kite', 'Zeta Kite'];
    await put('crm/kite-co', 'crm', 'CRM record: Kite Co', `Account code: KTCO\nAliases: ${names.join(', ')}`);
    for (const n of names) for (let i = 0; i < 3; i++) await put(`docs/${n.split(' ')[0]!.toLowerCase()}-${i}`, 'note', `Doc ${n} ${i}`, `${n} order number ${i}.`);
    await sweep(engine);
    const { rows, fanout, visible } = await search('Kite Co orders');
    expect(fanout!.aliases_searched).toHaveLength(4);
    expect(fanout!.aliases_skipped).toHaveLength(3);
    expect(fanout!.truncated).toBe(true);
    expect(visible).toContain('alias_fanout');
    for (const skipped of fanout!.aliases_skipped) expect(visible).toContain(skipped);
    expect(rows.filter(r => r.matched_alias).length).toBeLessThanOrEqual(8);
  });

  test('a resolved entity in a source still being indexed carries the mention_index notice', async () => {
    await account();
    expect((await search('Widget Co discount history')).visible).not.toContain('mention_index');
    await engine.executeRaw('UPDATE page_mention_state SET mention_version = 1, alias_version = 1');
    await engine.executeRaw("UPDATE mention_index_status SET policy_fingerprint = split_part(policy_fingerprint, ';', 1)");
    expect((await search('Widget Co discount history')).visible).toContain('mention_index');
  });

  test('search.alias_fanout_max=0 turns fan-out off', async () => {
    await account();
    await engine.setConfig('search.alias_fanout_max', '0');
    const { rows, fanout } = await search('Widget Co discount history');
    expect(fanout).toBeUndefined();
    expect(rows.some(r => r.matched_alias)).toBe(false);
  });

  test('a private sibling\'s names never reach an untrusted caller', async () => {
    await put('accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Internal nickname: Private Plover', { visibility: 'private' });
    await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO');
    await put('tickets/t9', 'ticket', 'Ticket 9', 'Private Plover escalated.');
    await sweep(engine);
    const { visible, fanout, rows } = await search('Widget Co escalations');
    expect(JSON.stringify(fanout ?? {})).not.toContain('Private Plover');
    expect(rows.some(r => r.matched_alias === 'Private Plover')).toBe(false);
    expect(visible).not.toContain('accounts/widget-co');
  });

  test('the alias-required query escapes codes and quotes and ranks by the other terms', async () => {
    await put('docs/x1', 'note', 'X1', 'ZX-41 shipped late; refund issued.');
    await put('docs/x2', 'note', 'X2', 'ZX-41 shipped on time.');
    await put('docs/x3', 'note', 'X3', 'A refund for someone else.');
    expect(aliasPhrase('Say "hi"')).toBe('"Say hi"');
    expect(aliasRankQuery('"ZX-41"', ['refund'])).toBe('"ZX-41" OR refund');
    const rows = await searchAliasRequired(engine, 'ZX-41', ['refund'], { sourceId: 'default', limit: 5 });
    expect(rows.map(r => r.slug)).toEqual(['docs/x1', 'docs/x2']);
  });
});
