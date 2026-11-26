/**
 * BrainEngine parity — the fact reads of an ordinary member and of a labelled-only member with access.members_read_lineage
 * on (row 32e-b-4): one case for each of the 12 families of fact reads that apply the private-provenance policy
 * (storePrivacyPolicy in src/core/rust-engine/store-members/private-provenance.ts), each called under the caller record
 * a stdio member read builds, on PGLite, Postgres and Rust.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with lineage on, a fact is read through its provenance page as the SQL renders it. privateProvenanceFilterUnderPolicy
 *    (form 1: the fact lists, the relevance pool, the similar-fact list, factReadableUnder) judges the caller's own member page by
 *    its identity, any other member page by the empty identity, and every other page by the member's lineage (lineageAccessSql: its
 *    readers, its folder rules, and for a derived page its origins), AND the entity page, AND for a labelled-only member the page
 *    must name it (labelledOnlyFactSql: its own member page, or, with lineage, a provenance page that names it or is derived from
 *    origins that all name it). privateFactFilterForCaller (form 2: saved-fact matching, newest facts of an entity, the brief
 *    world facts, contested pairs, counts, ontology, row attribution) judges the provenance page by the plain no-caller policy, so
 *    lineage changes only its labelled-only conjunct. A fact the caller may not read is absent from every list and its
 *    single-fact reads answer false or null, on every engine.
 *  - Regression: the Rust store refused every one of these reads with engine_capability_missing when lineage was on, for every
 *    member (storePrivacyPolicy: "a lineage read refuses"). Each family below returns a refusal as a value ({ refused }), so an arm
 *    that still refuses fails the comparison with PGLite instead of counting as stopped.
 *  - Pending prefixes: a record that holds a pending folder prefix hides a page under it. The policy the Rust store is sent must
 *    send the record's folder coverage with the lineage flag (a field missing there was a leak in row 32e-b-2), so a fact held on
 *    a page under a pending prefix, and a fact about an entity page under one, are cases of every family.
 *  - Why existing coverage misses it: folder-rule-fact-reads.test.ts reads facts through one list read and a recall, and its
 *    lineage case was a named stop; no case called the other families under a lineage record.
 *  - Seam: members through createMember and the typed labelled-only write; folder rules through restrictFolder; the caller record
 *    is the one remoteCallerAccess builds for a stdio member.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { rustAccessBrain } from './rust-arm.ts';

const { parityTest } = parityArms(testBackends());

const CAROL = 'carol-example';
const DANA = 'dana-example';
const MEMBERS = [CAROL, DANA] as const;
const CAROL_PAGE = `memory/members/${CAROL}`;
const DANA_PAGE = `memory/members/${DANA}`;
const ENTITY = 'people/open-example';
const ENTITY_BOB = 'people/bob-only-example';
const ENTITY_PENDING = 'pend/entity-example';
const ENTITIES = [ENTITY, ENTITY_BOB, ENTITY_PENDING];
const WORD = 'zzlineagefact';

/** A provenance page: its slug, type and frontmatter. */
interface PageSeed { slug: string; type?: string; frontmatter: Record<string, unknown> }
const WORLD = { visibility: 'world' } as const;
const PAGES: readonly PageSeed[] = [
  { slug: ENTITY, type: 'person', frontmatter: {} },
  { slug: ENTITY_BOB, type: 'person', frontmatter: { readable_by: ['bob-example'] } },
  { slug: ENTITY_PENDING, type: 'person', frontmatter: { readable_by: ['group:team-a'] } },
  { slug: 'open/plain', frontmatter: {} },
  { slug: 'open/readers-carol', frontmatter: { readable_by: [CAROL] } },
  { slug: 'open/readers-group', frontmatter: { readable_by: ['group:team-a'] } },
  { slug: 'open/readers-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'open/origin-carol', frontmatter: { readable_by: [CAROL] } },
  { slug: 'open/origin-dana', frontmatter: { readable_by: [DANA] } },
  { slug: 'open/origin-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'walk/atom-carol', type: 'atom', frontmatter: { ...WORLD, source_slug: 'open/origin-carol' } },
  { slug: 'walk/atom-dana', type: 'atom', frontmatter: { ...WORLD, source_slug: 'open/origin-dana' } },
  { slug: 'walk/atom-bob', type: 'atom', frontmatter: { ...WORLD, source_slug: 'open/origin-bob' } },
  { slug: 'walk/null-mix', frontmatter: { ...WORLD, derived_from: ['open/origin-carol.md', null] } },
  { slug: 'walk/null-only', frontmatter: { ...WORLD, derived_from: [null] } },
  { slug: 'memory/members/bob-example', frontmatter: { readable_by: ['member:bob-example'] } },
  { slug: CAROL_PAGE, frontmatter: { readable_by: [`member:${CAROL}`] } },
  { slug: DANA_PAGE, frontmatter: { readable_by: [`member:${DANA}`] } },
  { slug: 'ruled-carol/open', frontmatter: {} },
  { slug: 'ruled-bob/open', frontmatter: {} },
  { slug: 'open/private-dana', frontmatter: { visibility: 'private', readable_by: [DANA] } },
  { slug: 'open/gone-dana', frontmatter: { readable_by: [DANA, CAROL] } },
  { slug: 'pend/readers-group', frontmatter: { readable_by: ['group:team-a'] } },
  { slug: 'ctrl/readers-group', frontmatter: { readable_by: ['group:team-a'] } },
  // An origin under a raw-only folder rule that carol and dana satisfy (covers_derived false): the rule does not close a page derived
  // from it, so the plain policy passes the atom, and a labelled-only member reads it through its origin only with lineage on.
  { slug: 'raw/origin', frontmatter: {} },
  { slug: 'ctrl/atom-raw', type: 'atom', frontmatter: { ...WORLD, source_slug: 'raw/origin' } },
  { slug: 'ctrl/atom-raw-two', type: 'atom', frontmatter: { ...WORLD, source_slug: 'raw/origin' } },
  { slug: 'pend/atom-raw', type: 'atom', frontmatter: { ...WORLD, source_slug: 'raw/origin' } },
];

/** A fact: the page its text is stored on (the provenance page) and the entity it is about. */
interface FactSeed { id: string; provenance: string; entity?: string }
const FACTS: readonly FactSeed[] = [
  { id: 'plain', provenance: 'open/plain' },
  { id: 'readers-carol', provenance: 'open/readers-carol' },
  { id: 'readers-group', provenance: 'open/readers-group' },
  { id: 'readers-bob', provenance: 'open/readers-bob' },
  { id: 'atom-carol', provenance: 'walk/atom-carol' },
  { id: 'atom-dana', provenance: 'walk/atom-dana' },
  { id: 'atom-bob', provenance: 'walk/atom-bob' },
  { id: 'null-mix', provenance: 'walk/null-mix' },
  { id: 'null-only', provenance: 'walk/null-only' },
  { id: 'member-bob', provenance: 'memory/members/bob-example' },
  { id: 'own-carol', provenance: CAROL_PAGE },
  { id: 'own-dana', provenance: DANA_PAGE },
  { id: 'ruled-carol', provenance: 'ruled-carol/open' },
  { id: 'ruled-bob', provenance: 'ruled-bob/open' },
  { id: 'private-dana', provenance: 'open/private-dana' },
  { id: 'gone-dana', provenance: 'open/gone-dana' },
  { id: 'pending-page', provenance: 'pend/readers-group' },
  { id: 'control-page', provenance: 'ctrl/readers-group' },
  { id: 'atom-raw', provenance: 'ctrl/atom-raw' },
  { id: 'atom-raw-pending', provenance: 'pend/atom-raw' },
  { id: 'entity-bob', provenance: 'open/readers-group', entity: ENTITY_BOB },
  { id: 'entity-pending', provenance: 'open/readers-group', entity: ENTITY_PENDING },
];
const text = (f: FactSeed): string => `${WORD} marker ${f.id}`;
const LABELS = FACTS.map(f => f.id);

/** Seeded fact ids by label, with the anchor the single-neighbour reads start from. */
interface Seeded { ids: Map<string, number>; anchor: number; old: number }

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-lineage-facts-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

const put = (engine: BrainEngine, p: PageSeed): Promise<unknown> =>
  engine.putPage(p.slug, { type: (p.type ?? 'note') as never, title: p.slug, compiled_truth: `page ${p.slug}`, timeline: '', frontmatter: p.frontmatter }, { sourceId: 'default' });

/** A 1536-wide vector with `head` in the first slots (the similar-fact list ranks by it). */
function vec(...head: number[]): Float32Array {
  const v = new Float32Array(1536);
  head.forEach((x, i) => { v[i] = x; });
  return v;
}

/**
 * A raw-only folder rule (covers_derived false) over `prefix`, listing alice, carol and dana: a page under it names its readers through
 * the rule, and a page derived from one is not closed by it. Harness-only SQL behind the backend switch, as restrictFolder is.
 */
async function rawOnlyRule(engine: BrainEngine, backend: ParityBackend, prefix: string, ruleId: string): Promise<void> {
  const readers = ['member:alice-example', `member:${CAROL}`, `member:${DANA}`];
  await restrictFolder(engine, backend, 'default', 'unused-seed-prefix/', 'pending'); // gives the source its access state, as restrictFolder does
  if (backend === 'rust') {
    await rustAccessBrain(engine).putAccessRule({ source_id: 'default', rule_id: ruleId, prefix, readable_by: readers, revision: 1, covers_derived: false });
    return;
  }
  await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, covers_derived) VALUES ('default', $1, $2, $3::text[], 1, false)`, [ruleId, prefix, readers]);
}

/**
 * Members, rules and pages first, then the facts, then the rules the facts are judged by last (a page written before its rule is
 * not hidden on PGLite): a pending prefix over `pend/`, and a deleted provenance page.
 */
async function seed(engine: BrainEngine, backend: ParityBackend): Promise<Seeded> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com' });
  await createMember(engine, backend, { id: 'bob-example' });
  await createMember(engine, backend, { id: CAROL, groups: ['team-a'] });
  await createMember(engine, backend, { id: DANA, groups: ['team-a'] });
  await setOwner(engine, 'alice-example');
  await setMemberLabelledOnly(engine, CAROL, true, { remote: false });
  await restrictFolder(engine, backend, 'default', 'ruled-carol/', 'rule', { ruleId: 'rule-carol', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  await restrictFolder(engine, backend, 'default', 'ruled-bob/', 'rule', { ruleId: 'rule-bob', readers: ['member:alice-example', 'member:bob-example'] });
  await restrictFolder(engine, backend, 'default', 'memory/members/', 'rule', { ruleId: 'rule-members', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  await rawOnlyRule(engine, backend, 'raw/', 'rule-raw');
  for (const p of PAGES) await put(engine, p);
  await drainProjections(engine);
  const ids = new Map<string, number>();
  for (const [i, f] of FACTS.entries()) {
    const row = { fact: text(f), kind: 'fact', visibility: 'world', source: 'test', entity_slug: f.entity ?? ENTITY, source_markdown_slug: f.provenance, row_num: i + 1, embedding: vec(1, 0.01 * (i + 1)), embedding_model: 'm1' };
    const out = await engine.insertFacts([row] as never, { source_id: 'default' });
    ids.set(f.id, out.ids[0]!);
  }
  // The anchor of the similar-fact list sits on no page. The old side of each contested pair is held on an atom both members read.
  const loose = async (fact: string, row_num: number, over: Record<string, unknown> = {}): Promise<number> =>
    (await engine.insertFacts([{ fact, kind: 'fact', visibility: 'world', source: 'test', entity_slug: ENTITY, source_markdown_slug: 'notes/loose', row_num, embedding: vec(1, 0), embedding_model: 'm1', ...over }] as never, { source_id: 'default' })).ids[0]!;
  const anchor = await loose(`${WORD} anchor`, 101);
  const old = await loose(`${WORD} old`, 102, { source_markdown_slug: 'ctrl/atom-raw' });
  await engine.softDeletePage('open/gone-dana');
  await restrictFolder(engine, backend, 'default', 'pend/', 'pending');
  await setMembersReadLineage(engine, true, { remote: false });
  return { ids, anchor, old };
}

/** The caller record a stdio read builds for `member`, with lineage on; `read` runs under it. */
async function asMember<T>(engine: BrainEngine, member: string, read: () => Promise<T>): Promise<T> {
  const record = await remoteCallerAccess(engine, undefined, [], 'stdio', null, member, true);
  expect(record.lineage).toBe(true);
  expect((record.folderCoverage as unknown[]).length).toBeGreaterThan(0);
  return withCallerAccess({ ...record }, read);
}

/** A typed refusal of the engine as a value, so an arm that still refuses differs from PGLite. */
async function answer<T>(read: () => Promise<T>): Promise<T | { refused: string }> {
  try { return await read(); }
  catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'engine_capability_missing') return { refused: code };
    throw e;
  }
}

/** The labels of the seeded facts a read returned (by id, or by marker text). */
function labelsOf(seeded: Seeded, rows: ReadonlyArray<{ id?: number | string; fact?: string }>): string[] {
  const byId = new Map([...seeded.ids].map(([label, id]) => [id, label]));
  const out = new Set<string>();
  for (const r of rows) {
    const label = r.id !== undefined && byId.has(Number(r.id)) ? byId.get(Number(r.id)) : FACTS.find(f => String(r.fact ?? '').includes(text(f)))?.id;
    if (label) out.add(label);
  }
  return LABELS.filter(l => out.has(l));
}

/** What a family answered for each member: the labels it returned, or the refusal. */
type Seen = Record<string, string[] | { refused: string } | unknown>;

/**
 * The 12 families. `form` says which fact policy the read renders. Each `run` returns the labels the member reads (a count or a
 * list of ids is mapped back to labels), so a leak names the fact.
 */
interface Family {
  name: string;
  form: 1 | 2;
  needs?: 'proposals' | 'ontology' | 'uncomparable';
  run: (engine: BrainEngine, seeded: Seeded) => Promise<unknown>;
  /** The member's answer against the SQL rules above; a fact it must not read is never in it. */
  check: (member: string, got: any) => void;
}
/**
 * What each member reads, by the SQL rules (derived from the policy text, then confirmed on PGLite; never read off the Rust arm).
 * Form 1 judges the provenance page by the member's lineage: carol (labelled-only) reads a fact only on a page that names her, or
 * (lineage) an atom whose origin does; dana reads what her readers, rules and origins allow. A page under the pending prefix `pend/`,
 * another member's page, a private page and a page that names someone else are hidden from both. Form 2 judges it by the plain
 * no-caller policy: a page that names readers or sits under a rule is hidden from everyone, so dana reads the two plain pages, and
 * carol, whose own pages all name readers, reads only the atom derived from an origin under a raw-only rule (labelled lineage).
 */
const FORM1: Record<string, string[]> = {
  [CAROL]: ['readers-carol', 'readers-group', 'atom-carol', 'own-carol', 'ruled-carol', 'control-page', 'atom-raw'],
  [DANA]: ['plain', 'readers-group', 'atom-dana', 'null-only', 'own-dana', 'ruled-carol', 'control-page', 'atom-raw'],
};
const FORM2: Record<string, string[]> = { [CAROL]: ['atom-raw'], [DANA]: ['plain', 'null-only', 'atom-raw'] };
const WANT = (form: 1 | 2, member: string): string[] => (form === 1 ? FORM1 : FORM2)[member]!;
const ALL = (s: Seeded): number[] => [...s.ids.values()];

const FAMILIES: readonly Family[] = [
  { name: 'fact lists (listFactsSince, listFactsByEntity, listFactsByEntities)', form: 1, run: async (engine, s) => ({
    since: labelsOf(s, await engine.listFactsSince('default', new Date(0), { excludePrivate: true, visibility: ['world'], limit: 100 } as never)),
    byEntity: labelsOf(s, await engine.listFactsByEntity('default', ENTITY, { excludePrivate: true, visibility: ['world'], limit: 100 } as never)),
    byBob: labelsOf(s, await engine.listFactsByEntity('default', ENTITY_BOB, { excludePrivate: true, visibility: ['world'], limit: 100 } as never)),
    byPending: labelsOf(s, await engine.listFactsByEntity('default', ENTITY_PENDING, { excludePrivate: true, visibility: ['world'], limit: 100 } as never)),
  }), check: (m, g) => { for (const k of ['since', 'byEntity']) expect(g[k]).toEqual(WANT(1, m)); expect(g.byBob).toEqual([]); expect(g.byPending).toEqual([]); } },
  { name: 'the relevance pool (listFactsForRelevance, countUncomparableFacts)', form: 1, needs: 'uncomparable', run: async (engine, s) => {
    const scope = { sourceIds: ['default'], worldOnly: true, excludePrivate: true };
    return {
      keyword: labelsOf(s, await engine.listFactsForRelevance({ arm: 'keyword', scope, vector: null, terms: WORD, limit: 100 })),
      entity: labelsOf(s, await engine.listFactsForRelevance({ arm: 'entity', scope, vector: null, entity: { sourceId: 'default', slug: ENTITY }, limit: 100 })),
      uncomparable: await engine.countUncomparableFacts({ scope, dims: 1536, model: 'm1', declared: true }),
    };
  }, check: (m, g) => { expect(g.keyword).toEqual(WANT(1, m)); expect(g.entity).toEqual(WANT(1, m)); expect(g.uncomparable).toEqual([{ source_id: 'default', n: WANT(1, m).length }]); } },
  { name: 'listSimilarActiveFacts', form: 1, run: async (engine, s) =>
    labelsOf(s, (await engine.listSimilarActiveFacts({ sourceId: 'default', factId: s.anchor, remote: true, excludePrivate: true, minCosine: 0, limit: 100 })).rows as never), check: (m, g) => expect(g).toEqual(LABELS.filter(l => WANT(1, m).includes(l) || l === 'gone-dana')) },
  // anyVisibility true: the world-only form renders a visibility list that a member's own member page widens, which the Rust store refuses
  // with lineage off too (row 32e-b-5, labelled-only-floor-stops.test.ts); the policy under test is the same private-provenance policy.
  { name: 'factReadableUnder', form: 1, run: async (engine, s) => {
    const read: string[] = [];
    for (const [label, id] of s.ids) if (await engine.factReadableUnder({ id, sourceId: 'default', anyVisibility: true, eligibility: undefined, excludePrivate: true })) read.push(label);
    return LABELS.filter(l => read.includes(l));
  }, check: (m, g) => expect(g).toEqual(WANT(1, m)) },
  { name: 'readBriefWorldFacts', form: 2, run: async (engine, s) => labelsOf(s, await engine.readBriefWorldFacts(ALL(s))), check: (m, g) => expect(g).toEqual(WANT(2, m)) },
  { name: 'countWorldFacts', form: 2, run: async (engine) =>
    engine.countWorldFacts({ sourceId: 'default', entitySlugs: ENTITIES, worldOnly: true, excludePrivate: true }), check: (m, g) => expect(g).toBe(WANT(2, m).length + 1 + (m === DANA ? 1 : 0)) },
  { name: 'readEntityNewestFacts', form: 2, run: async (engine, s) =>
    labelsOf(s, await engine.readEntityNewestFacts({ sourceId: 'default', slugs: ENTITIES, remote: true, worldOnly: true } as never)), check: (m, g) => expect(g).toEqual(WANT(2, m)) },
  { name: 'matchSavedFacts (the saved-facts arm of search)', form: 2, run: async (engine, s) =>
    labelsOf(s, await engine.matchSavedFacts({ sources: ['default'], terms: [WORD, 'marker'], pats: [null, null], cue: CORRECTION_CUE, supersede: false, excludePrivate: true, worldOnly: true } as never)), check: (m, g) => expect(g).toEqual(WANT(2, m)) },
  { name: 'listContestedProposalPairs', form: 2, needs: 'proposals', run: async (engine, s) => {
    const rows = await engine.listContestedProposalPairs(ALL(s), { remote: true, excludePrivate: true });
    return labelsOf(s, rows.map(r => ({ id: r.new_fact_id })));
  }, check: (m, g) => expect(g).toEqual(WANT(2, m)) },
  { name: 'getOntology', form: 2, needs: 'ontology', run: async (engine) => {
    const out: Record<string, string[]> = {};
    for (const entity of ENTITIES) out[entity] = (await engine.getOntology(entity, { excludePrivate: true, includeQuarantined: true })).map(r => `${r.dimension}=${r.value}`).sort();
    return out;
  }, check: (m, g) => { const values = Object.values(g as Record<string, string[]>).flat(); for (const id of LABELS) expect({ id, shown: values.some(v => v === `role_${id.replace(/-/g, '_')}=from-${id}`) }).toEqual({ id, shown: WANT(2, m).includes(id) }); expect(g[ENTITY_BOB]).toEqual([]); expect(g[ENTITY_PENDING]).toEqual([]); } },
  { name: 'findOntologyConflicts', form: 2, needs: 'ontology', run: async (engine) =>
    (await engine.findOntologyConflicts({ excludePrivate: true })).map(c => `${c.entity_slug}:${c.dimension}:${c.values.length}`).sort(), check: (m, g) => expect(g).toEqual(m === CAROL ? [`${ENTITY}:role_atom_raw:2`] : [`${ENTITY}:role_atom_raw:3`, `${ENTITY}:role_null_only:2`]) },
  { name: 'readRowAttribution (a fact)', form: 2, run: async (engine, s) => {
    const read: string[] = [];
    for (const f of FACTS) {
      const row = await engine.readRowAttribution({ kind: 'fact', id: s.ids.get(f.id)!, sourceId: 'default', slug: f.entity ?? ENTITY, worldOnly: true, excludePrivate: true });
      if (row) read.push(f.id);
    }
    return LABELS.filter(l => read.includes(l));
  }, check: (m, g) => expect(g).toEqual(WANT(2, m)) },
];
const CORRECTION_CUE = String.raw`\m(correction|retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what))\M`;

/** Ontology rows for the ontology families: a value from each provenance page, and a rival from an open page on the same dimension. */
async function seedOntology(engine: BrainEngine): Promise<void> {
  const from = (slug: string, validFrom: string, entity: string, dimension: string, value: string) =>
    engine.mergeOntologyFact({ entitySlug: entity, dimension, value, source: slug, validFrom, visibility: 'world', status: 'active' });
  for (const f of FACTS) {
    await from(f.provenance, '2026-05-01', f.entity ?? ENTITY, `role-${f.id}`, `from-${f.id}`);
    // A second, older value of the same dimension from an open page: a conflict exists for a caller that reads both values.
    await from('open/plain', '2026-01-01', f.entity ?? ENTITY, `role-${f.id}`, `rival-${f.id}`);
  }
  // A third value of one dimension from a second atom both members read: a labelled-only member sees two sources, so a conflict.
  await from('ctrl/atom-raw-two', '2026-03-01', ENTITY, 'role-atom-raw', 'second-atom-raw');
}

/** One family's case body: seed, add the rows the family needs, read as each member, and answer the labels (never a refusal). */
function body(name: string): (engine: BrainEngine, backend: ParityBackend) => Promise<Seen> {
  const family = FAMILIES.find(f => f.name.startsWith(name))!;
  return (engine, backend) => inFreshHome(async () => {
    const seeded = await seed(engine, backend);
    if (family.needs === 'proposals') {
      for (const [i, f] of FACTS.entries()) {
        expect(await engine.insertDecideProposal({
          source_id: 'default', sweep_id: 'sweep-1', pair_index: i, new_fact_id: seeded.ids.get(f.id)!, old_fact_id: seeded.old,
          direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a',
        })).not.toBeNull();
      }
    }
    if (family.needs === 'ontology') await seedOntology(engine);
    if (family.needs === 'uncomparable') {
      // A twin of each fact embedded by another model: the count of facts that cannot be compared is read through the same policy.
      for (const [i, f] of FACTS.entries()) {
        await engine.insertFacts([{ fact: `${WORD} marker u-${f.id}`, kind: 'fact', visibility: 'world', source: 'test', entity_slug: f.entity ?? ENTITY, source_markdown_slug: f.provenance, row_num: 201 + i, embedding: vec(1, 0.5), embedding_model: 'm2' }] as never, { source_id: 'default' });
      }
    }
    const seen: Seen = {};
    for (const member of MEMBERS) seen[member] = await asMember(engine, member, () => answer(() => family.run(engine, seeded)));
    // A refusal is the Rust store declining what the SQL engines answer: it must be an answer, never a stop.
    expect(JSON.stringify(seen)).not.toContain('refused');
    for (const member of MEMBERS) family.check(member, seen[member]);
    return seen;
  });
}

const OPTS = { timeout: 360_000 } as const;
const caseName = (family: string): string => `${family}: an ordinary and a labelled-only member read the same facts on every engine`;

describe('engine parity: fact reads with access.members_read_lineage on, one case for each of the 12 families', () => {
  parityTest(caseName('fact lists'), { methods: ['putPage', 'insertFacts', 'listFactsSince', 'listFactsByEntity'], ...OPTS }, body('fact lists'));
  parityTest(caseName('the relevance pool'), { methods: ['putPage', 'insertFacts', 'listFactsForRelevance', 'countUncomparableFacts'], ...OPTS }, body('the relevance pool'));
  parityTest(caseName('listSimilarActiveFacts'), { methods: ['putPage', 'insertFacts', 'listSimilarActiveFacts'], ...OPTS }, body('listSimilarActiveFacts'));
  parityTest(caseName('factReadableUnder'), { methods: ['putPage', 'insertFacts', 'factReadableUnder'], ...OPTS }, body('factReadableUnder'));
  parityTest(caseName('readBriefWorldFacts'), { methods: ['putPage', 'insertFacts', 'readBriefWorldFacts'], ...OPTS }, body('readBriefWorldFacts'));
  parityTest(caseName('countWorldFacts'), { methods: ['putPage', 'insertFacts', 'countWorldFacts'], ...OPTS }, body('countWorldFacts'));
  parityTest(caseName('readEntityNewestFacts'), { methods: ['putPage', 'insertFacts', 'readEntityNewestFacts'], ...OPTS }, body('readEntityNewestFacts'));
  parityTest(caseName('matchSavedFacts'), { methods: ['putPage', 'insertFacts', 'matchSavedFacts'], ...OPTS }, body('matchSavedFacts'));
  parityTest(caseName('listContestedProposalPairs'), { methods: ['putPage', 'insertFacts', 'insertDecideProposal', 'listContestedProposalPairs'], ...OPTS }, body('listContestedProposalPairs'));
  parityTest(caseName('getOntology'), { methods: ['putPage', 'insertFacts', 'mergeOntologyFact', 'getOntology'], ...OPTS }, body('getOntology'));
  parityTest(caseName('findOntologyConflicts'), { methods: ['putPage', 'insertFacts', 'mergeOntologyFact', 'findOntologyConflicts'], ...OPTS }, body('findOntologyConflicts'));
  parityTest(caseName('readRowAttribution'), { methods: ['putPage', 'insertFacts', 'readRowAttribution'], ...OPTS }, body('readRowAttribution'));
});

/** `member`'s remote call through the real dispatch on the stdio member path: its data, 'not_found', or the typed refusal as a value. */
async function remote(engine: BrainEngine, member: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const out = await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: member } as never)
    .catch((e: { code?: string }) => ({ thrown: String(e.code) }));
  if ('thrown' in out) return { refused: out.thrown };
  const body = out.content.map(part => (part as { text?: string }).text ?? '').join('');
  let parsed: unknown = body;
  // A read answers its JSON, then notices as text; a failed parse keeps the text.
  try { parsed = JSON.parse(body.includes('[gbrain') ? body.slice(0, body.indexOf('[gbrain')) : body); } catch { /* plain text */ }
  if (!out.isError) return parsed;
  const code = (parsed as { code?: string } | null)?.code;
  if (code === 'engine_capability_missing') return { refused: code };
  if (/page_not_found/.test(body)) return 'not_found';
  return { error: code ?? body.slice(0, 200) };
}

describe('engine parity: recall and the pages behind each fact with access.members_read_lineage on', () => {
  for (const member of MEMBERS) {
    parityTest(`${member}: recall answers the facts it may read, and a page it may not read comes back not found, on every engine`, {
      methods: ['putPage', 'insertFacts', 'listFactsSince', 'listFactsByEntity'], timeout: 360_000,
    }, (engine, backend) => inFreshHome(async () => {
      await seed(engine, backend);
      const idsOf = (a: unknown): string[] | unknown => {
        if (a && typeof a === 'object' && ('refused' in a || 'error' in a)) return a;
        const facts = ((a as { facts?: Array<{ fact?: string }> } | null)?.facts ?? []).map(f => String(f.fact));
        return FACTS.filter(f => facts.some(t => t.includes(text(f)))).map(f => f.id);
      };
      const recent = idsOf(await remote(engine, member, 'recall', {}));
      const since = idsOf(await remote(engine, member, 'recall', { since: '2000-01-01T00:00:00Z' }));
      const byEntity: Record<string, unknown> = {};
      for (const entity of ENTITIES) byEntity[entity] = idsOf(await remote(engine, member, 'recall', { entity }));
      const pages: Record<string, unknown> = {};
      for (const slug of new Set(FACTS.map(f => f.provenance))) {
        const got = await remote(engine, member, 'get_page', { slug });
        pages[slug] = got === 'not_found' ? got : (got && typeof got === 'object' && 'refused' in got ? got : 'visible');
      }
      // Recall reads facts through form 1 (the fact list policy), so it answers what the family cases above do. The entity pages
      // judged by the member's ordinary access: the open entity answers, the entity only bob reads and the pending one are hidden.
      expect(recent).toEqual(WANT(1, member).filter(l => l !== 'gone-dana'));
      expect(since).toEqual(recent);
      expect(byEntity[ENTITY]).toEqual(recent);
      // A hidden fact's page a member may not read is not found (never a refusal): the facts held on bob's page, a private page and a pending prefix.
      for (const slug of ['open/readers-bob', 'memory/members/bob-example', 'ruled-bob/open', 'open/private-dana', 'pend/readers-group']) {
        expect({ slug, answer: pages[slug] }).toEqual({ slug, answer: 'not_found' });
      }
      return { recent, since, byEntity, pages };
    }));
  }
});
