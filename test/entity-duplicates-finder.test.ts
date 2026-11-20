/**
 * Duplicate finder (plan autoplan-20261117192252, PR 1): read-only groups of
 * person and company pages that are likely one entity, with evidence and a
 * class. This file is the executable form of the finder contract that
 * gbrain-evals scores (research/entity-resolution/finder-contract.md).
 *
 * Protects: rule A (owner's choice): a shared exclusive key (LinkedIn, GitHub,
 * declared id) plus the same strict name across sources is "clean", and a group
 * sharing only contact or handle keys (email, phone, X handle, domain) is
 * "likely" with a contact_key_only item, unless an exclusive key differs: a
 * contact-only or no-key pair with a vetoing key is a conflict, never proposed;
 * each shared contact or handle key counts the other pages carrying it; a placeholder (empty, 0, all zeros, a placeholder word) or a key
 * value carried by more than five pages is never a key; an id field counts
 * only when the schema pack declares it; a key two different names share
 * goes to the conflict list and nowhere else, so clean groups never chain two
 * different names; inside one source, legacy accent spellings, a root-level
 * copy and an agent-wiki copy of \`people/<x>\` group as "likely"; a lone
 * first-name page beside exactly one full-name page is "thin", and beside two
 * it is nothing; \`distinct_from\` keeps a pair apart; evidence names the
 * matcher, the rule and the key type, never a key value; group ids are
 * stable; both name folds also fold the letters NFKD leaves whole (ø, ł,
 * đ, ß, æ, œ, þ, ı and capitals); evidence lists every key type the members
 * share and every key type they all carry with disjoint values; the finder
 * writes nothing; a different exclusive key (LinkedIn, GitHub, declared id)
 * vetoes clean while a different handle or email only shows; two different
 * domains keep a group out of clean (a US firm and its UK namesake on one
 * LinkedIn page); in a company name a run of single letters folds as one
 * word (L.L.C. = LLC), while a person's initials stay apart; role and
 * household addresses are tagged; free-mail domains are never company keys;
 * a union of clean groups that share a page is checked as a whole; \`gbrain dedupe --preview --json\` keeps
 * an exact versioned key set; matchers are pluggable. PGLite, no repository,
 * no API key. Made-up names only. PGLite always; Postgres too with DATABASE_URL
 * (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  findDuplicateGroups, DEFAULT_MATCHERS, DEDUPE_PREVIEW_SCHEMA_VERSION,
  strictNameFold, variantNameFold,
  type DuplicateGroup, type DuplicateMatcher, type FindDuplicatesOptions,
} from '../src/core/entities/duplicates.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { entityDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { nameWords } from '../src/core/entities/name-variants.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { GITHUB_RESERVED_NAMES } from '../src/core/entities/github-reserved.ts';

for (const backend of testBackends()) describe(backend, () => {
let engine: BrainEngine;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
let clone: { close: () => Promise<void> } | undefined;
beforeAll(async () => {
  if (backend === 'postgres') { template = await persistencePostgresTemplate(requirePostgresTestDatabase()); return; }
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engine = pglite;
}, 120_000);
afterAll(async () => {
  if (backend === 'postgres') { await clone?.close(); await template?.dispose(); return; }
  await engine.disconnect();
});
beforeEach(async () => {
  if (backend === 'postgres') {
    await clone?.close();
    const c = await template!.clone();
    engine = c.engine; clone = c;
  } else {
    await resetPgliteState(engine as PGLiteEngine);
  }
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b'), ('source-c', 'source-c') ON CONFLICT DO NOTHING");
}, 60_000);

const page = (slug: string, type: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') =>
  engine.putPage(slug, { type: type as never, title, compiled_truth: `${title}.`, timeline: '', frontmatter }, { sourceId });

const DECLARED: FindDuplicatesOptions['identityKeys'] = { person: ['external_id'], company: ['registry_id'] };
const members = (g: DuplicateGroup) => g.members.map(m => `${m.source_id}:${m.slug}`).sort();
async function groups(kind?: DuplicateGroup['kind']) {
  return (await findDuplicateGroups(engine, { identityKeys: DECLARED, ...(kind ? { kind } : {}) })).groups;
}

describe('cross-source groups', () => {
  test('a shared email and the same name in two sources is likely, never clean, and the evidence names the key type only', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'Alice@Example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { emails: ['alice@example.com '] }, 'source-b');
    const [g, ...rest] = await groups('cross_source');
    expect(rest).toEqual([]);
    expect(members(g!)).toEqual(['default:people/alice-example', 'source-b:people/alice-example']);
    expect(g!.class).toBe('likely');
    expect(g!.evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'email', field: 'email', key_class: 'contact', role_address: false, other_pages_same_name: 0, other_pages_other_name: 0 });
    for (const e of g!.evidence) expect(Object.keys(e).every(k => ['matcher', 'rule', 'key', 'field', 'key_class', 'role_address', 'other_pages_same_name', 'other_pages_other_name', 'veto'].includes(k))).toBe(true);
    expect(JSON.stringify(g)).not.toContain('example.com');
  });

  test('a declared id keys a group; the same field undeclared does not', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { external_id: 4711 });
    await page('people/alice-example', 'person', 'Alice Example', { external_id: '4711' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'declared_id', field: 'external_id', key_class: 'exclusive' });
    const [undeclared] = (await findDuplicateGroups(engine, { identityKeys: {}, kind: 'cross_source' })).groups;
    expect(undeclared!.class).toBe('weak');
  });

  test('placeholders are never keys: 0, all zeros, empty and placeholder words', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { external_id: 0 });
    await page('people/bob-example', 'person', 'Bob Example', { external_id: '000' }, 'source-b');
    await page('people/carol-example', 'person', 'Carol Example', { email: 'unknown' }, 'source-b');
    await page('people/dan-example', 'person', 'Dan Example', { email: 'N/A' });
    await page('people/erin-example', 'person', 'Erin Example', { email: '' }, 'source-b');
    await page('people/fay-example', 'person', 'Fay Example', { email: '' });
    expect(await groups('conflict')).toEqual([]);
    expect(await groups('cross_source')).toEqual([]);
  });

  test('a key value on more than five pages is crowded: never a key, only counted', async () => {
    for (const n of ['ann', 'ben', 'cal', 'dee', 'eve', 'gus']) await page(`people/${n}-example`, 'person', `${n} Example`, { email: 'office@example.com' }, n < 'd' ? 'default' : 'source-b');
    const res = await findDuplicateGroups(engine, { identityKeys: DECLARED });
    expect(res.groups).toEqual([]);
    expect(res.counts.crowded_key_values).toBe(1);
  });

  test('one key on two different names is a conflict, never a group', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'family@example.com' });
    await page('people/bob-example', 'person', 'Bob Example', { email: 'family@example.com' }, 'source-b');
    expect(await groups('cross_source')).toEqual([]);
    const [c] = await groups('conflict');
    expect(members(c!)).toEqual(['default:people/alice-example', 'source-b:people/bob-example']);
    expect(c!.class).toBe('conflict');
  });

  test('a suffix keeps a parent and child apart even with a shared email', async () => {
    await page('people/sam-example', 'person', 'Sam Example', { email: 'home@example.com' });
    await page('people/sam-example-jr', 'person', 'Sam Example Jr', { email: 'home@example.com' }, 'source-b');
    expect((await groups('cross_source')).filter(g => g.class === 'clean')).toEqual([]);
    expect(await groups('conflict')).toHaveLength(1);
  });

  test('a chain through a shared key never joins two different names into clean groups', async () => {
    await page('people/kim-example', 'person', 'Kim Example', { linkedin: 'linkedin.com/in/kim-example' });
    await page('people/kim-example', 'person', 'Kim Example', { linkedin: 'linkedin.com/in/kim-example', external_id: 99 }, 'source-b');
    await page('people/lee-example', 'person', 'Lee Example', { external_id: 99 });
    const clean = (await groups()).filter(g => g.class === 'clean');
    expect(clean.map(members)).toEqual([['default:people/kim-example', 'source-b:people/kim-example']]);
    const [c] = await groups('conflict');
    expect(members(c!)).toEqual(['default:people/lee-example', 'source-b:people/kim-example']);
  });

  test('the same name with no shared key across sources is weak', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    await page('people/alice-example', 'person', 'Alice Example', {}, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('weak');
    expect(g!.evidence).toEqual([{ matcher: 'same_name', rule: 'strict_name' }]);
  });

  test('company pages group by a declared id the same way', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', { registry_id: 'R-123' });
    await page('companies/acme-example', 'company', 'Acme Example', { registry_id: 'r-123' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'declared_id', field: 'registry_id', key_class: 'exclusive' });
  });

  test('a person and a company never group', async () => {
    await page('people/acme-example', 'person', 'Acme Example');
    await page('companies/acme-example', 'company', 'Acme Example', {}, 'source-b');
    expect(await groups()).toEqual([]);
  });
});

describe('name folds', () => {
  test('both folds fold the letters NFKD leaves whole, capitals included', () => {
    for (const fold of [strictNameFold, variantNameFold]) {
      expect(fold('Søndergaard')).toBe(fold('Sondergaard'));
      expect(fold('ØSTERGÅRD Łukasz Đorđe Straße Æsir Œuvre Þór Iıl')).toBe('ostergard lukasz dorde strasse aesir oeuvre thor iil');
      expect(fold('ŁÆŒÞĐØ')).toBe('laeoethdo');
    }
    expect(strictNameFold('Sam Example Jr.')).toBe('sam example jr');
    for (const n of ['Dr. Ada Søndergaard III', 'Łukasz Ó Example-Sample']) expect(strictNameFold(n)).toBe(nameWords(n).join(' '));
  });

  test('in a company name a run of single letters folds as one word, so a dotted legal suffix matches the plain one', async () => {
    for (const n of ['Iselwood, L.L.C.', 'Iselwood L L C', 'ISELWOOD LLC']) {
      expect(strictNameFold(n, 'company')).toBe('iselwood llc');
      expect(variantNameFold(n, 'company')).toBe('iselwood');
    }
    expect(strictNameFold('D. R. Example')).toBe('d r example');
    expect(strictNameFold('D. R. Example')).not.toBe(strictNameFold('Dr. Example'));
    expect(variantNameFold('D. R. Example', 'person')).not.toBe(variantNameFold('Example', 'person'));
    expect(strictNameFold('Alice B Example')).toBe('alice b example');
    await page('companies/iselwood', 'company', 'Iselwood, L.L.C.', { linkedin: 'linkedin.com/company/iselwood' });
    await page('companies/iselwood', 'company', 'Iselwood LLC', { linkedin: 'https://www.linkedin.com/company/iselwood/' }, 'source-b');
    const [g, ...rest] = await groups('cross_source');
    expect(rest).toEqual([]);
    expect(g!.class).toBe('clean');
  });

  test('Søndergaard and Sondergaard with a shared declared id are one clean group, not a conflict', async () => {
    await page('people/ada-sondergaard', 'person', 'Ada Søndergaard', { external_id: 'ada-1' });
    await page('people/ada-sondergaard', 'person', 'Ada Sondergaard', { external_id: 'ADA-1' }, 'source-b');
    expect(await groups('conflict')).toEqual([]);
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
  });
});

describe('evidence lists every key type', () => {
  test('every shared key type, and every key type the members carry with different values; a different declared id beside only contact keys is a conflict', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', x_handle: '@alice_example', external_id: 11 });
    await page('people/alice-example', 'person', 'Alice Example', { emails: ['ALICE@example.com'], twitter: 'https://x.com/Alice_Example', external_id: 12 }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.evidence).toEqual([
      { matcher: 'key_check', rule: 'contact_key_only' },
      { matcher: 'key_check', rule: 'key_differs', key: 'declared_id', field: 'external_id', key_class: 'exclusive', veto: true },
      { matcher: 'same_name', rule: 'strict_name' },
      { matcher: 'shared_key', rule: 'shared_key', key: 'email', field: 'email', key_class: 'contact', role_address: false, other_pages_same_name: 0, other_pages_other_name: 0 },
      { matcher: 'shared_key', rule: 'shared_key', key: 'x_handle', field: 'x_handle', key_class: 'handle', other_pages_same_name: 0, other_pages_other_name: 0 },
    ]);
    expect(g!.class).toBe('conflict');
    expect(JSON.stringify(g)).not.toMatch(/example\.com|alice_example|"1[12]"/);
  });

  test('values that overlap are not a difference, and placeholders and one-sided keys are ignored', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { emails: ['alice@example.com', 'alice@work.example'], external_id: 0, github: 'alice-example' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', external_id: 7 }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.evidence.filter(e => e.rule === 'key_differs')).toEqual([]);
  });
});

describe('conflicting-key veto', () => {
  const pair = async (a: Record<string, unknown>, b: Record<string, unknown>) => {
    await page('people/alice-example', 'person', 'Alice Example', a);
    await page('people/alice-example', 'person', 'Alice Example', b, 'source-b');
    const [g, ...rest] = await groups('cross_source');
    expect(rest).toEqual([]);
    return g!;
  };

  test('rule A: a shared LinkedIn path plus a shared email is clean', async () => {
    const g = await pair({ email: 'alice@example.com', linkedin: 'https://linkedin.com/in/alice-example' }, { email: 'alice@example.com', linkedin_url: 'linkedin.com/in/alice-example/' });
    expect(g.class).toBe('clean');
    expect(g.evidence).not.toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
  });

  test('a shared email with different GitHub logins is a conflict, never proposed, with the veto kept', async () => {
    const g = await pair({ email: 'alice@example.com', github: 'alice-one' }, { email: 'alice@example.com', github: 'alice-two' });
    expect(g.kind).toBe('cross_source');
    expect(g.class).toBe('conflict');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'github', field: 'github', key_class: 'exclusive', veto: true });
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
  });

  test('rule A: a shared X handle alone is likely, never clean', async () => {
    const g = await pair({ x_handle: '@alice_example' }, { twitter: 'alice_example' });
    expect(g.class).toBe('likely');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
  });

  test('different LinkedIn profiles beside a shared email are a conflict', async () => {
    const g = await pair({ email: 'alice@example.com', linkedin: 'https://www.linkedin.com/in/alice-one/' }, { email: 'alice@example.com', linkedin_url: 'linkedin.com/in/alice-two' });
    expect(g.class).toBe('conflict');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'linkedin', field: 'linkedin', key_class: 'exclusive', veto: true });
  });

  test('different GitHub logins veto clean; a shared declared id keeps the pair likely', async () => {
    const g = await pair({ external_id: 5, github: 'alice-one' }, { external_id: 5, github: '@Alice-Two' });
    expect(g.class).toBe('likely');
  });

  test('the same name with no shared key and different GitHub logins is a conflict, not weak', async () => {
    const g = await pair({ github: 'alice-one' }, { github: 'alice-two' });
    expect(g.class).toBe('conflict');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'github', field: 'github', key_class: 'exclusive', veto: true });
  });

  test('the same LinkedIn profile written two ways is a shared exclusive key', async () => {
    const g = await pair({ linkedin: 'https://www.linkedin.com/in/Alice-One/?trk=x' }, { linkedin_url: 'linkedin.com/in/alice-one' });
    expect(g.class).toBe('clean');
    expect(g.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'linkedin', field: 'linkedin', key_class: 'exclusive' });
  });

  test('a different X handle is a review flag, not a veto', async () => {
    const g = await pair({ linkedin: 'linkedin.com/in/alice-one', x_handle: 'alice_old' }, { linkedin: 'linkedin.com/in/alice-one', x_handle: 'alice_new' });
    expect(g.class).toBe('clean');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'x_handle', field: 'x_handle', key_class: 'handle', veto: false });
  });

  test('a different email is not a veto', async () => {
    const g = await pair({ email: 'alice@work.example', github: 'alice-one' }, { email: 'alice@home.example', github: 'alice-one' });
    expect(g.class).toBe('clean');
    expect(g.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'email', field: 'email', key_class: 'contact', veto: false });
  });
});

describe('role and household addresses', () => {
  test('a shared role or household address is tagged, not dropped; plus-tags and dots are not stripped', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'Team@example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'team@example.com' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { email: 'family@example.org' });
    await page('people/bob-example', 'person', 'Bob Example', { email: 'family@example.org' }, 'source-b');
    await page('people/cy-example', 'person', 'Cy Example', { email: 'cy+news@example.net' });
    await page('people/cy-example', 'person', 'Cy Example', { email: 'cy@example.net' }, 'source-b');
    const found = await groups('cross_source');
    const byName = (slug: string) => found.find(g => g.members[0]!.slug === slug)!;
    for (const slug of ['people/alice-example', 'people/bob-example']) {
      expect(byName(slug).class).toBe('likely');
      expect(byName(slug).evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
      expect(byName(slug).evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'email', field: 'email', key_class: 'contact', role_address: true, other_pages_same_name: 0, other_pages_other_name: 0 });
    }
    expect(byName('people/cy-example').class).toBe('weak');
  });
});

describe('other pages that carry a shared contact key', () => {
  test('each shared contact or handle key counts the other pages carrying it, split by same and other name, never naming them', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', linkedin: 'linkedin.com/in/alice-example' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { email: 'alice@example.com' }, 'source-c');
    await page('companies/alice-example', 'company', 'Alice Example', { email: 'alice@example.com' });
    const found = await groups();
    const pair = found.find(g => g.kind === 'cross_source')!;
    expect(members(pair)).toEqual(['default:people/alice-example', 'source-b:people/alice-example']);
    expect(pair.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'email', field: 'email', key_class: 'contact', role_address: false, other_pages_same_name: 1, other_pages_other_name: 1 });
    expect(pair.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'linkedin', field: 'linkedin', key_class: 'exclusive' });
    expect(JSON.stringify(pair)).not.toContain('example.com');
  });
});

describe('phone numbers', () => {
  test('a phone written two ways is one contact key, compared as digits', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { phone: '+1 (555) 010-4477' });
    await page('people/alice-example', 'person', 'Alice Example', { phones: ['15550104477'] }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('likely');
    expect(g!.evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'phone', field: 'phone', key_class: 'contact', other_pages_same_name: 0, other_pages_other_name: 0 });
    expect(JSON.stringify(g)).not.toContain('0104477');
  });

  test('all zeros and too-short numbers are never keys', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { phone: '000-000-0000' });
    await page('people/alice-example', 'person', 'Alice Example', { phone: '(000) 000 0000' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { phone: '12345' });
    await page('people/bob-example', 'person', 'Bob Example', { phone: '1-2345' }, 'source-b');
    expect((await groups('cross_source')).map(g => g.class)).toEqual(['weak', 'weak']);
  });

  test('a number on more than five pages is crowded', async () => {
    for (const n of ['ann', 'ben', 'cal', 'dee', 'eve', 'gus']) await page(`people/${n}-example`, 'person', `${n} Example`, { phone: '+1 555 010 9999' }, n < 'd' ? 'default' : 'source-b');
    const res = await findDuplicateGroups(engine, { identityKeys: DECLARED });
    expect(res.groups).toEqual([]);
    expect(res.counts.crowded_key_values).toBe(1);
  });
});

describe('GitHub URLs', () => {
  test('every reserved GitHub name is a lowercase login-shaped word, since the github key compares a lowercased login against the set', () => {
    expect([...GITHUB_RESERVED_NAMES].filter(n => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(n))).toEqual([]);
  });

  test('route words GitHub serves its own pages at (enterprises, watching, customer-stories) and the deleted-user placeholder give no key', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', { github: 'https://github.com/enterprises/acme-example' });
    await page('companies/acme-example', 'company', 'Acme Example', { github: 'github.com/enterprises/acme-example/people' }, 'source-b');
    await page('people/alice-example', 'person', 'Alice Example', { github: 'https://github.com/watching' });
    await page('people/alice-example', 'person', 'Alice Example', { github: 'https://github.com/customer-stories/acme-example' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { github: 'ghost' });
    await page('people/bob-example', 'person', 'Bob Example', { github: '@ghost' }, 'source-b');
    const found = await groups('cross_source');
    expect(found.map(g => g.class)).toEqual(['weak', 'weak', 'weak']);
    for (const g of found) expect(g.evidence.filter(e => e.key === 'github')).toEqual([]);
  });

  test('a login GitHub still serves as a profile stays a key, even when it looks like a route word', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { github: 'https://github.com/inbox' });
    await page('people/alice-example', 'person', 'Alice Example', { github: 'inbox' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'github', field: 'github', key_class: 'exclusive' });
  });

  test('a URL under a path GitHub reserves (orgs, sponsors, settings and the like) names no login and gives no key', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { github: 'https://github.com/orgs/acme-example' });
    await page('people/alice-example', 'person', 'Alice Example', { github: 'github.com/orgs/acme-example/people' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { github: 'https://github.com/sponsors/bob-example' });
    await page('people/bob-example', 'person', 'Bob Example', { github: 'https://github.com/settings/profile' }, 'source-b');
    const found = await groups('cross_source');
    expect(found.map(g => g.class)).toEqual(['weak', 'weak']);
    for (const g of found) expect(g.evidence.filter(e => e.key === 'github')).toEqual([]);
  });
});

describe('company domains', () => {
  test('a company website or domain is a contact key; a free-mail domain never is', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', { website: 'https://www.Acme-Example.com/about' });
    await page('companies/acme-example', 'company', 'Acme Example', { domain: 'acme-example.com' }, 'source-b');
    await page('companies/bolt-example', 'company', 'Bolt Example', { domain: 'gmail.com' });
    await page('companies/bolt-example', 'company', 'Bolt Example', { website: 'https://outlook.com' }, 'source-b');
    const found = await groups('cross_source');
    const acme = found.find(g => g.members[0]!.slug === 'companies/acme-example')!;
    expect(acme.class).toBe('likely');
    expect(acme.evidence).toContainEqual({ matcher: 'key_check', rule: 'contact_key_only' });
    expect(acme.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'domain', field: 'domain', key_class: 'contact', other_pages_same_name: 0, other_pages_other_name: 0 });
    expect(found.find(g => g.members[0]!.slug === 'companies/bolt-example')!.class).toBe('weak');
  });

  test('rule A: a company pair sharing a LinkedIn company path is clean', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', { linkedin: 'https://www.linkedin.com/company/acme-example/', domain: 'acme-example.com' });
    await page('companies/acme-example', 'company', 'Acme Example', { linkedin_url: 'linkedin.com/company/acme-example' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
    expect(g!.evidence).toContainEqual({ matcher: 'shared_key', rule: 'shared_key', key: 'linkedin', field: 'linkedin', key_class: 'exclusive' });
  });

  test('two same-name companies on one LinkedIn company page with different domains are likely, not clean', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', { linkedin: 'https://www.linkedin.com/company/acme-example/', domain: 'acme-example.com', country: 'US' });
    await page('companies/acme-example', 'company', 'Acme Example', { linkedin: 'linkedin.com/company/acme-example', website: 'https://acme-example.co.uk', country: 'UK' }, 'source-b');
    await page('companies/bolt-example', 'company', 'Bolt Example', { linkedin: 'linkedin.com/company/bolt-example', domain: 'bolt-example.com' });
    await page('companies/bolt-example', 'company', 'Bolt Example', { linkedin: 'linkedin.com/company/bolt-example', website: 'https://www.bolt-example.com/about' }, 'source-b');
    const bySlug = new Map((await groups('cross_source')).map(g => [g.members[0]!.slug, g]));
    expect(bySlug.get('companies/acme-example')!.class).toBe('likely');
    expect(bySlug.get('companies/acme-example')!.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'domain', field: 'domain', key_class: 'contact', veto: false });
    expect(bySlug.get('companies/bolt-example')!.class).toBe('clean');
  });

  test('a person page has no domain key', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { domain: 'alice-example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { domain: 'alice-example.com' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('weak');
  });
});

describe('LinkedIn profile URLs', () => {
  test('a malformed profile path with an empty id gives no key, so two pages carrying it never match on it', async () => {
    for (const [slug, type, title, url] of [
      ['people/alice-example', 'person', 'Alice Example', 'https://www.linkedin.com/in//x'],
      ['people/bob-example', 'person', 'Bob Example', 'linkedin.com/pub//'],
      ['companies/acme-example', 'company', 'Acme Example', 'https://linkedin.com/company//x'],
    ] as const) {
      await page(slug, type, title, { linkedin: url });
      await page(slug, type, title, { linkedin_url: url }, 'source-b');
    }
    const found = await groups('cross_source');
    expect(found.map(g => g.class)).toEqual(['weak', 'weak', 'weak']);
    for (const g of found) expect(g.evidence.filter(e => e.key === 'linkedin')).toEqual([]);
  });

  test('two legacy /pub/ profiles with one name but different ids are different keys, never clean', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'https://www.linkedin.com/pub/alice-example/12/345/678' });
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'https://www.linkedin.com/pub/alice-example/98/765/432/' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).not.toBe('clean');
    expect(g!.evidence).toContainEqual({ matcher: 'key_check', rule: 'key_differs', key: 'linkedin', field: 'linkedin', key_class: 'exclusive', veto: true });
  });

  test('the same legacy /pub/ profile in two sources is one exclusive key', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'https://www.linkedin.com/pub/alice-example/12/345/678' });
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/pub/alice-example/12/345/678/' }, 'source-b');
    const [g] = await groups('cross_source');
    expect(g!.class).toBe('clean');
  });
});

describe('the union of clean groups that share a page', () => {
  test('a union with one page per source and no veto is one clean group', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' });
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example', github: 'alice-one' }, 'source-b');
    await page('people/alice-example', 'person', 'Alice Example', { github: 'alice-one' }, 'source-c');
    const [g, ...rest] = await groups('cross_source');
    expect(rest).toEqual([]);
    expect(members(g!)).toEqual(['default:people/alice-example', 'source-b:people/alice-example', 'source-c:people/alice-example']);
    expect(g!.class).toBe('clean');
  });

  test('a bridge page that joins two pages of one source sends the union to review', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' });
    await page('people/alice-example', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example', github: 'alice-two' }, 'source-b');
    await page('people/alice-example-2', 'person', 'Alice Example', { github: 'alice-two' });
    const found = await groups('cross_source');
    expect(found.filter(g => g.class === 'clean')).toEqual([]);
    const [g] = found;
    expect(members(g!)).toEqual(['default:people/alice-example', 'default:people/alice-example-2', 'source-b:people/alice-example']);
    expect(g!.class).toBe('likely');
    expect(g!.evidence).toContainEqual({ matcher: 'key_check', rule: 'union_check_failed' });
  });

  test('a union never joins two pages one of them declares distinct_from the other', async () => {
    await page('people/alice-a', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' });
    await page('people/alice-b', 'person', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example', github: 'alice-one' }, 'source-b');
    await page('people/alice-c', 'person', 'Alice Example', { github: 'alice-one', distinct_from: ['people/alice-a'] }, 'source-c');
    const found = await groups('cross_source');
    expect(found.filter(g => members(g).includes('default:people/alice-a') && members(g).includes('source-c:people/alice-c'))).toEqual([]);
    expect(found.map(g => [members(g), g.class])).toEqual(expect.arrayContaining([
      [['default:people/alice-a', 'source-b:people/alice-b'], 'clean'],
      [['source-b:people/alice-b', 'source-c:people/alice-c'], 'clean'],
    ]));
  });

  test('a veto between two pages of the union sends it to review', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { github: 'alice-gh', linkedin: 'linkedin.com/in/alice-one' });
    await page('people/alice-example', 'person', 'Alice Example', { github: 'alice-gh', external_id: 31 }, 'source-b');
    await page('people/alice-example', 'person', 'Alice Example', { external_id: 31, linkedin: 'linkedin.com/in/alice-two' }, 'source-c');
    const found = await groups('cross_source');
    expect(found.filter(g => g.class === 'clean')).toEqual([]);
    expect(found[0]!.evidence).toContainEqual({ matcher: 'key_check', rule: 'union_check_failed' });
  });
});

describe('same-source groups', () => {
  test('legacy accent spellings of one name group as likely', async () => {
    await page('people/jose-example', 'person', 'José Example');
    await page('people/jos-example', 'person', 'José Example');
    await page('people/jos-e-example', 'person', 'José Example');
    const [g, ...rest] = await groups('in_source');
    expect(rest).toEqual([]);
    expect(members(g!)).toEqual(['default:people/jos-e-example', 'default:people/jos-example', 'default:people/jose-example']);
    expect(g!.class).toBe('likely');
    expect(g!.evidence.map(e => e.rule)).toContain('legacy_accent_slug');
  });

  test('a root-level copy and an agent-wiki copy group with people/<x>', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    await page('alice-example', 'person', 'Alice Example');
    await page('wiki/agents/3/people/alice-example', 'person', 'Alice Example');
    const [g] = await groups('in_source');
    expect(members(g!)).toEqual(['default:alice-example', 'default:people/alice-example', 'default:wiki/agents/3/people/alice-example']);
    expect(g!.evidence.map(e => e.rule)).toEqual(expect.arrayContaining(['agent_wiki_copy', 'root_copy']));
  });

  test('distinct_from keeps two pages apart', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    await page('alice-example', 'person', 'Alice Example', { distinct_from: ['people/alice-example'] });
    expect(await groups('in_source')).toEqual([]);
  });

  test('a one-word first-name page beside exactly one full name is thin', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    await page('people/alice', 'person', 'Alice');
    const [g] = await groups('thin');
    expect(members(g!)).toEqual(['default:people/alice', 'default:people/alice-example']);
    expect(g!.class).toBe('thin');
  });

  test('a first-name page beside two full names with that first name is nothing', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    await page('people/alice-sample', 'person', 'Alice Sample');
    await page('people/alice', 'person', 'Alice');
    expect(await groups('thin')).toEqual([]);
  });
});

describe('preview only', () => {
  test('group ids are stable across runs and the finder writes nothing', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' }, 'source-b');
    await page('people/jose-example', 'person', 'José Example');
    await page('people/jos-example', 'person', 'José Example');
    const count = async () => (await engine.executeRaw<{ t: string; n: number }>(
      `SELECT 'pages' AS t, count(*)::int AS n FROM pages UNION ALL SELECT 'entity_identities', count(*)::int FROM entity_identities
       UNION ALL SELECT 'page_versions', count(*)::int FROM page_versions UNION ALL SELECT 'links', count(*)::int FROM links`)).map(r => `${r.t}=${r.n}`);
    const before = await count();
    const a = await findDuplicateGroups(engine, {});
    const b = await findDuplicateGroups(engine, {});
    expect(b.groups.map(g => g.id)).toEqual(a.groups.map(g => g.id));
    expect(a.groups.length).toBe(2);
    for (const g of a.groups) expect(g.id).toMatch(/^dedupe\/[0-9a-f]{16}$/);
    expect(await count()).toEqual(before);
  });
});

describe('schema pack declares identity keys', () => {
  test('a page type may carry identity_keys', () => {
    const m = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1', name: 'example-pack', version: '1.0.0',
      page_types: [{ name: 'person', primitive: 'entity', identity_keys: ['external_id'] }],
    } as never);
    expect(m.page_types[0]!.identity_keys).toEqual(['external_id']);
  });
});

describe('matchers are pluggable', () => {
  test('an added matcher contributes groups next to the defaults, and the finder stamps its name on the evidence', async () => {
    await page('people/robert-example', 'person', 'Robert Example');
    await page('people/bob-example', 'person', 'Bob Example');
    const nickname: DuplicateMatcher = {
      name: 'test_nickname',
      async propose(scan) {
        const rows = await scan.pages({ type: 'person' });
        const a = rows.find(r => r.slug === 'people/robert-example');
        const b = rows.find(r => r.slug === 'people/bob-example');
        return a && b ? [{ kind: 'in_source', class: 'likely', members: [a, b], evidence: [{ matcher: 'forged', rule: 'nickname' }] }] : [];
      },
    };
    expect(await groups('in_source')).toEqual([]);
    const { groups: found } = await findDuplicateGroups(engine, { matchers: [...DEFAULT_MATCHERS, nickname] });
    const g = found.find(x => x.evidence.some(e => e.rule === 'nickname'));
    expect(members(g!)).toEqual(['default:people/bob-example', 'default:people/robert-example']);
    expect(g!.evidence).toEqual([{ matcher: 'test_nickname', rule: 'nickname' }]);
  });

  test('only the built-in shared-key rule can make a group clean; an added matcher is held at likely', async () => {
    await page('people/robert-example', 'person', 'Robert Example');
    await page('people/bob-example', 'person', 'Bob Example', {}, 'source-b');
    const eager: DuplicateMatcher = {
      name: 'test_eager',
      async propose(scan) {
        const rows = await scan.pages({ type: 'person' });
        return [{ kind: 'cross_source', class: 'clean', members: rows, evidence: [{ rule: 'eager' }] }];
      },
    };
    const { groups: found } = await findDuplicateGroups(engine, { matchers: [...DEFAULT_MATCHERS, eager] });
    expect(found.map(g => g.class)).toEqual(['likely']);
  });
});

describe('gbrain dedupe --preview --json', () => {
  async function run(args: string[]) {
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try { await runDedupe(engine, args); } finally { console.log = log; }
    return out.join('\n');
  }

  test('prints the versioned contract with exactly these keys', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', linkedin: 'linkedin.com/in/alice-example' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    const doc = JSON.parse(await run(['--preview', '--json']));
    expect(doc.schema_version).toBe(DEDUPE_PREVIEW_SCHEMA_VERSION);
    expect(DEDUPE_PREVIEW_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(doc).sort()).toEqual(['counts', 'groups', 'schema_version']);
    expect(Object.keys(doc.counts).sort()).toEqual(['by_class', 'by_kind', 'crowded_key_values']);
    expect(Object.keys(doc.counts.by_kind).sort()).toEqual(['conflict', 'cross_source', 'in_source', 'thin']);
    expect(Object.keys(doc.counts.by_class).sort()).toEqual(['clean', 'conflict', 'likely', 'thin', 'weak']);
    const [g] = doc.groups;
    expect(Object.keys(g).sort()).toEqual(['class', 'evidence', 'id', 'kind', 'members']);
    expect(Object.keys(g.members[0]).sort()).toEqual(['slug', 'source_id']);
    expect(g).toMatchObject({ kind: 'cross_source', class: 'clean' });
    expect(JSON.stringify(doc)).not.toContain('example.com');
  });

  test('the human list tells the owner how to clear a veto', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', github: 'alice-one' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com', github: 'alice-two' }, 'source-b');
    const text = await run(['--preview']);
    expect(text).toContain('if they are one person, correct the wrong id on one page');
    expect(text).not.toContain('alice-one');
  });

  test('--kind and --source narrow the groups, and the command writes nothing', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' }, 'source-b');
    await page('people/jose-example', 'person', 'José Example');
    await page('people/jos-example', 'person', 'José Example');
    const before = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n;
    const inSource = JSON.parse(await run(['--preview', '--json', '--kind', 'in-source']));
    expect(inSource.groups.map((g: any) => g.kind)).toEqual(['in_source']);
    const onlyB = JSON.parse(await run(['--preview', '--json', '--source', 'source-b']));
    expect(onlyB.groups.length).toBe(1);
    expect(onlyB.groups.every((g: any) => g.members.some((m: any) => m.source_id === 'source-b'))).toBe(true);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n).toBe(before);
  });
});

describe('entity_duplicates doctor check', () => {
  const check = async () => {
    const ctx = { engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext;
    const [c] = await entityDuplicatesEntry.run(ctx) as Array<{ name: string; status: string; message: string; details: any }>;
    return c!;
  };

  test('ok on a brain with no duplicates', async () => {
    await page('people/alice-example', 'person', 'Alice Example');
    expect(await check()).toMatchObject({ name: 'entity_duplicates', status: 'ok' });
  });

  test('warns with counts by kind and never prints a key value', async () => {
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' });
    await page('people/alice-example', 'person', 'Alice Example', { email: 'alice@example.com' }, 'source-b');
    await page('people/bob-example', 'person', 'Bob Example', { email: 'family@example.com' });
    await page('people/carol-example', 'person', 'Carol Example', { email: 'family@example.com' }, 'source-b');
    const c = await check();
    expect(c).toMatchObject({ name: 'entity_duplicates', status: 'warn' });
    expect(c.details.counts.by_kind).toMatchObject({ cross_source: 1, conflict: 1 });
    expect(JSON.stringify(c)).not.toContain('example.com');
  });
});
});

describe('a large group of pages with one name', () => {
  test('30,000 same-name pages are grouped in linear time', async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => ({ source_id: 'default', slug: `people/alice-${String(i).padStart(5, '0')}`, title: 'Alice Example', type: 'person', keys: {} }));
    const stub = {
      listAllSources: async () => [{ id: 'default' }],
      getConfig: async () => null,
      listEntityKeyRows: async (opts: { after?: { source_id: string; slug: string }; limit: number }) =>
        rows.filter(r => !opts.after || r.slug > opts.after.slug).slice(0, opts.limit),
    } as unknown as BrainEngine;
    const { groups: found } = await findDuplicateGroups(stub, { identityKeys: {} });
    expect(found).toHaveLength(1);
    expect(found[0]!.members).toHaveLength(30_000);
  }, 5_000); // gstack-timing-ok: before the fix the grouping copied each bucket on every push and compared every pair (over 15 s here); linear work takes well under 1 s
});
