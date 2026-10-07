/**
 * `gbrain extract mentions --explain <name|slug> [--page <slug>]`.
 *
 * Protects: one reason code per rejection class, so an agent debugging
 * "why isn't this page listed?" gets the guard that applied and is never told
 * to rerun extraction for a policy rejection; `extract --explain <kind>`
 * keeps its own meaning. Regression: an explain that reports "links" for a
 * name the gazetteer dropped, or `pending` for a policy rejection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { explainMention } from '../src/commands/extract-mentions-explain.ts';
import { runExtract } from '../src/commands/extract.ts';
import { mentionBrain, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

const account = () => page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO. Ticker: QCO.');

describe('extract mentions --explain reason codes', () => {
  test('a linking name reports its entry and origin', async () => {
    await account();
    await sweep(engine);
    const r = await explainMention(engine, 'QUCO');
    expect(r.reason).toBeNull();
    expect(r.entries).toEqual([{ name: 'QUCO', slug: 'crm/123', origin: 'declared', case_sensitive: true }]);
  });

  test('case_mismatch', async () => {
    await account();
    await sweep(engine);
    expect((await explainMention(engine, 'quco')).reason).toBe('case_mismatch');
  });

  test('ambiguous_first_word', async () => {
    await account();
    await sweep(engine);
    expect((await explainMention(engine, 'Quormiro')).reason).toBe('ambiguous_first_word');
  });

  test('below_min_length (a 3-character declared code)', async () => {
    await account();
    await sweep(engine);
    expect((await explainMention(engine, 'QCO')).reason).toBe('below_min_length');
  });

  test('generic_token', async () => {
    await page(engine, 'people/will', 'person', 'Will', 'x');
    expect((await explainMention(engine, 'Will')).reason).toBe('generic_token');
  });

  test('alias_collision', async () => {
    await page(engine, 'crm/a', 'crm', 'CRM record: Alpha Holdings', 'Account code: DUPE');
    await page(engine, 'crm/b', 'crm', 'CRM record: Beta Holdings', 'Account code: DUPE');
    await sweep(engine);
    expect((await explainMention(engine, 'DUPE')).reason).toBe('alias_collision');
  });

  test('type_not_linkable', async () => {
    await page(engine, 'projects/apollo', 'project', 'Project Apollo', 'x');
    expect((await explainMention(engine, 'projects/apollo')).reason).toBe('type_not_linkable');
  });

  test('linking_disabled', async () => {
    await account();
    await engine.setConfig('mentions.auto_link', 'false');
    expect((await explainMention(engine, 'QUCO')).reason).toBe('linking_disabled');
  });

  test('pending names the sweep; a policy rejection never does', async () => {
    await account();
    await sweep(engine);
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO');
    const r = await explainMention(engine, 'QUCO', { page: 'tickets/t1' });
    expect(r).toMatchObject({ reason: 'pending', page: { slug: 'tickets/t1', linked: false }, next: 'gbrain extract --stale' });
    expect((await explainMention(engine, 'quco')).next).toBeUndefined();
    await sweep(engine);
    expect(await explainMention(engine, 'QUCO', { page: 'tickets/t1' })).toMatchObject({ reason: null, page: { linked: true } });
  });

  test('ignored_by_page', async () => {
    await account();
    await page(engine, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO', { frontmatter: { mention_ignore: ['QUCO'] } });
    await sweep(engine);
    expect((await explainMention(engine, 'QUCO', { page: 'tickets/t1' })).reason).toBe('ignored_by_page');
  });

  test('ignored_by_config and not_a_known_name', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'x');
    await engine.setConfig('mentions.ignore', 'Acme Example');
    expect((await explainMention(engine, 'Acme Example')).reason).toBe('ignored_by_config');
    expect((await explainMention(engine, 'Nobody Holdings')).reason).toBe('not_a_known_name');
  });

  test('`gbrain extract --explain <kind>` keeps its own meaning', async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (m?: unknown) => { out.push(String(m)); };
    try { await runExtract(engine, ['--explain', 'atoms', '--json']); }
    finally { console.log = log; }
    expect(JSON.parse(out.join('\n'))).toMatchObject({ schema_version: 1, kind: 'atoms' });
  });
});

describe('extract mentions --explain <slug>: names, rejections and the sibling decision', () => {
  test('lists each derived alias with its origin and line, each rejected candidate with its reason', async () => {
    await page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO. Ticker: QCO.\nInternal nickname: Copper Fox\nShort name: Quormiro');
    await sweep(engine);
    const r = await explainMention(engine, 'crm/123');
    expect(r.aliases).toEqual(expect.arrayContaining([
      { alias: 'Quormiro Capital', origin: 'subject' },
      { alias: 'QUCO', origin: 'declared', line: 'Account code: QUCO. Ticker: QCO.' },
      { alias: 'Copper Fox', origin: 'declared', line: 'Internal nickname: Copper Fox' },
    ]));
    expect(r.rejected).toEqual(expect.arrayContaining([
      { alias: 'QCO', origin: 'declared', reason: 'below_min_length', line: 'Account code: QUCO. Ticker: QCO.' },
      { alias: 'Quormiro', origin: 'declared', reason: 'ambiguous_first_word', line: 'Short name: Quormiro' },
    ]));
    expect(r.siblings).toEqual({ pages: [], capped: false, verdict: 'none' });
  });

  test('a denied alias explains as denied_by_config', async () => {
    await page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Internal nickname: Copper Fox');
    await engine.setConfig('mentions.alias_deny', 'Copper Fox');
    await sweep(engine);
    expect((await explainMention(engine, 'Copper Fox')).reason).toBe('denied_by_config');
  });

  test('a capped sibling group and a formed one', async () => {
    await page(engine, 'crm/a', 'crm', 'CRM record: Widget Co', 'x');
    await page(engine, 'accounts/a', 'account', 'Account sheet: Widget Co', 'y');
    await sweep(engine);
    expect((await explainMention(engine, 'crm/a')).siblings).toEqual({ pages: ['accounts/a'], capped: false, verdict: 'group' });
    await page(engine, 'billing/a', 'account', 'Billing record: Widget Co', 'z');
    await page(engine, 'support/a', 'account', 'Support record: Widget Co', 'w');
    await sweep(engine);
    expect((await explainMention(engine, 'crm/a')).siblings).toEqual({ pages: [], capped: true, verdict: 'capped' });
  });
});
