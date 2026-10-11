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
import { aliasRejection, declaredNames, deriveEntityAliases, titleSubject } from '../src/core/mentions/aliases.ts';

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
    const r = deriveEntityAliases({ title: 'CRM record: Quormiro Capital', compiled_truth: 'Ticker: QCO. Also known as Quormiro Capital. aka Team' });
    expect(r.aliases.map(a => a.alias_text)).toEqual(['Quormiro Capital']);
    expect(r.rejected).toEqual(expect.arrayContaining([
      { alias: 'QCO', origin: 'declared', reason: 'below_min_length' },
      { alias: 'Quormiro', origin: 'declared', reason: 'ambiguous_first_word' },
      { alias: 'Team', origin: 'declared', reason: 'generic_token' },
    ]));
    expect(aliasRejection('Grace', 'Grace Hopper-Example')).toBe('ambiguous_first_word');
  });

  test('"aka Mark" is a case-sensitive single-token alias', () => {
    const [mark] = deriveEntityAliases({ title: 'Marcus Example', compiled_truth: 'Marcus, aka Mark, runs sales.' }).aliases;
    expect(mark).toMatchObject({ alias_text: 'Mark', case_sensitive: true, origin: 'declared' });
  });

  test('derived aliases preserve the shared declaration parser', () => {
    expect(declaredNames('Account code: QUCO.', 'Quormiro Capital')).toEqual(['QUCO']);
    expect(deriveEntityAliases({title:'CRM record: Quormiro Capital',compiled_truth:'Account code: QUCO.'}).aliases)
      .toContainEqual(expect.objectContaining({alias_text:'QUCO',origin:'declared',case_sensitive:true}));
  });
});
