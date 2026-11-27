/**
 * Belief ledger restore probes (docs/designs/BELIEF_LEDGER.md section 11: 11,
 * 32, 34, 36). PGLite restores replay the purge mirror inside
 * `restorePgliteBackup`; a Postgres restore replays the pre-restore
 * database's tombstones through `replayPurgesFromDatabase` (its arm runs when
 * DATABASE_URL is set). Each probe has a forced probe: a deliberately broken
 * replay or emitter that must make the same assertion fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import { __setBeliefEmitterFaultForTests } from '../src/core/belief/append.ts';
import { __setPurgeReplayFaultForTests, PURGE_MIRROR_FILE, purgeMirrorPath, readRestorePurgeReplay, replayPurgesFromDatabase, type PurgeReplayFault } from '../src/core/belief/purge-mirror.ts';
import { replayPurgesCli } from '../src/commands/beliefs-replay-purges.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { runBackupCli } from '../src/commands/backup.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations } from '../src/core/operations.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setPurgeRedactionFaultForTests } from '../src/core/belief/purge.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { beliefBrain, beliefEngineCase, beliefPage, openFileBeliefBrain, withFileBeliefBrain, type BeliefBrain, type FileBeliefBrain } from './helpers/belief-ledger.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

afterEach(() => { __setPurgeReplayFaultForTests(null); __setBeliefEmitterFaultForTests(null); __setPurgeRedactionFaultForTests(null); });

const X = 'Door code is 4417';
const SOURCE = 'belief-restore';
const purgeOp = operations.find(o => o.name === 'purge_fact')!;
const deleteOp = operations.find(o => o.name === 'delete_page')!;

async function purgeFact(b: BeliefBrain, claim: string): Promise<Record<string, any>> {
  const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id LIMIT 1', [b.sourceId, claim]);
  const dry = await purgeOp.handler(b.ctx, { id: Number(row!.id), dry_run: true }) as Record<string, any>;
  return await purgeOp.handler(b.ctx, { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }) as Record<string, any>;
}

const ledgerRows = (engine: BrainEngine) => engine.executeRaw<{ row: string }>('SELECT row_to_json(e)::text AS row FROM belief_events e ORDER BY id').then(r => r.map(x => x.row));

/** What every read surface of a restored brain still says about `claim`. */
async function carriers(b: BeliefBrain, claim: string): Promise<string[]> {
  const needle = claim.toLowerCase();
  const found: string[] = [];
  for (const [store, sql] of [['facts', 'SELECT fact AS t FROM facts'], ['pages', "SELECT compiled_truth || COALESCE(timeline,'') AS t FROM pages"],
    ['page_versions', "SELECT compiled_truth || COALESCE(timeline,'') AS t FROM page_versions"], ['belief_events', 'SELECT value::text AS t FROM belief_events WHERE value IS NOT NULL']] as const) {
    if ((await b.engine.executeRaw<{ t: string }>(sql)).some(r => r.t?.toLowerCase().includes(needle))) found.push(store);
  }
  return found;
}

/** What the restored brain's facts, pages and versions still say about `claim` (an archive with no ledger tables). */
async function carriersWithoutLedger(b: BeliefBrain, claim: string): Promise<string[]> {
  const needle = claim.toLowerCase();
  const found: string[] = [];
  for (const [store, sql] of [['facts', 'SELECT fact AS t FROM facts'], ['pages', "SELECT compiled_truth || COALESCE(timeline,'') AS t FROM pages"]] as const) {
    if ((await b.engine.executeRaw<{ t: string }>(sql)).some(r => r.t?.toLowerCase().includes(needle))) found.push(store);
  }
  return found;
}

async function backupAndRestore(fb: FileBeliefBrain, between: () => Promise<void>, opts: { purgeMirror?: string } = {}) {
  const archive = join(fb.home, `archive-${randomUUID().slice(0, 8)}.gbrain-backup`);
  const archived = await fb.open(b => ledgerRows(b.engine));
  await createPgliteBackup({ root: fb.home, output: archive });
  await between();
  const into = join(fb.home, `restored-${randomUUID().slice(0, 8)}`);
  const result = await restorePgliteBackup({ archive, into, ...opts });
  const { brain: restored, close } = await openFileBeliefBrain(join(into, '.gbrain', 'brain.pglite'), SOURCE, join(into, 'content'));
  return { archived, result, restored, receipt: JSON.parse(readFileSync(join(into, 'restore-receipt.json'), 'utf8')), close };
}

const Y = 'Acme front door is secured by a four digit code';
const DERIVED_SLUG = 'notes/acme-summary-example';

/** Page with X, a summary page whose fact Y was derived from X (derivation_inputs). */
async function seedDerived(b: BeliefBrain): Promise<void> {
  await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
  await b.put('companies/acme-example', beliefPage({ facts: [X] }));
  await b.put(DERIVED_SLUG, beliefPage({ prose: 'Summary.' }));
  await b.put(DERIVED_SLUG, beliefPage({ facts: [Y] }));
  const [x] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2', [b.sourceId, X]);
  const [y] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2', [b.sourceId, Y]);
  await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId],
    () => recordDerivationInputs(tx, { table: 'facts', id: y!.id, sourceId: b.sourceId }, [{ table: 'facts', id: x!.id }]), TEST_WRITE_ATTRIBUTION));
}

/** Y's live state and the derived.hidden events a replay appended. */
async function derivedState(engine: BrainEngine, sourceId: string) {
  const [y] = await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE source_id = $1 AND fact = $2', [sourceId, Y]);
  const hidden = await engine.executeRaw<{ slug: string; op: string }>(`SELECT slug, cause->>'op' AS op FROM belief_events WHERE source_id = $1 AND event_type = 'derived.hidden'
    AND cause->>'op' = 'restore_replay'`, [sourceId]);
  return { expired: y?.expired ?? null, hidden: hidden.map(h => [h.slug, h.op]) };
}

/** Runs a brain scenario to completion (teardown included, so withEnv scopes never overlap) and returns what it reported. */
async function collect<T>(run: (report: (value: T) => void) => Promise<void>): Promise<T> {
  let out: T | undefined;
  await run(value => { out = value; });
  return out as T;
}

/** Runs `scenario` once for real and once under `fault`; the real run must pass `check` and the faulty one must fail it. */
async function forced<T>(scenario: () => Promise<T>, check: (value: T) => void, fault: () => void): Promise<void> {
  check(await scenario());
  fault();
  try {
    const value = await scenario();
    let failed = false;
    try { check(value); } catch { failed = true; }
    expect(failed).toBe(true);
  } finally { __setPurgeReplayFaultForTests(null); __setBeliefEmitterFaultForTests(null); __setPurgeRedactionFaultForTests(null); }
}
const replayFault = (fault: PurgeReplayFault) => () => __setPurgeReplayFaultForTests(fault);

describe('belief ledger restore (pglite archive)', () => {
  test('probe 11: the restored ledger is the archive\'s plus one coverage.restored; a later purge is replayed; no mirror records unavailable', async () => {
    const scenario = () => collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme sells widgets'] }));
      });
      const plain = await backupAndRestore(fb, async () => undefined);
      const plainRows = await ledgerRows(plain.restored.engine);
      const plainAdded = (await plain.restored.events()).slice(-1).map(e => [e.event_type, e.cause.purge_replay]);
      await plain.close();
      let request = '';
      const replayed = await backupAndRestore(fb, () => fb.open(async b => {
        const result = await purgeFact(b, X);
        request = (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [result.request_id]))[0]!.id;
      }));
      const replayEvents = (await replayed.restored.events()).filter(e => e.cause.op === 'restore_replay').map(e => [e.event_type, e.value, e.purged, e.cause.purge_request, e.cause.outcome]);
      const left = await carriers(replayed.restored, X);
      const page = await operations.find(o => o.name === 'get_page')!.handler(replayed.restored.ctx, { slug: 'companies/acme-example' });
      const replay = { state: replayed.result.purge_replay.state, receipt: replayed.receipt.purge_replay.state, recorded: (await readRestorePurgeReplay(replayed.restored.engine)).map(r => r.purge_replay) };
      await replayed.close();
      const lost = await backupAndRestore(fb, async () => undefined, { purgeMirror: join(fb.home, 'missing', '.gbrain', PURGE_MIRROR_FILE) });
      const unavailable = { state: lost.result.purge_replay.state, recorded: (await readRestorePurgeReplay(lost.restored.engine)).map(r => r.purge_replay),
        warned: lost.result.reconnect_required.some(l => l.includes('were not replayed')) };
      await lost.close();
      resolve({ archived: plain.archived, plainRows, plainAdded, request, replayEvents, left, pageText: JSON.stringify(page), replay, unavailable });
    }));
    await forced(scenario, (r: any) => {
      expect(r.plainRows.slice(0, -1)).toEqual(r.archived);
      expect(r.plainRows.length).toBe(r.archived.length + 1);
      expect(r.plainAdded).toEqual([['coverage.restored', 'none']]);
      expect(r.replayEvents).toEqual([['fact.purged', null, true, r.request, 'complete']]);
      expect(r.left).toEqual([]);
      expect(r.pageText.toLowerCase()).not.toContain(X.toLowerCase());
      expect(r.replay).toEqual({ state: 'complete', receipt: 'complete', recorded: ['complete'] });
      expect(r.unavailable).toEqual({ state: 'unavailable', recorded: ['unavailable'], warned: true });
    }, replayFault('skip_replay'));
  }, 300_000);

  test('probe 32: an archive holding only another subject\'s quote of a claim asserted and purged later replays partial and warns', async () => {
    const scenario = () => collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(async b => {
        await b.put('notes/quotes-example', beliefPage({ prose: 'Quotes.' }));
        await b.put('notes/quotes-example', beliefPage({ facts: [{ claim: 'Quote one', context: `heard ${X}` }] }));
      });
      const restored = await backupAndRestore(fb, () => fb.open(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X] }));
        await purgeFact(b, X);
      }));
      const out = { state: restored.result.purge_replay.state, outcomes: restored.result.purge_replay.replays.map(r => r.outcome),
        warned: restored.result.reconnect_required.some(l => l.includes('Purge replay is partial')) };
      await restored.close();
      resolve(out);
    }));
    await forced(scenario, (r: any) => expect(r).toEqual({ state: 'partial', outcomes: ['partial'], warned: true }), replayFault('always_complete'));
  }, 300_000);

  test('probe 34: a purge whose committed line never landed, after complete ones, is reported unverified and warns', async () => {
    const scenario = () => collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme has two offices'] }));
        await b.put('companies/widgets-example', beliefPage({ prose: 'Widgets.' }));
        await b.put('companies/widgets-example', beliefPage({ facts: ['Acme sells widgets'] }));
      });
      const restored = await backupAndRestore(fb, () => fb.open(async b => {
        await purgeFact(b, 'Acme sells widgets');
        await purgeFact(b, X);
        const mirror = join(fb.home, '.gbrain', PURGE_MIRROR_FILE);
        const lines = readFileSync(mirror, 'utf8').trimEnd().split('\n');
        expect(JSON.parse(lines.at(-1)!).kind).toBe('committed');
        writeFileSync(mirror, lines.slice(0, -1).join('\n') + '\n', { mode: 0o600 });
      }));
      const out = { state: restored.result.purge_replay.state, outcomes: restored.result.purge_replay.replays.map(r => r.outcome),
        warned: restored.result.reconnect_required.some(l => l.includes('(unverified)')), left: await carriers(restored.restored, X) };
      await restored.close();
      resolve(out);
    }));
    await forced(scenario, (r: any) => expect(r).toEqual({ state: 'unverified', outcomes: ['complete', 'unverified'], warned: true,
      left: ['facts', 'pages', 'belief_events'] }), replayFault('replay_uncommitted'));
  }, 300_000);

  test('probe 36: backup, soft delete, retention cleanup (page.expired), then restore: no tombstone, no redaction, nothing replayed', async () => {
    const scenario = () => collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      const slug = 'notes/old-example';
      await fb.open(async b => {
        await b.put(slug, beliefPage({ prose: 'Old.' }));
        await b.put(slug, beliefPage({ facts: ['Old note fact'] }));
      });
      let cleanup: Record<string, unknown> = {};
      const restored = await backupAndRestore(fb, () => fb.open(async b => {
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
        await deleteOp.handler(b.ctx, { slug, expected_revision: snapshot!.revision, request_id: randomUUID() });
        const mark = await b.lastId();
        await purgeDeletedPagesCoordinated(b.engine, 0);
        const events = await b.events(mark);
        cleanup = {
          events: events.map(e => [e.subject_kind, e.event_type, e.purged, e.cause.cause ?? null]),
          tombstones: Number((await b.engine.executeRaw<{ n: number }>('SELECT (SELECT count(*) FROM page_purges) + (SELECT count(*) FROM fact_purges) AS n'))[0]!.n),
          redacted: Number((await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_events WHERE purged OR redacted_fields IS NOT NULL'))[0]!.n),
          mirror: existsSync(join(fb.home, '.gbrain', PURGE_MIRROR_FILE)),
        };
      }));
      const out = { cleanup, state: restored.result.purge_replay.state,
        restoredRedacted: Number((await restored.restored.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_events WHERE purged OR redacted_fields IS NOT NULL'))[0]!.n) };
      await restored.close();
      resolve(out);
    }));
    await forced(scenario, (r: any) => expect(r).toEqual({
      cleanup: { events: [['page', 'page.expired', false, null]], tombstones: 0, redacted: 0, mirror: false }, state: 'none', restoredRedacted: 0 }),
    () => __setBeliefEmitterFaultForTests(drafts => drafts.map(d => d.eventType === 'page.expired' ? { ...d, eventType: 'page.purged', purged: true } : d)));
  }, 300_000);
  test('#9: gbrain backup restore --purge-mirror replays from a named copy of the mirror, and the warning names that flag', async () => {
    const r = await collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme sells widgets'] }));
      });
      const archive = join(fb.home, 'cli.gbrain-backup');
      await createPgliteBackup({ root: fb.home, output: archive });
      await fb.open(async b => { await purgeFact(b, X); });
      const copy = join(fb.home, 'mirror-copy.jsonl');
      renameSync(join(fb.home, '.gbrain', PURGE_MIRROR_FILE), copy);
      const cli = async (args: string[]) => {
        const logged: string[] = [];
        const original = console.log;
        console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
        try { const { exitCode } = await runBackupCli(args, async () => { throw new Error('restore opens no brain'); }); return { exitCode, out: JSON.parse(logged.at(-1)!) }; }
        finally { console.log = original; }
      };
      const named = await cli(['restore', archive, '--into', join(fb.home, 'restored-named'), '--purge-mirror', copy, '--json']);
      const lost = await restorePgliteBackup({ archive, into: join(fb.home, 'restored-lost'), purgeMirror: join(fb.home, 'missing', '.gbrain', PURGE_MIRROR_FILE) });
      resolve({ exitCode: named.exitCode, state: named.out.purge_replay.state, warning: lost.reconnect_required.find(l => l.includes('were not replayed'))?.includes('--purge-mirror') });
    }));
    expect(r).toEqual({ exitCode: 0, state: 'complete', warning: true });
  }, 300_000);

  test('#3: a replayed purge hides its derived rows again and appends derived.hidden', async () => {
    const scenario = () => collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(seedDerived);
      const restored = await backupAndRestore(fb, () => fb.open(async b => { await purgeFact(b, X); }));
      const out = { outcomes: restored.result.purge_replay.replays.map(r => r.outcome), ...await derivedState(restored.restored.engine, SOURCE) };
      await restored.close();
      resolve(out);
    }));
    await forced(scenario, (r: any) => expect(r).toEqual({ outcomes: ['complete'], expired: true, hidden: [[DERIVED_SLUG, 'restore_replay']] }),
      () => __setPurgeRedactionFaultForTests('skip_derived_hidden'));
  }, 300_000);

  test('#4: an archive from before the ledger (v248) restores and replays tombstones and row removal', async () => {
    const r = await collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      await fb.open(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme sells widgets'] }));
      });
      const archive = join(fb.home, 'old.gbrain-backup');
      await fb.open(async b => {
        await b.engine.executeRaw('DROP TABLE belief_events, belief_page_lifetimes, belief_commit_marks, belief_retier_manifest, belief_redactions');
        await b.engine.executeRaw('ALTER TABLE sources DROP COLUMN purge_epoch');
        await b.engine.setConfig('version', '248');
      });
      await createPgliteBackup({ root: fb.home, output: archive });
      await fb.open(async b => { await b.engine.initSchema(); await purgeFact(b, X); });
      const into = join(fb.home, 'restored-old');
      const result = await restorePgliteBackup({ archive, into });
      const { brain, close } = await openFileBeliefBrain(join(into, '.gbrain', 'brain.pglite'), SOURCE, join(into, 'content'));
      try {
        resolve({ purge_replay: { ...result.purge_replay, replays: result.purge_replay.replays.map(x => x.outcome) }, left: await carriersWithoutLedger(brain, X),
          tombstones: (await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_purges WHERE source_id = $1', [SOURCE]))[0]!.n });
      } finally { await close(); }
    }));
    expect(r).toEqual({ purge_replay: { state: 'complete', replays: ['complete'], ledger: 'absent' }, left: [], tombstones: 1 });
  }, 300_000);

  /** #9469: one page's text in each store a live page purge sweeps, for a replay parity probe. */
  interface ParityPage { sourceId: string; slug: string; claim: string; timeline: string; reason: string }
  const PURGED_REPLAY: Omit<ParityPage, 'sourceId'> = { slug: 'notes/purged-replay-example', claim: X, timeline: 'Visited the vault at the harbor office', reason: 'Reason quoting the vault plan' };
  const KEPT_REPLAY: Omit<ParityPage, 'sourceId'> = { slug: 'notes/kept-replay-example', claim: 'Zebra fence code is 9921', timeline: 'Walked the dog by the river', reason: 'Reason about the dog walk' };
  const REPOLESS = 'repoless-example';

  /** Writes the page through the coordinator with a change reason, a fact and a timeline entry, then a file record, a core-edit notice, a generation preimage and (on a source with a checkout) its Git effect's reason trailer. */
  async function seedParity(b: BeliefBrain, page: ParityPage): Promise<void> {
    const ctx = { ...b.ctx, sourceId: page.sourceId };
    const op = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx as never, { operation: operation as never, params: { request_id: randomUUID(), ...params } as never });
    await op('put_page', { slug: page.slug, content: beliefPage({ prose: `The plan. ${page.claim}.` }), force: true, reason: page.reason });
    await op('put_page', { slug: page.slug, content: beliefPage({ prose: `The plan. ${page.claim}.`, facts: [page.claim] }), force: true });
    await op('add_timeline_entry', { slug: page.slug, date: '2024-01-02', summary: page.timeline, source: 'notes' });
    const [row] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [page.sourceId, page.slug]);
    const [request] = await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE source_id = $1 AND slug = $2 ORDER BY sequence LIMIT 1', [page.sourceId, page.slug]);
    await b.engine.transaction(tx => withCoordinatedWrite(tx, [page.sourceId], async () => {
      await tx.executeRaw(`INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, content_hash) VALUES ($1, $2, $3, 'plan.pdf', $4, 'sha-example')`,
        [page.sourceId, page.slug, row!.id, `files/${page.sourceId}/${page.slug}.pdf`]);
      await tx.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, page_id, base_text, actor) VALUES ($1, $2, $3, $4, 'example')`, [page.sourceId, page.slug, row!.id, page.claim]);
      const [gen] = await tx.executeRaw<{ id: number }>(`INSERT INTO derived_generations (source_id, kind, owner_key, state, operation_id, item_set_hash) VALUES ($1, 'example', 'page:' || $2, 'superseded', 'op-example', 'hash-example') RETURNING id`,
        [page.sourceId, page.slug]);
      await tx.executeRaw(`INSERT INTO derived_generation_items (generation_id, item_key, identity_hash, action, preimage) VALUES ($1, $2, 'identity-example', 'published', $3::text::jsonb)`,
        [gen!.id, page.slug, JSON.stringify({ text: page.claim })]);
      if (page.sourceId !== REPOLESS) {
        await tx.executeRaw(`INSERT INTO persistence_effects (request_id, kind, data, state, source_id) VALUES ($1::uuid, 'git', $2::text::jsonb, 'committed', $3) ON CONFLICT DO NOTHING`,
          [request!.id, JSON.stringify({ slug: page.slug, commit_line: `Update ${page.slug}`, commit_trailers: [`gbrain-reason: ${page.reason}`] }), page.sourceId]);
      }
    }, TEST_WRITE_ATTRIBUTION));
  }

  /** The stores of the source that still carry the page's claim, timeline entry or reason, or name its slug. */
  async function parityStores(engine: BrainEngine, page: ParityPage): Promise<string[]> {
    const found: string[] = [];
    const needles = [page.claim, page.timeline, page.reason].map(n => n.toLowerCase());
    const carries = async (store: string, sql: string) => {
      const rows = await engine.executeRaw<{ t: string | null }>(sql, [page.sourceId, page.slug]);
      if (rows.some(r => needles.some(n => (r.t ?? '').toLowerCase().includes(n)))) found.push(store);
    };
    const names = async (store: string, sql: string) => { if ((await engine.executeRaw(sql, [page.sourceId, page.slug])).length) found.push(store); };
    await carries('persistence_requests', "SELECT intent::text || COALESCE(outcome::text, '') AS t FROM persistence_requests WHERE source_id = $1 AND ($2::text IS NOT NULL)");
    await names('files', 'SELECT 1 FROM files WHERE source_id = $1 AND page_slug = $2');
    await names('core_edit_notices', 'SELECT 1 FROM core_edit_notices WHERE source_id = $1 AND slug = $2');
    await carries('derived_generation_items', 'SELECT i.preimage::text AS t FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id WHERE g.source_id = $1 AND i.item_key = $2');
    await carries('persistence_effects', "SELECT data::text AS t FROM persistence_effects WHERE source_id = $1 AND kind = 'git' AND data->>'slug' = $2");
    return found;
  }

  /** Every row of the page and of the stores keyed to it, as stored, for a byte-for-byte comparison. */
  async function parityRows(engine: BrainEngine, page: ParityPage): Promise<Record<string, string[]>> {
    const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [page.sourceId, page.slug]);
    const read = async (sql: string, params: unknown[]) => (await engine.executeRaw<{ r: string }>(sql, params)).map(x => x.r).sort();
    const id = row?.id ?? -1;
    return {
      pages: await read('SELECT row_to_json(t)::text AS r FROM pages t WHERE id = $1', [id]),
      facts: await read('SELECT row_to_json(t)::text AS r FROM facts t WHERE source_id = $1 AND source_markdown_slug = $2', [page.sourceId, page.slug]),
      timeline_entries: await read('SELECT row_to_json(t)::text AS r FROM timeline_entries t WHERE page_id = $1', [id]),
      page_versions: await read('SELECT row_to_json(t)::text AS r FROM page_versions t WHERE page_id = $1', [id]),
      files: await read('SELECT row_to_json(t)::text AS r FROM files t WHERE source_id = $1 AND page_slug = $2', [page.sourceId, page.slug]),
      core_edit_notices: await read('SELECT row_to_json(t)::text AS r FROM core_edit_notices t WHERE source_id = $1 AND slug = $2', [page.sourceId, page.slug]),
      derived_generation_items: await read('SELECT row_to_json(i)::text AS r FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id WHERE g.source_id = $1 AND i.item_key = $2', [page.sourceId, page.slug]),
      derived_generations: await read("SELECT row_to_json(g)::text AS r FROM derived_generations g WHERE g.source_id = $1 AND g.owner_key = 'page:' || $2", [page.sourceId, page.slug]),
      // An effect's state and attempts move as background work runs after the restore; what a purge would change is its data.
      persistence_effects: await read("SELECT json_build_object('id', id, 'kind', kind, 'data', data)::text AS r FROM persistence_effects t WHERE source_id = $1 AND data->>'slug' = $2", [page.sourceId, page.slug]),
      // A settled request's claim bookkeeping (execution token, terminal reservation) is released after the restore opens; a purge changes neither.
      persistence_requests: await read("SELECT (to_jsonb(t) - 'execution_token' - 'terminal_reservation' - 'claim_expires_at')::text AS r FROM persistence_requests t WHERE source_id = $1 AND slug = $2", [page.sourceId, page.slug]),
    };
  }

  /** Seeds a purged and a kept page in \`sourceId\`, backs up, purges the first live, restores, and reports what each brain still holds. */
  async function parityProbe(sourceId: string) {
    const purged = { ...PURGED_REPLAY, sourceId }, kept = { ...KEPT_REPLAY, sourceId };
    return collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      let keptBefore: Record<string, string[]> = {}, seeded: string[] = [], effects = 0;
      await fb.open(async b => {
        if (sourceId === REPOLESS) await b.engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [REPOLESS]);
        await seedParity(b, purged);
        await seedParity(b, kept);
        seeded = await parityStores(b.engine, purged);
        effects = (await b.engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id = $1 AND kind = 'git'", [sourceId])).length;
        keptBefore = await parityRows(b.engine, kept);
      });
      let live: string[] = [];
      const restored = await backupAndRestore(fb, () => fb.open(async b => {
        const ctx = { ...b.ctx, sourceId };
        const snapshot = await b.engine.readPageSnapshot(purged.slug, { sourceId, includeDeleted: true });
        expect((await deleteOp.handler(ctx as never, { slug: purged.slug, source_id: sourceId, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() }) as { status: string }).status).toBe('purged');
        live = await parityStores(b.engine, purged);
      }));
      const out = { seeded, effects: effects > 0, live, replayed: await parityStores(restored.restored.engine, purged),
        keptChanged: await parityRows(restored.restored.engine, kept).then(after => Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(keptBefore[k]))), keptCarries: await parityStores(restored.restored.engine, kept),
        outcomes: restored.result.purge_replay.replays.map(x => [x.scope, x.outcome]) };
      await restored.close();
      resolve(out);
    }));
  }

  test('#9469: a replayed page purge leaves no more of the page than the live purge (request intents and timeline receipts, files, slug stores, the generation ledger, Git effect reasons), and a page it did not purge is byte-for-byte intact', async () => {
    expect(await parityProbe(SOURCE)).toEqual({ seeded: ['persistence_requests', 'files', 'core_edit_notices', 'derived_generation_items', 'persistence_effects'], effects: true,
      live: [], replayed: [], keptChanged: [], keptCarries: ['persistence_requests', 'files', 'core_edit_notices', 'derived_generation_items', 'persistence_effects'], outcomes: [['page', 'complete']] });
  }, 300_000);

  test('#9469 (repo-less source): no Git effects exist; the change reason lives only in the request journal, and the replay redacts it there as the live purge does', async () => {
    expect(await parityProbe(REPOLESS)).toEqual({ seeded: ['persistence_requests', 'files', 'core_edit_notices', 'derived_generation_items'], effects: false,
      live: [], replayed: [], keptChanged: [], keptCarries: ['persistence_requests', 'files', 'core_edit_notices', 'derived_generation_items'], outcomes: [['page', 'complete']] });
  }, 300_000);

  test('#9469: a replay whose journal sweep cannot cover every request stops the restore and names the purge it did not replay', async () => {
    const r = await collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      const purged = { ...PURGED_REPLAY, sourceId: SOURCE };
      await fb.open(b => seedParity(b, purged));
      let requestId = '';
      __setPurgeReplayFaultForTests('incomplete_census');
      try {
        await backupAndRestore(fb, () => fb.open(async b => {
          requestId = randomUUID();
          const snapshot = await b.engine.readPageSnapshot(purged.slug, { sourceId: SOURCE, includeDeleted: true });
          await deleteOp.handler(b.ctx, { slug: purged.slug, purge: true, expected_revision: snapshot!.revision, request_id: requestId });
        }));
        resolve({ threw: null });
      } catch (error) {
        resolve({ threw: (error as { code?: string }).code ?? String(error), names: String((error as Error).message).includes(requestId) });
      }
    }));
    expect(r).toEqual({ threw: 'purge_replay_incomplete', names: true });
  }, 300_000);

  test('#33: a page-scope replay never deletes an unrelated page that held the slug in the archive', async () => {
    const r = await collect<Record<string, unknown>>(resolve => withFileBeliefBrain(SOURCE, async fb => {
      const slug = 'notes/shared-slug-example';
      await fb.open(async b => { await b.put(slug, beliefPage({ prose: 'Page B, unrelated.' })); });
      const restored = await backupAndRestore(fb, () => fb.open(async b => {
        renameSync(join(b.root, `${slug}.md`), join(b.root, 'notes/b-moved-example.md'));
        await b.engine.executeRaw(`UPDATE pages SET slug = 'notes/b-moved-example', source_path = $3 WHERE source_id = $1 AND slug = $2`,
          [SOURCE, slug, join(b.root, 'notes/b-moved-example.md')]);
        await b.put(slug, beliefPage({ prose: 'Page A.' }));
        await b.put(slug, beliefPage({ facts: [X] }));
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: SOURCE, includeDeleted: true });
        await deleteOp.handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() });
      }));
      const out = { outcomes: restored.result.purge_replay.replays.map(x => [x.scope, x.outcome]),
        pages: (await restored.restored.engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug', [SOURCE])).map(p => p.slug) };
      await restored.close();
      resolve(out);
    }));
    expect(r).toEqual({ outcomes: [['page', 'partial']], pages: ['notes/shared-slug-example'] });
  }, 300_000);
});

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger restore (${engineCase.name})`, () => {
    test('probe 36 (managed): retention cleanup appends page.expired, writes no tombstone or mirror line and redacts nothing', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => beliefBrain(async b => {
        const slug = 'notes/old-example';
        await b.put(slug, beliefPage({ prose: 'Old.' }));
        await b.put(slug, beliefPage({ facts: ['Old note fact'] }));
        const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: b.sourceId });
        await deleteOp.handler(b.ctx, { slug, expected_revision: snapshot!.revision, request_id: randomUUID() });
        await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '2 hours' WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]).catch(() => undefined);
        const mark = await b.lastId();
        const purged = await purgeDeletedPagesCoordinated(b.engine, 0);
        resolve({
          slugs: purged.slugs,
          events: (await b.events(mark)).map(e => [e.subject_kind, e.event_type, e.purged]),
          tombstones: Number((await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM page_purges WHERE source_id = $1', [b.sourceId]))[0]!.n),
          redacted: Number((await b.engine.executeRaw<{ n: number }>('SELECT count(*) AS n FROM belief_events WHERE source_id = $1 AND (purged OR redacted_fields IS NOT NULL)', [b.sourceId]))[0]!.n),
          mirror: existsSync(join(process.env.GBRAIN_HOME!, '.gbrain', PURGE_MIRROR_FILE)),
        });
      }, { managed: true, databaseUrl: engineCase.databaseUrl }));
      await forced(scenario, (r: any) => expect(r).toEqual({ slugs: ['notes/old-example'], events: [['page', 'page.expired', false]], tombstones: 0, redacted: 0, mirror: false }),
        () => __setBeliefEmitterFaultForTests(drafts => drafts.map(d => d.eventType === 'page.expired' ? { ...d, eventType: 'page.purged', purged: true } : d)));
    }, 240_000);

    test('#9: beliefs replay-purges refuses on PGLite (the restore replays itself) and refuses without one replay source', async () => {
      const r = await collect<string[]>(resolve => beliefBrain(async b => {
        const codes: string[] = [];
        for (const args of [['replay-purges', '--archived-at', '2026-01-01T00:00:00Z'], ['replay-purges', '--archived-at', '2026-01-01T00:00:00Z', '--purge-mirror', 'relative.jsonl']])
          codes.push(await replayPurgesCli(b.engine, args).then(() => 'ok', (e: { code?: string; message: string }) => `${e.code}:${/PGLite|exactly one|absolute/.exec(e.message)?.[0]}`));
        resolve(codes);
      }, { databaseUrl: engineCase.databaseUrl }));
      expect(r).toEqual(engineCase.name === 'postgres' ? ['invalid_params:exactly one', 'invalid_params:absolute'] : ['invalid_params:PGLite', 'invalid_params:PGLite']);
    }, 120_000);

    if (engineCase.name !== 'postgres') return;
    test('#10 (postgres): a purge that started before the dump and committed after it is replayed; one already in the archive is not', async () => {
      const r = await collect<Record<string, unknown>>(resolve => beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme has two offices'] }));
        await b.put('companies/widgets-example', beliefPage({ prose: 'Widgets.' }));
        await b.put('companies/widgets-example', beliefPage({ facts: ['Acme sells widgets'] }));
        await purgeFact(b, 'Acme sells widgets');
        const url = new URL(engineCase.databaseUrl!);
        const [{ db }] = await b.engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const clone = `gbrain_test_restore_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const admin = postgres(engineCase.databaseUrl!, { max: 1, prepare: false });
        await disposePersistenceConsumer(b.engine);
        await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);
        await admin.unsafe(`CREATE DATABASE ${clone} TEMPLATE ${db}`);
        const archivedAt = new Date().toISOString();
        const restored = new PostgresEngine();
        try {
          const result = await purgeFact(b, X);
          const request = (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [result.request_id]))[0]!.id;
          for (const table of ['fact_purges', 'take_purges'])
            await b.engine.executeRaw(`UPDATE ${table} SET purged_at = $2::timestamptz - interval '1 second' WHERE request_id = $1::uuid`, [request, archivedAt]);
          url.pathname = `/${clone}`;
          await restored.connect({ database_url: url.toString(), poolSize: 2 });
          const replay = await replayPurgesFromDatabase(restored, b.engine, archivedAt);
          resolve({ replays: replay.replays.map(x => [x.request === request, x.outcome]), left: await carriers({ ...b, engine: restored }, X) });
        } finally {
          await restored.disconnect();
          await admin.unsafe(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`);
          await admin.end();
        }
      }, { databaseUrl: engineCase.databaseUrl }));
      expect(r).toEqual({ replays: [[true, 'complete']], left: [] });
    }, 300_000);
    test('#9 (postgres): beliefs replay-purges previews without writing, then --apply replays from the pre-restore database or the purge mirror', async () => {
      const r = await collect<Record<string, unknown>>(resolve => beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme has two offices'] }));
        const url = new URL(engineCase.databaseUrl!);
        const [{ db }] = await b.engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const admin = postgres(engineCase.databaseUrl!, { max: 1, prepare: false });
        await disposePersistenceConsumer(b.engine);
        await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);
        const clones = [0, 1].map(() => `gbrain_test_restore_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
        for (const clone of clones) await admin.unsafe(`CREATE DATABASE ${clone} TEMPLATE ${db}`);
        const archivedAt = new Date().toISOString();
        const engines = clones.map(() => new PostgresEngine());
        const env = `GBRAIN_TEST_PRE_RESTORE_URL_${randomUUID().slice(0, 8).toUpperCase()}`;
        try {
          await purgeFact(b, X);
          url.pathname = `/${db}`;
          const preRestoreUrl = url.toString();
          for (const [i, clone] of clones.entries()) { url.pathname = `/${clone}`; await engines[i]!.connect({ database_url: url.toString(), poolSize: 2 }); }
          const [fromDb, fromMirror] = engines.map(e => ({ ...b, engine: e }));
          const dbArgs = ['replay-purges', '--archived-at', archivedAt, '--from-url-env', env];
          const viaDb = (args: string[]) => withEnv({ [env]: preRestoreUrl }, () => replayPurgesCli(fromDb!.engine, args));
          const dry = await viaDb(dbArgs);
          const afterDry = (await carriers(fromDb!, X)).length;
          const applied = await viaDb([...dbArgs, '--apply']);
          const mirror = await replayPurgesCli(fromMirror!.engine, ['replay-purges', '--archived-at', archivedAt, '--purge-mirror', purgeMirrorPath(), '--apply']);
          resolve({ dry: [dry.value.applied, dry.value.replays.length, dry.value.apply_argv?.at(-1)], afterDry: afterDry > 0,
            applied: [applied.value.applied, applied.value.state], leftDb: await carriers(fromDb!, X),
            mirror: [mirror.value.from, mirror.value.state], leftMirror: await carriers(fromMirror!, X) });
        } finally {
          for (const e of engines) await e.disconnect().catch(() => undefined);
          for (const clone of clones) await admin.unsafe(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`);
          await admin.end();
        }
      }, { databaseUrl: engineCase.databaseUrl }));
      expect(r).toEqual({ dry: [false, 1, '--apply'], afterDry: true, applied: [true, 'complete'], leftDb: [], mirror: ['purge_mirror', 'complete'], leftMirror: [] });
    }, 300_000);

    test('#3 (postgres): replayPurgesFromDatabase hides the purge\'s derived rows again and appends derived.hidden', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => beliefBrain(async b => {
        await seedDerived(b);
        const url = new URL(engineCase.databaseUrl!);
        const [{ db }] = await b.engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const clone = `gbrain_test_restore_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const admin = postgres(engineCase.databaseUrl!, { max: 1, prepare: false });
        await disposePersistenceConsumer(b.engine);
        await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);
        await admin.unsafe(`CREATE DATABASE ${clone} TEMPLATE ${db}`);
        const archivedAt = new Date().toISOString();
        const restored = new PostgresEngine();
        try {
          await purgeFact(b, X);
          url.pathname = `/${clone}`;
          await restored.connect({ database_url: url.toString(), poolSize: 2 });
          const replay = await replayPurgesFromDatabase(restored, b.engine, archivedAt);
          resolve({ outcomes: replay.replays.map(x => x.outcome), ...await derivedState(restored, b.sourceId) });
        } finally {
          await restored.disconnect();
          await admin.unsafe(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`);
          await admin.end();
        }
      }, { databaseUrl: engineCase.databaseUrl }));
      await forced(scenario, (r: any) => expect(r).toEqual({ outcomes: ['complete'], expired: true, hidden: [[DERIVED_SLUG, 'restore_replay']] }),
        () => __setPurgeRedactionFaultForTests('skip_derived_hidden'));
    }, 300_000);
    test('probe 11 (postgres): replayPurgesFromDatabase replays the pre-restore database\'s later purges into a clone taken at the archive time', async () => {
      const scenario = () => collect<Record<string, unknown>>(resolve => beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme.' }));
        await b.put('companies/acme-example', beliefPage({ facts: [X, 'Acme sells widgets'] }));
        const url = new URL(engineCase.databaseUrl!);
        const [{ db }] = await b.engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const clone = `gbrain_test_restore_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const admin = postgres(engineCase.databaseUrl!, { max: 1, prepare: false });
        await disposePersistenceConsumer(b.engine);
        await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);
        await admin.unsafe(`CREATE DATABASE ${clone} TEMPLATE ${db}`);
        const archivedAt = new Date().toISOString();
        const restored = new PostgresEngine();
        try {
          const result = await purgeFact(b, X);
          const request = (await b.engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id = $1::uuid', [result.request_id]))[0]!.id;
          url.pathname = `/${clone}`;
          await restored.connect({ database_url: url.toString(), poolSize: 2 });
          const replay = await replayPurgesFromDatabase(restored, b.engine, archivedAt);
          const events = (await restored.executeRaw<{ event_type: string; value: unknown; purged: boolean; cause: unknown }>(`SELECT event_type, value, purged, cause FROM belief_events
            WHERE source_id = $1 AND (cause->>'op' = 'restore_replay' OR event_type = 'coverage.restored') ORDER BY id`, [b.sourceId]))
            .map(e => { const c = typeof e.cause === 'string' ? JSON.parse(e.cause) : e.cause as Record<string, unknown>; return [e.event_type, e.value, e.purged, c.purge_request ?? c.purge_replay]; });
          const left = await carriers({ ...b, engine: restored }, X);
          resolve({ request, state: replay.state, events, left });
        } finally {
          await restored.disconnect();
          await admin.unsafe(`DROP DATABASE IF EXISTS ${clone} WITH (FORCE)`);
          await admin.end();
        }
      }, { databaseUrl: engineCase.databaseUrl }));
      await forced(scenario, (r: any) => expect(r).toEqual({ request: r.request, state: 'complete',
        events: [['fact.purged', null, true, r.request], ['coverage.restored', null, false, 'complete']], left: [] }), replayFault('skip_replay'));
    }, 300_000);
  });
}
