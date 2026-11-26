/**
 * BrainEngine parity — a labelled-only member's remote page reads, and an ordinary member's, with access.members_read_lineage
 * off and on, through the real MCP dispatch (the stdio member path).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a remote member reads a page, a page list, a search, a backlink list and a version list the same way on
 *    PGLite, Postgres and Rust. A labelled-only member (carol-example) reads only the pages that name it: its id or a group
 *    in readable_by, or a folder rule it satisfies; with members-read-lineage on, a derived page also passes when it has an
 *    origin and every origin names it (gbrain_access_origin_labelled_for, v308). An ordinary member (dana-example) reads
 *    what its readers and folder rules allow, and with lineage on a derived page whose origins it reads. A page a caller may
 *    not read comes back page_not_found, and is missing from every list, on every arm.
 *  - Regression: the Rust store refused every remote read of a labelled-only member, and every read of any member with
 *    lineage on, with engine_capability_missing (the policy it could not model), so this brain answered nothing there.
 *    Each case returns a refusal as a value ({ refused }), so a Rust arm that still refuses fails the comparison with
 *    PGLite instead of counting as stopped.
 *  - The walk: gbrain_access_origin_labelled_for is checked branch by branch (atom, concept, question, Life Chronicle event,
 *    declared derived_from; rename and alias; a null, empty or missing origin fails closed).
 *  - Why existing coverage misses it: labelled-access-allowed.test.ts reads get_page and search for one member, and
 *    labelled-only-policy.test.ts covers the writer's side; no parity case read a version list, a backlink list or a
 *    derived page for a labelled-only or lineage caller.
 *  - Seam: members through createMember and the typed labelled-only write; folder rules through restrictFolder; the read is
 *    the real dispatchToolCall with a stdio member.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { createMember, parityArms, resetArm, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';

const { arms, parityTest } = parityArms(testBackends());

const CAROL = 'carol-example';
const DANA = 'dana-example';
const WORD = 'zzreadsword';
type Lineage = 'off' | 'on';

interface Shape { slug: string; type?: string; frontmatter: Record<string, unknown> }

/** The probe's 13 page shapes (labelled-access-allowed.test.ts), plus a derived page whose origin names a group both members are in. */
const SHAPES: readonly Shape[] = [
  { slug: 'open/plain', frontmatter: {} },
  { slug: 'open/readers-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'open/readers-carol', frontmatter: { readable_by: ['carol-example'] } },
  { slug: 'open/readers-group', frontmatter: { readable_by: ['group:team-a'] } },
  { slug: 'ruled-carol/open', frontmatter: {} },
  { slug: 'ruled-bob/open', frontmatter: {} },
  { slug: 'two/sub/both-rules', frontmatter: {} },
  { slug: 'open/origin-carol', frontmatter: { readable_by: ['carol-example'] } },
  { slug: 'open/origin-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'open/derived-carol', frontmatter: { derived_from: 'open/origin-carol.md' } },
  { slug: 'open/derived-bob', frontmatter: { derived_from: 'open/origin-bob.md' } },
  { slug: 'open/derived-group', frontmatter: { derived_from: 'open/readers-group.md' } },
  { slug: 'open/malformed', frontmatter: { readable_by: [42] } },
  { slug: 'open/private-carol', frontmatter: { visibility: 'private', readable_by: ['carol-example'] } },
];
const HUB = 'open/hub';

/** Folder rules first (a page written before its rule is not hidden on PGLite), then the members. */
async function seedMembers(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com' });
  await createMember(engine, backend, { id: 'bob-example' });
  await createMember(engine, backend, { id: CAROL, groups: ['team-a'] });
  await createMember(engine, backend, { id: DANA, groups: ['team-a'] });
  await setOwner(engine, 'alice-example');
  await setMemberLabelledOnly(engine, CAROL, true, { remote: false });
  await restrictFolder(engine, backend, 'default', 'ruled-carol/', 'rule', { ruleId: 'rule-carol', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  await restrictFolder(engine, backend, 'default', 'ruled-bob/', 'rule', { ruleId: 'rule-bob', readers: ['member:alice-example', 'member:bob-example'] });
  await restrictFolder(engine, backend, 'default', 'two/', 'rule', { ruleId: 'rule-two-carol', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  await restrictFolder(engine, backend, 'default', 'two/sub/', 'rule', { ruleId: 'rule-two-bob', readers: ['member:alice-example', 'member:bob-example'] });
}

async function put(engine: BrainEngine, slug: string, type: string, frontmatter: Record<string, unknown>, text = `${WORD} body of ${slug}`): Promise<void> {
  await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: text, timeline: '', frontmatter }, { sourceId: 'default' });
}

/** What one remote read answered: its data, 'not_found', or the typed refusal as a value (the harness counts a thrown refusal as a pass). */
type Answer = unknown;

/** `member`'s remote call through the real dispatch on the stdio member path. */
async function remote(engine: BrainEngine, member: string, tool: string, args: Record<string, unknown>): Promise<Answer> {
  const out = await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: member } as never)
    .catch((e: { code?: string }) => ({ thrown: String(e.code) }));
  if ('thrown' in out) return { refused: out.thrown };
  const text = out.content.map(part => (part as { text?: string }).text ?? '').join('');
  let body: unknown = text;
  // A search answers its JSON rows, then notices as text; a failed parse keeps the text.
  try { body = JSON.parse(text.includes('[gbrain') ? text.slice(0, text.indexOf('[gbrain')) : text); } catch { /* plain text */ }
  if (!out.isError) return body;
  const code = (body as { code?: string } | null)?.code;
  if (code === 'engine_capability_missing') return { refused: code };
  if (/page_not_found/.test(text)) return 'not_found';
  return { error: code ?? text.slice(0, 200) };
}

const slugsOf = (rows: unknown): string[] => (Array.isArray(rows) ? rows : ((rows as { results?: unknown[] } | null)?.results ?? []))
  .map(r => (r as { slug?: string; from_slug?: string }).slug ?? (r as { from_slug?: string }).from_slug).filter((s): s is string => typeof s === 'string').sort();
const refusedOf = (a: Answer): string | undefined => (a && typeof a === 'object' && 'refused' in (a as object) ? String((a as { refused: string }).refused) : undefined);

async function eachLineage<T>(engine: BrainEngine, fn: (lineage: Lineage) => Promise<T>): Promise<Record<Lineage, T>> {
  const off = await fn('off');
  await setMembersReadLineage(engine, true, { remote: false });
  return { off, on: await fn('on') };
}

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-reads-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

/** The pages each member reads, by lineage setting (PGLite and Postgres answer these; read from the SQL, then confirmed on a run). */
const VISIBLE: Record<string, Record<Lineage, string[]>> = {
  [CAROL]: {
    off: ['open/readers-carol', 'open/readers-group', 'ruled-carol/open', 'open/origin-carol'],
    on: ['open/readers-carol', 'open/readers-group', 'ruled-carol/open', 'open/origin-carol', 'open/derived-carol', 'open/derived-group'],
  },
  [DANA]: {
    off: ['open/plain', 'open/readers-group', 'ruled-carol/open'],
    on: ['open/plain', 'open/readers-group', 'ruled-carol/open', 'open/derived-group'],
  },
};

async function seedShapes(engine: BrainEngine): Promise<void> {
  await put(engine, HUB, 'note', { readable_by: ['group:team-a'] }, 'the hub every shape links to');
  for (const s of SHAPES) {
    await put(engine, s.slug, s.type ?? 'note', s.frontmatter);
    // The first text is kept as a version, then the page is rewritten; keyword search reads sealed chunks of the rewrite.
    await engine.createVersion(s.slug, { sourceId: 'default' });
    await put(engine, s.slug, s.type ?? 'note', s.frontmatter, `${WORD} rewritten ${s.slug}`);
    await installChunks(engine, s.slug, [chunk(0, `${WORD} rewritten ${s.slug}`)], { sourceId: 'default' });
    await engine.addLink(s.slug, HUB, 'reads', 'mentions', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
  }
}

describe('engine parity: remote page reads of a labelled-only member and of an ordinary member', () => {
  for (const member of [CAROL, DANA]) {
    parityTest(`${member}: get_page, search, list_pages, get_backlinks and get_versions answer the same on every engine, lineage off and on`, {
      methods: ['putPage', 'sealChunks', 'addLink', 'createVersion', 'readPageSnapshot'], timeout: 360_000,
    }, (engine, backend) => inFreshHome(async () => {
      await seedMembers(engine, backend);
      await seedShapes(engine);
      await drainProjections(engine);
      const table = await eachLineage(engine, async (lineage) => {
        const reads: Record<string, unknown> = {};
        for (const s of SHAPES) {
          const got = await remote(engine, member, 'get_page', { slug: s.slug });
          const versions = await remote(engine, member, 'get_versions', { slug: s.slug });
          reads[s.slug] = { get: refusedOf(got) ? got : got === 'not_found' ? got : 'visible', versions: refusedOf(versions) ? versions : Array.isArray(versions) ? versions.length : versions };
        }
        // With lineage on, search also reads saved facts under the fact policy, which the Rust store refuses (row 32e-b-4): the
        // named-loss case below pins it. With lineage off it is the page arm alone and answers the same on every engine.
        const search = lineage === 'off' ? await remote(engine, member, 'search', { query: WORD, limit: 50 }) : [];
        const list = await remote(engine, member, 'list_pages', { limit: 100 });
        const backlinks = await remote(engine, member, 'get_backlinks', { slug: HUB });
        const lists = { search: refusedOf(search) ? search : slugsOf(search), list: refusedOf(list) ? list : slugsOf(list), backlinks: refusedOf(backlinks) ? backlinks : slugsOf(backlinks) };
        // What the member must read, by the SQL rules (not by what any one arm answers).
        const want = VISIBLE[member]![lineage];
        const seen = SHAPES.filter(s => (reads[s.slug] as { get: string }).get === 'visible').map(s => s.slug);
        expect({ lineage, seen }).toEqual({ lineage, seen: SHAPES.map(s => s.slug).filter(slug => want.includes(slug)) });
        // A page the caller may not read lists no versions.
        for (const s of SHAPES) {
          expect({ lineage, slug: s.slug, versions: (reads[s.slug] as { versions: unknown }).versions })
            .toEqual({ lineage, slug: s.slug, versions: want.includes(s.slug) ? 1 : 0 });
        }
        if (lineage === 'off') expect({ lineage, search: lists.search }).toEqual({ lineage, search: [...seen].sort() });
        expect({ lineage, backlinks: lists.backlinks }).toEqual({ lineage, backlinks: [...seen].sort() });
        expect({ lineage, list: lists.list }).toEqual({ lineage, list: [...seen, HUB].sort() });
        return { reads, lists };
      });
      return table;
    }));
  }
});

interface WalkRow {
  id: string; type: string; frontmatter: Record<string, unknown>; inputs?: string[];
  /** Read by carol-example (labelled-only), lineage on; lineage off only W24 reads. */
  carol: boolean;
  /** Read by dana-example (ordinary), lineage on. */
  dana: boolean;
  why: string;
}

const WORLD = { visibility: 'world' } as const;
/** gbrain_access_origin_labelled_for (v308), branch by branch. Every derived page is `visibility: world`, so the privacy part never hides it. */
const WALK: readonly WalkRow[] = [
  { id: 'w01', type: 'atom', frontmatter: { source_slug: 'open/origin-carol' }, carol: true, dana: false, why: 'atom: its origin page names carol' },
  { id: 'w02', type: 'atom', frontmatter: { source_slug: 'open/origin-bob' }, carol: false, dana: false, why: 'atom: its origin names bob' },
  { id: 'w03', type: 'atom', frontmatter: {}, carol: false, dana: true, why: 'atom with no source_slug: no origin, fail closed' },
  { id: 'w04', type: 'atom', frontmatter: { source_slug: 'open/plain' }, carol: false, dana: true, why: 'atom: its origin names nobody' },
  { id: 'w05', type: 'atom', frontmatter: { source_slug: 'open/was-carol' }, carol: true, dana: false, why: 'atom: the origin was renamed to a page that names carol' },
  { id: 'w06', type: 'concept', frontmatter: { synthesized_by: 'x' }, inputs: ['open/origin-carol', 'open/readers-group'], carol: true, dana: false, why: 'concept: every input names carol' },
  { id: 'w07', type: 'concept', frontmatter: { synthesized_by: 'x' }, inputs: ['open/origin-carol', 'open/plain'], carol: false, dana: false, why: 'concept: one input names nobody' },
  { id: 'w08', type: 'concept', frontmatter: { synthesized_by: 'x' }, inputs: ['walk/w01'], carol: true, dana: false, why: 'concept: an atom input whose own origin names carol' },
  { id: 'w09', type: 'concept', frontmatter: { synthesized_by: 'x' }, carol: false, dana: true, why: 'concept with no inputs: no origin, fail closed' },
  { id: 'w10', type: 'question', frontmatter: {}, inputs: ['open/origin-carol'], carol: true, dana: false, why: 'question: its input names carol' },
  { id: 'w11', type: 'concept', frontmatter: {}, carol: false, dana: true, why: 'concept with no synthesized_by and no derived_from: no branch applies' },
  { id: 'w12', type: 'event', frontmatter: { captured_via: 'life-chronicle:x', event: { depth: 'open/origin-carol' } }, carol: true, dana: false, why: 'event: its depth page names carol' },
  { id: 'w13', type: 'event', frontmatter: { captured_via: 'life-chronicle:x', event: { depth: 'open/nowhere' } }, carol: false, dana: false, why: 'event: the depth page does not exist (the privacy part hides a chronicle event whose origin is not visible, for every member)' },
  { id: 'w14', type: 'event', frontmatter: {}, carol: false, dana: true, why: 'event with no captured_via: no branch applies' },
  { id: 'w15', type: 'note', frontmatter: { derived_from: ['open/origin-carol.md', 'open/origin-bob'] }, carol: false, dana: false, why: 'declared: one origin names bob' },
  { id: 'w17', type: 'note', frontmatter: { derived_from: [] }, carol: false, dana: true, why: 'declared: an empty list, fail closed' },
  { id: 'w18', type: 'note', frontmatter: { derived_from: 'open/nowhere' }, carol: false, dana: true, why: 'declared: the origin does not exist' },
  { id: 'w19', type: 'note', frontmatter: { derived_from: 5 }, carol: false, dana: true, why: 'declared: a number is neither a list nor a string, no branch applies' },
  { id: 'w20', type: 'note', frontmatter: { derived_from: 'ruled-carol/open' }, carol: true, dana: true, why: 'declared: the origin sits under a folder rule carol satisfies' },
  { id: 'w21', type: 'note', frontmatter: { derived_from: 'open/readers-group' }, carol: true, dana: true, why: 'declared: the origin names a group carol is in' },
  { id: 'w22', type: 'atom', frontmatter: { source_slug: 'open/origin-carol', derived_from: 'open/plain' }, carol: false, dana: false, why: 'atom branch passes, declared branch fails: both must pass' },
  { id: 'w23', type: 'note', frontmatter: { derived_from: null }, carol: false, dana: true, why: 'declared: a null value is neither a list nor a string' },
  { id: 'w24', type: 'note', frontmatter: { readable_by: ['carol-example'], derived_from: 'open/plain' }, carol: true, dana: false, why: 'the page names carol itself' },
];

async function seedWalk(engine: BrainEngine, rows: readonly WalkRow[]): Promise<void> {
  await put(engine, 'open/was-carol', 'note', { readable_by: ['carol-example'] });
  await engine.updateSlug('open/was-carol', 'open/now-carol', { sourceId: 'default' });
  for (const row of rows) {
    await put(engine, `walk/${row.id}`, row.type, { ...WORLD, ...row.frontmatter });
    for (const input of row.inputs ?? []) {
      await engine.addLink(`walk/${row.id}`, input, '', 'synthesized_from', 'concept-provenance', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
    }
  }
}

/** One get_page per walk page, for each member; lineage off must read only w24 (carol) and nothing derived (dana's ordinary rule is not under test). */
async function readWalk(engine: BrainEngine, rows: readonly WalkRow[], member: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const got = await remote(engine, member, 'get_page', { slug: `walk/${row.id}` });
    out[row.id] = refusedOf(got) ? got : got === 'not_found' ? got : 'visible';
  }
  return out;
}

const answerOf = (visible: boolean): string => (visible ? 'visible' : 'not_found');

describe('engine parity: the labelled-only walk of a derived page, branch by branch', () => {
  parityTest('a labelled-only member reads a derived page by its origins only when every origin names it; an ordinary member by the lineage rule', {
    methods: ['putPage', 'addLink', 'updateSlug', 'readPageSnapshot'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seedMembers(engine, backend);
    await seedShapes(engine);
    await seedWalk(engine, WALK);
    const table = await eachLineage(engine, async (lineage) => {
      const carol = await readWalk(engine, WALK, CAROL);
      const dana = lineage === 'on' ? await readWalk(engine, WALK, DANA) : {};
      expect({ lineage, carol }).toEqual({ lineage, carol: Object.fromEntries(WALK.map(r => [r.id, answerOf(lineage === 'on' ? r.carol : r.id === 'w24')])) });
      if (lineage === 'on') expect({ lineage, dana }).toEqual({ lineage, dana: Object.fromEntries(WALK.map(r => [r.id, answerOf(r.dana)])) });
      return { carol, dana };
    });
    return table;
  }));
});

interface VersionRow {
  slug: string; old: Record<string, unknown>; live: Record<string, unknown>; carol: { off: number; on: number }; dana: { off: number; on: number }; why: string;
  /** A second snapshot (the middle one) written with a reason, between `old` and `live`; `reasons` says which listed versions carry replaced_because. */
  middle?: Record<string, unknown>; reasons?: { carol: boolean[]; dana: boolean[] };
}

/**
 * A version carries its own readers: a labelled-only reader sees it when its readers name the caller, or when the live page
 * sits under a folder rule the caller satisfies, or (lineage on) is derived and every origin names the caller. The live page's
 * own readers do not count for a version (callerReadersAllowedSql 'snapshot', labelledOnlySql with readers false).
 * An ordinary reader sees a version whose readers it meets.
 */
const VERSIONS: readonly VersionRow[] = [
  { slug: 'open/vers-old-carol', old: { readable_by: ['carol-example'] }, live: { readable_by: ['carol-example', 'bob-example'] }, carol: { off: 1, on: 1 }, dana: { off: 0, on: 0 }, why: 'the old version names carol; the live page names carol and bob' },
  { slug: 'open/vers-old-bob', old: { readable_by: ['bob-example'] }, live: { readable_by: ['carol-example', 'dana-example', 'bob-example'] }, carol: { off: 0, on: 0 }, dana: { off: 0, on: 0 }, why: 'the old version names bob; the live page names carol, dana and bob' },
  { slug: 'open/vers-old-dana', old: { readable_by: ['dana-example'] }, live: { readable_by: ['carol-example', 'dana-example'] }, carol: { off: 0, on: 0 }, dana: { off: 1, on: 1 }, why: 'the old version names dana; the live page names carol and dana' },
  { slug: 'open/vers-old-group', old: { readable_by: ['group:team-a'] }, live: { readable_by: ['group:team-a', 'bob-example'] }, carol: { off: 1, on: 1 }, dana: { off: 1, on: 1 }, why: 'the old version names the group both are in' },
  { slug: 'open/vers-live-readers', old: {}, live: { readable_by: ['carol-example', 'dana-example'] }, carol: { off: 0, on: 0 }, dana: { off: 1, on: 1 }, why: 'the old version names nobody and the live page names carol and dana: its readers do not label a version for carol' },
  { slug: 'ruled-carol/vers-open', old: {}, live: {}, carol: { off: 1, on: 1 }, dana: { off: 1, on: 1 }, why: 'a version of a page under a rule both satisfy' },
  { slug: 'ruled-bob/vers-open', old: {}, live: {}, carol: { off: 0, on: 0 }, dana: { off: 0, on: 0 }, why: 'a page under a rule neither satisfies is not read, so lists no versions' },
  { slug: 'open/vers-reason', old: { readable_by: ['carol-example'] }, middle: {}, live: { readable_by: ['carol-example', 'dana-example'] }, carol: { off: 1, on: 1 }, dana: { off: 1, on: 1 }, reasons: { carol: [false], dana: [true] }, why: 'the first version names carol, its successor names nobody (not a label for carol): carol sees the first with its reason withheld; dana sees only the successor, with its reason' },
  { slug: 'open/vers-derived', old: { derived_from: 'open/origin-carol.md' }, live: { derived_from: 'open/origin-carol.md' }, carol: { off: 0, on: 1 }, dana: { off: 0, on: 0 }, why: 'a derived page whose origin names carol' },
];

describe('engine parity: the version list of a labelled-only member and of an ordinary member', () => {
  for (const member of [CAROL, DANA]) {
    parityTest(`${member}: get_versions lists a version by its own readers, the live page's rules and (lineage on) its origins`, {
      methods: ['putPage', 'createVersion', 'getVersions'], timeout: 240_000,
    }, (engine, backend) => inFreshHome(async () => {
      await seedMembers(engine, backend);
      await seedShapes(engine);
      for (const v of VERSIONS) {
        await put(engine, v.slug, 'note', v.old, 'first text');
        await engine.createVersion(v.slug, { sourceId: 'default', ...(v.middle ? { reason: 'why one' } : {}) });
        if (v.middle) {
          await put(engine, v.slug, 'note', v.middle, 'middle text');
          await engine.createVersion(v.slug, { sourceId: 'default', reason: 'why two' });
        }
        await put(engine, v.slug, 'note', v.live, 'second text');
      }
      return eachLineage(engine, async (lineage) => {
        const counts: Record<string, unknown> = {};
        const reasons: Record<string, unknown> = {};
        for (const v of VERSIONS) {
          const list = await remote(engine, member, 'get_versions', { slug: v.slug });
          counts[v.slug] = refusedOf(list) ? list : Array.isArray(list) ? list.length : list;
          if (v.reasons && Array.isArray(list)) reasons[v.slug] = list.map(row => typeof (row as { replaced_because?: unknown }).replaced_because === 'string');
        }
        expect({ lineage, counts }).toEqual({ lineage, counts: Object.fromEntries(VERSIONS.map(v => [v.slug, (member === CAROL ? v.carol : v.dana)[lineage]])) });
        expect({ lineage, reasons }).toEqual({ lineage, reasons: Object.fromEntries(VERSIONS.filter(v => v.reasons).map(v => [v.slug, member === CAROL ? v.reasons!.carol : v.reasons!.dana])) });
        return { counts, reasons };
      });
    }));
  }
});

describe('engine parity: a null entry in derived_from', () => {
  // The SQL walk turns a JSON null in the list into a NULL slug, which names no page, so the walk fails closed. A Rust reader
  // that dropped the null would read a page whose other origins all name carol.
  parityTest('a derived_from list holding a null entry is never read by a labelled-only member, and an ordinary member reads it as the SQL does', {
    methods: ['putPage', 'readPageSnapshot'], timeout: 240_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seedMembers(engine, backend);
    await seedShapes(engine);
    const rows = [
      { id: 'w16a', frontmatter: { derived_from: ['open/origin-carol.md', null] }, carol: false, dana: false },
      { id: 'w16b', frontmatter: { derived_from: [null] }, carol: false, dana: true },
      { id: 'w16c', frontmatter: { derived_from: [null, 'open/readers-group'] }, carol: false, dana: true },
    ];
    for (const row of rows) await put(engine, `walk/${row.id}`, 'note', { ...WORLD, ...row.frontmatter });
    await setMembersReadLineage(engine, true, { remote: false });
    const answers: Record<string, unknown> = {};
    for (const row of rows) {
      for (const member of [CAROL, DANA]) {
        const got = await remote(engine, member, 'get_page', { slug: `walk/${row.id}` });
        answers[`${row.id}/${member}`] = refusedOf(got) ? got : got === 'not_found' ? got : 'visible';
      }
    }
    expect(answers).toEqual(Object.fromEntries(rows.flatMap(r => [[`${r.id}/${CAROL}`, answerOf(r.carol)], [`${r.id}/${DANA}`, answerOf(r.dana)]])));
    return answers;
  }));
});

describe('engine parity: named loss of search under lineage (RUST_ENGINE.md, row 32e-b-4)', () => {
  // Not a parityTest: the arms answer differently on purpose. With access.members_read_lineage on, search also matches saved facts
  // under the fact policy of a lineage read, which the Rust store does not model, so Rust declines the whole call for every member
  // while PGLite and Postgres answer the pages. The day Rust answers it this fails and the row goes.
  test('with access.members_read_lineage on, search answers the readable pages on PGLite and Postgres and Rust declines it, for both members', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      await inFreshHome(async () => {
        await seedMembers(arm.engine, arm.backend);
        await seedShapes(arm.engine);
        await drainProjections(arm.engine);
        await setMembersReadLineage(arm.engine, true, { remote: false });
        for (const member of [CAROL, DANA]) {
          const answer = await remote(arm.engine, member, 'search', { query: WORD, limit: 50 });
          if (arm.backend === 'rust') expect({ backend: arm.backend, member, refused: refusedOf(answer) }).toEqual({ backend: arm.backend, member, refused: 'engine_capability_missing' });
          else expect({ backend: arm.backend, member, slugs: slugsOf(answer) }).toEqual({ backend: arm.backend, member, slugs: [...VISIBLE[member]!.on].sort() });
        }
      });
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 120_000);
});
