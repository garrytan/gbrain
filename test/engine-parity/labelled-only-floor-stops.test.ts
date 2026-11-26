/**
 * BrainEngine parity — the reads a Rust brain refuses for a labelled-only member (or a labelled-only audience, or a caller with a pending folder
 * prefix) whatever access.members_read_lineage says (row 32e-b-5): the remote fact floors (`storeFloorPolicy` and `storeRemoteFloor`), a
 * labelled-only audience of several identities, and `as_of` editions. PGLite and Postgres answer each; the Rust store stops with
 * engine_capability_missing (fail closed: it never answers a different set of facts).
 *
 * The fourth item is not about labelled-only members: the same two floors also refuse any caller, an ordinary member included, whose record
 * holds a pending folder prefix (the floor text then renders the record's coverage, which the store has no form for). It is pinned here too.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a labelled-only caller reads, through the remote provenance floor, only a fact on its own member page (the labelled-only
 *    fact conjunct), and an edition of a page only when the edition's own readers or the live page's rules name it; a labelled-only
 *    audience of several identities reads what every identity may read. A fact or edition the caller may not read is not returned.
 *  - Regression (named stop): the Rust store has no form for these three policies, so each case stops on the typed refusal, which is
 *    pinned in test/rust-stop-pins/labelled-only-floors.tsv with an owner and a due date. The day Rust answers one, its case fails,
 *    and the pin, the RUST_ENGINE.md row 32e-b-5 and the swap-report loss entry go. A wrong answer would not stop: it would differ from
 *    PGLite and fail here, so a pinned case that reached a wrong Rust answer is a leak, never a stop.
 *  - Why existing coverage misses it: the translator tests (rust-private-reads-policy.test.ts, rust-engine-store.test.ts) pin the refusals
 *    in process; no parity case read these shapes on the SQL engines to show the answer the Rust store declines.
 *  - Seam: members through createMember and the typed labelled-only write; the caller record is the one remoteCallerAccess builds for a
 *    stdio member (the audience case adds the identities of a second member).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { rustAccessBrain } from './rust-arm.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { drainProjections } from '../../src/core/page-state/projections.ts';

const { parityTest } = parityArms(testBackends());

const CAROL = 'carol-example';
const DANA = 'dana-example';
const OWN_PAGE = `memory/members/${CAROL}`;
const ENTITY = 'people/open-example';

/**
 * A raw-only folder rule (covers_derived false) over `raw/`, listing alice, carol and dana: a page derived from a page under it is not closed
 * by it, so an atom derived from `raw/origin` passes the plain provenance floor, and a labelled-only member reads it only with lineage on.
 * Harness-only SQL behind the backend switch, as restrictFolder is.
 */
async function rawOnlyRule(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  const readers = ['member:alice-example', `member:${CAROL}`, `member:${DANA}`];
  await restrictFolder(engine, backend, 'default', 'unused-seed-prefix/', 'pending'); // gives the source its access state, as restrictFolder does
  if (backend === 'rust') {
    await rustAccessBrain(engine).putAccessRule({ source_id: 'default', rule_id: 'rule-raw', prefix: 'raw/', readable_by: readers, revision: 1, covers_derived: false });
    return;
  }
  await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, covers_derived) VALUES ('default', 'rule-raw', 'raw/', $1::text[], 1, false)`, [readers]);
}

/** The ids of the three facts: on the member page of carol, on an open page, and on an atom derived from an origin under a raw-only rule. */
async function seed(engine: BrainEngine, backend: ParityBackend): Promise<{ own: number; open: number; atom: number }> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com' });
  await createMember(engine, backend, { id: CAROL });
  await createMember(engine, backend, { id: DANA });
  await setOwner(engine, 'alice-example');
  await setMemberLabelledOnly(engine, CAROL, true, { remote: false });
  await rawOnlyRule(engine, backend);
  const put = (slug: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `page ${slug}`, timeline: '', frontmatter }, { sourceId: 'default' });
  await put(ENTITY, {}, 'person');
  await put(OWN_PAGE, { readable_by: [`member:${CAROL}`] });
  await put('open/plain');
  await put('raw/origin');
  await put('ctrl/atom-raw', { visibility: 'world', source_slug: 'raw/origin' }, 'atom');
  await drainProjections(engine);
  const rows = [
    { fact: 'zzfloor on the member page of carol', source_markdown_slug: OWN_PAGE, row_num: 1 },
    { fact: 'zzfloor on an open page', source_markdown_slug: 'open/plain', row_num: 2 },
    { fact: 'zzfloor on an atom of a raw-only origin', source_markdown_slug: 'ctrl/atom-raw', row_num: 3 },
  ].map(r => ({ ...r, kind: 'fact', visibility: 'world', source: 'test', entity_slug: ENTITY }));
  const ids: number[] = [];
  for (const row of rows) ids.push((await engine.insertFacts([row] as never, { source_id: 'default' })).ids[0]!);
  return { own: ids[0]!, open: ids[1]!, atom: ids[2]! };
}

/** The caller record of a stdio read by carol, labelled-only, with whatever lineage setting the case has set. */
const carolRecord = async (engine: BrainEngine): Promise<Record<string, unknown>> => {
  const record = await remoteCallerAccess(engine, undefined, [], 'stdio', null, CAROL, true);
  expect(record.labelledOnly).toBe(true);
  return { ...record };
};

/** An ordinary member (dana) whose record holds a pending folder prefix: a fact on a page under it is hidden, one on an open page is read. */
async function seedPending(engine: BrainEngine, backend: ParityBackend): Promise<{ open: number; pending: number }> {
  await seed(engine, backend);
  await engine.putPage('pend/plain', { type: 'note', title: 'pend/plain', compiled_truth: 'page pend/plain', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const ids: number[] = [];
  for (const [i, slug] of ['open/plain', 'pend/plain'].entries()) {
    const row = { fact: `zzpending on ${slug}`, source_markdown_slug: slug, row_num: 11 + i, kind: 'fact', visibility: 'world', source: 'test', entity_slug: ENTITY };
    ids.push((await engine.insertFacts([row] as never, { source_id: 'default' })).ids[0]!);
  }
  await restrictFolder(engine, backend, 'default', 'pend/', 'pending');
  return { open: ids[0]!, pending: ids[1]! };
}

/** dana's record, holding the pending prefix: an ordinary member, never labelled-only. */
const danaRecord = async (engine: BrainEngine): Promise<Record<string, unknown>> => {
  const record = await remoteCallerAccess(engine, undefined, [], 'stdio', null, DANA, true);
  expect(record.labelledOnly).not.toBe(true);
  expect((record.folderCoverage as unknown[]).length).toBeGreaterThan(0);
  return { ...record };
};

describe('engine parity: named stops of row 32e-b-5 (a labelled-only member: fact floors, an audience of several identities, as_of editions)', () => {
  parityTest('a labelled-only member\'s remote forget-tier read answers its own member page fact and nothing else on PGLite and Postgres, and the Rust store stops (row 32e-b-5)', {
    methods: ['putPage', 'insertFacts', 'readRemoteForgetTier'], timeout: 240_000,
  }, async (engine, backend) => {
    const ids = await seed(engine, backend);
    const read = async (factId: number) => withCallerAccess(await carolRecord(engine) as never, () => engine.readRemoteForgetTier({ factId, sourceId: 'default', remoteFloor: true }));
    // Lineage off: the floor judges the provenance page by the plain policy (a member page names readers, so it is closed) and the
    // labelled-only conjunct (the member's own page only): nothing is read. Lineage on: the atom of a raw-only origin passes both.
    const off = { own: await read(ids.own), open: await read(ids.open), atom: await read(ids.atom) };
    await setMembersReadLineage(engine, true, { remote: false });
    const on = { own: await read(ids.own), open: await read(ids.open), atom: await read(ids.atom) };
    expect(off).toEqual({ own: null, open: null, atom: null });
    expect({ own: on.own, open: on.open, atom: typeof on.atom }).toEqual({ own: null, open: null, atom: 'string' });
    return { off, on };
  });

  parityTest('a labelled-only member\'s single-fact lookup under the remote floor (storeFloorPolicy) finds the fact on its own member page only on PGLite and Postgres, and the Rust store stops (row 32e-b-5)', {
    methods: ['putPage', 'insertFacts', 'findActiveSingleFact'], timeout: 240_000,
  }, async (engine, backend) => {
    await seed(engine, backend);
    const find = async (pageSlug: string, fact: string) => withCallerAccess(await carolRecord(engine) as never, async () => {
      const row = await engine.findActiveSingleFact({ sourceId: 'default', entitySlug: ENTITY, visibility: 'world', fact, attributedTo: null, pageSlug, remoteFloor: true });
      return row ? 'found' : 'none';
    });
    const all = async () => ({
      own: await find(OWN_PAGE, 'zzfloor on the member page of carol'),
      open: await find('open/plain', 'zzfloor on an open page'),
      atom: await find('ctrl/atom-raw', 'zzfloor on an atom of a raw-only origin'),
    });
    const off = await all();
    await setMembersReadLineage(engine, true, { remote: false });
    const on = await all();
    expect(off).toEqual({ own: 'none', open: 'none', atom: 'none' });
    expect(on).toEqual({ own: 'none', open: 'none', atom: 'found' });
    return { off, on };
  });

  parityTest('a labelled-only audience of two identities reads the facts both may read on PGLite and Postgres, and the Rust store stops (row 32e-b-5)', {
    methods: ['putPage', 'insertFacts', 'listFactsSince'], timeout: 240_000,
  }, async (engine, backend) => {
    await seed(engine, backend);
    const audienceRead = async () => {
      const record = await carolRecord(engine);
      // The audience of a channel that holds two members: the policy is one test per identity (accessAllowedForAllSql).
      const audience = { ...record, audience: [`member:${CAROL}`, `member:${DANA}`], audienceIdentities: [[`member:${CAROL}`], [`member:${DANA}`]] };
      const rows = await withCallerAccess(audience as never, () => engine.listFactsSince('default', new Date(0), { excludePrivate: true, visibility: ['world'], limit: 50 } as never));
      return rows.map(r => String(r.fact)).sort();
    };
    const off = await audienceRead();
    await setMembersReadLineage(engine, true, { remote: false });
    const on = await audienceRead();
    // The audience reads what every identity may read; a fact on a member page or an open page is read by neither of the two together.
    expect(off).toEqual([]);
    expect(on.every(f => f !== 'zzfloor on an open page' && f !== 'zzfloor on the member page of carol')).toBe(true);
    return { off, on };
  });

  parityTest('as_of reads an edition a labelled-only member may read on PGLite and Postgres, and the Rust store stops on pickValidTimeEdition (row 32e-b-5)', {
    methods: ['putPage', 'createVersion', 'getPage', 'pickValidTimeEdition'], timeout: 240_000,
  }, async (engine, backend) => {
    await seed(engine, backend);
    const note = (frontmatter: Record<string, unknown>) =>
      ({ type: 'note' as const, title: 'VT', compiled_truth: `body ${JSON.stringify(frontmatter)}`, timeline: '', frontmatter });
    // Its January edition names carol, its June edition names nobody: the edition an as_of of February picks is the January one.
    await engine.putPage('vt/ed', note({ valid_from: '2026-01-01', readable_by: [CAROL] }), { sourceId: 'default' });
    await engine.createVersion('vt/ed', { sourceId: 'default' });
    await engine.putPage('vt/ed', note({ valid_from: '2026-06-01' }), { sourceId: 'default' });
    const record = await carolRecord(engine);
    const pageId = (await engine.getPage('vt/ed', { sourceId: 'default' }))!.id;
    const picked = await withCallerAccess(record as never, () => engine.pickValidTimeEdition({ pageId, asOf: '2026-02-01', excludePrivate: true, pinOrd: null, inlineMaxBytes: 1_000_000 }));
    const answer = picked ? `${picked.valid_from}:${picked.visible ? 'visible' : 'hidden'}` : null;
    expect(answer).toBe('2026-01-01:visible');
    return answer;
  });
  parityTest('an ordinary member whose record holds a pending folder prefix reads a forget tier on an open page only, lineage off and on, on PGLite and Postgres, and the Rust store stops (row 32e-b-5)', {
    methods: ['putPage', 'insertFacts', 'readRemoteForgetTier'], timeout: 240_000,
  }, async (engine, backend) => {
    const ids = await seedPending(engine, backend);
    const read = async (factId: number) => withCallerAccess(await danaRecord(engine) as never, () => engine.readRemoteForgetTier({ factId, sourceId: 'default', remoteFloor: true }));
    const off = { open: typeof await read(ids.open), pending: await read(ids.pending) };
    await setMembersReadLineage(engine, true, { remote: false });
    const on = { open: typeof await read(ids.open), pending: await read(ids.pending) };
    // The fact on a page under the pending prefix is hidden whoever reads; the one on an open page is read.
    expect(off).toEqual({ open: 'string', pending: null });
    expect(on).toEqual({ open: 'string', pending: null });
    return { off, on };
  });

  parityTest('an ordinary member whose record holds a pending folder prefix finds a fact on an open page only through the remote floor (storeFloorPolicy), lineage off and on, on PGLite and Postgres, and the Rust store stops (row 32e-b-5)', {
    methods: ['putPage', 'insertFacts', 'findActiveSingleFact'], timeout: 240_000,
  }, async (engine, backend) => {
    await seedPending(engine, backend);
    const find = async (pageSlug: string) => withCallerAccess(await danaRecord(engine) as never, async () => {
      const row = await engine.findActiveSingleFact({ sourceId: 'default', entitySlug: ENTITY, visibility: 'world', fact: `zzpending on ${pageSlug}`, attributedTo: null, pageSlug, remoteFloor: true });
      return row ? 'found' : 'none';
    });
    const all = async () => ({ open: await find('open/plain'), pending: await find('pend/plain') });
    const off = await all();
    await setMembersReadLineage(engine, true, { remote: false });
    const on = await all();
    expect(off).toEqual({ open: 'found', pending: 'none' });
    expect(on).toEqual({ open: 'found', pending: 'none' });
    return { off, on };
  });
});
