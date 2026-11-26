/**
 * BrainEngine parity — the typed reads the CLI import and extract paths ran through `executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listSourceRecords, readSourceIncarnation, readSyncDispatchRow, readRetainedSources, hasCompanyBrainReceipt, readGuestSourceRow, listGuestSourceIds,
 *    hasGuestSource, readPageTrustRows, readRowTrustRows, readDatabaseClock, listLinkPageMetadata, listLinkPageMetadataForSlugs,
 *    listAttendedOriginSlugs, listStoredTimelineRows and
 *    filterPagesAtRevision return the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), and so do the page labels pageActivationVerdicts builds
 *    from readPageTrustRows for `gbrain delta`, the turn context and the retrieval reflex.
 *  - Regression: an engine that answers one of these differently changes which sources an import loads, which writes a
 *    guest-source guard refuses, which pages a trust stamp marks, which links reconciliation sees and which extract
 *    stamps land; the Rust engine has no SQL, so each read has to exist as a typed method it can implement.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines (docs/research/rust-cli-executeraw-map.md).
 *  - Seam: none in the cases. Typed methods only (no executeRaw: D18); sources are created through harness.ts behind
 *    the backend switch. Generated values (serial ids, incarnations, revisions, timestamps) are compared by shape or by
 *    a relation, never by value; reads with no ORDER BY are sorted before they are compared.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pageActivationVerdicts } from '../../src/core/eligibility/activation.ts';
import type { ReadEligibility } from '../../src/core/eligibility/policy.ts';

const { parityTest } = parityArms(testBackends());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

async function note(engine: BrainEngine, slug: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}) {
  return engine.putPage(slug, { type: 'note', title: slug.toUpperCase(), compiled_truth: `body of ${slug}`, frontmatter }, { sourceId });
}

/** Run `fn` in a transaction whose write trust context declares `tier` and `origin`. */
function declaredWrite(engine: BrainEngine, tier: string, origin: Record<string, unknown> | null, fn: (tx: BrainEngine) => Promise<unknown>) {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, origin ? JSON.stringify(origin) : '']);
    return fn(tx);
  });
}

describe('engine parity: CLI import reads', () => {
  parityTest('listSourceRecords lists every source, default first then by id, with its import columns', { methods: ['listSourceRecords'] }, async (engine, backend) => {
    await createSource(engine, backend, 'zeta', { keep: 1 });
    await createSource(engine, backend, 'alpha', {}, '/var/tmp/parity-alpha');
    const rows = await engine.listSourceRecords();
    expect(rows.map(r => r.id)).toEqual(['default', 'alpha', 'zeta']);
    for (const row of rows) expect(row.created_at).toBeInstanceOf(Date);
    const view = rows.map(r => ({
      id: r.id, name: r.name, local_path: r.local_path, last_commit: r.last_commit, last_sync_at: r.last_sync_at,
      config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config, archived: r.archived ?? false,
      newest_content_at: r.newest_content_at ?? null,
    }));
    expect(view[2]).toEqual({ id: 'zeta', name: 'zeta', local_path: null, last_commit: null, last_sync_at: null, config: { keep: 1 }, archived: false, newest_content_at: null });
    return view;
  });

  parityTest('readSourceIncarnation returns the config and a uuid incarnation; an unknown id is null', { methods: ['readSourceIncarnation'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { keep: 2 });
    const work = await engine.readSourceIncarnation('work');
    expect(String(work?.incarnation)).toMatch(UUID);
    const unknown = await engine.readSourceIncarnation('no-such-source');
    expect(unknown).toBeNull();
    const config = typeof work?.config === 'string' ? JSON.parse(work.config) : work?.config;
    return { config, incarnationIsUuid: UUID.test(String(work?.incarnation)), unknown };
  });

  parityTest('readSyncDispatchRow returns one routing row: the source columns, no claim or company receipt, and the persistence mode; an unknown id has null columns',
    { methods: ['readSyncDispatchRow'] }, async (engine, backend) => {
      await createSource(engine, backend, 'work', { kind: 'storage', keep: 2 }, '/var/tmp/l11-work');
      await createSource(engine, backend, 'gone');
      await archiveSource(engine, backend, 'gone');
      const view = async (id: string) => {
        const row = await engine.readSyncDispatchRow(id);
        if (!row) return row;
        const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
        return { ...row, incarnation: row.incarnation === null ? null : UUID.test(row.incarnation), config };
      };
      const out = { work: await view('work'), gone: await view('gone'), unknown: await view('no-such-source') };
      expect(out.work).toEqual({ id: 'work', archived: false, config: { kind: 'storage', keep: 2 }, incarnation: true, local_path: '/var/tmp/l11-work', claimed: false, company_receipt: false, modes: [false] });
      expect(out.gone).toEqual({ id: 'gone', archived: true, config: {}, incarnation: true, local_path: null, claimed: false, company_receipt: false, modes: [false] });
      expect(out.unknown).toEqual({ id: null, archived: null, config: null, incarnation: null, local_path: null, claimed: false, company_receipt: false, modes: [false] });
      return out;
    });

  parityTest('readRetainedSources keeps no source whose worktree holds no recovery record, and an empty list reads nothing', { methods: ['readRetainedSources'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work', { keep: 2 });
    await createSource(engine, backend, 'notes', {});
    const none = await engine.readRetainedSources([]);
    const named = await engine.readRetainedSources(['work', 'notes', 'no-such-source']);
    expect(none).toEqual([]);
    expect(named).toEqual([]);
    return { none, named };
  });

  parityTest('hasCompanyBrainReceipt is false for a source with no ingestion receipt', { methods: ['hasCompanyBrainReceipt'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const work = await engine.hasCompanyBrainReceipt('work');
    const unknown = await engine.hasCompanyBrainReceipt('no-such-source');
    expect({ work, unknown }).toEqual({ work: false, unknown: false });
    return { work, unknown };
  });

  parityTest('readGuestSourceRow finds no guest_sources row for a config-only guest or a plain source, and is not hidden', { methods: ['readGuestSourceRow'] }, async (engine, backend) => {
    await createSource(engine, backend, 'visitors', { guest: true });
    await createSource(engine, backend, 'plain');
    const none = { hidden: false, source_id: null, writers: null, trust_ceiling: null };
    const rows = {
      visitors: await engine.readGuestSourceRow('visitors'),
      plain: await engine.readGuestSourceRow('plain'),
      unknown: await engine.readGuestSourceRow('no-such-source'),
    };
    expect(rows).toEqual({ visitors: none, plain: none, unknown: none });
    return rows;
  });

  parityTest('listGuestSourceIds keeps the named sources whose config says guest, each once; hasGuestSource sees any', { methods: ['listGuestSourceIds', 'hasGuestSource'] }, async (engine, backend) => {
    const before = await engine.hasGuestSource();
    expect(before).toBe(false);
    await createSource(engine, backend, 'visitors', { guest: true });
    await createSource(engine, backend, 'texty', { guest: 'true' });
    await createSource(engine, backend, 'plain', { guest: false });
    const ids = sorted(await engine.listGuestSourceIds(['plain', 'visitors', 'texty', 'visitors', 'no-such-source', 'default']));
    expect(ids).toEqual(['texty', 'visitors']);
    const empty = await engine.listGuestSourceIds([]);
    expect(empty).toEqual([]);
    const after = await engine.hasGuestSource();
    expect(after).toBe(true);
    return { before, ids, empty, after };
  });

  parityTest('readPageTrustRows reads pages by id (deleted too) and by key (live unless includeDeleted)', { methods: ['putPage', 'softDeletePage', 'readPageTrustRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'visitors', { guest: true });
    const a = await note(engine, 'a');
    await note(engine, 'b', 'visitors');
    const gone = await note(engine, 'gone');
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const view = (rows: Awaited<ReturnType<BrainEngine['readPageTrustRows']>>) => sorted(
      rows.map(r => ({ source_id: r.source_id, slug: r.slug, trust_tier: r.trust_tier, write_origin: r.write_origin ?? null, flagged: r.flagged, guest: r.guest, byId: r.byId })),
      r => `${r.byId}/${r.source_id}/${r.slug}`);
    const live = view(await engine.readPageTrustRows({
      ids: [a.id, gone.id, a.id],
      keys: [{ source_id: 'visitors', slug: 'b' }, { source_id: 'default', slug: 'gone' }, { source_id: 'visitors', slug: 'b' }, { source_id: 'default', slug: 'missing' }],
    }));
    expect(live.map(r => `${r.byId}/${r.slug}`)).toEqual(['false/b', 'true/a', 'true/gone']);
    const withDeleted = view(await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug: 'gone' }], includeDeleted: true }));
    expect(withDeleted.map(r => r.slug)).toEqual(['gone']);
    const none = await engine.readPageTrustRows({});
    expect(none).toEqual([]);
    return { live, withDeleted, none };
  });

  parityTest('readPageTrustRows reads the tier and origin the page write stamped under the write trust context', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'readPageTrustRows'] }, async (engine) => {
    const TIER = 'gbrain.write_trust_tier';
    const ORIGIN = 'gbrain.write_origin';
    const declared = (tier: string, origin: Record<string, unknown> | null, fn: (tx: BrainEngine) => Promise<unknown>) =>
      engine.transaction(async (tx) => {
        await tx.applyTransactionSettings([TIER, ORIGIN], [tier, origin ? JSON.stringify(origin) : '']);
        return fn(tx);
      });
    const read = async (slug: string) => {
      const [row] = await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug }] });
      const origin = typeof row?.write_origin === 'string' ? JSON.parse(row.write_origin) : row?.write_origin ?? null;
      return { tier: row?.trust_tier, origin };
    };
    const steps: Record<string, unknown> = {};
    await declared('operator_curated', { channel: 'import' }, tx => note(tx, 'curated'));
    steps.inserted = await read('curated');
    expect(steps.inserted).toEqual({ tier: 'operator_curated', origin: { channel: 'import' } });
    await declared('agent_written', { channel: 'agent' }, tx => note(tx, 'curated', 'default', { captured_at: '2026-01-01' }));
    steps.ephemeralOnly = await read('curated');
    expect(steps.ephemeralOnly).toEqual(steps.inserted);
    await declared('agent_written', { channel: 'agent' }, tx => tx.putPage('curated', { type: 'note', title: 'CURATED', compiled_truth: 'rewritten by an agent' }));
    steps.agentRewrite = await read('curated');
    expect(steps.agentRewrite).toEqual({ tier: 'agent_written', origin: { channel: 'agent' } });
    await declared('operator_curated', { channel: 'owner' }, tx => tx.putPage('curated', { type: 'note', title: 'CURATED', compiled_truth: 'rewritten by the owner' }));
    steps.ownerRewrite = await read('curated');
    expect(steps.ownerRewrite).toEqual({ tier: 'operator_curated', origin: { channel: 'owner' } });
    await engine.putPage('curated', { type: 'note', title: 'CURATED', compiled_truth: 'rewritten undeclared' });
    steps.undeclaredRewrite = await read('curated');
    expect(steps.undeclaredRewrite).toEqual({ tier: 'unknown', origin: null });
    await note(engine, 'plain');
    steps.undeclaredInsert = await read('plain');
    expect(steps.undeclaredInsert).toEqual({ tier: 'unknown', origin: null });
    let refused = false;
    await declared('user_confirmed', { channel: 'claim' }, tx => note(tx, 'raised')).catch(() => { refused = true; });
    steps.raiseRefused = { refused, rows: await engine.readPageTrustRows({ keys: [{ source_id: 'default', slug: 'raised' }] }) };
    expect(steps.raiseRefused).toEqual({ refused: true, rows: [] });
    return steps;
  });

  parityTest('readPageTrustRows flags a page at or below agent_written with an instruction-family flag receipt', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'upsertPageWriteGateReceipt', 'readPageTrustRows'] }, async (engine) => {
    const receipt = (hash: string, verdict: 'flag' | 'quarantine', families: string[]) => ({
      content_hash: hash, tier: 'agent_written', detector_version: 1, verdict, reason_families: families,
      reasons: families.map(f => `${f} found`), detector_error: false, request_id: null,
    });
    const agent = (slug: string) => declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => note(tx, slug));
    await agent('agent-flagged');
    await engine.upsertPageWriteGateReceipt('default', 'agent-flagged', receipt('h1', 'flag', ['override']));
    await note(engine, 'unknown-flagged');
    await engine.upsertPageWriteGateReceipt('default', 'unknown-flagged', receipt('h1', 'flag', ['credential', 'other']));
    await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, tx => note(tx, 'tool-flagged'));
    await engine.upsertPageWriteGateReceipt('default', 'tool-flagged', receipt('h1', 'flag', ['exfiltration']));
    await agent('other-family');
    await engine.upsertPageWriteGateReceipt('default', 'other-family', receipt('h1', 'flag', ['other']));
    await agent('quarantined');
    await engine.upsertPageWriteGateReceipt('default', 'quarantined', receipt('h1', 'quarantine', ['standing_instruction']));
    await engine.upsertPageWriteGateReceipt('default', 'quarantined', receipt('h2', 'flag', ['other']));
    await agent('confirmed');
    await engine.upsertPageWriteGateReceipt('default', 'confirmed', receipt('h1', 'flag', ['standing_instruction']));
    await declaredWrite(engine, 'operator_curated', { channel: 'owner' }, tx => tx.putPage('confirmed', { type: 'note', title: 'CONFIRMED', compiled_truth: 'confirmed by the owner' }));
    await agent('no-receipt');
    const slugs = ['agent-flagged', 'unknown-flagged', 'tool-flagged', 'other-family', 'quarantined', 'confirmed', 'no-receipt'];
    const rows = await engine.readPageTrustRows({ keys: slugs.map(slug => ({ source_id: 'default', slug })) });
    const flags = Object.fromEntries(sorted(rows.map(r => [r.slug, { tier: r.trust_tier, flagged: r.flagged }] as const), ([slug]) => slug));
    expect(flags).toEqual({
      'agent-flagged': { tier: 'agent_written', flagged: true },
      'confirmed': { tier: 'operator_curated', flagged: false },
      'no-receipt': { tier: 'agent_written', flagged: false },
      'other-family': { tier: 'agent_written', flagged: false },
      'quarantined': { tier: 'agent_written', flagged: false },
      'tool-flagged': { tier: 'tool_observed', flagged: false },
      'unknown-flagged': { tier: 'unknown', flagged: true },
    });
    return flags;
  });

  parityTest('pageActivationVerdicts labels live pages by key with the stored tier, origin and flag, and applies the floor and flag suppression', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'softDeletePage', 'upsertPageWriteGateReceipt', 'readPageTrustRows'] }, async (engine) => {
    // `gbrain delta` and the turn context label their page rows through this read; an engine that cannot answer it
    // falls back to tier `unknown` and origin `unrecorded` for every page.
    await declaredWrite(engine, 'operator_curated', { channel: 'import' }, tx => note(tx, 'verdict/curated'));
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, tx => note(tx, 'verdict/agent-flagged'));
    await engine.upsertPageWriteGateReceipt('default', 'verdict/agent-flagged', {
      content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['override'],
      reasons: ['override found'], detector_error: false, request_id: null,
    });
    await note(engine, 'verdict/undeclared');
    await declaredWrite(engine, 'operator_curated', { channel: 'import' }, tx => note(tx, 'verdict/deleted'));
    await engine.softDeletePage('verdict/deleted');
    const keys = ['verdict/curated', 'verdict/agent-flagged', 'verdict/undeclared', 'verdict/deleted', 'verdict/missing']
      .map(slug => ({ source_id: 'default', slug }));
    const view = async (policy: ReadEligibility) => Object.fromEntries(sorted([...(await pageActivationVerdicts(engine, keys, policy)).entries()]
      .map(([k, v]) => [k.split('\u0000')[1]!, { ...v, origin: typeof v.origin === 'string' ? JSON.parse(v.origin) : v.origin }] as const), ([slug]) => slug));
    const open = await view({});
    const floored = await view({ floor: 'operator_curated', suppressFlagged: true });
    const none = await pageActivationVerdicts(engine, [], {});
    expect(open).toEqual({
      'verdict/agent-flagged': { tier: 'agent_written', origin: { channel: 'agent' }, belowFloor: false, suppressed: false, unconfirmed: true },
      'verdict/curated': { tier: 'operator_curated', origin: { channel: 'import' }, belowFloor: false, suppressed: false, unconfirmed: false },
      'verdict/undeclared': { tier: 'unknown', origin: null, belowFloor: false, suppressed: false, unconfirmed: false },
    });
    expect(Object.fromEntries(Object.entries(floored).map(([slug, v]) => [slug, [v.belowFloor, v.suppressed]]))).toEqual({
      'verdict/agent-flagged': [true, true], 'verdict/curated': [false, false], 'verdict/undeclared': [true, false],
    });
    expect(none.size).toBe(0);
    return { open, floored };
  });

  parityTest('readRowTrustRows reads the tier, origin and activation flag each timeline write stamped; an unknown id reads none', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTimelineEntry', 'getTimeline', 'upsertWriteGateReceipt', 'readRowTrustRows'] }, async (engine) => {
    await note(engine, 'people/trust-example');
    const add = (summary: string, date: string) => (tx: BrainEngine) => tx.addTimelineEntry('people/trust-example', { date, summary });
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, add('agent flagged', '2026-07-01'));
    await engine.addTimelineEntry('people/trust-example', { date: '2026-07-02', summary: 'unknown flagged' });
    await declaredWrite(engine, 'tool_observed', { channel: 'tool' }, add('tool flagged', '2026-07-03'));
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, add('other family', '2026-07-04'));
    await declaredWrite(engine, 'agent_written', null, add('no receipt', '2026-07-05'));
    const families: Record<string, string[]> = {
      'agent flagged': ['override'], 'unknown flagged': ['credential', 'other'], 'tool flagged': ['exfiltration'], 'other family': ['other'],
    };
    // Receipt targets and the lookup need the row ids; they are written and read, never returned or compared.
    const entries = await engine.getTimeline('people/trust-example');
    for (const row of entries) {
      const f = families[row.summary];
      if (!f) continue;
      await engine.upsertWriteGateReceipt({
        target_table: 'timeline_entries', target_id: String(row.id), source_id: 'default', content_hash: 'h1', tier: 'agent_written',
        detector_version: 1, verdict: 'flag', reason_families: f, reasons: f.map(x => `${x} found`), detector_error: false, request_id: null,
      });
    }
    const summaryOf = new Map(entries.map(e => [Number(e.id), e.summary]));
    const missing = Math.max(...summaryOf.keys()) + 1000;
    const rows = await engine.readRowTrustRows({ table: 'timeline_entries', ids: [...summaryOf.keys(), missing] });
    const trust = Object.fromEntries(sorted(rows.map(r => [summaryOf.get(Number(r.id)), {
      tier: r.trust_tier, origin: r.write_origin, flagged: r.flagged, contested: r.contested,
    }] as const), ([summary]) => String(summary)));
    expect(rows.length).toBe(5);
    expect(trust).toEqual({
      'agent flagged': { tier: 'agent_written', origin: { channel: 'agent' }, flagged: true, contested: null },
      'no receipt': { tier: 'agent_written', origin: null, flagged: false, contested: null },
      'other family': { tier: 'agent_written', origin: { channel: 'agent' }, flagged: false, contested: null },
      'tool flagged': { tier: 'tool_observed', origin: { channel: 'tool' }, flagged: false, contested: null },
      'unknown flagged': { tier: 'unknown', origin: null, flagged: true, contested: null },
    });
    return { trust, none: await engine.readRowTrustRows({ table: 'timeline_entries', ids: [] }) };
  });

  /** One flag receipt on a fact or take row, for the activation flag. */
  parityTest('readPageTrustRows and the fact rows of readRowTrustRows carry the source precedence class (master #10320): guest external, an approved page, the source setting, chat sources, curated', { methods: ['putPage', 'insertFacts', 'readPageTrustRows', 'readRowTrustRows'] }, async (engine, backend) => {
    await createSource(engine, backend, 'visitors', { guest: true });
    await createSource(engine, backend, 'ledger', { precedence: 'record' });
    await createSource(engine, backend, 'meet', { kind: 'meetings' });
    await createSource(engine, backend, 'conversations', {});
    await createSource(engine, backend, 'bogus', { precedence: 'nonsense' });
    const typed = (slug: string, sourceId: string, type: string, frontmatter: Record<string, unknown> = {}) =>
      engine.putPage(slug, { type, title: slug, compiled_truth: `body of ${slug}`, frontmatter }, { sourceId });
    const rows: Array<[string, string]> = [];
    const put = async (slug: string, sourceId: string, type: string, frontmatter: Record<string, unknown> = {}) => { await typed(slug, sourceId, type, frontmatter); rows.push([sourceId, slug]); };
    await put('notes/plain', 'default', 'note');
    await put('notes/draft', 'default', 'facts', { claims: 'draft' });
    await put('company/facts', 'default', 'facts', { claims: 'allowed' });
    await put('rules/weekend', 'default', 'rule');
    await put('rules/in-ledger', 'ledger', 'rule');
    await put('ledgers/q1', 'ledger', 'note');
    await put('meetings/standup', 'meet', 'note');
    await put('chats/day', 'conversations', 'note');
    await put('guest/facts', 'visitors', 'facts', { claims: 'allowed' });
    await put('notes/bogus', 'bogus', 'note');
    const pages = await engine.readPageTrustRows({ keys: rows.map(([source_id, slug]) => ({ source_id, slug })) });
    const byPage = Object.fromEntries(sorted(pages.map(r => [`${r.source_id}/${r.slug}`, r.precedence] as const), ([k]) => k));
    expect(byPage['default/company/facts']).toBe('approved');
    expect(byPage['ledger/rules/in-ledger']).toBe('record');
    expect(byPage['visitors/guest/facts']).toBe('external');
    expect(byPage['meet/meetings/standup']).toBe('chat');
    expect(byPage['default/notes/plain']).toBe('curated');
    // A fact takes its precedence from the page at its source_markdown_slug.
    const ids: Array<[number, string]> = [];
    let n = 0;
    for (const [sourceId, slug] of rows) {
      const out = await engine.insertFacts([{ fact: `fact on ${slug}`, entity_slug: null, visibility: 'world', source: 'test', embedding: null, row_num: ++n, source_markdown_slug: slug }], { source_id: sourceId });
      ids.push([out.ids[0]!, `${sourceId}/${slug}`]);
    }
    const nameOf = new Map(ids);
    const facts = await engine.readRowTrustRows({ table: 'facts', ids: ids.map(([id]) => id) });
    const byFact = Object.fromEntries(sorted(facts.map(r => [nameOf.get(Number(r.id))!, r.precedence] as const), ([k]) => k));
    expect(byFact['default/company/facts']).toBe('approved');
    expect(byFact['ledger/ledgers/q1']).toBe('record');
    const bare = await engine.insertFacts([{ fact: 'no page', entity_slug: null, visibility: 'world', source: 'test', embedding: null, row_num: 99, source_markdown_slug: 'notes/missing' }], { source_id: 'meet' });
    const bareRow = await engine.readRowTrustRows({ table: 'facts', ids: bare.ids });
    expect(bareRow[0]!.precedence).toBe('chat');
    return { byPage, byFact, bare: bareRow[0]!.precedence };
  });

  const flag = (engine: BrainEngine, table: 'facts' | 'takes', id: number, families: string[]) => engine.upsertWriteGateReceipt({
    target_table: table, target_id: String(id), source_id: 'default', content_hash: 'h1', tier: 'agent_written',
    detector_version: 1, verdict: 'flag', reason_families: families, reasons: families.map(x => `${x} found`), detector_error: false, request_id: null,
  });
  /** The trust rows by name: ids and proposal ids are generated, so `contested` reads as its side only. */
  const trustByName = (rows: Awaited<ReturnType<BrainEngine['readRowTrustRows']>>, nameOf: Map<number, string>, proposal: number) =>
    Object.fromEntries(sorted(rows.map(r => [nameOf.get(Number(r.id)), {
      tier: r.trust_tier, origin: r.write_origin, flagged: r.flagged,
      contested: r.contested === null ? null : String(r.contested).replace(`tp${proposal}:`, 'tp:'),
    }] as const), ([name]) => String(name)));

  parityTest('readRowTrustRows reads the tier, origin, activation flag and supersede proposal of each fact; an unknown id reads none', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'upsertWriteGateReceipt', 'insertTrustProposal', 'readRowTrustRows'] }, async (engine) => {
    await engine.putPage('people/fact-example', { type: 'person', title: 'F', compiled_truth: 'F', timeline: '' });
    const insert = (fact: string) => (tx: BrainEngine) => tx.insertFact({ fact, entity_slug: 'people/fact-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
    const curated = await declaredWrite(engine, 'operator_curated', { channel: 'import' }, insert('curated')) as { id: number };
    const agent = await declaredWrite(engine, 'agent_written', { channel: 'agent' }, insert('agent')) as { id: number };
    const bare = await engine.insertFact({ fact: 'bare', entity_slug: 'people/fact-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
    await flag(engine, 'facts', agent.id, ['override']);
    await flag(engine, 'facts', bare.id, ['credential', 'other']);
    // The agent fact challenges the curated one; the bare fact is named by no pending supersede proposal.
    const proposal = await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: 'default', target: { table: 'facts', id: curated.id },
      related: { table: 'facts', id: agent.id }, before: {}, proposer: 'parity' });
    const nameOf = new Map([[curated.id, 'curated'], [agent.id, 'agent'], [bare.id, 'bare']]);
    const missing = Math.max(...nameOf.keys()) + 1000;
    const rows = await engine.readRowTrustRows({ table: 'facts', ids: [...nameOf.keys(), missing] });
    expect(rows.length).toBe(3);
    const trust = trustByName(rows, nameOf, proposal.id);
    expect(trust).toEqual({
      agent: { tier: 'agent_written', origin: { channel: 'agent' }, flagged: true, contested: 'tp:challenger' },
      bare: { tier: 'unknown', origin: null, flagged: true, contested: null },
      curated: { tier: 'operator_curated', origin: { channel: 'import' }, flagged: false, contested: 'tp:challenged' },
    });
    return { trust, none: await engine.readRowTrustRows({ table: 'facts', ids: [] }) };
  });

  parityTest('readRowTrustRows reads the tier and origin each take write stamped, with its activation flag and supersede proposal', { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'addTakesBatch', 'updateTake', 'supersedeTake', 'listTakes', 'upsertWriteGateReceipt', 'insertTrustProposal', 'readRowTrustRows'] }, async (engine) => {
    const page = await engine.putPage('people/take-example', { type: 'person', title: 'T', compiled_truth: 'T', timeline: '' });
    const take = (row_num: number, claim: string, weight = 0.5) => ({ page_id: page.id, row_num, claim, kind: 'take' as const, holder: 'h', weight });
    await declaredWrite(engine, 'operator_curated', { channel: 'import' }, tx => tx.addTakesBatch([take(1, 'rewritten'), take(2, 'reweighted'), take(3, 'superseded')]));
    await declaredWrite(engine, 'agent_written', { channel: 'agent' }, async (tx) => {
      // A claim rewrite is a content change and lowers the tier; a weight change, updateTake and the supersede mark keep it.
      await tx.addTakesBatch([take(1, 'rewritten by agent'), take(2, 'reweighted', 0.9)]);
      await tx.updateTake(page.id, 2, { weight: 0.7 });
      await tx.supersedeTake(page.id, 3, { claim: 'successor', kind: 'take', holder: 'h', weight: 0.5 });
    });
    await engine.addTakesBatch([take(10, 'bare')]);
    const all = [...await engine.listTakes({ page_id: page.id }), ...await engine.listTakes({ page_id: page.id, active: false })];
    const nameOf = new Map(all.map(t => [Number(t.id), t.claim]));
    const idOf = (claim: string) => [...nameOf].find(([, c]) => c === claim)![0];
    expect([...nameOf.values()].sort()).toEqual(['bare', 'reweighted', 'rewritten by agent', 'successor', 'superseded']);
    await flag(engine, 'takes', idOf('successor'), ['override']);
    await flag(engine, 'takes', idOf('reweighted'), ['other']);
    const proposal = await engine.insertTrustProposal({ action: 'supersede_take', sourceId: 'default', target: { table: 'takes', id: idOf('superseded') },
      related: { table: 'takes', id: idOf('successor') }, before: {}, proposer: 'parity' });
    const rows = await engine.readRowTrustRows({ table: 'takes', ids: [...nameOf.keys(), Math.max(...nameOf.keys()) + 1000] });
    expect(rows.length).toBe(5);
    const trust = trustByName(rows, nameOf, proposal.id);
    const curated = { tier: 'operator_curated', origin: { channel: 'import' } };
    const agent = { tier: 'agent_written', origin: { channel: 'agent' } };
    expect(trust).toEqual({
      bare: { tier: 'unknown', origin: null, flagged: false, contested: null },
      reweighted: { ...curated, flagged: false, contested: null },
      'rewritten by agent': { ...agent, flagged: false, contested: null },
      successor: { ...agent, flagged: true, contested: 'tp:challenger' },
      superseded: { ...curated, flagged: false, contested: 'tp:challenged' },
    });
    return trust;
  });

  parityTest('readDatabaseClock returns the UTC clock with microseconds', { methods: ['readDatabaseClock'] }, async (engine) => {
    const at = await engine.readDatabaseClock();
    expect(at).toMatch(CLOCK);
    expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(10 * 60_000);
    return { shape: CLOCK.test(at) };
  });

  parityTest('listLinkPageMetadata lists live pages by source then slug, with aliases and the knowledge revision', { methods: ['putPage', 'softDeletePage', 'listLinkPageMetadata'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await note(engine, 'b', 'default', { aliases: ['Bee'] });
    await note(engine, 'a', 'work');
    await note(engine, 'a');
    await note(engine, 'gone');
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const view = (rows: Awaited<ReturnType<BrainEngine['listLinkPageMetadata']>>) => rows.map(r => {
      expect(String(r.knowledge_revision)).toMatch(UUID);
      return { slug: r.slug, source_id: r.source_id, type: r.type, title: r.title, aliases: r.aliases ?? null };
    });
    const all = view(await engine.listLinkPageMetadata());
    expect(all.map(r => `${r.source_id}/${r.slug}`)).toEqual(['default/a', 'default/b', 'work/a']);
    expect(all[1]!.aliases).toEqual(['Bee']);
    const work = view(await engine.listLinkPageMetadata('work'));
    expect(work.map(r => r.slug)).toEqual(['a']);
    return { all, work };
  });

  parityTest('listLinkPageMetadataForSlugs reads only the named live pages of one source, by slug', { methods: ['putPage', 'softDeletePage', 'listLinkPageMetadataForSlugs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    await note(engine, 'b', 'default', { aliases: ['Bee'] });
    await note(engine, 'a');
    await note(engine, 'c');
    await note(engine, 'b', 'work');
    await note(engine, 'gone');
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const rows = await engine.listLinkPageMetadataForSlugs('default', ['b', 'a', 'gone', 'missing', 'a']);
    for (const r of rows) expect(String(r.knowledge_revision)).toMatch(UUID);
    const view = rows.map(r => ({ slug: r.slug, source_id: r.source_id, type: r.type, title: r.title, aliases: r.aliases ?? null }));
    expect(view.map(r => `${r.source_id}/${r.slug}`)).toEqual(['default/a', 'default/b']);
    expect(view[1]!.aliases).toEqual(['Bee']);
    expect(await engine.listLinkPageMetadataForSlugs('default', [])).toEqual([]);
    return view;
  });

  parityTest('listAttendedOriginSlugs names the pages of one source with a body or frontmatter self attended link', { methods: ['putPage', 'addLinksBatch', 'softDeletePage', 'listAttendedOriginSlugs'] }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    for (const slug of ['a', 'b', 'c', 'd', 'e', 'gone']) await note(engine, slug);
    await note(engine, 'a', 'work');
    const self = (slug: string, link_type: string, link_source: string, sourceId = 'default') => ({ from_slug: slug, to_slug: slug,
      link_type, link_source, origin_slug: slug, from_source_id: sourceId, to_source_id: sourceId, origin_source_id: sourceId,
      ...(link_source === 'frontmatter' ? { origin_field: 'attendees' } : {}) });
    await engine.addLinksBatch([
      self('a', 'attended', 'markdown'),
      self('b', 'attended', 'frontmatter'),
      self('c', 'mentions', 'markdown'),
      self('e', 'attended', 'manual'),
      { from_slug: 'd', to_slug: 'a', link_type: 'attended', link_source: 'markdown', origin_slug: 'd' },
      self('gone', 'attended', 'wikilink-resolved'),
      self('a', 'attended', 'markdown', 'work'),
    ]);
    // The origin join has no live filter: a soft-deleted page that authored the link still counts.
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const all = [...await engine.listAttendedOriginSlugs('default')].sort();
    expect(all).toEqual(['a', 'b', 'gone']);
    const scoped = [...await engine.listAttendedOriginSlugs('default', ['b', 'c', 'missing'])].sort();
    expect(scoped).toEqual(['b']);
    expect(await engine.listAttendedOriginSlugs('default', [])).toEqual([]);
    const work = await engine.listAttendedOriginSlugs('work');
    expect(work).toEqual(['a']);
    return { all, scoped, work };
  });

  parityTest('listStoredTimelineRows returns the stored timeline rows of one page with dates as YYYY-MM-DD', { methods: ['putPage', 'addTimelineEntry', 'listStoredTimelineRows'] }, async (engine) => {
    await note(engine, 'a');
    await note(engine, 'other');
    await engine.addTimelineEntry('a', { date: '2026-02-01', summary: 'second', detail: 'more', source: 'meeting' });
    await engine.addTimelineEntry('a', { date: '2026-01-01', summary: 'first' });
    await engine.addTimelineEntry('other', { date: '2026-03-01', summary: 'elsewhere' });
    const rows = await engine.listStoredTimelineRows('default', 'a');
    const view = sorted(rows.map(r => ({ date: r.date, source: r.source, summary: r.summary, detail: r.detail ?? '' })), r => r.date);
    expect(view).toEqual([
      { date: '2026-01-01', source: '', summary: 'first', detail: '' },
      { date: '2026-02-01', source: 'meeting', summary: 'second', detail: 'more' },
    ]);
    const missing = await engine.listStoredTimelineRows('default', 'missing');
    expect(missing).toEqual([]);
    return { view, missing };
  });

  parityTest('filterPagesAtRevision keeps the live pages still at the named knowledge revision', { methods: ['putPage', 'softDeletePage', 'filterPagesAtRevision'] }, async (engine) => {
    const a = await note(engine, 'a');
    const b = await note(engine, 'b');
    const gone = await note(engine, 'gone');
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const revision = (page: { knowledge_revision?: string }) => String(page.knowledge_revision);
    expect(revision(a)).toMatch(UUID);
    const found = sorted(await engine.filterPagesAtRevision([
      { source_id: 'default', slug: 'a', revision: revision(a) },
      { source_id: 'default', slug: 'b', revision: '00000000-0000-4000-8000-000000000000' },
      { source_id: 'default', slug: 'gone', revision: revision(gone) },
      { source_id: 'work', slug: 'b', revision: revision(b) },
    ]), r => `${r.source_id}/${r.slug}`);
    expect(found).toEqual([{ slug: 'a', source_id: 'default' }]);
    const empty = await engine.filterPagesAtRevision([]);
    expect(empty).toEqual([]);
    return { found, empty };
  });
});
