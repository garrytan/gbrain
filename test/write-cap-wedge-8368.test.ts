/**
 * #8368: one source's write requests that can never succeed held every slot of the shared local CLI principal's
 * outstanding-request cap, so another source's sync refused `write_capacity` indefinitely.
 *
 * (a) A deterministic ownership refusal on a claimed publication group finishes every claimed member terminally (its
 *     slot is released) instead of leaving it running for the next claim; the single path already did.
 * (b) At the principal cap, a source holding less than its fair share of the local CLI principal (the cap over the
 *     sources holding outstanding requests on it) is still admitted; the brain cap stays hard.
 * (c) A missing ownership marker is refused `owner_marker_missing`, and its fix (the verified self-transfer) restores it.
 * (d) doctor persistence_capacity warns at 90% of an outstanding-request cap and names the source holding the slots.
 *
 * Synthetic content only. PGLite and, with DATABASE_URL, Postgres (test/e2e/write-cap-wedge-8368-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { admitWrite, admitWriteGroupInTransaction, getWriteRequestById, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { editRequest, requestFixture } from './helpers/persistence-request-fixture.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { checkPersistenceCapacity } from '../src/commands/doctor/checks/persistence-capacity.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { CODES } from '../src/core/error-registry.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { classifyItemFailure } from '../src/core/item-failure.ts';
import { classifyConnectorError } from '../src/core/connectors/item-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nA synthetic observation about ${title}.\n`;

for (const kind of testBackends()) describe(`#8368 write-cap wedge (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-wedge-8368-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    installFaultHook(undefined);
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A managed git source with `files`, claimed on this host. */
  async function managedSource(files: Record<string, string>) {
    const id = `wedge-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(directory, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
    commit(root, 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { id, root };
  }
  const env = () => ({ GBRAIN_HOME: directory, GBRAIN_SYNC_FAILURES_DIR: directory, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined });

  test('(c) a missing ownership marker refuses owner_marker_missing, and its fix (the verified self-transfer) restores writes', () => withEnv(env(), async () => {
    const s = await managedSource({ 'notes/a.md': note('A') });
    const binding = (await getWorktreeBinding(engine, s.id))!;
    const reservation = readFileSync(physicalRootReservationPath(s.root), 'utf8');
    rmSync(join(s.root, PHYSICAL_ROOT_MARKER));
    const refusal = await acquireWorktree(binding, 0, undefined, engine).then(() => null, (error: unknown) => error as Record<string, any>);
    expect(refusal).toMatchObject({ code: 'owner_marker_missing', docs: 'docs/guides/write-refusals.md#owner_marker_missing' });
    expect(refusal!.message).toContain(PHYSICAL_ROOT_MARKER);
    expect(refusal!.fix).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', s.id, '--self-transfer',
      '--admin-intent', 'writer_transfer_prepare', '--expected-state', '<admin_state>'] });
    expect(refusal!.fix.then.argv).toEqual(expect.arrayContaining(['gbrain', 'sources', 'writer', 'transfer', 'accept', s.id, '--path', s.root, '--self-transfer']));
    expect(CODES.owner_marker_missing).toMatchObject({ class: 'host_only' });
    // Nothing was rewritten by the refusal, and no marker was invented.
    expect(existsSync(join(s.root, PHYSICAL_ROOT_MARKER))).toBe(false);
    expect(readFileSync(physicalRootReservationPath(s.root), 'utf8')).toBe(reservation);
    // A marker that is present but names another owner keeps the generic identity refusal.
    writeFileSync(join(s.root, PHYSICAL_ROOT_MARKER), JSON.stringify({ version: 1, token: randomUUID(), brainId: randomUUID(), worktreeId: binding.worktree_id,
      root: s.root, device: '1', inode: '1', birth: '1' }), { mode: 0o600 });
    await expect(acquireWorktree(binding, 0, undefined, engine)).rejects.toMatchObject({ code: 'recovery_required' });
    rmSync(join(s.root, PHYSICAL_ROOT_MARKER));
    // The fix: prepare and accept the verified self-transfer for the same root on this host.
    const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    expect(existsSync(join(s.root, PHYSICAL_ROOT_MARKER))).toBe(true);
    const lock = await acquireWorktree((await getWorktreeBinding(engine, s.id))!, 0, undefined, engine); expect(lock).not.toBeNull(); await lock?.release();
  }), 120_000);

  test('(c) a birth time that only drifted within tolerance keeps the generic refusal the plain self-transfer would also refuse', () => withEnv(env(), async () => {
    const s = await managedSource({ 'notes/a.md': note('A') });
    const binding = (await getWorktreeBinding(engine, s.id))!;
    const reservation = JSON.parse(readFileSync(physicalRootReservationPath(s.root), 'utf8'));
    expect(BigInt(reservation.initialBirth)).toBeGreaterThan(0n);
    writeFileSync(physicalRootReservationPath(s.root), JSON.stringify({ ...reservation, initialBirth: (BigInt(reservation.initialBirth) + 500n).toString() }), { mode: 0o600 });
    rmSync(join(s.root, PHYSICAL_ROOT_MARKER));
    const refusal = await acquireWorktree(binding, 0, undefined, engine).then(() => null, (error: unknown) => error as Record<string, any>);
    expect(refusal).toMatchObject({ code: 'recovery_required' });
    await expect(runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: s.id, self_transfer: true,
      ...await reviewedWriterIntent(engine, 'writer_transfer_prepare') })).rejects.toMatchObject({ code: 'recovery_required' });
  }), 120_000);

  for (const [code, fault] of [
    ['owner_marker_missing', (root: string) => rmSync(join(root, PHYSICAL_ROOT_MARKER), { force: true })],
    ['recovery_required', (root: string) => writeFileSync(join(root, PHYSICAL_ROOT_MARKER), JSON.stringify({ version: 1, token: randomUUID(), brainId: randomUUID(),
      worktreeId: randomUUID(), root, device: '1', inode: '1', birth: '1' }), { mode: 0o600 })],
  ] as const) test(`(a) requests refused ${code} by the ownership check end terminally, release every principal slot and name the fix`, () => withEnv(env(), async () => {
    const s = await managedSource({ 'notes/first.md': note('First') });
    expect((await performSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true, drain: true })).status).toBe('first_sync');
    for (let i = 0; i < 40; i++) writeFileSync(join(s.root, 'notes', `n${i}.md`), note(`N${i}`));
    commit(s.root, 'more');
    // The marker goes missing while the drain runs: on Postgres the next publication group is claimed with its followers.
    installFaultHook(async at => { if (at === 'sync:before_group_admission' || at === 'consumer:preparing') fault(s.root); });
    try {
      const run = performSync(engine, { sourceId: s.id, noPull: true, noEmbed: true, noExtract: true, drain: true }).then(r => r, (e: unknown) => e);
      const outcome = await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('timed_out'), 60_000))]);
      expect(outcome).not.toBe('timed_out');
    } finally { installFaultHook(undefined); }
    const rows = await engine.executeRaw<{ state: string; error_code: string | null; claimed: boolean; request_id: string; slug: string; operation: string; error_message: string | null; error_detail: unknown; intent_kind: string | null }>(
      `SELECT state,error_code,claim_expires_at IS NOT NULL AS claimed,request_id::text AS request_id,slug,operation,error_message,error_detail,intent->>'kind' AS intent_kind
       FROM persistence_requests WHERE source_id=$1 AND state<>'committed' ORDER BY sequence`, [s.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ state: 'failed', error_code: code, claimed: false });
    const [principal] = await engine.executeRaw<{ outstanding: number }>(`SELECT max(outstanding_count)::int AS outstanding FROM persistence_counters WHERE key LIKE 'principal:%'`);
    expect(Number(principal!.outstanding)).toBe(0);
    if (code !== 'owner_marker_missing') return;
    // The receipt's diagnosis is typed and names the restore step, then a read-only verify.
    const verdict = classifyTerminal({ ...rows[0]!, source_id: s.id, error_detail: rows[0]!.error_detail as object | null, recovery: null, blocked_reason: null, compacted: false, publication_started: false });
    expect(verdict).toMatchObject({ code: 'owner_marker_missing', class: 'systemic', needs_human: true });
    expect(verdict!.action.argv).toEqual(['gbrain', 'sources', 'writer', 'transfer', 'prepare', s.id, '--self-transfer', '--admin-intent', 'writer_transfer_prepare', '--expected-state', '<admin_state>']);
    expect(verdict!.action.verify?.argv).toBeDefined();
  }), 150_000);

  test('a refused group member whose claim moved is left to its claimant and the rest still end failed', () => withEnv(env(), async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const fixture = await requestFixture(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    // A claimed group: three members running under one claim.
    const claimed: WriteRequest[] = [];
    for (const slug of ['notes/one', 'notes/two', 'notes/three']) {
      const admitted = await fixture.admit(slug);
      await editRequest(engine, admitted.id, "state='running',execution_token=$2::uuid,claim_expires_at=now()+interval '1 hour'", [randomUUID()]);
      claimed.push((await getWriteRequestById(engine, admitted.id))!);
    }
    const consumer = new PersistenceConsumer(engine, { engine: engine.kind }, async () => { throw new Error('unused'); }, { hostId: localHostId() });
    // The first member's lease lapses and another claimant takes it between the consumer's read and its completion.
    const transaction = engine.transaction.bind(engine);
    let moved = false;
    engine.transaction = (async (fn: Parameters<BrainEngine['transaction']>[0]) => {
      if (!moved) { moved = true; await editRequest(engine, claimed[0]!.id, 'execution_token=$2::uuid', [randomUUID()]); }
      return transaction(fn);
    }) as BrainEngine['transaction'];
    try {
      await (consumer as unknown as { failRefusedClaims(rows: unknown[], error: OperationError): Promise<boolean> })
        .failRefusedClaims(claimed, new OperationError('owner_marker_missing', 'The ownership marker is missing.'));
    } finally { engine.transaction = transaction; }
    const states = await engine.executeRaw<{ state: string; error_code: string | null }>(
      'SELECT state,error_code FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [fixture.sourceId]);
    expect(states.map(row => [row.state, row.error_code])).toEqual([['running', null], ['failed', 'owner_marker_missing'], ['failed', 'owner_marker_missing']]);
  }), 60_000);

  describe('(b, d) one source cannot starve another on the shared local principal', () => {
    async function dbSource() {
      const id = `fair-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      return id;
    }
    async function admission(sourceId: string): Promise<WriteAdmission> {
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
      const slug = `notes/fair-${randomUUID().slice(0, 8)}`;
      const context: OperationContext = { engine, sourceId, remote: false, dryRun: false, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(context, 'put_page', sourceId, source!.incarnation, slug);
      const content = note('Fair share');
      return { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation, slug, pageId: null, requestId: randomUUID(),
        callerIntent: { slug, content }, intent: { slug, content }, authority };
    }
    const refusedWith = (sourceId: string) => admission(sourceId).then(input => admitWrite(engine, input)).then(() => null, (error: Record<string, any>) => error);

    test('a stuck source fills the cap; another source still gets its fair share, the brain cap stays hard, and doctor names the holder', () => withEnv(env(), async () => {
      await disposePersistenceConsumer(engine);
      await registerLocalWriter(engine, 'cli');
      expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
      await engine.executeRaw(`UPDATE persistence_requests SET state='cancelled',execution_token=NULL,claim_expires_at=NULL WHERE state IN ('queued','running')`);
      await engine.executeRaw(`UPDATE persistence_counters SET outstanding_count=0`);
      const stuck = await dbSource(), other = await dbSource();
      await engine.setConfig('persistence.limits.principal_outstanding', '4');
      try {
        for (let i = 0; i < 4; i++) await admitWrite(engine, await admission(stuck));
        // A single source at the cap is refused as before, and the refusal names the source holding the slots.
        const own = await refusedWith(stuck);
        expect(own).toMatchObject({ code: 'queue_capacity', detail: 'outstanding=4 limit=4' });
        expect(own!.message).toContain(`source ${stuck} holds 4`);
        // (d) young requests at the cap are a busy drain, not a stall: doctor stays ok.
        expect(await checkPersistenceCapacity(engine)).toMatchObject({ status: 'ok', details: { outstanding: [] } });
        // Once they stop settling, doctor warns at the cap and names the holder; its fix is the read-only writer status of that source.
        await engine.executeRaw(`UPDATE persistence_requests SET created_at=now()-interval '1 hour' WHERE source_id=$1 AND state IN ('queued','running')`, [stuck]);
        const check = await checkPersistenceCapacity(engine);
        expect(check.status).toBe('warn');
        expect(check.message).toContain(stuck);
        expect(check.details).toMatchObject({ outstanding: [expect.objectContaining({ resource: 'outstanding_count', used: 4, limit: 4,
          holders: [expect.objectContaining({ source_id: stuck, outstanding: 4 })] })] });
        expect(check.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', stuck, '--json'] });
        // (b) the other source is admitted up to its share (4 / 2 sources = 2), then refused naming the holder.
        await admitWrite(engine, await admission(other));
        await admitWrite(engine, await admission(other));
        const past = await refusedWith(other);
        expect(past).toMatchObject({ code: 'queue_capacity' });
        expect(past!.message).toContain(`source ${stuck} holds 4`);
        // The stuck source cannot borrow back: it already holds more than its share.
        expect(await refusedWith(stuck)).toMatchObject({ code: 'queue_capacity' });
        // Doctor names the source whose requests stopped settling first, even when a busier source with young requests outranks it.
        await engine.executeRaw(`UPDATE persistence_requests SET created_at=now() WHERE source_id=$1 AND state IN ('queued','running')`, [stuck]);
        await engine.executeRaw(`UPDATE persistence_requests SET created_at=now()-interval '1 hour' WHERE source_id=$1 AND state IN ('queued','running')`, [other]);
        expect(await checkPersistenceCapacity(engine)).toMatchObject({ status: 'warn',
          fix: { argv: ['gbrain', 'sources', 'writer', 'status', '--source', other, '--json'] } });
        // The brain cap is never borrowed past.
        await engine.executeRaw(`UPDATE persistence_requests SET state='cancelled',execution_token=NULL WHERE source_id=$1 AND state='queued' AND id=(SELECT id FROM persistence_requests WHERE source_id=$1 AND state='queued' ORDER BY sequence DESC LIMIT 1)`, [other]);
        await engine.executeRaw(`UPDATE persistence_counters SET outstanding_count=outstanding_count-1 WHERE key='brain' OR key LIKE 'principal:%'`);
        await engine.setConfig('persistence.limits.brain_outstanding', '5');
        expect(await refusedWith(other)).toMatchObject({ code: 'queue_capacity', message: expect.stringContaining('brain outstanding') });
        // A publication group larger than a starved source's share (4 / 3 sources = 1) is admitted whole, once.
        await engine.unsetConfig('persistence.limits.brain_outstanding');
        const third = await dbSource();
        const group = async () => Promise.all(Array.from({ length: 3 }, () => admission(third)));
        const members = await group();
        expect(await engine.transaction(tx => admitWriteGroupInTransaction(tx, members))).toHaveLength(3);
        const again = await group().then(members => engine.transaction(tx => admitWriteGroupInTransaction(tx, members))).then(() => null, (error: Record<string, any>) => error);
        expect(again).toMatchObject({ code: 'queue_capacity' });
      } finally {
        await engine.unsetConfig('persistence.limits.principal_outstanding');
        await engine.unsetConfig('persistence.limits.brain_outstanding');
      }
    }), 120_000);
  });
});

test('#8368: owner_marker_missing stops a sync or connector run for the source instead of counting against one item', () => {
  const refusal = new OperationError('owner_marker_missing', 'The ownership marker is missing.');
  expect(classifyItemFailure(refusal).scope).not.toBe('item');
  expect(classifyConnectorError(refusal)).toMatchObject({ code: 'owner_marker_missing', scope: 'source' });
});
