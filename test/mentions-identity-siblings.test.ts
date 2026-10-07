/**
 * Identity siblings and the entity card's identity fields (Cat 40 Hard fix
 * wave, F1): pages naming one subject under different title prefixes are
 * shown side by side (never unioned), a name they share links to every
 * candidate, and the card carries verbatim identity lines and honest `aka`
 * guidance. PGLite, through MCP dispatch where the caller matters.
 *
 * Protects: a document that names an account only by its name reaches the
 * card's referenced_by although two pages claim the name (it was dropped as
 * an alias collision); a nickname declared on the account sheet reaches a
 * card that resolves to the CRM record; people, look-alikes, large groups,
 * excluded and `identity: separate` pages are never grouped; private
 * siblings and private fence text never reach an untrusted caller.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { excerptLines, EXCERPT_CARD_CHARS, EXCERPT_PAGE_CHARS } from '../src/core/verbs/entity-card-identity.ts';
import { siblingVerdict } from '../src/core/mentions/siblings.ts';
import { mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;
const local = { remote: false, sourceId: 'default', config };
const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function call(op: string, args: Record<string, unknown>, opts: Record<string, unknown> = local) {
  const r = await dispatchToolCall(engine, op, args, opts as never);
  return { json: r.isError ? null : JSON.parse(r.content[0].text), notices: r.content.slice(1).map(c => c.text) };
}

const pair = async (sheetFm: Record<string, unknown> = {}) => {
  await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Segment: freight\nTeam handle: Copper Fox\nRegion: west', { frontmatter: sheetFm });
  await page(engine, 'crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO\nOwner: Dana Example');
};

describe('identity siblings on the card', () => {
  test('sheet + CRM record: siblings listed with their own aliases; aka stays the card page\'s own', async () => {
    await pair();
    await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Segment: freight\nInternal nickname: Copper Fox');
    await sweep(engine);
    const { json } = await call('entity', { name: 'WGCO' });
    const card = json.card;
    expect(card.entity.slug).toBe('crm/widget-co');
    expect(card.aka).toEqual(['wgco', 'widget co']);
    expect(card.aka_sources).toEqual([{ origin: 'declared', slug: 'crm/widget-co' }, { origin: 'subject', slug: 'crm/widget-co' }]);
    expect(card.identity_siblings).toEqual({ capped: false,
      pages: [{ slug: 'accounts/widget-co', title: 'Account sheet: Widget Co', type: 'account', aka: ['Copper Fox', 'Widget Co'] }] });
    expect(card.identity_excerpt).toContainEqual({ slug: 'accounts/widget-co', line: 'Internal nickname: Copper Fox' });
    expect(card.alias_guidance.text).toContain('not proof the list is complete');
    expect(card.alias_guidance.requires_surface).toBeUndefined();
  });

  test('a name both siblings claim links to every candidate; a document naming only the subject reaches referenced_by', async () => {
    await pair();
    await page(engine, 'notes/n1', 'note', 'Renewal call', 'Talked to Widget Co about the renewal.');
    await sweep(engine);
    const links = await mentionLinks(engine);
    expect(links).toContain('notes/n1 -> accounts/widget-co');
    expect(links).toContain('notes/n1 -> crm/widget-co');
    expect(links).not.toContain('crm/widget-co -> accounts/widget-co');
    const card = (await buildEntityCard(engine, 'default', 'Widget Co', { remote: false, includeReferences: true })).card!;
    expect(card.referenced_by!.flatMap(g => g.rows.map(r => r.slug))).toContain('notes/n1');
  });

  test('an unknown label carrying the nickname shows in the excerpt below 600+ characters of ordinary fields', async () => {
    const ordinary = Array.from({ length: 30 }, (_, i) => `field ${i}: value number ${i} for the record`).join('\n');
    await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', `${ordinary}\nCrew shorthand: Kumquat Example`);
    await page(engine, 'crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO');
    expect(ordinary.length).toBeGreaterThan(600);
    await sweep(engine);
    const card = (await buildEntityCard(engine, 'default', 'WGCO', { remote: false, includeReferences: true })).card!;
    expect(card.identity_excerpt!.map(l => l.line)).toContain('Crew shorthand: Kumquat Example');
  });

  test('verbs surface: guidance names the starter surface; an entity with nothing to say gets no guidance', async () => {
    await pair();
    await page(engine, 'companies/plain', 'company', 'plain', 'nothing here');
    await sweep(engine);
    const verbs = await buildEntityCard(engine, 'default', 'WGCO', { remote: false, includeReferences: true, surfaceCeiling: 'verbs' });
    expect(verbs.card!.alias_guidance).toMatchObject({ requires_surface: 'starter' });
    const bare = await buildEntityCard(engine, 'default', 'plain', { remote: false, includeReferences: true });
    expect(bare.card!.alias_guidance).toBeUndefined();
    expect(bare.card!.identity_siblings).toBeUndefined();
  });
});

describe('the sibling rule', () => {
  const pack = { page_types: [{ name: 'account', primitive: 'entity', aliases: ['crm'] }, { name: 'person', primitive: 'entity' }] };
  const policy = { siblingMerge: true, excludeSlugs: [] as string[] };
  const p = (slug: string, title: string, type = 'account', identity?: string) => ({ slug, title, type, identity });

  test('verdicts', () => {
    expect(siblingVerdict([p('a', 'Account sheet: Widget Co'), p('b', 'CRM record: Widget Co', 'crm')], pack, policy)).toBe('group');
    expect(siblingVerdict([p('a', 'Profile: Dana Example', 'person'), p('b', 'Contact: Dana Example', 'person')], pack, policy)).toBe('person');
    expect(siblingVerdict([p('a', 'CRM record: Widget Co'), p('b', 'CRM record: Widget Co')], pack, policy)).toBe('same_prefix');
    expect(siblingVerdict(['A', 'B', 'C', 'D'].map(x => p(x, `${x} sheet: Widget Co`)), pack, policy)).toBe('capped');
    expect(siblingVerdict([p('a', 'Account: Widget Co'), p('b', 'Account sheet: Widget Co Successor')], pack, policy)).toBe('subject_mismatch');
    expect(siblingVerdict([p('a', 'Account sheet: Widget Co'), p('b', 'CRM record: Widget Co', 'crm', 'separate')], pack, policy)).toBe('separate');
    expect(siblingVerdict([p('a', 'Account sheet: Widget Co'), p('b', 'CRM record: Widget Co')], pack, { ...policy, excludeSlugs: ['b'] })).toBe('excluded');
    expect(siblingVerdict([p('a', 'Account sheet: Widget Co'), p('b', 'CRM record: Widget Co')], pack, { ...policy, siblingMerge: false })).toBe('disabled');
  });

  test('people with the same name stay separate (same or different prefixes), in the card and the gazetteer', async () => {
    await page(engine, 'people/dana-a', 'person', 'Profile: Dana Example', 'x');
    await page(engine, 'people/dana-b', 'person', 'Contact: Dana Example', 'y');
    await page(engine, 'notes/n1', 'note', 'Note', 'Met Dana Example today.');
    await sweep(engine);
    const card = (await buildEntityCard(engine, 'default', 'people/dana-a', { remote: false, includeReferences: true })).card!;
    expect(card.identity_siblings).toBeUndefined();
    expect((await mentionLinks(engine)).filter(l => l.startsWith('notes/n1'))).toEqual([]);
  });

  test('a four-page group shows nothing, is capped and emits the explain notice', async () => {
    for (const x of ['Account sheet', 'CRM record', 'Billing record', 'Support record']) {
      await page(engine, `accounts/${x.toLowerCase().replace(' ', '-')}`, 'account', `${x}: Widget Co`, 'Owner: Dana Example');
    }
    await sweep(engine);
    const { json, notices } = await call('entity', { name: 'accounts/account-sheet' });
    expect(json.card.identity_siblings).toEqual({ pages: [], capped: true });
    expect(notices.join('\n')).toContain('identity_siblings_capped');
    expect(notices.join('\n')).toContain('gbrain extract mentions --explain accounts/account-sheet');
  });

  test('identity: separate, mentions.exclude_slugs and mentions.sibling_merge=false keep pages apart', async () => {
    await pair({ identity: 'separate' });
    await sweep(engine);
    const card = async () => (await buildEntityCard(engine, 'default', 'crm/widget-co', { remote: false, includeReferences: true })).card!;
    expect((await card()).identity_siblings).toBeUndefined();
    await resetMentionBrain(engine);
    await pair();
    expect((await card()).identity_siblings?.pages.length).toBe(1);
    await engine.setConfig('mentions.exclude_slugs', 'accounts/widget-co');
    expect((await card()).identity_siblings).toBeUndefined();
    await engine.unsetConfig('mentions.exclude_slugs');
    await engine.setConfig('mentions.sibling_merge', 'false');
    expect((await card()).identity_siblings).toBeUndefined();
  });
});

describe('excerpt privacy and size', () => {
  test('remote caller: a private sibling, private fence text and forgotten facts never show', async () => {
    const fence = '## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n'
      + '| 1 | Secret handle: Hidden Heron | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |\n'
      + '| 2 | ~~Old handle: Gone Gull~~ | fact | 1.0 | world | medium | 2026-01-01 |  | test | forgotten: user asked |\n<!--- gbrain:facts:end -->\n';
    await page(engine, 'crm/widget-co', 'crm', 'CRM record: Widget Co', `Account code: WGCO\n\n${fence}`);
    await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Internal nickname: Private Plover', { frontmatter: { visibility: 'private' } });
    await sweep(engine);
    const { json } = await call('entity', { name: 'WGCO' }, remote);
    const text = JSON.stringify(json.card);
    for (const secret of ['Hidden Heron', 'Gone Gull', 'Private Plover', 'accounts/widget-co']) expect(text).not.toContain(secret);
    const localCard = (await buildEntityCard(engine, 'default', 'WGCO', { remote: false, includeReferences: true })).card!;
    expect(JSON.stringify(localCard.identity_excerpt)).not.toContain('Hidden Heron');
    expect(JSON.stringify(localCard.identity_excerpt)).not.toContain('Gone Gull');
    expect(localCard.identity_siblings?.pages.map(p => p.slug)).toEqual(['accounts/widget-co']);
  });

  test('caps: 600 characters per page, 1,200 per card; omitted pages are listed', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Contact ${i}: Person Number${i} Example`).join('\n');
    expect(excerptLines(long, 'X').join('').length).toBeLessThanOrEqual(EXCERPT_PAGE_CHARS);
    await page(engine, 'accounts/a', 'account', 'Account sheet: Widget Co', long);
    await page(engine, 'crm/b', 'crm', 'CRM record: Widget Co', long);
    await page(engine, 'billing/c', 'account', 'Billing record: Widget Co', long);
    await sweep(engine);
    const card = (await buildEntityCard(engine, 'default', 'crm/b', { remote: false, includeReferences: true })).card!;
    expect(card.identity_excerpt!.reduce((n, l) => n + l.line.length, 0)).toBeLessThanOrEqual(EXCERPT_CARD_CHARS);
    expect(card.identity_excerpt_omitted!.length).toBeGreaterThan(0);
  });
});
