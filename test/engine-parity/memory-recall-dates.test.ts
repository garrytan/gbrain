/**
 * BrainEngine parity — the MCP verb `memory_recall` (src/core/ops/qm-memory.ts) for an ordinary member and for the owner,
 * with access.members_read_lineage off and on (row 32e-b-7), on PGLite, Postgres and Rust.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: memory_recall answers plain-text lines `- <fact> (<date>; <kind>)`: the caller's own recent facts, then the facts it
 *    may read ranked by the query. The date is the day the database writes for the fact: valid_from, else created_at, in UTC
 *    (a driver's own timestamp parse reads years 1-99 as 19xx, so the database writes the day). Every engine answers the same
 *    lines for the same caller, and a fact the caller may not read is in none of them.
 *  - Regression: on a Rust brain memory_recall refused with engine_capability_missing at a raw SQL read of the facts' written
 *    dates (qm-memory.ts, ctx.engine.executeRaw), for every caller, lineage off and on. memory_recall is an agent-facing MCP
 *    verb, so a refusal for every caller breaks the byte-exact agent contract. Each case returns the refusal as a value
 *    ({ refused }), so an arm that still refuses fails the comparison with PGLite instead of counting as stopped.
 *  - Why existing coverage misses it: qm-memory-tools.test.ts runs memory_recall on PGLite and Postgres only, and
 *    lineage-fact-reads.test.ts skips the verb on the Rust arm by name. Neither compares the Rust answer.
 *  - Seam: members through createMember; pages and facts through typed members; the caller is the stdio member path of the real
 *    dispatch. Fact text names each fact, so ids that differ between arms never enter the answer.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, createSource, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { ownMemberFactIds } from '../../src/core/access/member-facts.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'alice-example';
const MEMBER = 'bob-example';
const QUERY = 'budget ledger';
const OWNER_PAGE = `memory/members/${OWNER}`;
const MEMBER_PAGE = `memory/members/${MEMBER}`;

interface PageSeed { slug: string; type?: string; frontmatter: Record<string, unknown> }
const PAGES: readonly PageSeed[] = [
  { slug: 'people/open-example', type: 'person', frontmatter: {} },
  { slug: 'open/plain', frontmatter: {} },
  { slug: 'open/readers-owner', frontmatter: { readable_by: [OWNER] } },
  { slug: 'open/readers-member', frontmatter: { readable_by: [MEMBER] } },
  { slug: OWNER_PAGE, frontmatter: { readable_by: [`member:${OWNER}`] } },
  { slug: MEMBER_PAGE, frontmatter: { readable_by: [`member:${MEMBER}`] } },
];

/** A fact: the page its text sits on and the day it is valid from. The dates cover the cases the written-date read decides. */
interface FactSeed { id: string; page: string; validFrom: string; visibility?: 'private' }
const FACTS: readonly FactSeed[] = [
  { id: 'own-owner', page: OWNER_PAGE, validFrom: '2026-03-05T10:00:00Z' },
  { id: 'own-member', page: MEMBER_PAGE, validFrom: '2026-03-04T10:00:00Z' },
  { id: 'own-private-member', page: MEMBER_PAGE, validFrom: '2026-03-06T10:00:00Z', visibility: 'private' },
  { id: 'own-private-owner', page: OWNER_PAGE, validFrom: '2026-03-07T10:00:00Z', visibility: 'private' },
  { id: 'plain', page: 'open/plain', validFrom: '2026-05-06T12:00:00Z' },
  { id: 'year-fifty', page: 'open/plain', validFrom: '0050-03-04T00:00:00Z' },
  { id: 'late-utc', page: 'open/plain', validFrom: '2026-12-31T23:30:00Z' },
  { id: 'early-utc', page: 'open/plain', validFrom: '2026-01-01T00:30:00Z' },
  { id: 'readers-owner', page: 'open/readers-owner', validFrom: '2026-04-07T09:00:00Z' },
  { id: 'readers-member', page: 'open/readers-member', validFrom: '2026-04-08T09:00:00Z' },
];
const text = (f: FactSeed): string => `budget ledger note ${f.id}`;

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-memory-recall-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

async function seed(engine: BrainEngine, backend: ParityBackend, lineage: boolean): Promise<void> {
  await createMember(engine, backend, { id: OWNER, email: 'alice@example.com' });
  await createMember(engine, backend, { id: MEMBER });
  await setOwner(engine, OWNER);
  await restrictFolder(engine, backend, 'default', 'sealed/', 'pending');
  for (const p of PAGES) {
    await engine.putPage(p.slug, { type: (p.type ?? 'note') as never, title: p.slug, compiled_truth: `page ${p.slug}`, timeline: '', frontmatter: p.frontmatter }, { sourceId: 'default' });
  }
  await drainProjections(engine);
  for (const [i, f] of FACTS.entries()) {
    await engine.insertFacts([{
      fact: text(f), kind: 'fact', visibility: f.visibility ?? 'world', source: 'test', entity_slug: 'people/open-example', source_markdown_slug: f.page, row_num: i + 1,
      valid_from: new Date(f.validFrom),
    }] as never, { source_id: 'default' });
  }
  if (lineage) await setMembersReadLineage(engine, true, { remote: false });
}

/** `member`'s memory_recall through the real dispatch on the stdio member path: its text lines, or the typed refusal as a value. */
async function memoryRecall(engine: BrainEngine, member: string): Promise<unknown> {
  const out = await dispatchToolCall(engine, 'memory_recall', { query: QUERY }, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: member } as never)
    .catch((e: { code?: string }) => ({ thrown: String(e.code) }));
  if ('thrown' in out) return { refused: out.thrown };
  const body = out.content.map(part => (part as { text?: string }).text ?? '').join('');
  let parsed: unknown = body;
  try { parsed = JSON.parse(body.includes('[gbrain') ? body.slice(0, body.indexOf('[gbrain')) : body); } catch { /* plain text */ }
  if (!out.isError) {
    // The structured answer names each fact's own_page flag (ids differ between arms, so the flags are keyed by the fact's text).
    const facts = ((out as { structuredContent?: { facts?: Array<{ text: string; own_page: boolean }> } }).structuredContent?.facts ?? []);
    const ownPage = Object.fromEntries(facts.map(f => [FACTS.find(x => f.text.includes(text(x)))?.id ?? f.text, f.own_page]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    return { text: String(parsed), ownPage };
  }
  const code = (parsed as { code?: string } | null)?.code;
  // The typed refusal rides along unseen by toEqual, so a case pinned as a Rust stop can rethrow it (rebuilt from its envelope).
  if (code === 'engine_capability_missing') return Object.defineProperty({ refused: code }, 'error', { value: Object.assign(new Error(String((parsed as { message?: unknown }).message)), parsed), enumerable: false });
  return { error: code ?? body.slice(0, 200) };
}

/** A Rust case pinned as a named stop (test/rust-stop-pins/memory-recall-dates.tsv): the refusal must name `member`, then the case stops on it. */
function stopOnRefusal(backend: ParityBackend, answer: unknown, member: string): void {
  if (backend !== 'rust' || !(answer && typeof answer === 'object' && 'refused' in answer)) return;
  const refusal = (answer as unknown as { error: Error & { detail?: unknown } }).error;
  expect({ refused: (answer as { refused: string }).refused, names: String(refusal.detail ?? '').includes(`member=${member}`) }).toEqual({ refused: 'engine_capability_missing', names: true });
  throw refusal;
}

/** The lines of a memory_recall answer, newest-first order as the verb wrote them. */
const linesOf = (answer: unknown): string[] => String((answer as { text?: string } | null)?.text ?? '').split('\n').filter(Boolean);

/** The written date of each seeded fact the answer names. */
function datesIn(answer: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of linesOf(answer)) {
    const f = FACTS.find(x => line.includes(text(x)));
    const date = /\((\d{4}-\d{2}-\d{2}|undated);/.exec(line)?.[1];
    if (f && date) out[f.id] = date;
  }
  return out;
}

/**
 * What each caller reads, confirmed on PGLite: its own page and the open pages; a page that names the caller only for the owner, and for an
 * ordinary member only with lineage on (the ranked read judges a page's readers by lineage).
 */
const OPEN = ['plain', 'year-fifty', 'late-utc', 'early-utc'];
const reads = (member: string, lineage: boolean): string[] => member === OWNER
  ? ['own-owner', 'own-private-owner', 'readers-owner', ...OPEN]
  : ['own-member', 'own-private-member', ...(lineage ? ['readers-member'] : []), ...OPEN];
const DATES: Record<string, string> = {
  'own-owner': '2026-03-05', 'own-member': '2026-03-04', 'own-private-member': '2026-03-06', 'own-private-owner': '2026-03-07', plain: '2026-05-06', 'year-fifty': '0050-03-04', 'late-utc': '2026-12-31',
  'early-utc': '2026-01-01', 'readers-owner': '2026-04-07', 'readers-member': '2026-04-08',
};

/**
 * One memory_recall case: the caller's lines carry the facts it reads and each fact's written date, and own_page is true on exactly
 * the private facts of its own member page. `stop` names the Rust refusal a pinned case ends on (test/rust-stop-pins/memory-recall-dates.tsv).
 */
async function recallCase(engine: BrainEngine, backend: ParityBackend, member: string, lineage: boolean, stop?: string): Promise<unknown> {
  await seed(engine, backend, lineage);
  const answer = await memoryRecall(engine, member);
  if (stop !== undefined) stopOnRefusal(backend, answer, stop);
  const seen = datesIn(answer);
  const want = reads(member, lineage);
  expect(Object.keys(seen).sort()).toEqual([...want].sort());
  for (const id of want) expect({ id, date: seen[id] }).toEqual({ id, date: DATES[id] });
  const own = member === OWNER ? 'own-private-owner' : 'own-private-member';
  expect(linesOf(answer).slice(0, 3).some(l => l.includes(own))).toBe(true);
  expect((answer as { ownPage: Record<string, boolean> }).ownPage).toEqual(Object.fromEntries(want.map(id => [id, id === own]).sort(([x], [y]) => String(x).localeCompare(String(y)))));
  return answer;
}

describe('engine parity: memory_recall answers the same lines, with the written date and own-page flag of each fact, on every engine', () => {
  parityTest('an ordinary member reads its facts and their written dates, access.members_read_lineage off', {
    methods: ['putPage', 'insertFacts', 'listFactsSince', 'readFactWrittenDates', 'readOwnMemberFactIds'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(() => recallCase(engine, backend, MEMBER, false)));

  // Named stop on Rust, owner row 32e-b-4 (the lineage fact reads): listFactsSince refuses with lineage on. Flip this case to a plain one
  // (declare readFactWrittenDates and readOwnMemberFactIds, drop the stop and its row) when that row lands.
  parityTest('an ordinary member reads its facts and their written dates, access.members_read_lineage on', {
    methods: ['putPage', 'insertFacts', 'listFactsSince'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(() => recallCase(engine, backend, MEMBER, true, 'listFactsSince')));

  // Named stop on Rust, owner row RA-1 (the owner's remote read, ownerLineageRefusal): refused before the store, lineage off or on. Flip
  // both owner cases to plain ones (declare the members they then call, drop the stop and its row) when that row lands.
  parityTest('the owner reads its facts and their written dates, access.members_read_lineage off', {
    methods: ['putPage', 'insertFacts', 'readFolderAccess'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(() => recallCase(engine, backend, OWNER, false, 'memory_recall')));

  parityTest('the owner reads its facts and their written dates, access.members_read_lineage on', {
    methods: ['putPage', 'insertFacts', 'readFolderAccess'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(() => recallCase(engine, backend, OWNER, true, 'memory_recall')));
});

describe('engine parity: readFactWrittenDates, the date column of memory_recall', () => {
  parityTest('each named fact gets the UTC day it is valid from, as the database writes it; a missing or repeated id adds nothing', {
    methods: ['insertFacts', 'readFactWrittenDates'],
  }, async (engine) => {
    const ids = new Map<string, number>();
    for (const [i, f] of FACTS.entries()) {
      const out = await engine.insertFacts([{
        fact: text(f), kind: 'fact', visibility: 'world', source: 'test', entity_slug: null, source_markdown_slug: 'open/plain', row_num: i + 1, valid_from: new Date(f.validFrom),
      }] as never, { source_id: 'default' });
      ids.set(f.id, Number(out.ids[0]));
    }
    const label = new Map([...ids].map(([name, id]) => [id, name]));
    const named = (rows: Array<{ id: number | string; d: string }>) => rows.map(r => ({ fact: label.get(Number(r.id)) ?? `unknown:${r.id}`, d: r.d })).sort((a, b) => a.fact.localeCompare(b.fact));
    const every = [...ids.values()];
    const out = {
      all: named(await engine.readFactWrittenDates(every)),
      repeated: named(await engine.readFactWrittenDates([every[0]!, every[0]!, every[2]!])),
      missing: named(await engine.readFactWrittenDates([999_999, ids.get('year-fifty')!])),
      none: named(await engine.readFactWrittenDates([])),
    };
    expect(out.all.map(r => r.fact)).toEqual([...FACTS.map(f => f.id)].sort((a, b) => a.localeCompare(b)));
    for (const r of out.all) expect({ fact: r.fact, d: r.d }).toEqual({ fact: r.fact, d: DATES[r.fact] });
    expect(out.repeated).toHaveLength(2);
    expect(out.missing).toEqual([{ fact: 'year-fifty', d: '0050-03-04' }]);
    expect(out.none).toEqual([]);
    return out;
  });
});

/**
 * ownMemberFactIds (access/member-facts.ts): of the fact ids asked for, the ones that are private facts of `sourceId` on the
 * caller's own member page, while that page is live, names the caller as a reader and passes the caller's page policy. memory_recall
 * reports it as `own_page`; forget_fact and the owner's default save (persistence/memory-mutations.ts) ask the same question.
 */
describe('engine parity: ownMemberFactIds, the own_page flag of memory_recall', () => {
  const CAROL = 'carol-example';
  const DANA = 'dana-example';
  const PAGES_OWN: ReadonlyArray<{ slug: string; frontmatter: Record<string, unknown> }> = [
    { slug: MEMBER_PAGE, frontmatter: { readable_by: [`member:${MEMBER}`] } },
    { slug: OWNER_PAGE, frontmatter: { readable_by: [`member:${OWNER}`] } },
    // carol's own page names someone else, not carol: it is not a page that admits her
    { slug: `memory/members/${CAROL}`, frontmatter: { readable_by: [`member:${DANA}`] } },
    { slug: 'open/plain', frontmatter: {} },
  ];
  // [label, page, source, visibility]
  const ROWS: ReadonlyArray<[string, string, string, string]> = [
    ['member-private', MEMBER_PAGE, 'default', 'private'],
    ['member-world', MEMBER_PAGE, 'default', 'world'],
    ['member-private-two', MEMBER_PAGE, 'default', 'private'],
    ['owner-private', OWNER_PAGE, 'default', 'private'],
    ['carol-private', `memory/members/${CAROL}`, 'default', 'private'],
    ['open-private', 'open/plain', 'default', 'private'],
    ['member-private-elsewhere', MEMBER_PAGE, 'other', 'private'],
  ];

  parityTest('a member owns its private facts on its own live member page in the source asked, and no one else\'s', {
    methods: ['putPage', 'insertFacts'], timeout: 360_000,
  }, (engine, backend) => inFreshHome(async () => {
    await createMember(engine, backend, { id: OWNER, email: 'alice@example.com' });
    await createMember(engine, backend, { id: MEMBER });
    await createMember(engine, backend, { id: CAROL });
    await createMember(engine, backend, { id: DANA });
    await setOwner(engine, OWNER);
    await createSource(engine, backend, 'other');
    await restrictFolder(engine, backend, 'default', 'sealed/', 'pending');
    for (const sourceId of ['default', 'other']) {
      for (const pg of PAGES_OWN) await engine.putPage(pg.slug, { type: 'note' as never, title: pg.slug, compiled_truth: `page ${pg.slug}`, timeline: '', frontmatter: pg.frontmatter }, { sourceId });
    }
    await drainProjections(engine);
    const ids = new Map<string, number>();
    for (const [i, [label, page, sourceId, visibility]] of ROWS.entries()) {
      const out = await engine.insertFacts([{ fact: `own page ${label}`, kind: 'fact', visibility, source: 'test', entity_slug: null, source_markdown_slug: page, row_num: i + 1, valid_from: new Date('2026-03-04T00:00:00Z') }] as never, { source_id: sourceId });
      ids.set(label, Number(out.ids[0]));
    }
    const label = new Map([...ids].map(([name, id]) => [id, name]));
    const every = [...ids.values()];
    const asked = [...every, every[0]!, 999_999];
    // The owner is left out: its remote record renders other admission text (the owner lineage read), which a Rust brain refuses by name
    // (row RA-1, test/rust-stop-pins/memory-recall-dates.tsv covers the owner's memory_recall); the SQL arms answer it ['owner-private'].
    const answer = async (member: string | null, sourceId = 'default', list: readonly number[] = asked): Promise<unknown> => {
      const record = member ? { ...await remoteCallerAccess(engine, undefined, [], 'stdio', null, member, false) } : { identity: [] as string[], hidePrivate: true };
      try {
        const owned = await withCallerAccess(record, () => ownMemberFactIds(engine, sourceId, list));
        return [...owned].map(id => label.get(id) ?? `unknown:${id}`).sort();
      } catch (e) {
        if ((e as { code?: string } | null)?.code === 'engine_capability_missing') return { refused: 'engine_capability_missing' };
        throw e;
      }
    };
    const out = {
      member: await answer(MEMBER),
      carol: await answer(CAROL),
      noMember: await answer(null),
      otherSource: await answer(MEMBER, 'other'),
      oneId: await answer(MEMBER, 'default', [ids.get('member-private-two')!]),
      noIds: await answer(MEMBER, 'default', []),
    };
    expect(out.member).toEqual(['member-private', 'member-private-two']);
    expect(out.carol).toEqual([]);
    expect(out.noMember).toEqual([]);
    expect(out.otherSource).toEqual(['member-private-elsewhere']);
    expect(out.oneId).toEqual(['member-private-two']);
    expect(out.noIds).toEqual([]);
    return out;
  }));
});
