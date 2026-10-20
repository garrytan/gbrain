/**
 * Managed-persistence path of the Apple connector (#6855): importMarkdown,
 * delete, saveState and assertAccount through ManagedConnectorSync, on the
 * real persistence owner (PGLite, plus Postgres when the harness provides it).
 * Modeled on google-managed-delta-abort. Fake readers; synthetic data only.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { withEnv } from './helpers/with-env.ts';
import { completeBaselineSweep, createConnectorFixture, options, sourceCheckpoint } from './helpers/connector-fixture.ts';
import { AppleReaderError } from '../src/core/apple/readers/errors.ts';
import type { AppleContact, AppleReaders, AppleSourceState } from '../src/core/apple/types.ts';

const { home, engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const person = (id: string, given: string): AppleContact => ({ id, givenName: given, familyName: 'Example', emails: [`${id}@example.com`], phones: [], groups: [] });

function readers(state: { contacts: AppleContact[] }): AppleReaders {
  return {
    async calendar() { return []; },
    async contacts() { return structuredClone(state.contacts); },
    async mail() { return []; },
    async probe() { return { ok: true as const }; },
  };
}

test('managed apple sweep: pages land via importMarkdown, the cursor lands via saveState, the account is pinned, and a --full sweep deletes through the managed path', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'contacts' };
    const f = await source(engine, config);
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    const state = { contacts: [person('c-1', 'Alice'), person('c-2', 'Bob')] };
    const run = (extra = {}) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, ...extra }, { readers: readers(state), log: () => {} });
    const imports = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT DISTINCT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);
    const deletes = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT DISTINCT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_delete' ORDER BY slug", [f.id])).map((r) => r.slug);

    // First sweep: importMarkdown for each contact through the owner.
    const first = await run();
    expect(first.status).toBe('first_sync');
    expect(first.added).toBe(2);
    expect(await imports()).toEqual(['people/alice-example', 'people/bob-example']);

    // assertAccount: the label is pinned in the connector state row.
    const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
    const pinned = await readManagedConnectorState(engine, f.id, row!.incarnation);
    expect(pinned.account).toEqual({ kind: 'apple', account: 'alice-example' });

    // saveState: the hash cursor was committed with the checkpoint.
    await disposePersistenceConsumer(engine);
    const [cp] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { contacts?: { hashes: Record<string, string> }; last_probe?: Record<string, { ok: boolean }> } }[] }[];
    expect(Object.keys(cp!.completed_keys[0]!.state!.contacts!.hashes)).toHaveLength(2);
    expect(cp!.completed_keys[0]!.state!.last_probe!.contacts!.ok).toBe(true);

    // Idempotent rerun: nothing added or modified.
    const again = await run();
    expect(again.added + again.modified + again.deleted).toBe(0);

    // An incremental sweep never deletes; a --full sweep deletes the vanished contact through the managed path.
    state.contacts = [person('c-1', 'Alice')];
    const incremental = await run();
    expect(incremental.deleted).toBe(0);
    expect(await deletes()).toEqual([]);
    const full = await run({ full: true });
    expect(full.deleted).toBe(1);
    expect(await deletes()).toEqual(['people/bob-example']);
    const live = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug", [f.id]);
    expect(live.map((p) => p.slug)).toEqual(['people/alice-example']);
  }
}), 180_000);

test('managed apple sweep: a re-pointed account label is refused (connector_account_changed) and imports nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'contacts' };
    const f = await source(engine, config);
    const state = { contacts: [person('c-1', 'Alice')] };
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    await runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id }, { readers: readers(state), log: () => {} });

    // Same source, label changed in the stored config: the pinned account no longer matches.
    await engine.executeRaw("UPDATE sources SET config = config || '{\"a_account\":\"someone-else\"}'::jsonb WHERE id=$1", [f.id]);
    const moved = parseAppleSourceConfig({ ...config, a_account: 'someone-else', a_dir: f.dir }, f.dir);
    state.contacts = [person('c-1', 'Alice'), person('c-9', 'Zed')];
    const refused = await runAppleSync(engine, f.id, moved, { ...options, sourceId: f.id }, { readers: readers(state), log: () => {} }).then(() => null, (e: Error & { code?: string }) => e);
    expect(refused?.code).toBe('connector_account_changed');
    const pages = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug", [f.id]);
    expect(pages.map((p) => p.slug)).not.toContain('people/zed-example');
  }
}), 180_000);

test('managed apple sweep: a permanently denied service has its denial saved (last_probe) and does not stall the other services', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'calendar,contacts' };
    const f = await source(engine, config);
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    const state = { contacts: [person('c-1', 'Alice')] };
    const denied = new AppleReaderError('permission_denied', 'calendar', 'Calendar access denied', 'Enable it in System Settings');
    const rd: AppleReaders = { ...readers(state), async calendar() { throw denied; } };
    const run = (extra = {}) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, ...extra }, { readers: rd, log: () => {} });
    const cursor = async () => {
      await disposePersistenceConsumer(engine);
      const [cp] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { contacts?: { hashes: Record<string, string> }; last_probe?: Record<string, { ok: boolean; code?: string }> } }[] }[];
      return cp?.completed_keys[0]?.state;
    };

    const first = await run();
    expect(first.status).toBe('partial');
    expect(first.added).toBe(1);
    let saved = await cursor();
    // The recorded denial reaches the managed checkpoint (doctor apple_permissions and `apple status --no-probe` read it).
    expect(saved?.last_probe?.calendar).toMatchObject({ ok: false, code: 'permission_denied' });
    // The service that succeeded saved its cursor in the same run.
    expect(Object.keys(saved?.contacts?.hashes ?? {})).toHaveLength(1);

    // A second run with a new contact still advances the cursor for contacts although calendar stays denied.
    state.contacts = [person('c-1', 'Alice'), person('c-2', 'Bob')];
    const second = await run();
    expect(second.status).toBe('partial');
    expect(second.added).toBe(1);
    saved = await cursor();
    expect(Object.keys(saved?.contacts?.hashes ?? {})).toHaveLength(2);
    expect(saved?.last_probe?.calendar?.code).toBe('permission_denied');
    expect(saved?.last_probe?.contacts?.ok).toBe(true);

    // last_sync_at advanced on the strength of the clean contacts sweep.
    const [row] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(row?.last_sync_at).not.toBeNull();

    // The recorded denial is what the doctor check and `apple status --no-probe` read back.
    const { appleServicePermissionsCheck } = await import('../src/commands/doctor/checks/apple-permissions.ts');
    const check = await appleServicePermissionsCheck(engine, [f.id]);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ count: 1 });
  }
}), 180_000);

test('managed apple sweep: Mail loop state lands in the checkpoint, open loops are written, freshness is read back from the checkpoint, and a Contacts-only run does not freshen Mail', async () => withEnv(env, async () => {
  const { loopsOperations } = await import('../src/core/ops/loops.ts');
  const openLoops = loopsOperations.find((o) => o.name === 'open_loops')!;
  for (const engine of engines) {
    const owner = 'me-example@example.com';
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'contacts,mail', a_mail_owner_addresses: owner };
    const f = await source(engine, config);
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    const old = new Date(Date.now() - 60 * 3_600_000).toISOString();
    const mail = [{ id: 'm-1', threadId: 'thr-1', mailbox: 'INBOX', subject: 'Plan', from: 'Alice Example <alice-example@example.com>', to: [owner], cc: [], date: old, body: 'Can you review the plan?', read: true, automated: false, bulk: false }];
    const rd: AppleReaders = { ...readers({ contacts: [] }), async mail() { return structuredClone(mail); } };
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: f.id } as never;
    const answer = async () => openLoops.handler(ctx, { source_id: f.id, group_by: 'counterparty', include_context: false }) as Promise<{ stale: boolean; sources: Array<{ last_sync_at: string | null }>; groups: unknown[] }>;

    await completeBaselineSweep(engine, f.id, () => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id }, { readers: rd, log: () => {} }));
    await disposePersistenceConsumer(engine);
    const [cp] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { mail_loops?: { complete_at?: string; digest?: string; threads?: Record<string, unknown[]> } } }[] }[];
    const loops = cp!.completed_keys[0]!.state!.mail_loops!;
    expect(loops.complete_at).toBeDefined();
    expect(Object.keys(loops.threads ?? {})).toEqual(['thr-1']);
    const opened = await engine.executeRaw<{ loop_type: string }>("SELECT loop_type FROM open_loops WHERE source_id=$1 AND status='open'", [f.id]);
    expect(opened.map((r) => r.loop_type)).toEqual(['unanswered_inbound']);
    const res = await answer();
    expect(res.stale).toBe(false);
    expect(res.sources[0]!.last_sync_at).toBe(loops.complete_at as string);
    expect(res.groups).toHaveLength(1);

    // A Contacts-only configuration (Mail opted out) leaves the Mail loop answer unavailable-by-service, not fresh.
    const contactsOnly = { ...config, a_services: 'contacts' };
    await engine.executeRaw("UPDATE sources SET config = $2::text::jsonb WHERE id=$1", [f.id, JSON.stringify(contactsOnly)]);
    expect((await answer()).sources).toEqual([]);
  }
}), 180_000);


// F6 also protects the managed checkpoint, including a save deferred behind pending publication.
// The existing saveState seam models that boundary; publishHolds and the waiting readback remain real.
// Removing Mail bookkeeping from the deferred save exposes the old complete stamp again.
test('F6 managed partial and deferred saves publish durable incomplete coverage instead of retaining a fresh checkpoint', async () => withEnv(env, async () => {
  const { loopsOperations }=await import('../src/core/ops/loops.ts');
  const {ManagedConnectorSync}=await import('../src/core/persistence/connector-sync.ts');
  for(const engine of engines) {
    const raw={kind:'apple',a_services:'mail',a_mail_owner_addresses:'owner@example.com'};
    const f=await source(engine,raw),cfg=parseAppleSourceConfig({...raw,a_dir:f.dir},f.dir);
    let unavailable=false;
    const rd:AppleReaders={...readers({contacts:[]}),async mail(){return unavailable ? {messages:[],unavailableThreads:['missing']} : {messages:[{id:'recovered',threadId:'missing',mailbox:'INBOX',subject:'Example recovery',from:'external@example.com',to:['owner@example.com'],cc:[],date:new Date(Date.now()-60*3_600_000).toISOString(),body:'Can you review?',read:true,automated:false,bulk:false}]};}};
    const run=()=>runAppleSync(engine,f.id,cfg,{...options,sourceId:f.id},{readers:rd,log:()=>{}});
    const ctx={engine,config:{},logger:{info(){},warn(){},error(){}},dryRun:false,remote:false,sourceId:f.id} as never;
    const answer=async()=>loopsOperations.find(o=>o.name==='open_loops')!.handler(ctx,{source_id:f.id,group_by:'counterparty',include_context:false}) as Promise<{stale:boolean;completeness:string}>;
    await completeBaselineSweep(engine,f.id,run);await disposePersistenceConsumer(engine);
    expect((await answer()).stale).toBe(false);
    unavailable=true;
    const deferred=spyOn(ManagedConnectorSync.prototype,'saveState').mockImplementation(async function(this:InstanceType<typeof ManagedConnectorSync>){this.deferred=true;});
    try {await run();}finally{deferred.mockRestore();}
    await disposePersistenceConsumer(engine);
    expect((await answer()).stale).toBe(true);expect((await answer()).completeness).toBe('partial');
    unavailable=false;await completeBaselineSweep(engine,f.id,run);await disposePersistenceConsumer(engine);
    expect((await answer()).stale).toBe(false);expect((await answer()).completeness).toBe('complete');
  }
}),180_000);


for (const mode of ["cancel", "unavailable", "permission", "interrupted"] as const) {
  test(`F6 boundary managed ${mode} invalidates observation durably without moving the mail cursor and recovers`, async () => withEnv(env, async () => {
    const { loopsOperations } = await import("../src/core/ops/loops.ts");
    for (const engine of engines) {
      const raw = { kind: "apple", a_services: "mail", a_mail_owner_addresses: "me@example.com" };
      const f = await source(engine, raw), cfg = parseAppleSourceConfig({ ...raw, a_dir: f.dir }, f.dir);
      const now = Date.now();
      const controller = new AbortController(), deadline = new Error("synthetic-deadline");
      let phase: "baseline" | "gap" | "empty" | "recovery" = "baseline";
      let observedBeforeRead: AppleSourceState | undefined;
      const saved = async (): Promise<AppleSourceState> => {
        const [cp] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state: AppleSourceState }[] }[];
        return cp!.completed_keys[0]!.state;
      };
      const rd: AppleReaders = { ...readers({ contacts: [] }), async mail() {
        if (phase === "gap") {
          // Real checkpoint read from inside the abortable observation, not a saveState mock.
          observedBeforeRead = await saved();
          if (mode === "cancel") controller.abort(deadline);
          if (mode === "interrupted") { controller.abort(deadline); throw deadline; }
          if (mode === "permission") throw new AppleReaderError("permission_denied", "mail", "Synthetic denial", "Synthetic permission fix");
          return { messages: [], unavailableThreads: ["missing"] };
        }
        if (phase === "recovery") return { messages: [{ id: "recovered", threadId: "missing", mailbox: "INBOX", subject: "Example recovery", from: "external@example.com", to: ["me@example.com"], cc: [], date: new Date(now - 100 * 3_600_000).toISOString(), body: "Can you review?", read: true, automated: false, bulk: false }] };
        return { messages: [] };
      } };
      const run = (signal?: AbortSignal) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, signal }, { readers: rd, now: () => now, log: () => {} });
      const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: f.id } as never;
      const answer = async () => loopsOperations.find(o => o.name === "open_loops")!.handler(ctx, { source_id: f.id, group_by: "counterparty", include_context: false }) as Promise<{ stale: boolean; completeness: string; text: string }>;
      await completeBaselineSweep(engine, f.id, () => run());
      await disposePersistenceConsumer(engine);
      const baseline = await saved();
      expect(baseline.mail_loops?.complete_at).toBeDefined();
      expect(await answer()).toMatchObject({ stale: false, completeness: "complete" });
      // A successful empty observation must remain capable of proving complete.
      await completeBaselineSweep(engine, f.id, () => run());
      expect(await answer()).toMatchObject({ stale: false, completeness: "complete" });
      phase = "gap";
      if (mode === "cancel" || mode === "interrupted") await expect(run(controller.signal)).rejects.toThrow("synthetic-deadline");
      else expect((await run()).status).toBe("partial");
      await disposePersistenceConsumer(engine);
      if (mode === "cancel" && engine.kind === "pglite") {
        await engine.disconnect();
        await engine.connect({ engine: "pglite", database_path: join(home, "database") });
      }
      const incomplete = await saved();
      const position = ({ walk: _walk, ...cursor }: AppleSourceState["mail"]) => cursor;
      expect(position(incomplete.mail)).toEqual(position(baseline.mail));
      if (mode === "cancel" || mode === "interrupted") expect(incomplete.mail).toEqual(baseline.mail);
      expect(incomplete.mail_loops?.complete_at).toBeUndefined();
      expect(incomplete.mail_loops?.reread).toBe(true);
      expect(await answer()).toMatchObject({ stale: true, completeness: "partial" });
      expect((await answer()).text).not.toContain("You are clean");
      if (mode === "cancel" || mode === "interrupted") {
        expect(observedBeforeRead?.mail_loops?.complete_at).toBeUndefined();
        expect(observedBeforeRead?.mail_loops?.coverage_gap).toBe(true);
        // The pre-read journaled invalidation is the only committed checkpoint since baseline.
        const committed = await engine.executeRaw<{ fresh: boolean; state: string }>("SELECT (intent->>'fresh')::boolean AS fresh,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint' ORDER BY created_at DESC LIMIT 1", [f.id]);
        expect(committed).toEqual([{ fresh: false, state: "committed" }]);
      }
      if (mode === "permission") expect(incomplete.last_probe?.mail).toMatchObject({ ok: false, code: "permission_denied" });
      phase = "empty";
      await completeBaselineSweep(engine, f.id, () => run()); await disposePersistenceConsumer(engine);
      expect(await answer()).toMatchObject({ stale: true, completeness: "partial" });
      expect(position((await saved()).mail)).toEqual(position(baseline.mail));
      phase = "recovery";
      await completeBaselineSweep(engine, f.id, () => run()); await disposePersistenceConsumer(engine);
      const recovered = await saved();
      expect(recovered.mail_loops?.complete_at).toBeDefined();
      expect(recovered.mail_loops?.coverage_gap).toBeUndefined();
      expect(recovered.mail_loops?.pending_threads).toEqual([]);
      expect(recovered.mail.newest).toBeDefined();
      expect(Object.keys(recovered.mail.hashes)).toEqual(["missing"]);
      expect(await answer()).toMatchObject({ stale: false, completeness: "complete" });
      phase = "empty"; await completeBaselineSweep(engine, f.id, () => run());
      expect(await answer()).toMatchObject({ stale: false, completeness: "complete" });
    }
  }), 180_000);
}


test("F6 boundary managed invalidation refusal and pre-abort never start a reader or claim persisted metadata", async () => withEnv(env, async () => {
  const { ManagedConnectorSync } = await import("../src/core/persistence/connector-sync.ts");
  for (const engine of engines) {
    const raw = { kind: "apple", a_services: "mail", a_mail_owner_addresses: "me@example.com" };
    const f = await source(engine, raw), cfg = parseAppleSourceConfig({ ...raw, a_dir: f.dir }, f.dir);
    let calls = 0;
    const rd: AppleReaders = { ...readers({ contacts: [] }), async mail() { calls++; return []; } };
    const run = (signal?: AbortSignal) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, signal }, { readers: rd, log: () => {} });
    await completeBaselineSweep(engine, f.id, () => run()); await disposePersistenceConsumer(engine);
    const baseline = await sourceCheckpoint(engine, f.id), before = calls;
    const controller = new AbortController(); controller.abort(new Error("already-cancelled"));
    await expect(run(controller.signal)).rejects.toThrow("already-cancelled");
    expect(calls).toBe(before); expect(await sourceCheckpoint(engine, f.id)).toEqual(baseline);
    // Exercise the documented false return, not a fabricated successful save.
    const refused = spyOn(ManagedConnectorSync.prototype, "publishHolds").mockResolvedValue(false);
    try {
      await expect(run()).rejects.toMatchObject({ code: "storage_error" });
      expect(calls).toBe(before); expect(await sourceCheckpoint(engine, f.id)).toEqual(baseline);
    } finally { refused.mockRestore(); }
  }
}), 180_000);

test("F6 boundary managed cancellation preserves a nonempty cursor despite a newer observed message", async () => withEnv(env, async () => {
  for (const engine of engines) {
    const raw = { kind: "apple", a_services: "mail", a_mail_owner_addresses: "me@example.com" };
    const f = await source(engine, raw), cfg = parseAppleSourceConfig({ ...raw, a_dir: f.dir }, f.dir);
    const now = Date.now(), controller = new AbortController();
    let cancel = false;
    const old = { id: "old", threadId: "old", mailbox: "INBOX", subject: "Example notice", from: "peer@example.com", to: ["me@example.com"], cc: [], date: new Date(now - 100 * 3_600_000).toISOString(), body: "Here is the report.", read: true, automated: false, bulk: false };
    const rd: AppleReaders = { ...readers({ contacts: [] }), async mail() {
      if (cancel) { controller.abort(new Error("synthetic-cursor-deadline")); return { messages: [{ ...old, id: "new", threadId: "new", date: new Date(now).toISOString() }], unavailableThreads: ["missing"] }; }
      return [old];
    } };
    const run = (signal?: AbortSignal) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, signal }, { readers: rd, now: () => now, log: () => {} });
    await completeBaselineSweep(engine, f.id, () => run()); await disposePersistenceConsumer(engine);
    const saved = async () => (await sourceCheckpoint(engine, f.id) as { completed_keys: { state: AppleSourceState }[] }[])[0]!.completed_keys[0]!.state;
    const baseline = await saved(); expect(baseline.mail.newest).toBe(old.date); expect(Object.keys(baseline.mail.hashes)).toEqual(["old"]);
    cancel = true; await expect(run(controller.signal)).rejects.toThrow("synthetic-cursor-deadline"); await disposePersistenceConsumer(engine);
    const after = await saved();
    expect(after.mail).toEqual(baseline.mail); expect(after.mail_loops?.complete_at).toBeUndefined(); expect(after.mail_loops?.coverage_gap).toBe(true);
    const pages = await engine.executeRaw<{ tid: string }>("SELECT frontmatter->>'apple_thread_id' AS tid FROM pages WHERE source_id=$1 AND deleted_at IS NULL", [f.id]);
    expect(pages).toEqual([{ tid: "old" }]);
  }
}), 180_000);

test('managed Mail poison recovery: three failed runs hold the message, the cursor and later mail move on, the thread stays incomplete, retry-held reads it by id and recovers', async () => withEnv(env, async () => {
  const { loopsOperations } = await import('../src/core/ops/loops.ts');
  const { readAllSourceHolds } = await import('../src/core/connectors/item-holds-store.ts');
  const { retryHeld } = await import('../src/commands/sources-retry-held.ts');
  const { OWNER, DAY, fakeMail, mk, readersOf } = await import('./helpers/apple-mail-fake.ts');
  for (const engine of engines) {
    const raw = { kind: 'apple', a_account: 'alice-example', a_services: 'mail', a_mail_days: 60, a_mail_owner_addresses: OWNER };
    const f = await source(engine, raw), cfg = parseAppleSourceConfig({ ...raw, a_dir: f.dir }, f.dir);
    // Freshness is judged against the real clock, so the synthetic mailbox is dated relative to it.
    const T0 = Date.now(), dayIso = (n: number): string => new Date(T0 - n * DAY).toISOString();
    const msg = (id: string, thread: string, n: number) => mk(id, thread, 0, { date: dayIso(n) });
    const mail = fakeMail([msg('<a@x>', 'thr-a', 20)]);
    const run = () => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id }, { readers: readersOf(mail), now: () => T0, log: () => {} });
    const saved = async (): Promise<AppleSourceState> => ((await sourceCheckpoint(engine, f.id)) as { completed_keys: { state: AppleSourceState }[] }[])[0]!.completed_keys[0]!.state;
    const held = async () => (await readAllSourceHolds(engine, { sourceIds: [f.id] }))[0]?.held ?? [];
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: f.id } as never;
    const answer = async () => loopsOperations.find((o) => o.name === 'open_loops')!.handler(ctx, { source_id: f.id, group_by: 'counterparty', include_context: false }) as Promise<{ stale: boolean; completeness: string }>;
    const pageHas = async (needle: string) => (await engine.executeRaw<{ compiled_truth: string }>(
      "SELECT compiled_truth FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' IS NOT NULL", [f.id])).some((p) => p.compiled_truth.includes(needle));

    await completeBaselineSweep(engine, f.id, run); await disposePersistenceConsumer(engine);
    const baselineNewest = (await saved()).mail.newest;
    expect(await answer()).toMatchObject({ stale: false, completeness: 'complete' });

    mail.box.push(msg('<p@x>', 'thr-a', 19), msg('<b@x>', 'thr-b', 18));
    mail.unreadable.add('<p@x>');
    for (let i = 1; i <= 3; i++) {
      expect((await run()).status).toBe('partial');
      await disposePersistenceConsumer(engine);
      // A failed run pins the cursor; the healthy sibling and the neighbouring thread still import.
      expect((await saved()).mail.newest).toBe(baselineNewest);
    }
    expect(await pageHas('Synthetic body of <b@x>.')).toBe(true);
    expect(await held()).toEqual([expect.objectContaining({ key: 'mail-message:<p@x>', state: 'held', attempts: 3, ref: 'thr-a', meta: expect.objectContaining({ upstream_at: dayIso(19) }) })]);

    // Held at the start of run 4: excluded from the read, the cursor passes it, and later mail imports.
    mail.box.push(msg('<c@x>', 'thr-c', 1));
    const fourth = await run(); await disposePersistenceConsumer(engine);
    expect(mail.main.at(-1)!.exclude).toEqual(['<p@x>']);
    expect(fourth.status).not.toBe('partial');
    expect(Date.parse((await saved()).mail.newest!)).toBeGreaterThan(Date.parse(baselineNewest!));
    expect(await pageHas('Synthetic body of <c@x>.')).toBe(true);
    expect(await answer()).toMatchObject({ completeness: 'partial' });

    // Recovery through retry-held: the message is read by id and the thread page carries it; coverage completes.
    mail.unreadable.clear();
    expect((await retryHeld(engine, f.id)).scheduled).toBe(1);
    const recovered = await run(); await disposePersistenceConsumer(engine);
    expect(recovered.status).not.toBe('partial');
    expect(await held()).toEqual([]);
    expect(await pageHas('Synthetic body of <p@x>.')).toBe(true);
    expect((await saved()).mail_loops?.pending_threads).toEqual([]);
    expect(await answer()).toMatchObject({ stale: false, completeness: 'complete' });
  }
}), 240_000);
