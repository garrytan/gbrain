/**
 * Entity mention index, pure layer: the pack-aware linkable-type resolver
 * (mentions/policy.ts) and derived alias extraction (mentions/aliases.ts).
 *
 * Protects: which page types become linkable entities per bundled pack (a
 * `type: crm` page links under the init-default pack, `product` never does,
 * the four legacy types always do) and which names an entity page
 * contributes (title subject, body declarations, private fences stripped,
 * case-sensitive single-token codes, the first-word and length guards).
 * Regression: a hard-coded type list again, a private code becoming a public
 * alias, "also known as Quormiro Capital" adding "Quormiro".
 */
import { describe, expect, test } from 'bun:test';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import {
  ALWAYS_LINKABLE_TYPES, canonicalTypeOf, linkableTypesFor, parseNameList, typeAliasPairs,
} from '../src/core/mentions/policy.ts';
import { aliasRejection, captureName, declarationsIn, declaredNames, deriveEntityAliases, titleSubject } from '../src/core/mentions/aliases.ts';
import { aliasDeclarations } from '../src/core/ops/search.ts';

const none = { typeAdds: [], typeRemoves: [] };
const pack = async (name: string) => (await loadResolvedPackByName(name)).manifest;

describe('linkable entity types', () => {
  test('gbrain-base-v2 (init default): account and its alias crm are linkable; product is not', async () => {
    const types = linkableTypesFor(await pack('gbrain-base-v2'), none);
    for (const t of ['person', 'company', 'organization', 'entity', 'account', 'crm', 'contact', 'startup']) expect(types).toContain(t);
    expect(types).not.toContain('product');
    expect(types).not.toContain('project');
    expect(types).not.toContain('deal');
  });

  test('company-brain marks customer, competitor, supplier and distributor', async () => {
    const types = linkableTypesFor(await pack('company-brain'), none);
    for (const t of ['customer', 'competitor', 'supplier', 'distributor', 'entity']) expect(types).toContain(t);
  });

  test('legacy gbrain-base keeps its own entity types; no pack keeps the four', async () => {
    const legacy = linkableTypesFor(await pack('gbrain-base'), none);
    expect(legacy).toContain('person');
    expect(legacy).not.toContain('account');
    expect(linkableTypesFor(null, none)).toEqual([...ALWAYS_LINKABLE_TYPES].sort());
  });

  test('a type: entity page stays linkable under every bundled pack', async () => {
    for (const name of ['gbrain-base', 'gbrain-base-v2', 'company-brain', 'gbrain-recommended', 'gbrain-everything']) {
      expect(linkableTypesFor(await pack(name), none)).toContain('entity');
    }
  });

  test('mentions.entity_types adds and removes, but never the four always-linkable types', async () => {
    const v2 = await pack('gbrain-base-v2');
    const types = linkableTypesFor(v2, { typeAdds: ['project'], typeRemoves: ['account', 'person'] });
    expect(types).toContain('project');
    expect(types).not.toContain('account');
    expect(types).toContain('person');
  });

  test('config lists parse as JSON arrays or comma lists', () => {
    expect(parseNameList('["+project", "-account"]')).toEqual(['+project', '-account']);
    expect(parseNameList('Acme, Widget Co\nfund-a')).toEqual(['Acme', 'Widget Co', 'fund-a']);
    expect(parseNameList(null)).toEqual([]);
  });

  test('canonical type maps stored aliases through the pack; untyped pages group as untyped', async () => {
    const v2 = await pack('gbrain-base-v2');
    expect(canonicalTypeOf('crm', v2)).toBe('account');
    expect(canonicalTypeOf('account', v2)).toBe('account');
    expect(canonicalTypeOf('ticket', v2)).toBe('ticket');
    expect(canonicalTypeOf('', v2)).toBe('untyped');
    const pairs = typeAliasPairs(v2);
    expect(pairs.canonical[pairs.stored.indexOf('crm')]).toBe('account');
  });
});

describe('derived aliases', () => {
  test('title subject and a body code; the full title is not repeated', () => {
    const { aliases } = deriveEntityAliases({ title: 'CRM record: Quormiro Capital', compiled_truth: 'Account code: QUCO\nOwner: Dana' });
    expect(aliases).toEqual([
      { alias_norm: 'quormiro capital', alias_text: 'Quormiro Capital', origin: 'subject', case_sensitive: false },
      { alias_norm: 'quco', alias_text: 'QUCO', origin: 'declared', case_sensitive: true },
    ]);
    expect(titleSubject('Acme Example')).toBeNull();
  });

  test('a code inside a private facts fence is never derived', () => {
    const body = 'Account code: PUBL\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Ticker: SECR | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->\n';
    const norms = deriveEntityAliases({ title: 'CRM record: Widget Co', compiled_truth: body }).aliases.map(a => a.alias_norm);
    expect(norms).toContain('publ');
    expect(norms).not.toContain('secr');
  });

  test('guards: 3-character code, first word of the own name, generic word', () => {
    const r = deriveEntityAliases({ title: 'CRM record: Quormiro Capital', compiled_truth: 'Ticker: QCO. Also known as Quormiro Capital.\nShort name: Quormiro\naka Staff' });
    expect(r.aliases.map(a => a.alias_text)).toEqual(['Quormiro Capital']);
    expect(r.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ alias: 'QCO', origin: 'declared', reason: 'below_min_length' }),
      expect.objectContaining({ alias: 'Quormiro', origin: 'declared', reason: 'ambiguous_first_word' }),
      expect.objectContaining({ alias: 'Staff', origin: 'declared', reason: 'generic_token' }),
    ]));
    expect(aliasRejection('Grace', 'Grace Hopper-Example')).toBe('ambiguous_first_word');
  });

  test('"aka Mark" is a case-sensitive single-token alias', () => {
    const [mark] = deriveEntityAliases({ title: 'Marcus Example', compiled_truth: 'Marcus, aka Mark, runs sales.' }).aliases;
    expect(mark).toMatchObject({ alias_text: 'Mark', case_sensitive: true, origin: 'declared' });
  });

  test('search\'s declared-name fan-out reads the same parser', () => {
    expect(declaredNames('Account code: QUCO.', 'Quormiro Capital')).toEqual(['QUCO']);
    expect(aliasDeclarations([{ slug: 'crm/1', title: 'CRM record: Quormiro Capital', chunk_text: 'Account code: QUCO.' }], 'QUCO renewal'))
      .toEqual([{ name: 'Quormiro Capital', alias: 'QUCO', slug: 'crm/1' }]);
  });
});

// docs/designs/ALIAS_CONVENTIONS.md: one positive fixture per convention, and the negatives the spec names.
describe('declared-name grammar (alias conventions spec)', () => {
  const names = (text: string, name = 'Widget Co') => declaredNames(text, name);

  test.each([
    ['also known as', 'Widget Co, also known as Blue Harbor, renewed.', ['Blue Harbor']],
    ['a.k.a.', 'Widget Co (a.k.a. Blue Harbor) renewed.', ['Blue Harbor']],
    ['known internally as', 'Widget Co, known internally as Project Kestrel, renewed.', ['Project Kestrel']],
    ['nicknamed, quoted', 'The account is nicknamed "Copper Fox".', ['Copper Fox']],
    ['goes by', 'Widget Co goes by WCX in chat.', ['WCX']],
    ['also called', 'Widget Co, also called Northwind Ops.', ['Northwind Ops']],
    ['referred to as, curly quotes', 'commonly referred to as \u201cAtlas North\u201d', ['Atlas North']],
    ['formerly, parenthetical', 'Widget Co (formerly Gearbox Labs) renewed.', ['Gearbox Labs']],
    ['doing business as', 'Widget Co LLC d/b/a Northwind Partners', ['Northwind Partners']],
    ['trading as', 'Widget Co, trading as Harbor Freight Example.', ['Harbor Freight Example']],
    ['short name label', 'Short name: WGCO', ['WGCO']],
    ['code label', 'Account code: QUCO', ['QUCO']],
    ['alias cue', 'Also filed under the alias "Red Kite".', ['Red Kite']],
    ['qualified nickname label', 'Internal nickname: Copper Fox', ['Copper Fox']],
    ['label with a phrase', 'Nickname (sales team): Copper Fox', ['Copper Fox']],
    ['bold key-value list', '- **Aliases:** Copper Fox, WCX', ['Copper Fox', 'WCX']],
    ['plain key-value', 'trading name: Northwind Ops', ['Northwind Ops']],
    ['table row', '| Nickname | Copper Fox |', ['Copper Fox']],
    ['table row, qualified label', '| Former legal name | Gearbox Labs Inc |', ['Gearbox Labs Inc']],
    ['values joined by or', 'Aliases: Copper Fox or Red Kite', ['Copper Fox', 'Red Kite']],
    ['defined term after the own name', 'Widget Co Holdings, Inc. ("Widgetry") signed.', ['Widgetry']],
  ])('%s', (_label, text, want) => {
    expect(names(text, _label === 'defined term after the own name' ? 'Widget Co Holdings' : 'Widget Co')).toEqual(want);
  });

  test.each([
    'the team calls it a success',
    'Dana Example goes by the book.',
    'known as a leader in freight',
    'formerly the head of sales',
    'referred to as needed',
    'aka the usual',
    'aka Monday', 'also known as the Board', 'aka Finance', 'aka Legal', 'aka Q3 Plan', 'aka FY26 Review',
    'Our competitor, also known as Blue Harbor, cut prices.',
    'Their parent company, formerly Gearbox Labs, filed.',
    'also known as Blue Harbor\'s team',
    'also known as Blue Harbor Shipping Lines Group',
    'Another firm ("Bluebird") bid.',
    '| Alias | Notes |\n|---|---|',
  ])('no alias: %s', text => {
    expect(names(text)).toEqual([]);
  });

  test('a capture ends at punctuation, a lowercase word or the line end; the possessive is never part of it', () => {
    expect(captureName(' Copper Fox, renewed')).toBe('Copper Fox');
    expect(captureName(' Copper Fox renewed')).toBe('Copper Fox');
    expect(captureName(' Copper Fox')).toBe('Copper Fox');
    expect(captureName(" Copper Fox's desk")).toBeNull();
    expect(captureName(' "Copper Fox"\'s desk')).toBeNull();
  });

  test('declarations carry their line; multi-word captures can be turned off', () => {
    const text = 'Owner: Dana Example\nInternal nickname: Copper Fox\nAccount code: QUCO';
    expect(declarationsIn(text)).toEqual([{ alias: 'Copper Fox', line: 1 }, { alias: 'QUCO', line: 2 }]);
    expect(declarationsIn(text, { multiword: false })).toEqual([{ alias: 'QUCO', line: 2 }]);
  });

  test('a multi-word alias is case-insensitive; deny lists drop a derived alias', () => {
    const page = { title: 'Account sheet: Widget Co', compiled_truth: 'Internal nickname: Copper Fox\nAccount code: WGCO', frontmatter: { alias_deny: ['WGCO'] } };
    const r = deriveEntityAliases(page);
    expect(r.aliases.map(a => [a.alias_text, a.case_sensitive])).toEqual([['Widget Co', false], ['Copper Fox', false]]);
    expect(r.rejected).toContainEqual({ alias: 'WGCO', origin: 'declared', reason: 'denied', line: 'Account code: WGCO' });
    expect(r.lines.get('copper fox')).toBe('Internal nickname: Copper Fox');
    expect(deriveEntityAliases({ ...page, frontmatter: null }, { deny: ['copper fox'] }).aliases.map(a => a.alias_text)).toEqual(['Widget Co', 'WGCO']);
    expect(deriveEntityAliases({ ...page, frontmatter: null }, { multiword: false }).aliases.map(a => a.alias_text)).toEqual(['Widget Co', 'WGCO']);
  });

  test('parsing stays linear on adversarial lines', () => {
    const line = `aka ${'A '.repeat(5000)}` + `\n| ${'Nickname '.repeat(3000)}|` + `\nNickname: ${'"'.repeat(5000)}`;
    const t0 = performance.now();
    declaredNames(line, 'Widget Co');
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
