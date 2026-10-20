/**
 * Managed-persistence path of the resumable Mail hold recovery: the staged evidence is part of the ONE canonical connector
 * checkpoint (saveState / publishHolds), never a side file, and it is consistent with the holds at every committed state:
 * a partial run stages and leaves the hold untouched, an aborted run commits nothing of its own, and the hold clears only
 * with the checkpoint that lands the thread and drops its staging. Fake readers; synthetic data only.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ManagedConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, sourceCheckpoint } from './helpers/connector-fixture.ts';
import { STAGE_MAX_MESSAGES } from '../src/core/apple/mail-recovery.ts';
import type { AppleReaders, AppleSourceState } from '../src/core/apple/types.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('managed: slow-Mail recovery of a 40-message held thread stages in the canonical checkpoint, an abort commits nothing, and the thread lands whole', async () => withEnv(env, async () => {
  const { readAllSourceHolds } = await import('../src/core/connectors/item-holds-store.ts');
  const { retryHeld } = await import('../src/commands/sources-retry-held.ts');
  const { OWNER, HOUR, DAY, fakeMail, mk, readersOf } = await import('./helpers/apple-mail-fake.ts');
  for (const engine of engines) {
    const raw = { kind: 'apple', a_account: 'alice-example', a_services: 'mail', a_mail_days: 60, a_mail_owner_addresses: OWNER };
    const f = await source(engine, raw);
    const cfg = parseAppleSourceConfig({ ...raw, a_dir: f.dir }, f.dir);
    // Freshness is judged against the real clock, so the synthetic mailbox is dated relative to it.
    const T0 = Date.now();
    let clock = T0;
    const big = Array.from({ length: 40 }, (_, i) => mk(`<thr-big-${i}@x>`, 'thr-big', 0, { date: new Date(T0 - 25 * DAY + i * 60_000).toISOString() }));
    const mail = fakeMail([...big, mk('<ok@x>', 'thr-ok', 0, { date: new Date(T0 - 24 * DAY).toISOString() })]);
    const base = readersOf(mail);
    let calls: string[][] = [];
    const slow: AppleReaders = { ...base, async mailMessages(opts) {
      const take = [...opts.targets].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).slice(0, 3);
      calls.push(opts.targets.map((t) => t.id));
      const res = await base.mailMessages!({ ...opts, targets: take });
      return { ...res, truncated: opts.targets.length > 3, budgetExhausted: opts.targets.length > 3 };
    } };
    const run = (extra: Record<string, unknown> = {}, readers: AppleReaders = readersOf(mail)) =>
      runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, ...extra }, { readers, now: () => clock, log: () => {} });
    const saved = async (): Promise<AppleSourceState> => { await disposePersistenceConsumer(engine); return ((await sourceCheckpoint(engine, f.id)) as { completed_keys: { state: AppleSourceState }[] }[])[0]!.completed_keys[0]!.state; };
    const held = async () => (await readAllSourceHolds(engine, { sourceIds: [f.id] }))[0]?.held ?? [];
    const pageCount = async () => (await engine.executeRaw<{ compiled_truth: string }>(
      "SELECT compiled_truth FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = 'thr-big'", [f.id]))[0]?.compiled_truth.split('Synthetic body of').length ?? 0;

    // The thread's page import is refused on 3 runs (an item-scoped content refusal): the thread is held.
    const original = ManagedConnectorSync.prototype.importMarkdown;
    const spy = spyOn(ManagedConnectorSync.prototype, 'importMarkdown').mockImplementation(async function (this: ManagedConnectorSync, path: string, content: string) {
      if (/thr-big/.test(path)) throw new OperationError('invalid_connector_text', 'synthetic refusal', 'synthetic');
      return original.call(this, path, content);
    });
    try {
      for (let i = 0; i < 3; i++) { clock += HOUR; await run(); await disposePersistenceConsumer(engine); }
    } finally { spy.mockRestore(); }
    expect((await held()).find((h) => h.key === 'mail:thr-big')).toMatchObject({ state: 'held', attempts: 3 });
    mail.box.push(mk('<later@x>', 'thr-later', 0, { date: new Date(T0 - 1 * DAY).toISOString() }));
    clock += HOUR; await run(); clock += HOUR; await run(); await disposePersistenceConsumer(engine);
    expect(await pageCount()).toBe(0);

    // Recovery at 3 bodies per call: the first run stages, commits through the checkpoint, and leaves the hold untouched.
    expect((await retryHeld(engine, f.id)).scheduled).toBeGreaterThan(0);
    const heldBefore = (await held()).find((h) => h.key === 'mail:thr-big')!;
    clock += HOUR; calls = [];
    await run({}, slow);
    const afterOne = await saved();
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(Object.keys(afterOne.mail_recovery?.staged ?? {}).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(afterOne.mail_recovery!.staged).length).toBeLessThanOrEqual(STAGE_MAX_MESSAGES);
    expect(await pageCount()).toBe(0);
    const heldAfterOne = (await held()).find((h) => h.key === 'mail:thr-big')!;
    expect([heldAfterOne.state, heldAfterOne.attempts, heldAfterOne.reconsiderations, heldAfterOne.next_attempt_at]).toEqual([heldBefore.state, heldBefore.attempts, heldBefore.reconsiderations, heldBefore.next_attempt_at]);

    // An abort in the middle of the next run commits nothing of that run: the checkpoint is exactly what it was.
    const ac = new AbortController();
    let n = 0;
    const aborting: AppleReaders = { ...slow, async mailMessages(opts) { if (n++ === 1) { ac.abort(); throw new DOMException('aborted', 'AbortError'); } return slow.mailMessages!(opts); } };
    clock += HOUR;
    await run({ signal: ac.signal }, aborting).catch(() => undefined);
    const afterAbort = await saved();
    expect(afterAbort.mail_recovery).toEqual(afterOne.mail_recovery);
    expect(afterAbort.item_holds).toEqual(afterOne.item_holds);
    expect(await pageCount()).toBe(0);
    expect((await held()).find((h) => h.key === 'mail:thr-big')?.state).toBe('held');

    // The restart resumes from the committed staging and lands all 40 messages; the hold and the staging clear together.
    for (let i = 0; i < 8 && await pageCount() !== 41; i++) { clock += HOUR; await run({}, slow); await disposePersistenceConsumer(engine); }
    expect(await pageCount()).toBe(41); // 40 messages -> 41 split parts
    expect((await held()).find((h) => h.key === 'mail:thr-big')).toBeUndefined();
    const done = await saved();
    expect(done.mail_recovery).toBeUndefined();
    expect(Object.keys(done.item_holds ? (done.item_holds as { items: object }).items : {})).not.toContain('mail:thr-big');
  }
}), 300_000);
