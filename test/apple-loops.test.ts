/**
 * apple-loops — open-loop parity for Apple Mail (#6855 finding 8), end to end on PGLite with injected fake
 * AppleReaders and a fake chat transport (no macOS, no helper, no provider call). Placeholders only.
 *
 * Every guard the feature adds is pinned by a test that FAILS when the guard is removed (see the "guard"
 * notes): identity (owner addresses only), consent (global switch AND Apple consent), freshness (only a
 * complete Mail loop sweep), fail-closed classification, and Google isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig, parseOwnerAddresses } from '../src/core/apple/source-config.ts';
import { appleLoopsAvailability, appleLoopsFreshness, appleOwnerDigest } from '../src/core/apple/loops-status.ts';
import { compactMailMessage, toLoopThread, appleExtractionPolicy, enqueueAppleLoopsExtraction } from '../src/core/apple/loops.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { addSuppression } from '../src/core/loops/loops-store.ts';
import { __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { enqueueLoopsExtraction } from '../src/core/google/loops-enqueue.ts';
import { NO_EXCLUSION } from '../src/core/google/loops-exclusion.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { AppleMailListing, AppleMailMessage, AppleReaders } from '../src/core/apple/types.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
let chatCalls = 0;
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  // The fake model: counts calls and returns "nothing found". No provider is ever reached.
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return { text: '{"commitments":[],"decisions_pending":[]}', blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
}, 60_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  for (const sql of ['DELETE FROM minion_jobs', 'DELETE FROM op_checkpoints', 'DELETE FROM mcp_spend_reservations', 'DELETE FROM mcp_spend_log', "DELETE FROM config WHERE key LIKE 'loops.%'"]) {
    await engine.executeRaw(sql).catch(() => undefined);
  }
  chatCalls = 0;
  __clearSuppressionCacheForTests();
});

const SID = 'amail';
const OWNER = 'me-example@example.com';
const BASE = Date.now();
const hoursAgo = (h: number): string => new Date(BASE - h * 3_600_000).toISOString();
const clock = { t: BASE };

function msg(id: string, threadId: string, over: Partial<AppleMailMessage> & { hoursAgo: number }): AppleMailMessage {
  const { hoursAgo: h, ...rest } = over;
  return { id, threadId, mailbox: 'INBOX', subject: 'Quarterly plan', from: 'Alice Example <alice-example@example.com>', to: [OWNER], cc: [], date: hoursAgo(h), body: 'Can you review the plan?', read: true, automated: false, bulk: false, ...rest };
}
const inbound = (id: string, thread: string, h: number, over: Partial<AppleMailMessage> = {}) => msg(id, thread, { hoursAgo: h, ...over });
const outbound = (id: string, thread: string, h: number, over: Partial<AppleMailMessage> = {}) =>
  msg(id, thread, { hoursAgo: h, mailbox: 'Sent', from: OWNER, to: ['bob-example@example.com'], subject: 'Re: Quarterly plan', body: 'Could you send the numbers?', ...over });

interface Fake { mail: AppleMailMessage[]; flags?: Omit<AppleMailListing, 'messages'>; calls: { mail: number; contacts: number; calendar: number }; sinceFilter?: boolean; lastSince?: Date }
const fake = (mail: AppleMailMessage[] = []): Fake => ({ mail, calls: { mail: 0, contacts: 0, calendar: 0 } });
function readers(f: Fake): AppleReaders {
  return {
    async calendar() { f.calls.calendar++; return []; },
    async contacts() { f.calls.contacts++; return []; },
    async mail(opts) {
      f.calls.mail++; f.lastSince = opts.since;
      const all = f.sinceFilter ? f.mail.filter((m) => Date.parse(m.date) > opts.since.getTime()) : f.mail;
      return { messages: structuredClone(all), ...(f.flags ?? {}) };
    },
    async probe() { return { ok: true as const }; },
  };
}

const logs: string[] = [];
type RawCfg = Record<string, unknown>;
const baseCfg = (dir: string, extra: RawCfg = {}): RawCfg => ({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'contacts,mail', a_mail_owner_addresses: OWNER, ...extra });
const newDir = (): string => mkdtempSync(join(tmpdir(), 'aloops-'));
const withHome = <T,>(fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);

async function insertSource(dir: string, extra: RawCfg = {}): Promise<RawCfg> {
  const cfg = baseCfg(dir, extra);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [SID, dir, JSON.stringify(cfg)]);
  return cfg;
}
async function sweep(dir: string, f: Fake, raw: RawCfg, opts: Partial<SyncOpts> = {}) {
  const cfg = parseAppleSourceConfig(raw, dir);
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts }, { readers: readers(f), now: () => clock.t, log: (m) => { logs.push(m); } });
}
async function loops(): Promise<Array<{ loop_type: string; status: string; counterparty_email: string | null; thread_id: string | null; closed_by: string | null; detector: string }>> {
  return engine.executeRaw(`SELECT loop_type, status, counterparty_email, thread_id, closed_by, detector FROM open_loops WHERE source_id = $1 ORDER BY thread_id, loop_type`, [SID]);
}
const open = async () => (await loops()).filter((l) => l.status === 'open');
const jobs = () => engine.executeRaw<{ idempotency_key: string; data: Record<string, unknown> }>(`SELECT idempotency_key, data FROM minion_jobs WHERE name = 'loops_extract' ORDER BY id`);
function ctx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SID } as OperationContext;
}
const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;
const waiting = async (): Promise<any> => openLoopsOp.handler(ctx(), { source_id: SID, group_by: 'counterparty', include_context: false });

beforeEach(() => { clock.t = Date.now(); logs.length = 0; });

// ── Deterministic detection ──────────────────────────────────────────────────

describe('apple loops — deterministic detection (no model, no consent needed)', () => {
  test('inbound owed after grace and outbound awaited open; fresh inbound and answered threads do not', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([
      inbound('m-in', 'thr-in', 48),                               // owed: 48h > 24h grace
      inbound('m-fresh', 'thr-fresh', 2),                          // inside the grace window
      outbound('m-out', 'thr-out', 100),                           // awaited: ask older than 72h
      outbound('m-out-fresh', 'thr-out-fresh', 10),                // inside the 72h outbound grace
    ]);
    await sweep(dir, f, raw);
    const rows = await open();
    expect(rows.map((r) => [r.thread_id, r.loop_type, r.counterparty_email])).toEqual([
      ['thr-in', 'unanswered_inbound', 'alice-example@example.com'],
      ['thr-out', 'unanswered_outbound', 'bob-example@example.com'],
    ]);
    expect(rows.every((r) => r.detector === 'deterministic_thread')).toBe(true);
    expect(chatCalls).toBe(0);
    expect(await jobs()).toHaveLength(0);
    // The two grace-held threads are remembered, not opened.
    expect(Object.keys(readAppleState(dir).mail_loops!.loop_grace_holds ?? {}).sort()).toEqual(['thr-fresh', 'thr-out-fresh']);
  }));

  test('a user reply closes the owed loop (turn flip), and their reply closes the awaited one', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60), outbound('m-out', 'thr-out', 100)]);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(2);

    f.mail.push(outbound('m-reply', 'thr-in', 40, { body: 'Here is my review.', to: ['alice-example@example.com'] }));
    f.mail.push(inbound('m-answer', 'thr-out', 10, { from: 'bob-example@example.com', body: 'Numbers attached.' }));
    await sweep(dir, f, raw);
    const all = await loops();
    expect(all.filter((l) => l.status === 'open')).toHaveLength(0);
    expect(all.map((l) => [l.thread_id, l.loop_type, l.status, l.closed_by])).toEqual([
      ['thr-in', 'unanswered_inbound', 'done', 'reply_detected'], ['thr-out', 'unanswered_outbound', 'done', 'reply_detected']]);
    // Their reply (10h old, inside the grace window) is held, not an instantly owed loop.
    expect(Object.keys(readAppleState(dir).mail_loops!.loop_grace_holds ?? {})).toEqual(['thr-out']);
  }));

  test('a grace-held loop opens from stored messages when time passes with no new mail (no reader data needed)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-fresh', 'thr-fresh', 2)]);
    f.sinceFilter = true;
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0);
    clock.t = BASE + 30 * 3_600_000; // 30h later: 32h old, past the 24h grace. The reader lists nothing newer.
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-fresh']);
  }));

  test('direction comes from owner addresses only: an unlisted alias in Sent is NOT assumed to be the owner (guard: no Sent guessing)', () => withHome(async () => {
    const dir = newDir();
    const alias = 'me-alias@example.com';
    const thread = [outbound('m-1', 'thr-alias', 100, { from: alias })];
    const f = fake(thread);
    const raw = await insertSource(dir);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0); // in Sent, but not an owner address: nothing is judged mine
    const withAlias = baseCfg(dir, { a_mail_owner_addresses: `${OWNER},${alias}` });
    await insertSource(dir, { a_mail_owner_addresses: `${OWNER},${alias}` });
    await sweep(dir, f, withAlias);
    expect((await open()).map((r) => r.loop_type)).toEqual(['unanswered_outbound']);
  }));

  test('muted senders open no new loop; noise senders render no page and no loop; no Gmail labels are invented', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    await addSuppression(engine, SID, 'sender', 'alice-example@example.com');
    __clearSuppressionCacheForTests();
    const f = fake([inbound('m-muted', 'thr-muted', 60), inbound('m-noise', 'thr-noise', 60, { from: 'noreply@acme-example.com' }),
      inbound('m-list', 'thr-list', 60, { from: 'carol-example@example.com', bulk: true }), inbound('m-auto', 'thr-auto', 60, { from: 'dave-example@example.com', automated: true })]);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0);
    const thread = toLoopThread('t', [compactMailMessage(inbound('x', 't', 1))!], 'acct')!;
    expect(thread.messages.every((m) => m.labelIds.length === 0)).toBe(true);
  }));

  test('a message the reader did not classify refuses its thread and keeps the run non-fresh (guard: fail closed)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const unclassified = inbound('m-u', 'thr-u', 60);
    delete unclassified.automated; delete unclassified.bulk;
    const f = fake([unclassified, inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
    expect(logs.join('\n')).toContain('did not classify');
  }));

  test('a thread whose page did not land (import refused) opens no loop and the run is not fresh (guard: holds)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('bad\u0000id', 'thr-bad', 60), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    const r = await sweep(dir, f, raw);
    expect(r.failedFiles).toBe(1);
    expect((await open()).map((x) => x.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
  }));

  test('a HELD thread (import failed on 3 runs, now skipped without a new failure) opens no loop and the run stays non-fresh (guard: notLanded)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('bad\u0000id', 'thr-bad', 60), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    const r4 = await sweep(dir, f, raw);
    expect(r4.failedFiles ?? 0).toBe(0);            // held: skipped, not a fresh failure
    expect(r4.connectorHolds).toMatchObject({ held: 1 });
    expect((await open()).map((x) => x.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined(); // a skipped thread is a coverage gap
  }));

  test('a thread the reader flags unavailable is never judged', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-1', 'thr-gone', 60), inbound('m-2', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    f.flags = { unavailableThreads: ['thr-gone'] };
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
  }));
});

// ── Availability: identity, service opt-out ──────────────────────────────────

describe('apple loops — availability', () => {
  test('missing owner addresses: sync imports mail, tracking is unavailable (identity_missing), never "clean"', () => withHome(async () => {
    const dir = newDir();
    const raw = baseCfg(dir); delete raw.a_mail_owner_addresses;
    await insertSource(dir); await engine.executeRaw('UPDATE sources SET config = $2::text::jsonb WHERE id = $1', [SID, JSON.stringify(raw)]);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(r.added).toBe(1); // the page was imported
    expect(await loops()).toHaveLength(0);
    expect(readAppleState(dir).mail_loops).toBeUndefined();
    expect(r.loops_enqueue).toBeUndefined();
    const res = await waiting();
    expect(res.apple_loops_unavailable).toEqual([{ source_id: SID, reason: 'identity_missing' }]);
    expect(res.no_google_sources).toBe(false);
    expect(res.text).toContain('identity_missing');
    expect(res.text).not.toContain('You are clean');
    expect(res.text).not.toContain('No google source is connected');
  }));

  test('mail not enabled: the mail reader is never called, no loop state is written, and waiting reports mail_disabled (never "clean", never "connect Google")', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_services: 'contacts' });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(f.calls.mail).toBe(0);
    expect(await loops()).toHaveLength(0);
    expect(readAppleState(dir).mail_loops).toBeUndefined();
    expect(r.loops_enqueue).toBeUndefined();
    // Live-Mac regression: a calendar+contacts-only Apple source used to be dropped from the loop view, so an
    // Apple-only brain was told "No google source is connected… gbrain google setup".
    const res = await waiting();
    expect(res.apple_loops_unavailable).toEqual([{ source_id: SID, reason: 'mail_disabled' }]);
    expect(res.sources).toEqual([]);
    expect(res.no_google_sources).toBe(false);
    expect(res.text).toContain('mail_disabled');
    expect(res.text).toContain('set-services');
    expect(res.text).not.toContain('You are clean');
    expect(res.text).not.toContain('No google source is connected');
  }));

  test('availability helper: mail + owners required; consent is separate', () => {
    const base = { services: ['mail' as const], mailOwnerAddresses: [OWNER], loopsExtractConsent: false };
    expect(appleLoopsAvailability(base)).toEqual({ available: true, extraction: 'consent_missing' });
    expect(appleLoopsAvailability({ ...base, loopsExtractConsent: true })).toEqual({ available: true, extraction: 'enabled' });
    expect(appleLoopsAvailability({ ...base, mailOwnerAddresses: [] })).toEqual({ available: false, reason: 'identity_missing' });
    expect(appleLoopsAvailability({ ...base, services: [] })).toEqual({ available: false, reason: 'mail_disabled' });
    expect(parseOwnerAddresses('ME@Example.com, bad, a@b, me@example.com,<x@y.z>')).toEqual(['me@example.com']);
  });
});

// ── Freshness ────────────────────────────────────────────────────────────────

describe('apple loops — freshness (open_loops / waiting)', () => {
  test('a contacts sync never freshens Mail loops; partial Mail stays stale; a complete Mail sweep freshens (guard: complete_at only)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    f.flags = { truncated: true };
    await sweep(dir, f, raw);
    const [src] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [SID]);
    expect(src!.last_sync_at).not.toBeNull(); // contacts synced cleanly and stamped the source
    let res = await waiting();
    expect(res.stale).toBe(true); // ...but Mail loops are not fresh
    expect(res.sources[0].last_sync_at).toBeNull();
    expect(res.groups).toHaveLength(1); // the loop that WAS detected is still shown, with the stale warning
    expect(res.text).toContain('have not synced recently');

    f.flags = undefined;
    await sweep(dir, f, raw);
    res = await waiting();
    expect(res.stale).toBe(false);
    expect(Date.parse(res.sources[0].last_sync_at)).toBeGreaterThan(BASE - 1000);
  }));

  test('freshness is bound to the owner set: changing owners makes stored freshness stale until re-detection', () => {
    const state = { mail_loops: { digest: appleOwnerDigest([OWNER]), complete_at: new Date(BASE).toISOString() } };
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, state, BASE).stale).toBe(false);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER, 'other@example.com'] }, state, BASE).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, { mail_loops: { ...state.mail_loops, reread: true } }, BASE).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, state, BASE + 25 * 3_600_000).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, null, BASE).stale).toBe(true);
  });

  test('changing owner addresses re-reads the whole window once even when the incremental cursor sees nothing new', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    f.sinceFilter = true;
    await sweep(dir, f, raw);
    const windowStart = f.lastSince!.getTime();
    await sweep(dir, f, raw);
    expect(f.lastSince!.getTime()).toBeGreaterThan(windowStart); // incremental: starts after the newest message
    const widened = baseCfg(dir, { a_mail_owner_addresses: `${OWNER},me-alias@example.com` });
    await sweep(dir, f, widened);
    expect(f.lastSince!.getTime()).toBe(windowStart); // full window again
    expect(readAppleState(dir).mail_loops!.digest).toBe(appleOwnerDigest([OWNER, 'me-alias@example.com']));
  }));
});

// ── Extraction: consent matrix, enqueue, dedupe ──────────────────────────────

describe('apple loops — extraction requires BOTH the global switch and Apple consent', () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ['global on, Apple consent off', true, false, false],
    ['global off, Apple consent on', false, true, false],
    ['global off, Apple consent off', false, false, false],
    ['global on, Apple consent on', true, true, true],
  ];
  for (const [name, global, consent, enqueues] of cases) {
    test(`${name}: ${enqueues ? 'enqueues' : 'enqueues nothing'}; deterministic loops open either way; no model call during sync`, () => withHome(async () => {
      const dir = newDir();
      const raw = await insertSource(dir, consent ? { a_loops_extract_consent: true } : {});
      await engine.setConfig('loops.extraction_enabled', global ? 'true' : 'false');
      const f = fake([inbound('m-in', 'thr-in', 60)]);
      const r = await sweep(dir, f, raw);
      expect((await open()).map((x) => x.loop_type)).toEqual(['unanswered_inbound']);
      expect((await jobs()).length).toBe(enqueues ? 1 : 0);
      expect(chatCalls).toBe(0);
      if (!enqueues) expect(r.loops_enqueue).toMatchObject({ enqueued: 0, skipped_reason: consent ? 'extraction_disabled' : 'apple_consent_missing' });
    }));
  }

  test('with consent on: the job is revision-keyed (rerun dedupes, a new message enqueues a new revision) and carries the Apple page', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    await sweep(dir, f, raw);
    await sweep(dir, f, raw);
    const first = await jobs();
    expect(first).toHaveLength(1);
    expect(first[0]!.idempotency_key).toMatch(new RegExp(`^loops:${SID}:emails/.+:\\d+$`));
    expect(first[0]!.data).toMatchObject({ sourceId: SID, threadId: 'thr-in' });
    expect(typeof first[0]!.data.newestMs).toBe('number');
    f.mail.push(inbound('m-in-2', 'thr-in', 50, { body: 'Following up on the plan?' }));
    await sweep(dir, f, raw);
    const after = await jobs();
    expect(after).toHaveLength(2);
    expect(new Set(after.map((j) => j.idempotency_key)).size).toBe(2);
  }));

  test('turning consent on later re-candidates the window once even though no mail changed (guard: reread on consent)', () => withHome(async () => {
    const dir = newDir();
    const off = await insertSource(dir);
    // A newer noise message pins the incremental cursor past thr-in, so only a deliberate re-read can see it again.
    const f = fake([inbound('m-in', 'thr-in', 60), inbound('m-new', 'thr-new', 1, { from: 'noreply@acme-example.com' })]);
    f.sinceFilter = true;
    await sweep(dir, f, off);
    await sweep(dir, f, off);
    expect(await jobs()).toHaveLength(0);
    const on = await insertSource(dir, { a_loops_extract_consent: true });
    await sweep(dir, f, on);
    expect((await jobs()).map((j) => j.data.threadId)).toEqual(['thr-in']);
  }));

  test('threads that are noise, list or owner-less bulk mail are not eligible; the count is recorded without text', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-list', 'thr-list', 60, { from: 'carol-example@example.com', bulk: true }), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    await sweep(dir, f, raw);
    expect((await jobs()).map((j) => j.data.threadId)).toEqual(['thr-ok']);
    const line = logs.find((l) => l.includes('loops_extract eligibility'))!;
    expect(line).toContain('list_mail=1');
    expect(line).not.toContain('example.com');
  }));

  test('Gmail label exclusions cannot be evaluated on Mail: configured, paid extraction is withheld (fail closed); deterministic tracking unaffected', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    await engine.setConfig('loops.extraction_exclude_labels', 'Newsletters');
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(await jobs()).toHaveLength(0);
    expect(r.loops_enqueue).toMatchObject({ enqueued: 0, skipped_reason: 'excluded_label_unsupported' });
    expect(await open()).toHaveLength(1);
  }));

  test('the job handler re-checks the Apple consent at run time (consent revoked after enqueue → no model call)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    await sweep(dir, f, raw);
    const [job] = await jobs();
    const payload = { slug: String(job!.data.slug), sourceId: SID, threadId: 'thr-in' };

    await insertSource(dir); // consent revoked
    expect(await runLoopsExtract(engine, payload)).toMatchObject({ status: 'skipped', reason: 'apple_consent_missing' });
    expect(chatCalls).toBe(0);

    await insertSource(dir, { a_loops_extract_consent: true });
    expect(await runLoopsExtract(engine, payload)).toMatchObject({ status: 'extracted' });
    expect(chatCalls).toBe(1);

    const cfg = parseAppleSourceConfig(baseCfg(dir), dir);
    expect((await appleExtractionPolicy(engine, SID, cfg)).refusal).toBe('apple_consent_missing');
    expect((await appleExtractionPolicy(engine, SID, { ...cfg, mailOwnerAddresses: [], loopsExtractConsent: true })).refusal).toBe('identity_missing');
  }));
});

// ── Google isolation ─────────────────────────────────────────────────────────

describe('google behavior is unchanged', () => {
  test('the shared enqueue keeps its [google] log prefix by default and takes the label only from the Apple caller', async () => {
    const lines: string[] = [];
    const deps = { engine, sourceId: 'g1', exclusion: NO_EXCLUSION, extractCandidates: [], log: (m: string) => lines.push(m) };
    await enqueueLoopsExtraction(deps);
    await enqueueLoopsExtraction(deps, 'apple');
    expect(lines).toEqual(['[google] loops_extract: no eligible thread in this sweep; nothing to enqueue', '[apple] loops_extract: no eligible thread in this sweep; nothing to enqueue']);
  });

  test('a Google page is not subject to the Apple consent check in the job handler', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter) VALUES ('emails/g-1', 'g1', 'email', 'x', 'Thread body', '{"thread_id":"t1"}'::jsonb)`);
    expect(await runLoopsExtract(engine, { slug: 'emails/g-1', sourceId: 'g1', threadId: 't1' })).toMatchObject({ status: 'extracted' });
    expect(chatCalls).toBe(1);
  });

  test('open_loops on a brain with only a google source answers as before (no apple keys)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`);
    const res: any = await openLoopsOp.handler({ ...ctx(), sourceId: 'g1' }, { source_id: 'g1', group_by: 'counterparty', include_context: false });
    expect(res.apple_loops_unavailable).toBeUndefined();
    expect(res.stale).toBe(false);
    expect(res.text).toContain('You are clean');
    expect(res.text).not.toContain('Apple');
  });
});

// ── CLI / config surface ─────────────────────────────────────────────────────

import { buildAppleAddOptions, AppleAddFlagError } from '../src/commands/sources-apple-flags.ts';
import { runApple } from '../src/commands/apple.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { appleTuningConfig } from '../src/core/apple/source-config.ts';
import { connectorIdentity, CONNECTOR_LEAF_RULES } from '../src/core/persistence/connector-identity.ts';
import { randomUUID } from 'node:crypto';

describe('apple loops — flags, setup disclosure, identity', () => {
  const add = (over: Record<string, unknown>) => buildAppleAddOptions({ services: 'calendar,contacts,mail', confirmMail: true, dir: '/d', ...over } as never);

  test('owner addresses normalize; consent needs mail AND identity; invalid values never widen scope', () => {
    expect(add({ mailOwnerAddresses: 'Me@Example.com, me-alias@example.com' }).mailOwnerAddresses).toEqual(['me-alias@example.com', 'me@example.com']);
    expect(add({ mailOwnerAddresses: OWNER, loopsExtractConsent: true }).loopsExtractConsent).toBe(true);
    expect(add({}).loopsExtractConsent).toBeUndefined();
    const code = (fn: () => unknown): string => { try { fn(); return 'none'; } catch (e) { return (e as AppleAddFlagError).code; } };
    expect(code(() => add({ loopsExtractConsent: true }))).toBe('extraction_consent_requires_identity');
    expect(code(() => add({ services: 'calendar', mailOwnerAddresses: OWNER, loopsExtractConsent: true }))).toBe('invalid_value');
    expect(code(() => add({ mailOwnerAddresses: 'not-an-address' }))).toBe('invalid_value');
    expect(code(() => add({ mailOwnerAddresses: `${OWNER},bad` }))).toBe('invalid_value'); // a partial list is refused, not trimmed
  });

  test('config round-trip: only non-default keys are written; consent defaults false', () => {
    expect(appleTuningConfig(parseAppleSourceConfig({ kind: 'apple' }, '/d'))).toEqual({});
    const cfg = parseAppleSourceConfig({ kind: 'apple', a_mail_owner_addresses: [OWNER], a_loops_extract_consent: 'true' }, '/d');
    expect(cfg).toMatchObject({ mailOwnerAddresses: [OWNER], loopsExtractConsent: true });
    expect(appleTuningConfig(cfg)).toMatchObject({ a_mail_owner_addresses: OWNER, a_loops_extract_consent: true });
    expect(parseAppleSourceConfig({ kind: 'apple', a_loops_extract_consent: 'maybe' }, '/d').loopsExtractConsent).toBe(false);
  });

  test('connected parser accepts the flags only for --kind apple', () => {
    const parse = (...a: string[]) => parseSourceLifecycleArgs(['add', 'apple-x', ...a], randomUUID());
    const opts = (parse('--kind', 'apple', '--services', 'mail', '--confirm-mail', '--mail-owner-addresses', OWNER, '--consent-loops-extraction').params as { options: { apple: Record<string, unknown> } }).options.apple;
    expect(opts).toMatchObject({ mailOwnerAddresses: [OWNER], loopsExtractConsent: true });
    expect(() => parse('--kind', 'apple', '--services', 'mail', '--confirm-mail', '--consent-loops-extraction')).toThrow(/needs --mail-owner-addresses/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--mail-owner-addresses', OWNER], randomUUID())).toThrow(/requires --kind apple/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--consent-loops-extraction'], randomUUID())).toThrow(/requires --kind apple/);
  });

  test('identity: owner addresses and consent are excluded leaves (changing them never re-keys the checkpoint)', () => {
    expect(CONNECTOR_LEAF_RULES.apple.mailOwnerAddresses).toBe('excluded');
    expect(CONNECTOR_LEAF_RULES.apple.loopsExtractConsent).toBe('excluded');
    const id = (raw: RawCfg) => connectorIdentity('apple', { kind: 'apple', a_account: 'x', ...raw }, '/d').digest;
    expect(id({})).toBe(id({ a_mail_owner_addresses: OWNER, a_loops_extract_consent: true }));
    expect(id({})).not.toBe(id({ a_mail_days: 5 }));
  });

  test('setup discloses that extraction sends Mail text to the chat provider, before any probe', async () => {
    let out = '';
    const probed: string[] = [];
    const rd: AppleReaders = { ...readers(fake()), async probe(s) { probed.push(s); return { ok: true as const }; } };
    const code = await runApple(['setup', '--json'], { platform: 'darwin', engine, readers: rd, write: (t) => { out += t; } });
    expect(code).toBe(2);
    expect(JSON.parse(out).next_action.user_message).toContain('chat provider');
    expect(probed).toEqual([]);
  });

  test('`apple loops` sets owners/consent on an existing source without reading Apple data, and revokes', async () => {
    const dir = newDir();
    await insertSource(dir); await engine.executeRaw('UPDATE sources SET config = $2::text::jsonb WHERE id = $1', [SID, JSON.stringify({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'contacts,mail' })]);
    const run = async (...args: string[]) => { let out = ''; const rd = readers(fake()); const code = await runApple(['loops', '--json', '--source', SID, ...args], { platform: 'darwin', engine, readers: rd, write: (t) => { out += t; } }); return { code, json: JSON.parse(out) }; };
    const cfgNow = async () => { const [r] = await engine.executeRaw<{ config: RawCfg }>('SELECT config FROM sources WHERE id=$1', [SID]); return r!.config; };

    const none = await run();
    expect(none.json.loops).toMatchObject({ available: false, unavailable: 'identity_missing' });
    expect(none.code).toBe(0);                                  // read-only status is not an error
    const refused = await run('--consent-loops-extraction');
    expect(refused.json.error.code).toBe('extraction_consent_requires_identity');
    expect((await cfgNow()).a_loops_extract_consent).toBeUndefined();

    const set = await run('--mail-owner-addresses', OWNER);
    expect(set.json.loops).toMatchObject({ available: true, extraction: 'consent_missing', owner_addresses: 1 });
    const consent = await run('--consent-loops-extraction');
    expect(consent.json.loops.extraction).toBe('consented');
    expect((await cfgNow()).a_loops_extract_consent).toBe(true);
    const revoked = await run('--revoke-loops-extraction');
    expect(revoked.json.loops.extraction).toBe('consent_missing');
    expect((await cfgNow()).a_loops_extract_consent).toBe(false);
  });
});

// ── Reader: the real mail.js classifies headers (stub Mail environment; Mail.app is never launched) ──

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAIL_SCRIPT, normalizeMessage } from '../src/core/apple/readers/mail.ts';
import { ROUTE_ARGV, singleAccountApp } from './helpers/apple-mail-vm.ts';

describe('apple loops — mail.js header classification', () => {
  const headerSets: Array<[string, string, { automated: boolean; bulk: boolean }]> = [
    ['plain human mail', 'Message-ID: <a1>\nSubject: hi', { automated: false, bulk: false }],
    ['Auto-Submitted: auto-replied', 'Message-ID: <a2>\nAuto-Submitted: auto-replied', { automated: true, bulk: false }],
    ['Auto-Submitted: no is human', 'Message-ID: <a3>\nAuto-Submitted: no', { automated: false, bulk: false }],
    ['text/calendar part', 'Message-ID: <a4>\nContent-Type: text/calendar; method=REQUEST', { automated: true, bulk: false }],
    ['List-Unsubscribe', 'Message-ID: <a5>\nList-Unsubscribe: <mailto:u@example.com>', { automated: false, bulk: true }],
    ['List-Id', 'Message-ID: <a6>\nList-Id: <list.example.com>', { automated: false, bulk: true }],
    ['Precedence: bulk', 'Message-ID: <a7>\nPrecedence: bulk', { automated: false, bulk: true }],
    ['no-reply Reply-To', 'Message-ID: <a8>\nReply-To: noreply@example.com', { automated: false, bulk: true }],
    ['folded List-Id', 'Message-ID: <a9>\nList-\n Id: x', { automated: false, bulk: false }],
  ];
  test('each header set yields the documented verdict and the normalizer keeps only booleans', () => {
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    const dates = headerSets.map(() => new Date('2026-10-10T08:00:00.000Z'));
    const mailbox: any = { name: () => 'INBOX', id: () => 'inbox-example' };
    mailbox.messages = { whose: (query: any) => {
      let idx = dates.map((_, i) => i);
      if (Array.isArray(query?._or)) { const sel = new Set(query._or.map((x: any) => x.id._equals)); idx = idx.filter((i) => sel.has(i)); }
      return { id: () => idx, messageId: () => idx.map((i) => `<a${i + 1}>`), subject: () => idx.map(() => 's'), sender: () => idx.map(() => 'Alice Example <alice-example@example.com>'),
        dateReceived: () => idx.map((i) => dates[i]), readStatus: () => idx.map(() => true), allHeaders: () => idx.map((i) => headerSets[i]![1]), content: () => idx.map(() => 'body') };
    } };
    let output = '';
    const $: any = (v: string) => ({ dataUsingEncoding: () => v });
    $.NSUTF8StringEncoding = 1;
    $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (s: string) => { output = s; } } };
    $.exit = () => {};
    const sandbox = { ObjC: { import() {} }, $, Application: () => singleAccountApp({ INBOX: mailbox }), console };
    try { runInNewContext(`${js}\nrun(${JSON.stringify(['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', ...ROUTE_ARGV])});`, sandbox); } catch (e) { if (!(e as { code?: number }).code) throw e; }
    const items = JSON.parse(output).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(headerSets.length);
    for (const item of items) {
      const [name, , want] = headerSets[Number(String(item.id).replace(/\D/g, '')) - 1]!;
      expect([name, item.automated, item.bulk]).toEqual([name, want.automated, want.bulk]);
    }
    expect(normalizeMessage({ id: 'x', date: '2026-10-10T08:00:00Z', automated: 'yes', bulk: true })).toMatchObject({ bulk: true });
    expect('automated' in normalizeMessage({ id: 'x', date: '2026-10-10T08:00:00Z', automated: 'yes' })).toBe(false);
  });
});


// Independent final-review regressions: public sync/queue/waiting paths, disposable PGLite + synthetic
// readers only. Prior tests used short touched threads; these exercise paging, quiet recovery and policy
// changes. Each fails on a targeted behavioral mutation (report records the exact mutations), with no new
// production-only test seam. IDs/addresses are placeholders; no Apple helper or network is used.
function pagedReader(f: Fake, cap: number, observed: Array<Parameters<AppleReaders['mail']>[0]>): AppleReaders {
  const r = readers(f);
  r.mail = async opts => {
    observed.push(opts);
    let all = f.mail.filter(m => Date.parse(m.date) > opts.since.getTime())
      .sort((a,b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1));
    if (opts.after) all = all.filter(m => m.date > opts.after!.date || (m.date === opts.after!.date && m.id > opts.after!.id));
    return { messages: structuredClone(all.slice(0, cap)), truncated: all.length > cap, ...f.flags };
  };
  return r;
}
async function pagedSweep(dir: string, raw: RawCfg, r: AppleReaders, full = false) {
  return runAppleSync(engine, SID, parseAppleSourceConfig(raw, dir), { sourceId: SID, noEmbed: true, noExtract: true, noSchemaPack: true, full },
    { readers: r, now: () => clock.t, log: m => logs.push(m) });
}
async function updateRaw(raw: RawCfg): Promise<void> {
  await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [SID, JSON.stringify(raw)]);
}

describe('Apple final review — durable correctness', () => {
  test('F1 full enumeration discards an incompatible suffix, resumes its own walk, and reconciles only the union', () => withHome(async () => {
    const dir = newDir(), raw = await insertSource(dir, { a_mail_max: 2 });
    const f = fake([inbound('a','a',100), inbound('b','b',90), inbound('c','c',80)]);
    const observed: Array<Parameters<AppleReaders['mail']>[0]> = [], r = pagedReader(f, 2, observed);
    await pagedSweep(dir, raw, r);
    expect(readAppleState(dir).mail.resume_id).toBe('b');
    const full = await pagedSweep(dir, raw, r, true);
    expect(observed[1]!.after).toBeUndefined();
    expect(full.deleted).toBe(0);
    expect(full.status).toBe('partial');
    expect((await waiting()).stale).toBe(true);
    const end = await pagedSweep(dir, raw, r, true);
    expect(end.deleted).toBe(0);
    expect((await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL',[SID]))).toHaveLength(3);
    expect((await waiting()).stale).toBe(false);
    expect(readAppleState(dir).mail.walk).toBeUndefined();
  }));

  test('F1 owner change between capped pages re-evaluates the prefix before declaring freshness', () => withHome(async () => {
    const dir = newDir(), alias = 'alias-example@example.com';
    const raw = await insertSource(dir, { a_mail_max: 1, a_mail_owner_addresses: OWNER+','+alias });
    const f = fake([inbound('prefix','prefix',60,{from:alias}), inbound('suffix','suffix',50,{from:'noreply@example.com'})]);
    const observed: Array<Parameters<AppleReaders['mail']>[0]> = [], r = pagedReader(f, 1, observed);
    await pagedSweep(dir, raw, r);
    const changed = {...raw, a_mail_owner_addresses: OWNER}; await updateRaw(changed);
    await pagedSweep(dir, changed, r);
    expect(observed[1]!.after).toBeUndefined();
    expect((await open()).map(x=>x.thread_id)).toEqual(['prefix']);
    expect((await waiting()).stale).toBe(true);
    await pagedSweep(dir, changed, r);
    expect((await waiting()).stale).toBe(false);
    expect((await open()).map(x=>x.thread_id)).toEqual(['prefix']);
  }));

  test('F3 revoked current source blocks stale-snapshot enqueue and marker-free queued execution with zero model calls', () => withHome(async () => {
    const dir = newDir(), raw = await insertSource(dir, {a_loops_extract_consent:true});
    await engine.setConfig('loops.extraction_enabled','true');
    await sweep(dir, fake([inbound('private','consent',60)]), raw);
    const [job] = await jobs(); expect(job).toBeDefined();
    const payload = {slug:String(job!.data.slug),sourceId:SID,threadId:'consent'};
    await updateRaw({...raw,a_loops_extract_consent:false});
    expect((await appleExtractionPolicy(engine,SID,parseAppleSourceConfig(raw,dir))).refusal).toBe('apple_consent_missing');
    const result = await enqueueAppleLoopsExtraction({engine,sourceId:SID,cfg:parseAppleSourceConfig(raw,dir),run:{candidates:[{...payload,newestMs:BASE}],gaps:[],eligibility:{},withheld:{}},log:()=>{}});
    expect(result?.skipped_reason).toBe('apple_consent_missing');
    await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'apple_thread_id'-'source_kind' WHERE source_id=$1 AND slug=$2",[SID,payload.slug]);
    expect(await runLoopsExtract(engine,payload)).toMatchObject({status:'skipped',reason:'apple_consent_missing'});
    expect(chatCalls).toBe(0);
  }));

  test('F4 complete durable evidence retains an inbound question across twelve owner acknowledgments and empty sweeps', () => withHome(async () => {
    const dir = newDir(), raw = await insertSource(dir);
    const f = fake([inbound('question','long',100)]);
    await sweep(dir,f,raw);
    f.mail.push(...Array.from({length:12},(_,i)=>outbound('ack-'+i,'long',99-i,{body:'Thanks!',to:['alice-example@example.com']})));
    await sweep(dir,f,raw);
    f.mail=[]; await sweep(dir,f,raw);
    expect((await open()).map(x=>[x.thread_id,x.loop_type])).toEqual([['long','unanswered_inbound']]);
    const [page] = await engine.executeRaw<{frontmatter: Record<string,unknown>}>("SELECT frontmatter FROM pages WHERE source_id=$1",[SID]);
    expect(page!.frontmatter.apple_loop_messages).toHaveLength(13);
    expect((await waiting()).stale).toBe(false);
  }));

  test('F4 long unanswered runs retain the original grace deadline; classification outside the cached tail cannot disappear', () => withHome(async () => {
    const dir=newDir(),raw=await insertSource(dir),f=fake([inbound('oldest','nudges',23)]);
    await sweep(dir,f,raw);
    const due=readAppleState(dir).mail_loops!.loop_grace_holds!.nudges!.due_ms;
    f.mail.push(...Array.from({length:15},(_,i)=>inbound('nudge-'+i,'nudges',22-i)));
    await sweep(dir,f,raw);
    expect(readAppleState(dir).mail_loops!.loop_grace_holds!.nudges!.due_ms).toBe(due);
    delete f.mail[0]!.automated;
    await sweep(dir,f,raw);
    f.mail=[];clock.t=BASE+30*3_600_000;await sweep(dir,f,raw);
    const answer=await waiting();expect(answer.stale).toBe(true);expect(answer.completeness).toBe('partial');
    expect(readAppleState(dir).mail_loops!.pending_threads).toContain('nudges');
    expect(readAppleState(dir).mail_loops!.loop_grace_holds!.nudges!.due_ms).toBe(due);
  }));

  test('F5 quiet outbound ask survives exactly 100 newer noise threads, cache eviction and empty incremental grace recovery', () => withHome(async () => {
    const dir=newDir(),raw=await insertSource(dir),f=fake([outbound('quiet','quiet',70),inbound('noise0','noise0',1,{from:'noreply@example.com'})]);
    f.sinceFilter=true;await sweep(dir,f,raw);
    expect(readAppleState(dir).mail_loops!.loop_grace_holds!.quiet).toBeDefined();
    f.mail.push(...Array.from({length:100},(_,i)=>inbound('noise-'+i,'noise-'+i,0.5,{from:'noreply@example.com'})));
    await sweep(dir,f,raw);
    expect(readAppleState(dir).mail_loops!.threads!.quiet).toBeUndefined();
    f.mail=[];clock.t=BASE+3*3_600_000;await sweep(dir,f,raw);await sweep(dir,f,raw);
    expect((await open()).map(x=>[x.thread_id,x.loop_type])).toEqual([['quiet','unanswered_outbound']]);
    expect((await waiting()).text).not.toContain('You are clean');
    expect((await waiting()).stale).toBe(false);
  }));

  test('F5 a missing recovery page is not upstream gone; the hold and incomplete coverage survive empty sweeps', () => withHome(async () => {
    const dir=newDir(),raw=await insertSource(dir),f=fake([outbound('quiet','quiet',70)]);
    await sweep(dir,f,raw);
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1',[SID]);
    f.mail=[];clock.t=BASE+4*3_600_000;await sweep(dir,f,raw);await sweep(dir,f,raw);
    expect(readAppleState(dir).mail_loops!.loop_grace_holds!.quiet).toBeDefined();
    expect(readAppleState(dir).mail_loops!.pending_threads).toContain('quiet');
    expect((await waiting()).completeness).toBe('partial');
    expect((await waiting()).text).not.toContain('You are clean');
  }));

  for (const [name, flags] of [['incomplete',{incomplete:true}],['unavailable-only',{unavailableThreads:['missing']}],['truncated',{truncated:true}]] as Array<[string,Omit<AppleMailListing,'messages'>]>) {
    test(`F6 fresh then ${name} invalidates clean status; unavailable coverage requires actual recovery`, () => withHome(async () => {
      const dir=newDir(),raw=await insertSource(dir),f=fake([]);await sweep(dir,f,raw);
      expect((await waiting()).stale).toBe(false);
      f.flags=flags;await sweep(dir,f,raw);
      expect((await waiting()).stale).toBe(true);expect((await waiting()).completeness).toBe('partial');
      expect((await waiting()).text).not.toContain('You are clean');
      f.flags=undefined;await sweep(dir,f,raw);
      if(name!=='truncated') {
        expect((await waiting()).stale).toBe(true);
        expect((await waiting()).completeness).toBe('partial');
        f.mail=[inbound('recovered','missing',60)];await sweep(dir,f,raw);
        expect((await waiting()).stale).toBe(false);
      }
    }));
  }

  test('F6 refused full reconcile and unclassified follow-up invalidate an earlier complete stamp durably', () => withHome(async () => {
    const dir=newDir(),raw=await insertSource(dir),f=fake([inbound('first','first',60)]);await sweep(dir,f,raw);
    f.mail=[];await sweep(dir,f,raw,{full:true});
    expect(readAppleState(dir).mail.walk?.purpose).toBe('full');
    await sweep(dir,f,raw); // A normal empty sweep cannot silently forget a refused full reconcile.
    expect((await waiting()).completeness).toBe('partial');
    expect((await waiting()).stale).toBe(true);expect((await waiting()).completeness).toBe('partial');
    const m=inbound('first','first',60);delete m.bulk;f.mail=[m];await sweep(dir,f,raw);
    f.mail=[];await sweep(dir,f,raw);
    expect((await waiting()).stale).toBe(true);expect(readAppleState(dir).mail_loops!.pending_threads).toContain('first');
    f.mail=[inbound('first','first',60)];await sweep(dir,f,raw);
    expect((await waiting()).stale).toBe(false);
  }));

  test('F7 adding an owner alias removes obsolete self-mail obligations without undoing manual done/drop rows', () => withHome(async () => {
    const dir=newDir(),alias='alias-example@example.com',raw=await insertSource(dir);
    const f=fake([inbound('self','self',60,{from:alias}),inbound('manual','manual',60)]);await sweep(dir,f,raw);
    await engine.executeRaw("UPDATE open_loops SET status='dropped',closed_by='user',closed_at=now() WHERE source_id=$1 AND thread_id='manual'",[SID]);
    const changed={...raw,a_mail_owner_addresses:OWNER+','+alias};await updateRaw(changed);await sweep(dir,f,changed);
    expect(await open()).toHaveLength(0);
    expect((await loops()).find(x=>x.thread_id==='self')).toMatchObject({status:'done',closed_by:'apple_owner_changed'});
    expect((await loops()).find(x=>x.thread_id==='manual')).toMatchObject({status:'dropped',closed_by:'user'});
    expect((await waiting()).stale).toBe(false);
    await updateRaw(raw);await sweep(dir,f,raw);
    expect((await open()).map(x=>x.thread_id)).toEqual(['self']);
  }));

  for (const gate of ['global','provider','spend','queue'] as const) {
    test(`F8 ${gate} deferral recovers a quiet eligible revision without new mail`, () => withHome(async () => {
      configureGateway({chat_model:'anthropic:claude-sonnet-4-6',env:{ANTHROPIC_API_KEY:'sk-ant-test'}});
      const dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true});
      const f=fake([inbound('old','old',60),inbound('noise','noise',1,{from:'noreply@example.com'})]);f.sinceFilter=true;
      await engine.setConfig('loops.extraction_enabled',gate==='global'?'false':'true');
      if(gate==='provider') { __setChatTransportForTests(null); configureGateway({chat_model:'anthropic:claude-sonnet-4-6',env:{}}); }
      if(gate==='spend') await engine.setConfig('loops.extraction_max_usd_per_day','0');
      if(gate==='queue') {
        const { LOOPS_EXTRACT_ENQUEUE_CEILING }=await import('../src/core/google/loops-extract.ts');
        const {MinionQueue}=await import('../src/core/minions/queue.ts');const queue=new MinionQueue(engine);
        for(let i=0;i<LOOPS_EXTRACT_ENQUEUE_CEILING;i++) await queue.add('loops_extract',{sourceId:SID},{idempotency_key:'noise-budget-'+i});
      }
      const first=await sweep(dir,f,raw);
      expect((await jobs()).filter(j=>j.data.threadId==='old')).toHaveLength(0);
      if(gate==='queue') expect(first.loops_enqueue?.deferred).toBe(1);
      if(gate==='provider') __setChatTransportForTests(async()=>{chatCalls++;return {text:'{"commitments":[],"decisions_pending":[]}',blocks:[],stopReason:'end',usage,model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};});
      await engine.setConfig('loops.extraction_enabled','true');
      configureGateway({chat_model:'anthropic:claude-sonnet-4-6',env:{ANTHROPIC_API_KEY:'sk-ant-test'}});
      await engine.setConfig('loops.extraction_max_usd_per_day','2');
      if(gate==='queue') await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE idempotency_key LIKE 'noise-budget-%'");
      f.mail=[];await sweep(dir,f,raw);
      expect((await jobs()).filter(j=>j.data.threadId==='old')).toHaveLength(1);
      expect(chatCalls).toBe(0);
    }));
  }

  test('F8 a queued revision skipped while globally disabled is recoverable after re-enablement, not consumed forever', () => withHome(async () => {
    const dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true}),f=fake([inbound('old','old',60)]);
    await engine.setConfig('loops.extraction_enabled','true');await sweep(dir,f,raw);
    const [job]=await jobs();await engine.setConfig('loops.extraction_enabled','false');
    const result=await runLoopsExtract(engine,{slug:String(job!.data.slug),sourceId:SID,threadId:'old'});
    expect(result.reason).toBe('extraction_disabled');
    await engine.executeRaw("UPDATE minion_jobs SET status='completed',result=$2::text::jsonb WHERE idempotency_key=$1",[job!.idempotency_key,JSON.stringify(result)]);
    await engine.setConfig('loops.extraction_enabled','true');f.mail=[];await sweep(dir,f,raw);
    expect(await jobs()).toHaveLength(2);expect(chatCalls).toBe(0);
    await engine.executeRaw(`UPDATE minion_jobs SET status='completed', result='{"status":"extracted"}'::jsonb WHERE name='loops_extract' AND data->>'sourceId'=$1`,[SID]);
    await sweep(dir,f,raw);expect(await jobs()).toHaveLength(2); // Only actual extraction settles a quiet revision.
  }));

  test('F9 current owner addresses and aliases reach the judge as trusted system context independently of non-Sent thread text', () => withHome(async () => {
    const alias='owner-alias@example.com',dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true,a_mail_owner_addresses:OWNER+','+alias});
    await engine.setConfig('loops.extraction_enabled','true');
    await sweep(dir,fake([outbound('owner','identity',100,{from:alias,mailbox:'Archive',body:'Can you send it?'})]),raw);
    const [job]=await jobs();let system='',user='';
    __setChatTransportForTests(async opts=>{chatCalls++;system=opts.system??'';user=JSON.stringify(opts.messages);return {text:'{"commitments":[],"decisions_pending":[]}',blocks:[],stopReason:'end',usage,model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};});
    try {
      expect(await runLoopsExtract(engine,{slug:String(job!.data.slug),sourceId:SID,threadId:'identity'})).toMatchObject({status:'extracted'});
      expect(system).toContain('Trusted Apple account owner addresses');expect(system).toContain(OWNER);expect(system).toContain(alias);
      expect(user).toContain(alias);expect(chatCalls).toBe(1);
    } finally {
      __setChatTransportForTests(async()=>{chatCalls++;return {text:'{"commitments":[],"decisions_pending":[]}',blocks:[],stopReason:'end',usage,model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};});
    }
  }));
});


test('F3 source revoked inside the synthetic read blocks enqueue in the same actual sync', () => withHome(async () => {
  const dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true});
  await engine.setConfig('loops.extraction_enabled','true');
  const r=readers(fake([inbound('revoke','revoke',60)]));const original=r.mail;
  r.mail=async opts=>{const result=await original(opts);await updateRaw({...raw,a_loops_extract_consent:false});return result;};
  const result=await pagedSweep(dir,raw,r);
  expect(result.loops_enqueue?.skipped_reason).toBe('apple_consent_missing');
  expect(await jobs()).toHaveLength(0);expect(chatCalls).toBe(0);
}));

test('F6 unattributed unreadability cannot authorize closure from a possibly partial reply slice', () => withHome(async () => {
  const dir=newDir(),raw=await insertSource(dir),f=fake([inbound('ask','unknown-thread',60)]);await sweep(dir,f,raw);
  f.mail=[outbound('reply','unknown-thread',40,{body:'Here is the answer.',to:['alice-example@example.com']})];f.flags={incomplete:true};
  await sweep(dir,f,raw);
  expect((await open()).map(x=>x.loop_type)).toEqual(['unanswered_inbound']);
  expect((await waiting()).completeness).toBe('partial');
  f.flags=undefined;f.mail=[];await sweep(dir,f,raw);
  expect((await open()).map(x=>x.loop_type)).toEqual(['unanswered_inbound']);
  expect((await waiting()).stale).toBe(true);
  f.mail=[inbound('ask','unknown-thread',60),outbound('reply','unknown-thread',40,{body:'Here is the answer.',to:['alice-example@example.com']})];
  await sweep(dir,f,raw);
  expect(await open()).toHaveLength(0);expect((await waiting()).stale).toBe(false);
}));


test('F3 consent withdrawn during a truncated fake response prevents the second model attempt', () => withHome(async () => {
  const dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true});
  await engine.setConfig('loops.extraction_enabled','true');await sweep(dir,fake([inbound('retry','retry',60)]),raw);
  const [job]=await jobs();
  __setChatTransportForTests(async()=>{chatCalls++;await updateRaw({...raw,a_loops_extract_consent:false});return {text:'{',blocks:[],stopReason:'length',usage,model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};});
  try {
    expect(await runLoopsExtract(engine,{slug:String(job!.data.slug),sourceId:SID,threadId:'retry'})).toMatchObject({status:'skipped',reason:'apple_consent_missing'});
    expect(chatCalls).toBe(1);
  }finally{__setChatTransportForTests(async()=>{chatCalls++;return {text:'{"commitments":[],"decisions_pending":[]}',blocks:[],stopReason:'end',usage,model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};});}
}));


test('F3 actual queue handler retains explicit Apple origin when mutable page and source kind markers are changed', () => withHome(async () => {
  const dir=newDir(),raw=await insertSource(dir,{a_loops_extract_consent:true});
  await engine.setConfig('loops.extraction_enabled','true');await sweep(dir,fake([inbound('origin','origin',60)]),raw);
  const [job]=await jobs();expect(job!.data.sourceKind).toBe('apple');
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'apple_thread_id'-'source_kind' WHERE source_id=$1",[SID]);
  await updateRaw({...raw,kind:'google',a_loops_extract_consent:false});
  const {makeLoopsExtractHandler}=await import('../src/core/minions/handlers/loops-extract.ts');
  const handler=makeLoopsExtractHandler(engine);
  expect(await handler({data:job!.data} as Parameters<typeof handler>[0])).toMatchObject({status:'skipped',reason:'apple_source_unavailable'});
  expect(chatCalls).toBe(0);
}));


// Exact review reproduction: a question changes direction, not just self-mail eligibility.
test("F7 boundary direction roundtrip restores the same derived row with unchanged activity", () => withHome(async () => {
  const dir = newDir(), owner = "me@example.com", alias = "alias@example.com";
  const raw = await insertSource(dir, { a_services: "mail", a_mail_owner_addresses: owner });
  const f = fake([inbound("ask", "alias-turn", 100, { from: alias, to: [owner, "bob@example.com"], body: "Can you review?" })]);
  const rows = () => engine.executeRaw<{ id: number; loop_type: string; status: string; closed_by: string | null; last_activity_at: string }>(
    "SELECT id,loop_type,status,closed_by,last_activity_at::text FROM open_loops WHERE source_id=$1 ORDER BY loop_type", [SID]);
  await sweep(dir, f, raw);
  const [original] = await rows();
  expect(original).toMatchObject({ loop_type: "unanswered_inbound", status: "open" });
  const changed = { ...raw, a_mail_owner_addresses: owner + "," + alias };
  for (let cycle = 0; cycle < 2; cycle++) {
    await updateRaw(changed); await sweep(dir, f, changed);
    expect(await rows()).toEqual([
      expect.objectContaining({ id: original!.id, status: "done" }),
      expect.objectContaining({ loop_type: "unanswered_outbound", status: "open", closed_by: null }),
    ]);
    await updateRaw(raw); await sweep(dir, f, raw);
    expect(await rows()).toEqual([
      original!,
      expect.objectContaining({ loop_type: "unanswered_outbound", status: "done", closed_by: "apple_owner_changed" }),
    ]);
    const answer = await waiting();
    expect(answer.stale).toBe(false); expect(answer.completeness).toBe("complete");
    expect(answer.text).not.toContain("You are clean");
  }
}));

for (const disposition of ["done", "drop", "mute", "reply"] as const) {
  test(`F7 boundary owner roundtrip preserves ${disposition} disposition`, () => withHome(async () => {
    const dir = newDir(), owner = "me@example.com", alias = "alias@example.com";
    const raw = await insertSource(dir, { a_services: "mail", a_mail_owner_addresses: owner });
    const f = fake([inbound("ask", "control", 100, { from: alias, to: [owner, "bob@example.com"] })]);
    await sweep(dir, f, raw);
    if (disposition === "reply") {
      f.mail.push(outbound("answer", "control", 90, { from: owner, to: [alias, "bob@example.com"], body: "Here is the review." }));
      await sweep(dir, f, raw);
    } else {
      const { closeOpenLoop, closeMutedLoops } = await import("../src/core/loops/loops-store.ts");
      const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM open_loops WHERE source_id=$1 AND status='open'", [SID]);
      if (disposition === "mute") {
        await addSuppression(engine, SID, "thread", "control");
        await closeMutedLoops(engine, SID, "thread", "control", true);
        __clearSuppressionCacheForTests(engine);
      } else await closeOpenLoop(engine, SID, row!.id, disposition === "done" ? "done" : "dropped", "user");
    }
    const [before] = (await loops()).filter(l => l.loop_type === "unanswered_inbound");
    expect(before!.status).not.toBe("open");
    const changed = { ...raw, a_mail_owner_addresses: owner + "," + alias };
    await updateRaw(changed); await sweep(dir, f, changed);
    await updateRaw(raw); await sweep(dir, f, raw); await sweep(dir, f, raw);
    expect((await loops()).find(l => l.loop_type === "unanswered_inbound")).toEqual(before!);
    expect(await open()).toHaveLength(0);
  }));
}


test("F7 boundary returning direction waits for grace and honors a mute after identity reconciliation settles", () => withHome(async () => {
  const dir = newDir(), owner = "me@example.com", alias = "alias@example.com";
  const raw = await insertSource(dir, { a_services: "mail", a_mail_owner_addresses: owner });
  const f = fake([inbound("ask", "grace-turn", 30, { from: alias, to: [owner, "bob@example.com"] })]);
  await sweep(dir, f, raw);
  const changed = { ...raw, a_mail_owner_addresses: owner + "," + alias };
  await updateRaw(changed); await sweep(dir, f, changed);
  expect(await open()).toHaveLength(0);
  expect(readAppleState(dir).mail_loops?.identity_reconcile).toBeUndefined();
  expect(readAppleState(dir).mail_loops?.loop_grace_holds?.["grace-turn"]).toBeDefined();
  await addSuppression(engine, SID, "thread", "grace-turn"); __clearSuppressionCacheForTests(engine);
  clock.t += 80 * 3_600_000; await sweep(dir, f, changed);
  expect(await open()).toHaveLength(0);
  const { removeSuppression } = await import("../src/core/loops/loops-store.ts");
  await removeSuppression(engine, SID, "thread", "grace-turn"); __clearSuppressionCacheForTests(engine);
  await sweep(dir, f, changed);
  expect((await open()).map(l => l.loop_type)).toEqual(["unanswered_outbound"]);
  await updateRaw(raw); await sweep(dir, f, raw);
  expect((await open()).map(l => l.loop_type)).toEqual(["unanswered_inbound"]);
}));
