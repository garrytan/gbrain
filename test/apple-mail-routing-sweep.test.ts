/**
 * apple-mail-routing-sweep — Google-hosted Mail accounts are never ingested through Apple Mail, end to end on PGLite with
 * the synthetic Mail reader (no macOS, no Mail.app, no private data; placeholder ids only).
 *
 *  - mixed: only the non-Google accounts are read; Google-only: nothing is read; unknown: the WHOLE Mail sweep stops and
 *    Calendar/Contacts go on;
 *  - a routing change (or a legacy cursor with no routing) restarts the read of the window and drops staged recovery
 *    evidence, but NEVER deletes a stored page, clears a hold, or lets a later `--full` remove a mail page;
 *  - a changed account setup under a running read refuses that read before anything is rendered;
 *  - a held message the scoped read cannot find while accounts are routed away is out of scope, not gone;
 *  - open-loop coverage is never "complete" for Google mail that was not read.
 * The routing fixtures are plain data (test/helpers/apple-mail-fake.ts), so these tests run against any build of the sweep.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { appleStateFile, normalizeAppleState, readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { mailRelPath } from '../src/core/apple/render.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import { retryHeld } from '../src/commands/sources-retry-held.ts';
import type { ItemHoldRecord } from '../src/core/connectors/item-holds.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { AppleContact, AppleReaders } from '../src/core/apple/types.ts';
import { DAY, HOUR, NOW, OWNER, dayIso, fakeMail, fakeRouting, mk, readersOf, type FakeMail } from './helpers/apple-mail-fake.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.executeRaw('DELETE FROM op_checkpoints').catch(() => undefined);
  clock.t = NOW;
  logs.length = 0;
});

const SID = 'amr';
const clock = { t: NOW };
const logs: string[] = [];
const WINDOW_START = (): string => new Date(NOW - 60 * DAY).toISOString();

const newDir = (): string => mkdtempSync(join(tmpdir(), 'amr-'));
const withHome = <T,>(fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
const baseRaw = (dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'mail', a_mail_days: 60, a_mail_owner_addresses: OWNER, ...extra });

async function insertSource(dir: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const raw = baseRaw(dir, extra);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`, [SID, dir, JSON.stringify(raw)]);
  return raw;
}
async function sweep(dir: string, f: FakeMail, raw: Record<string, unknown>, opts: Partial<SyncOpts> = {}, readers: AppleReaders = readersOf(f)) {
  const cfg = parseAppleSourceConfig(raw, dir);
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts }, { readers, now: () => clock.t, log: (m) => { logs.push(m); } });
}
const holdsOf = (dir: string): Record<string, ItemHoldRecord> => ((readAppleState(dir).item_holds ?? { items: {} }) as { items: Record<string, ItemHoldRecord> }).items;
async function pages(): Promise<Array<{ slug: string; compiled_truth: string; tid: string }>> {
  return engine.executeRaw(`SELECT slug, compiled_truth, frontmatter->>'apple_thread_id' AS tid FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' IS NOT NULL ORDER BY slug`, [SID]);
}
async function pageOf(threadId: string): Promise<string | undefined> {
  const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = $2`, [SID, threadId]);
  return row?.compiled_truth;
}
const hasPage = async (needle: string): Promise<boolean> => (await pages()).some((p) => p.compiled_truth.includes(needle));
function ctx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SID } as OperationContext;
}
const waiting = async (): Promise<any> => loopsOperations.find((o) => o.name === 'open_loops')!.handler(ctx(), { source_id: SID, group_by: 'counterparty', include_context: false });

const APPLE = fakeRouting({ apple: ['acct-apple'] });
const MIXED = fakeRouting({ apple: ['acct-apple'], google: ['acct-google'] });
const GOOGLE_ONLY = fakeRouting({ google: ['acct-google'] });

describe('which accounts are read', () => {
  test('mixed: only the non-Google account is read; the Google message never becomes a page; the cursor carries the routing', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 5), mk('<g@x>', 'thr-g', 5, { body: 'GOOGLE-ONLY-BODY' })]);
    f.accountOf['<g@x>'] = 'acct-google';
    f.routing = MIXED;
    const r = await sweep(dir, f, raw);
    expect(r.status).not.toBe('partial');
    expect(await pageOf('thr-a')).toContain('Synthetic body of <a@x>.');
    expect(await pageOf('thr-g')).toBeUndefined();
    expect(await hasPage('GOOGLE-ONLY-BODY')).toBe(false);
    expect(f.seenRouting).toEqual([{ kind: 'main', fingerprint: MIXED.fingerprint }]);
    // A fresh scope has no pages of unknown origin: no legacy mark, so a later --full may still reconcile Apple mail.
    expect(readAppleState(dir).mail.routing).toEqual({ v: 1, fp: MIXED.fingerprint });
  }));

  test('Google-only: nothing is read or imported, the run is not partial, the source is not stamped fresh, and waiting is never complete', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<g@x>', 'thr-g', 5, { body: 'GOOGLE-ONLY-BODY' })]);
    f.accountOf['<g@x>'] = 'acct-google';
    f.routing = GOOGLE_ONLY;
    const r = await sweep(dir, f, raw);
    expect(f.main).toEqual([]);
    expect(f.byId).toEqual([]);
    expect(r.status).not.toBe('partial');
    expect(await pages()).toEqual([]);
    expect(logs.some((l) => l.includes('hosted by Google'))).toBe(true);
    const w = await waiting();
    expect(w.completeness).toBe('partial');
  }));

  test('unknown account: the WHOLE Mail sweep stops before any read or state change, Calendar/Contacts still run, and the error is explicit', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_services: 'contacts,mail' });
    const f = fakeMail([mk('<a@x>', 'thr-a', 5)]);
    f.routing = APPLE;
    const person: AppleContact = { id: 'c-1', givenName: 'Alice', familyName: 'Example', emails: ['alice-example@example.com'], phones: [], groups: [] };
    const withContacts = (): AppleReaders => ({ ...readersOf(f), async contacts() { return [structuredClone(person)]; } });
    await sweep(dir, f, raw, {}, withContacts());
    const before = readAppleState(dir);
    expect(await pageOf('thr-a')).toContain('<a@x>');

    f.box.push(mk('<later@x>', 'thr-later', 1));
    f.routing = fakeRouting({ apple: ['acct-apple'], unknown: ['acct-weird'] });
    const callsBefore = f.main.length;
    const r = await sweep(dir, f, raw, {}, withContacts());
    expect(f.main.length).toBe(callsBefore);
    expect(f.byId).toEqual([]);
    expect(r.status).toBe('partial');
    expect(await pageOf('thr-later')).toBeUndefined();
    const after = readAppleState(dir);
    expect(after.mail.hashes).toEqual(before.mail.hashes);
    expect(after.mail.routing).toEqual(before.mail.routing);
    expect(after.mail.newest).toBe(before.mail.newest);
    expect(after.last_probe?.mail).toMatchObject({ ok: false, code: 'mail_routing_unknown' });
    expect(after.last_probe?.contacts).toMatchObject({ ok: true });
    expect(logs.some((l) => l.includes('provider cannot be determined'))).toBe(true);
    const contactPage = await engine.executeRaw(`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_contact_id' IS NOT NULL`, [SID]);
    expect(contactPage).toHaveLength(1);
    // Mail and loop coverage are not claimed while the accounts cannot be told apart.
    expect((await waiting()).completeness).toBe('partial');
  }));

  test('every account disabled is the existing "Mail has nothing to read" error, not a clean empty listing', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 5)]);
    f.routing = fakeRouting({ disabled: ['acct-apple'] });
    const r = await sweep(dir, f, raw);
    expect(r.status).toBe('partial');
    expect(f.main).toEqual([]);
    expect(readAppleState(dir).last_probe?.mail).toMatchObject({ ok: false, code: 'mail_not_running_or_unconfigured' });
  }));
});

describe('open-loop coverage', () => {
  test('complete with only Apple-hosted accounts; a Google account in Mail makes it partial without forcing a whole-window re-read every run', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20)]);
    f.routing = APPLE;
    await sweep(dir, f, raw);
    expect((await waiting()).completeness).toBe('complete');

    // A Google account appears: the eligible scope (and so the fingerprint) is unchanged, nothing is re-read from scratch, but
    // Google mail is not read here, so the answer can no longer be "complete".
    f.routing = MIXED;
    f.box.push(mk('<b@x>', 'thr-b', 1));
    const newest = readAppleState(dir).mail.newest!;
    await sweep(dir, f, raw);
    expect(f.main.at(-1)!.since).toBe(new Date(Date.parse(newest) - 2 * DAY).toISOString());
    expect(await pageOf('thr-b')).toContain('<b@x>');
    expect((await waiting()).completeness).toBe('partial');
    expect(readAppleState(dir).mail_loops!.reread).toBeUndefined();
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
    await sweep(dir, f, raw);
    expect(f.main.at(-1)!.since).toBe(new Date(Date.parse(readAppleState(dir).mail.newest!) - 2 * DAY).toISOString());
  }));
});

describe('a routing change never deletes stored pages or clears holds', () => {
  const legacyThenRouted = async (dir: string, raw: Record<string, unknown>): Promise<FakeMail> => {
    // Before account routing existed Apple Mail read every account: the Google thread was ingested like any other.
    const f = fakeMail([mk('<a@x>', 'thr-a', 20), mk('<g@x>', 'thr-g', 19, { body: 'LEGACY-GOOGLE-BODY' })]);
    await sweep(dir, f, raw);
    expect(await pageOf('thr-g')).toContain('LEGACY-GOOGLE-BODY');
    expect(readAppleState(dir).mail.routing).toBeUndefined();
    f.accountOf['<g@x>'] = 'acct-google';
    f.routing = MIXED;
    return f;
  };

  test('a legacy cursor is reread from the window start under the new routing; the old Google page stays, and a later --full never removes it', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = await legacyThenRouted(dir, raw);
    const newestBefore = readAppleState(dir).mail.newest!;
    expect(Date.parse(newestBefore)).toBeGreaterThan(NOW - 30 * DAY);

    f.box.push(mk('<new@x>', 'thr-new', 1));
    const r = await sweep(dir, f, raw);
    expect(f.main.at(-1)!.since).toBe(WINDOW_START()); // not newest - 2 days
    expect(f.main.at(-1)!.after).toBeUndefined();
    expect(r.deleted).toBe(0);
    expect(await pageOf('thr-new')).toContain('<new@x>');
    expect(await pageOf('thr-g')).toContain('LEGACY-GOOGLE-BODY');
    expect(readAppleState(dir).mail.routing).toEqual({ v: 1, fp: MIXED.fingerprint, legacy: true });
    expect(logs.some((l) => l.includes('mail account routing is new for this cursor'))).toBe(true);

    // The Google thread is no longer listed by any Apple account. A complete --full walk still keeps it, and keeps the Apple
    // page of a thread that was deleted upstream: a page cannot say which account it came from.
    f.box = f.box.filter((m) => m.id !== '<a@x>');
    const full = await sweep(dir, f, raw, { full: true });
    expect(full.deleted).toBe(0);
    expect(await pageOf('thr-g')).toContain('LEGACY-GOOGLE-BODY');
    expect(await pageOf('thr-a')).toContain('<a@x>');
    expect(readAppleState(dir).mail.walk).toBeUndefined(); // the full walk completed
    expect(logs.some((l) => l.includes('--full kept'))).toBe(true);
    // And again with GBRAIN_ALLOW_MASS_RECONCILE: the opt-in for the mass guard is not an approval to remove mail pages.
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => { await sweep(dir, f, raw, { full: true }); });
    expect(await pageOf('thr-g')).toContain('LEGACY-GOOGLE-BODY');
  }));

  test('control: without routing the same --full does delete a thread that is gone upstream (the guard is specific to routed sources)', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20), mk('<g@x>', 'thr-g', 19)]);
    await sweep(dir, f, raw);
    f.box = f.box.filter((m) => m.id !== '<g@x>');
    const full = await sweep(dir, f, raw, { full: true });
    expect(full.deleted).toBe(1);
    expect(await pageOf('thr-g')).toBeUndefined();
  }));

  test('a fresh routed source (no stored pages of unknown origin) still reconciles an upstream deletion on --full', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20), mk('<b@x>', 'thr-b', 19)]);
    f.routing = APPLE;
    await sweep(dir, f, raw);
    f.box = f.box.filter((m) => m.id !== '<b@x>');
    const full = await sweep(dir, f, raw, { full: true });
    expect(full.deleted).toBe(1);
    expect(await pageOf('thr-b')).toBeUndefined();
    expect(readAppleState(dir).mail.routing).toEqual({ v: 1, fp: APPLE.fingerprint });
  }));

  test('a provider change under the SAME account id (Apple-hosted -> Google) restarts the read, keeps the pages, and stays out of that account', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20, { body: 'WAS-APPLE-HOSTED' })]);
    f.accountOf['<a@x>'] = 'acct-1';
    f.routing = fakeRouting({ apple: [['acct-1', 'imap.example.com']] });
    await sweep(dir, f, raw);
    expect(await pageOf('thr-a')).toContain('WAS-APPLE-HOSTED');
    const fp1 = readAppleState(dir).mail.routing!.fp;

    // The same account id is now a Google account (id-only signatures would not notice).
    f.box.push(mk('<later@x>', 'thr-later', 1, { body: 'POST-CHANGE-GOOGLE' }));
    f.accountOf['<later@x>'] = 'acct-1';
    f.routing = fakeRouting({ google: ['acct-1'] });
    const mid = await sweep(dir, f, raw);
    expect(mid.deleted).toBe(0);
    expect(f.main).toHaveLength(1); // nothing was read for the Google-only scope
    expect(await hasPage('POST-CHANGE-GOOGLE')).toBe(false);
    expect(await pageOf('thr-a')).toContain('WAS-APPLE-HOSTED');
    const fp2 = readAppleState(dir).mail.routing!.fp;
    expect(fp2).not.toBe(fp1);

    // A different host under the same id is a different scope again, even though the id set is unchanged.
    f.routing = fakeRouting({ apple: [['acct-1', 'imap.other.example.com']] });
    await sweep(dir, f, raw);
    expect(readAppleState(dir).mail.routing!.fp).not.toBe(fp2);
    expect(f.main.at(-1)!.since).toBe(WINDOW_START());
    expect(await pageOf('thr-a')).toContain('WAS-APPLE-HOSTED');
  }));

  test('a routing change mid-walk (capped read in progress) discards the resume cursor and rereads from the window start', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir, { a_mail_max: 2 });
    const f = fakeMail([1, 2, 3, 4, 5].map((n) => mk(`<m${n}@x>`, `thr-${n}`, 10 - n)));
    f.routing = APPLE;
    const first = await sweep(dir, f, raw);
    expect(first.status).toBe('partial');
    const mid = readAppleState(dir).mail;
    expect(mid.resume_from).toBeDefined();
    expect(mid.walk).toBeDefined();
    expect((await pages()).length).toBe(2);

    // A second Apple-hosted account appears while the walk is in progress.
    f.box.push(mk('<two@x>', 'thr-two', 9));
    f.accountOf['<two@x>'] = 'acct-two';
    f.routing = fakeRouting({ apple: ['acct-apple', 'acct-two'] });
    const second = await sweep(dir, f, raw);
    expect(f.main.at(-1)!.since).toBe(WINDOW_START());
    expect(f.main.at(-1)!.after).toBeUndefined();
    expect(second.deleted).toBe(0);
    for (let i = 0; i < 6; i++) { if (!readAppleState(dir).mail.walk) break; await sweep(dir, f, raw); }
    expect((await pages()).map((p) => p.tid).sort()).toEqual(['thr-1', 'thr-2', 'thr-3', 'thr-4', 'thr-5', 'thr-two']);
  }));

  test('accounts that change UNDER a running read refuse that read before anything is rendered; the next run recovers under the new scope', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 5)]);
    f.routing = APPLE;
    await sweep(dir, f, raw);
    const fpBefore = readAppleState(dir).mail.routing!.fp;
    f.box.push(mk('<n@x>', 'thr-n', 1));
    f.accountOf['<n@x>'] = 'acct-new';
    f.afterRoutingRead = () => { f.routing = fakeRouting({ apple: ['acct-apple', 'acct-new'] }); f.afterRoutingRead = undefined; };
    const r = await sweep(dir, f, raw);
    expect(r.status).toBe('partial');
    expect(await pageOf('thr-n')).toBeUndefined();
    const st = readAppleState(dir);
    expect(st.last_probe?.mail).toMatchObject({ ok: false, code: 'mail_routing_changed' });
    expect(st.mail.routing!.fp).toBe(fpBefore); // the cursor still belongs to the scope it was made under
    await sweep(dir, f, raw);
    expect(await pageOf('thr-n')).toContain('<n@x>');
    expect(readAppleState(dir).mail.routing!.fp).not.toBe(fpBefore);
    expect(await pageOf('thr-a')).toContain('<a@x>');
  }));

  test('a reader that does not echo the routing it read under is refused (fail closed), not trusted', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 5)]);
    f.routing = APPLE;
    const base = readersOf(f);
    const mute: AppleReaders = { ...base, async mail(opts) { const l = await base.mail(opts); return Array.isArray(l) ? l : { ...l, routing: undefined }; } };
    const r = await sweep(dir, f, raw, {}, mute);
    expect(r.status).toBe('partial');
    expect(await pages()).toEqual([]);
    expect(readAppleState(dir).last_probe?.mail).toMatchObject({ ok: false, code: 'mail_routing_changed' });
  }));
});

describe('held items and staged evidence across a routing change', () => {
  const threadMsgs = (tid: string, n: number, startDaysAgo: number): ReturnType<typeof mk>[] =>
    Array.from({ length: n }, (_, i) => mk(`<${tid}-${i}@x>`, tid, startDaysAgo, { date: new Date(Date.parse(dayIso(startDaysAgo)) + i * 60_000).toISOString() }));
  const blockerOf = (dir: string, tid: string, msgs: ReturnType<typeof mk>[]): string => join(dir, `${mailRelPath({ threadId: tid, messages: msgs })}.tmp`);

  /** A held thread import (a directory sits where its temp file goes), staged evidence left by an earlier run, then the import is unblocked. */
  async function heldWithStaging(dir: string, raw: Record<string, unknown>, f: FakeMail, msgs: ReturnType<typeof mk>[], stagedBody: string): Promise<void> {
    const blocker = blockerOf(dir, 'thr-t', msgs);
    mkdirSync(blocker, { recursive: true });
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect(holdsOf(dir)['mail:thr-t']?.state).toBe('held');
    f.box.push(mk('<later@x>', 'thr-later', 1));
    await sweep(dir, f, raw);
    // Evidence a previous run read by id and staged for message 1 (the body is a marker, so any reuse is visible).
    const file = appleStateFile(dir);
    const st = JSON.parse(readFileSync(file, 'utf8'));
    const nowIso = new Date(clock.t).toISOString();
    st.mail_recovery = { version: 1, turn: 1, units: { 'mail:thr-t': { turn: 1, n: msgs.length, at: nowIso } },
      staged: { [msgs[1]!.id]: { at: nowIso, m: { ...msgs[1], body: stagedBody } } }, gone: {} };
    writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
    rmSync(blocker, { recursive: true, force: true });
    clock.t += 30 * HOUR;
    await retryHeld(engine, SID);
  }

  test('control (no routing): staged evidence IS reused to rebuild the held thread, which is exactly what routing must stop for Google mail', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-t', 3, 12);
    const f = fakeMail([...msgs]);
    await heldWithStaging(dir, raw, f, msgs, 'STAGED-FROM-AN-ACCOUNT');
    await sweep(dir, f, raw);
    expect(await hasPage('STAGED-FROM-AN-ACCOUNT')).toBe(true);
  }));

  test('a held oversize-thread recovery walk does not drop the hold as gone when the whole thread is in a routed-away Google account', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-large', 101, 20);
    const f = fakeMail([...msgs]);
    // Fail the page import three times; 101 messages create a whole-window walk locator, not a targeted-id list.
    const blocker = join(dir, `${mailRelPath({ threadId: 'thr-large', messages: msgs })}.tmp`);
    mkdirSync(blocker, { recursive: true });
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect(holdsOf(dir)['mail:thr-large']?.state).toBe('held');
    expect(JSON.parse(holdsOf(dir)['mail:thr-large']!.ref!).w).toBe(101);
    rmSync(blocker, { recursive: true, force: true });
    // Every message in the failed thread is now in a Google-hosted account excluded by Apple routing.
    for (const m of msgs) f.accountOf[m.id] = 'acct-google';
    f.routing = MIXED;
    await retryHeld(engine, SID);
    const run = await sweep(dir, f, raw, { full: true });
    expect(run.deleted).toBe(0);
    expect(holdsOf(dir)['mail:thr-large']?.state).toBe('held');
    expect(await pageOf('thr-large')).toBeUndefined();
    expect((await waiting()).completeness).toBe('partial');
  }));

  test('staged bodies from before a routing change are never rendered; the hold stays held and visible; Google mail is not rebuilt from a read-by-id either', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const msgs = threadMsgs('thr-t', 3, 12);
    const f = fakeMail([...msgs]);
    await heldWithStaging(dir, raw, f, msgs, 'STAGED-FROM-AN-ACCOUNT');
    // Message 1 lives in an account that is now Google-hosted.
    f.accountOf[msgs[1]!.id] = 'acct-google';
    f.routing = MIXED;
    const r = await sweep(dir, f, raw);
    expect(r.deleted).toBe(0);
    expect(await hasPage('STAGED-FROM-AN-ACCOUNT')).toBe(false);
    expect(await hasPage(`Synthetic body of ${msgs[1]!.id}.`)).toBe(false);
    expect(await pageOf('thr-t')).toBeUndefined();
    expect(holdsOf(dir)['mail:thr-t']?.state).toBe('held'); // withheld, not cleared, not dropped as gone
    const staged = readAppleState(dir).mail_recovery?.staged ?? {};
    expect(Object.values(staged).some((e) => e.m.body === 'STAGED-FROM-AN-ACCOUNT')).toBe(false);
    expect(logs.some((l) => l.includes('staged recovery message(s) are dropped'))).toBe(true);
    // Whatever is outstanding is visible: Mail coverage is partial, never complete.
    expect((await waiting()).completeness).toBe('partial');
  }));

  test('a held message the scoped read cannot find while a Google account is routed away stays held (out of scope), but is dropped as gone when no account is routed away', () => withHome(async () => {
    const dir = newDir(); const raw = await insertSource(dir);
    const f = fakeMail([mk('<a@x>', 'thr-a', 20)]);
    await sweep(dir, f, raw);
    f.box.push(mk('<p@x>', 'thr-a', 19, { from: 'Bob Example <bob-example@example.com>' }));
    f.unreadable.add('<p@x>');
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    expect(holdsOf(dir)['mail-message:<p@x>']?.state).toBe('held');

    // The message now lives in a Google-hosted account the Apple connector no longer reads.
    f.unreadable.clear();
    f.accountOf['<p@x>'] = 'acct-google';
    f.routing = MIXED;
    f.byId.length = 0;
    await retryHeld(engine, SID);
    for (let i = 0; i < 2; i++) await sweep(dir, f, raw);
    expect(f.byId.flat().some((t) => t.id === '<p@x>')).toBe(true); // the targeted retry ran, under the same provider filter
    expect(f.seenRouting.filter((s) => s.kind === 'byId').every((s) => s.fingerprint === MIXED.fingerprint)).toBe(true);
    expect(holdsOf(dir)['mail-message:<p@x>']?.state).toBe('held');
    expect(await hasPage('Synthetic body of <p@x>.')).toBe(false);
    expect(logs.some((l) => l.includes('not found in the Mail accounts the Apple connector reads'))).toBe(true);

    // Control: with no account routed away, a message the read cannot find really is gone, and its hold is dropped.
    f.box = f.box.filter((m) => m.id !== '<p@x>');
    f.routing = fakeRouting({ apple: ['acct-apple'] });
    f.routing = { ...f.routing, fingerprint: MIXED.fingerprint }; // same scope: the point is only what "not found" means
    await retryHeld(engine, SID);
    for (let i = 0; i < 2; i++) await sweep(dir, f, raw);
    expect(holdsOf(dir)['mail-message:<p@x>']).toBeUndefined();
  }));
});

describe('state normalization', () => {
  test('the routing of the Mail cursor survives a state round trip; a malformed value is dropped, never guessed', () => {
    const kept = normalizeAppleState({ mail: { hashes: {}, routing: { v: 1, fp: 'abc', legacy: true } } });
    expect(kept.mail.routing).toEqual({ v: 1, fp: 'abc', legacy: true });
    expect(normalizeAppleState(JSON.parse(JSON.stringify(kept))).mail.routing).toEqual({ v: 1, fp: 'abc', legacy: true });
    expect(normalizeAppleState({ mail: { routing: { v: 1, fp: 'abc', legacy: 'yes' } } }).mail.routing).toEqual({ v: 1, fp: 'abc' });
    for (const bad of [{ v: '1', fp: 'abc' }, { v: 1, fp: '' }, { v: 1 }, 'x', null, [], { v: Number.NaN, fp: 'abc' }]) {
      expect(normalizeAppleState({ mail: { routing: bad } }).mail.routing).toBeUndefined();
    }
  });
});
