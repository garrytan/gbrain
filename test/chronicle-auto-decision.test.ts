/**
 * #5876 — the Life Chronicle write-time decision (E1/C1/C11/C13/C14/E11/D7).
 *
 * Protects: every coordinated page publication that imports a page records
 * one ledger row for its content and returns a truthful `chronicle_backstop`
 * hint; non-chronicle pages get no row and no receipt noise; the opt-out,
 * confinement, --no-extract, recency and invite-end rules decide before any
 * paid work; default ON when the key is unset.
 * Fails when: a receipt says queued for content the phase will never run, a
 * confined or opted-out write records a pending row, or ordinary notes grow a
 * chronicle field.
 * Seams: none for the managed put_page path; synthetic write-request rows for
 * the submit_job intents and grant shapes.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { decideChronicle, recordChronicleDecision } from '../src/core/chronicle/ledger.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { autoChronicleSetting } from '../src/core/chronicle/config.ts';
import { CHRONICLE_REASONS, chronicleBackfillArgv } from '../src/core/chronicle/reasons.ts';
import { prepareFactsBackstop } from '../src/core/persistence/effect-facts.ts';
import type { WriteAuthority, WriteRequest } from '../src/core/persistence/model.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

/** PGLite in the unit lane; the e2e wrapper reruns every case on an isolated Postgres database. */
const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const utcDay = () => new Date().toISOString().slice(0, 10);
const today = utcDay();
const lastYear = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const meeting = (extra = `date: ${today}\n`) => `---\ntype: meeting\ntitle: Sync\n${extra}---\n\n${BODY}`;

async function put(ctx: OperationContext, slug: string, content: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return await operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) }) as Record<string, unknown>;
}
async function rows(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; state: string; reason: string | null; trigger: string; request_id: string | null; principal_kind: string | null }>(
    'SELECT slug,state,reason,trigger,request_id,principal_kind FROM chronicle_page_state ORDER BY slug, decided_at');
}

describe('managed put_page', () => {
  test('an eligible meeting records one pending row with the writer; a no-op re-put changes nothing', () => brain(async ({ engine, ctx }) => {
    expect(await engine.getConfig('chronicle.activated_at')).toBeNull();
    const receipt = await put(ctx, 'meetings/sync', meeting());
    expect(receipt.chronicle_backstop).toEqual({ pending: 'next_cycle', daily_remaining: 200 });
    expect(await engine.getConfig('chronicle.activated_at')).not.toBeNull(); // the first decision activates the automatic path
    const [row] = await rows(engine);
    const [request] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1', [receipt.request_id]);
    expect(row).toMatchObject({ slug: 'meetings/sync', state: 'pending', reason: null, trigger: 'auto', principal_kind: 'local_cli', request_id: request.id });
    const again = await put(ctx, 'meetings/sync', meeting());
    expect(again.chronicle_backstop).toBeUndefined();
    expect(await rows(engine)).toHaveLength(1);
  }), 120_000);

  test('an ordinary note gets neither a row nor a receipt field', () => brain(async ({ engine, ctx }) => {
    const receipt = await put(ctx, 'notes/plan', `---\ntype: note\ntitle: Plan\n---\n\n${BODY}`);
    expect('chronicle_backstop' in receipt).toBe(false);
    expect(await rows(engine)).toEqual([]);
  }), 120_000);

  test('auto_chronicle false skips with auto_chronicle_off (no fix: off by choice); an invalid word skips auto_chronicle_invalid; unset is on', () => brain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_chronicle', 'false');
    expect((await put(ctx, 'meetings/a', meeting())).chronicle_backstop)
      .toEqual({ skipped: 'auto_chronicle_off', stage: 'decision', why: CHRONICLE_REASONS.auto_chronicle_off.meaning() });
    await engine.setConfig('auto_chronicle', 'flase');
    expect((await put(ctx, 'meetings/b', meeting())).chronicle_backstop)
      .toMatchObject({ skipped: 'auto_chronicle_invalid', fix: { argv: ['gbrain', 'config', 'set', 'auto_chronicle', 'true'], consent: ['paid'] } });
    await engine.unsetConfig('auto_chronicle');
    expect((await put(ctx, 'meetings/c', meeting())).chronicle_backstop).toMatchObject({ pending: 'next_cycle' });
    expect(autoChronicleSetting(null)).toBe('on');
    expect(autoChronicleSetting('flase')).toBe('invalid');
  }), 120_000);

  test('a page dated last year skips history with a scoped backfill command', () => brain(async ({ ctx }) => {
    // The receipt is dated when the decision runs; a run that crosses 00:00 UTC sees one of the two days.
    const before = utcDay();
    const receipt = await put(ctx, 'meetings/old', meeting(`date: ${lastYear}\n`));
    const after = utcDay();
    const argv = (receipt.chronicle_backstop as { fix?: { argv?: string[] } } | undefined)?.fix?.argv ?? [];
    const since = argv[argv.indexOf('--since') + 1];
    expect([before, after]).toContain(since);
    expect(receipt.chronicle_backstop).toMatchObject({ skipped: 'history', stage: 'decision', fix: {
      preview_argv: chronicleBackfillArgv({ sourceId: 'default', since, dryRun: true }),
      argv: chronicleBackfillArgv({ sourceId: 'default', since, dryRun: false }), consent: ['paid'] } });
  }), 120_000);

  test('a future invite is not_yet_happened and waits until its end', () => brain(async ({ engine, ctx }) => {
    const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const receipt = await put(ctx, 'calendar/2026/10/standup', meeting(`start: ${end}\nend: ${end}\n`));
    expect(receipt.chronicle_backstop).toEqual({ skipped: 'not_yet_happened', stage: 'decision', why: CHRONICLE_REASONS.not_yet_happened.meaning() });
    const [row] = await engine.executeRaw<{ state: string; next_attempt_at: Date }>('SELECT state,next_attempt_at FROM chronicle_page_state');
    expect(row.state).toBe('pending');
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(new Date(end).getTime());
  }), 120_000);
});

describe('submit_job intents and grants (C1/C11)', () => {
  const authority = (over: Partial<WriteAuthority> = {}): WriteAuthority => ({ version: 1, principal: { kind: 'local_cli', id: 'x' } as never,
    remote: false, sourceId: 'default', sourceIncarnation: 'i', scopes: ['write'], operations: null, slugPrefixes: null, ...over });
  async function decide(engine: BrainEngine, slug: string, row: Partial<WriteRequest>) {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const outcome: Record<string, unknown> = {};
    await recordChronicleDecision(engine, { id: crypto.randomUUID(), source_id: 'default', slug, authority: authority(), principal_kind: 'local_cli', principal_id: 'x', ...row }, snapshot, outcome);
    return outcome.chronicle_backstop;
  }

  test('managed sync and connector imports decide; --no-extract skips; other intents never decide', () => brain(async ({ engine, ctx }) => {
    for (const slug of ['meetings/sync-file', 'calendar/2026/09/invite', 'meetings/no-extract', 'meetings/maintenance']) await put(ctx, slug, meeting());
    await engine.executeRaw('DELETE FROM chronicle_page_state');
    expect(await decide(engine, 'meetings/sync-file', { operation: 'submit_job', intent: { kind: 'managed_sync_import', processingOptions: { noExtract: false } } }))
      .toMatchObject({ pending: 'next_cycle' });
    expect(await decide(engine, 'calendar/2026/09/invite', { operation: 'submit_job', intent: { kind: 'connector_v2_import' } }))
      .toMatchObject({ pending: 'next_cycle' });
    expect(await decide(engine, 'meetings/no-extract', { operation: 'submit_job', intent: { kind: 'managed_sync_import', processingOptions: { noExtract: true } } }))
      .toMatchObject({ skipped: 'no_extract' });
    expect(await decide(engine, 'meetings/maintenance', { operation: 'submit_job', intent: { kind: 'managed_maintenance_timeline_extract' } })).toBeUndefined();
    expect((await rows(engine)).map((r) => [r.slug, r.state, r.reason])).toEqual([
      ['calendar/2026/09/invite', 'pending', null], ['meetings/no-extract', 'skipped', 'no_extract'], ['meetings/sync-file', 'pending', null]]);
  }), 120_000);

  test('confined and operation-bound writers skip; the predicate is the one facts uses', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/a', meeting());
    expect(await decide(engine, 'meetings/a', { operation: 'put_page', authority: authority({ slugPrefixes: ['meetings/'] }) })).toMatchObject({ skipped: 'slug_bound_client' });
    expect(await decide(engine, 'meetings/a', { operation: 'put_page', authority: authority({ delegated: true }) })).toMatchObject({ skipped: 'slug_bound_client' });
    expect(await decide(engine, 'meetings/a', { operation: 'put_page', authority: authority({ operations: ['put_page'] }) })).toMatchObject({ skipped: 'operation_bound_client' });
    expect(await decide(engine, 'meetings/a', { operation: 'put_page', authority: authority({ operations: ['put_page', 'extract_facts'] }) })).toMatchObject({ pending: 'next_cycle' });
    const page = { slug: 'meetings/a', type: 'meeting', compiled_truth: BODY, frontmatter: {} } as never;
    expect(await prepareFactsBackstop(engine, { authority: authority({ operations: ['put_page'] }), slug: 'meetings/a' } as never, page))
      .toEqual({ skipped: 'operation_bound_client' });
  }), 120_000);
});

describe('one eligibility function (E13/E11/C13/C14)', () => {
  const now = new Date();
  const policy = { now, recentDays: 30 };
  const base = { type: 'meeting' as const, slug: 'meetings/x', body: BODY };
  test('recency reads an authored date only; a fallback date counts as undated (recent)', () => {
    expect(isChronicleEligible({ ...base, effectiveDate: lastYear, effectiveDateSource: 'date' }, policy)).toEqual({ ok: false, reason: 'history' });
    expect(isChronicleEligible({ ...base, effectiveDate: lastYear, effectiveDateSource: 'fallback' }, policy)).toEqual({ ok: true });
    expect(isChronicleEligible({ ...base, frontmatter: { start: `${lastYear}T10:00:00Z` } }, policy)).toEqual({ ok: false, reason: 'history' });
    expect(isChronicleEligible({ ...base, effectiveDate: lastYear, effectiveDateSource: 'date' }, { now, recentDays: null })).toEqual({ ok: true });
  });
  test('an invite waits until its end; the settle window waits after a change', () => {
    const end = new Date(now.getTime() + 3_600_000);
    expect(isChronicleEligible({ ...base, frontmatter: { end: end.toISOString() } }, policy)).toEqual({ ok: false, reason: 'not_yet_happened', wait: true, until: end });
    const changedAt = new Date(now.getTime() - 60_000);
    expect(isChronicleEligible({ ...base, changedAt }, { ...policy, settleSeconds: 180 }))
      .toEqual({ ok: false, reason: 'settling', wait: true, until: new Date(changedAt.getTime() + 180_000) });
  });
  test('decideChronicle orders opt-out, --no-extract and confinement before eligibility', () => {
    const page = { type: 'meeting', slug: 'meetings/x', compiled_truth: 'short' };
    const settings = { recentDays: 30, settleSeconds: 180 };
    expect(decideChronicle({ page, authority: null, noExtract: false, enabled: false, settings, now }).reason).toBe('auto_chronicle_off');
    expect(decideChronicle({ page, authority: null, noExtract: true, enabled: true, settings, now }).reason).toBe('no_extract');
    expect(decideChronicle({ page, authority: null, noExtract: false, enabled: true, settings, now }).reason).toBe('too_short');
  });
});
