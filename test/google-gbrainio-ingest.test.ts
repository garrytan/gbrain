import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { gbrainioRunner, type GbrainioRun, type GbrainioRunResult } from '../src/core/google/gbrainio-gmail.ts';
import { classifyConnectorError } from '../src/core/connectors/item-holds.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { connectorAtomExclusionSql } from '../src/core/cycle/connector-atoms.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, settleConnectorWrites, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const OWNER = 'owner@example.invalid';
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const realRun = gbrainioRunner.run;
afterEach(() => { gbrainioRunner.run = realRun; });

interface Msg { id: string; tid: string; ms: number; from: string; to: string; subject: string; state?: 'received' | 'sent'; automated?: 'strong' | 'weak'; tags?: string[] }

/** A synthetic gbrain.io terminal over an in-memory mailbox: search by epoch window and tag, thread show, labels, send-as. */
function fakeGbrainio(mail: Msg[], opts: { override?: (args: string[]) => GbrainioRunResult | null } = {}) {
  const calls: string[][] = [];
  const run: GbrainioRun = async (_command, args) => {
    calls.push(args);
    const hit = opts.override?.(args);
    if (hit) return hit;
    const account = args[args.indexOf('-a') + 1]!;
    const out = (body: Record<string, unknown>): GbrainioRunResult => ({ exitCode: 0, stdout: JSON.stringify({ account, ...body }), stderr: '' });
    const row = (m: Msg) => ({ account, id: m.id, thread_id: m.tid, received_at: new Date(m.ms).toISOString(), from: m.from, to: m.to, cc: '',
      subject: m.subject, state: m.state ?? 'received', ...(m.automated ? { automated: m.automated } : {}) });
    const [, , verb, sub] = args;
    if (verb === 'label' && sub === 'ls') return out({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    if (verb === 'send-as' && sub === 'ls') return out({ send_as: [{ email: account }] });
    if (verb === 'message' && sub === 'search') {
      const q = args[4]!;
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const tag = q.replace(/after:\d+|before:\d+/g, '').trim();
      const hits = mail.filter((m) => m.ms / 1000 >= after && m.ms / 1000 < before && (!tag || (m.tags ?? []).includes(tag))).sort((a, b) => b.ms - a.ms);
      const cursor = args.includes('--cursor') ? Number(args[args.indexOf('--cursor') + 1]) : 0;
      const page = hits.slice(cursor, cursor + 25);
      const next = cursor + 25 < hits.length ? String(cursor + 25) : null;
      return out({ count: page.length, more: next !== null, next_cursor: next, messages: page.map(row) });
    }
    if (verb === 'thread' && sub === 'show') {
      const messages = mail.filter((m) => m.tid === args[4]).sort((a, b) => a.ms - b.ms);
      if (messages.length === 0) return { exitCode: 3, stdout: '', stderr: 'not found' };
      return out({ thread_id: args[4], count: messages.length, messages: messages.map((m) => ({ ...row(m), body: 'Body of ' + m.subject + '.', attachments: [] })) });
    }
    return { exitCode: 2, stdout: '', stderr: 'unexpected fixture command' };
  };
  gbrainioRunner.run = run;
  return { calls, shows: () => calls.filter((a) => a[2] === 'thread').map((a) => a[4]) };
}

const MAIL: Msg[] = [
  { id: 'a1a1a1a1a1a1a101', tid: 'a1a1a1a1a1a1a100', ms: NOW_MS - 5 * HOUR, from: 'Peer Example <peer@example.invalid>', to: OWNER, subject: 'Lunch plan' },
  { id: 'a1a1a1a1a1a1a102', tid: 'a1a1a1a1a1a1a100', ms: NOW_MS - 4 * HOUR, from: OWNER, to: 'peer@example.invalid', subject: 'Re: Lunch plan', state: 'sent' },
  { id: 'b2b2b2b2b2b2b201', tid: 'b2b2b2b2b2b2b200', ms: NOW_MS - 2 * DAY, from: 'Stranger Example <stranger@example.invalid>', to: OWNER, subject: 'Quick question' },
  { id: 'c3c3c3c3c3c3c301', tid: 'c3c3c3c3c3c3c300', ms: NOW_MS - 3 * DAY, from: 'Shop Example <hello@shop.example.invalid>', to: OWNER, subject: 'Sale', tags: ['category:promotions'] },
  { id: 'd4d4d4d4d4d4d401', tid: 'd4d4d4d4d4d4d400', ms: NOW_MS - 4 * DAY, from: 'Service Example <alerts@service.example.invalid>', to: OWNER, subject: 'Build report', automated: 'strong' },
  { id: 'e5e5e5e5e5e5e501', tid: 'e5e5e5e5e5e5e500', ms: NOW_MS - 5 * DAY, from: 'Other Example <other@example.invalid>', to: OWNER, subject: 'Starred note', tags: ['is:starred'] },
  { id: 'f6f6f6f6f6f6f601', tid: 'f6f6f6f6f6f6f600', ms: NOW_MS - 6 * DAY, from: 'Private Example <alice-example@private.example.invalid>', to: OWNER, subject: 'Personal' },
  { id: '0707070707070701', tid: '0707070707070700', ms: NOW_MS - 45 * DAY, from: 'Old Example <old@example.invalid>', to: OWNER, subject: 'Too old' },
];

function privateList(lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'gbrainio-private-')), 'private-senders.txt');
  writeFileSync(file, lines.join('\n'));
  return file;
}

const gbrainioConfig = (extra: Record<string, unknown> = {}) => ({ kind: 'google', g_account: OWNER, g_access: 'gbrainio', g_history_days: 30, ...extra });

async function pages(engine: BrainEngine, id: string) {
  await settleConnectorWrites(engine, id);
  const rows = await engine.executeRaw<{ slug: string; frontmatter: unknown }>(
    "SELECT slug, frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'emails/%'", [id]);
  const byThread = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const fm = (typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown>;
    byThread.set(String(fm.thread_id), fm);
  }
  return byThread;
}

async function managedState(engine: BrainEngine, id: string) {
  await disposePersistenceConsumer(engine);
  const [row] = await sourceCheckpoint(engine, id) as { completed_keys: { state?: Record<string, unknown> }[] }[];
  return row?.completed_keys[0]?.state;
}

test('gbrain.io source: window mode lands 30 days by tier, keeps private senders owner-only, and never re-reads an unchanged thread', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig({ g_private_senders_file: privateList(['# people whose mail stays owner-only', '@private.example.invalid']) });
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    expect(cfg.services).toEqual(['gmail']);
    expect(cfg.ingestTiers).toBe(true);
    const mail = MAIL.map((m) => ({ ...m }));
    const io = fakeGbrainio(mail);
    const run = () => runGoogleSync(engine, f.id, cfg, options);

    const first = await run();
    expect(first.status).not.toBe('partial');
    expect(io.shows().sort()).toEqual(MAIL.slice(0, 7).map((m) => m.tid).filter((t, i, a) => a.indexOf(t) === i).sort());
    const landed = await pages(engine, f.id);
    expect(landed.get('a1a1a1a1a1a1a100')?.ingest_tier).toBe('full');
    expect(landed.get('e5e5e5e5e5e5e500')?.ingest_tier).toBe('full');
    const record = landed.get('b2b2b2b2b2b2b200');
    expect(record?.ingest_tier).toBe('record');
    expect(record?.facts_backstop).toBe(false);
    expect(record?.extract_atoms).toBe(false);
    const secret = landed.get('f6f6f6f6f6f6f600');
    expect(secret?.ingest_tier).toBe('private');
    expect(secret?.visibility).toBe('private');
    expect(secret?.extract_atoms).toBe(false);
    expect(landed.has('c3c3c3c3c3c3c300')).toBe(false);
    expect(landed.has('d4d4d4d4d4d4d400')).toBe(false);
    expect(landed.has('0707070707070700')).toBe(false);
    expect(landed.get('a1a1a1a1a1a1a100')?.labels).toEqual(['SENT']);
    const s1 = await managedState(engine, f.id);
    expect(s1?.gmail_history_id ?? null).toBeNull();
    expect(s1?.gmail_backfill_done).toBe(true);
    const fresh = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(fresh[0]!.last_sync_at).not.toBeNull();

    // Nothing new: the recent window is listed again, but no thread is fetched.
    io.calls.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(io.shows()).toEqual([]);

    // A reply in one thread: only that thread is fetched again.
    mail.push({ id: 'b2b2b2b2b2b2b202', tid: 'b2b2b2b2b2b2b200', ms: NOW_MS - 30 * 60_000, from: 'Stranger Example <stranger@example.invalid>', to: OWNER, subject: 'Re: Quick question' });
    io.calls.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(io.shows()).toEqual(['b2b2b2b2b2b2b200']);
  }
}), 180_000);

test('gbrain.io source: a grown private-senders list rewrites the matching pages as private', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const file = privateList(['nobody@elsewhere.example.invalid']);
    const config = gbrainioConfig({ g_private_senders_file: file });
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    fakeGbrainio(MAIL.map((m) => ({ ...m })));
    await runGoogleSync(engine, f.id, cfg, options);
    expect((await pages(engine, f.id)).get('b2b2b2b2b2b2b200')?.visibility).not.toBe('private');
    writeFileSync(file, 'nobody@elsewhere.example.invalid\nstranger@example.invalid\n');
    expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
    const after = (await pages(engine, f.id)).get('b2b2b2b2b2b2b200');
    expect(after?.visibility).toBe('private');
    expect(after?.ingest_tier).toBe('private');
  }
}), 180_000);

test('gbrain.io source: re-tiering stops at a usage limit, resumes, and never deletes a page whose thread is gone', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const file = privateList(['nobody@elsewhere.example.invalid']);
    const config = gbrainioConfig({ g_private_senders_file: file });
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const mail = MAIL.map((m) => ({ ...m }));
    fakeGbrainio(mail);
    await runGoogleSync(engine, f.id, cfg, options);
    const before = await pages(engine, f.id);
    expect(before.get('a1a1a1a1a1a1a100')?.visibility).not.toBe('private');
    expect(before.has('b2b2b2b2b2b2b200')).toBe(true);
    writeFileSync(file, 'nobody@elsewhere.example.invalid\nstranger@example.invalid\npeer@example.invalid\n');

    const limited = fakeGbrainio(mail, { override: (args) => args[2] === 'thread'
      ? { exitCode: 1, stdout: '', stderr: 'daily limit reached for this terminal' } : null });
    expect((await runGoogleSync(engine, f.id, cfg, options)).status).toBe('partial');
    expect(limited.shows()).toHaveLength(1);

    const gone = mail.findIndex((m) => m.tid === 'b2b2b2b2b2b2b200');
    mail.splice(gone, 1);
    fakeGbrainio(mail);
    expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
    const after = await pages(engine, f.id);
    expect(after.get('a1a1a1a1a1a1a100')?.visibility).toBe('private');
    expect(after.get('b2b2b2b2b2b2b200')?.ingest_tier).toBe('record');

    const retried = fakeGbrainio(mail);
    expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
    expect(retried.shows()).toEqual(['b2b2b2b2b2b2b200']);
    expect((await pages(engine, f.id)).has('b2b2b2b2b2b2b200')).toBe(true);
  }
}), 180_000);

test('gbrain.io source on an unmanaged brain: re-tiering replaces a renamed thread page and rewrites a page made private by hand', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const file = privateList(['nobody@elsewhere.example.invalid']);
    const config = gbrainioConfig({ g_private_senders_file: file });
    const f = await source(engine, config);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const cfg = parseGoogleSourceConfig(config, f.dir);
      const mail = MAIL.map((m) => ({ ...m }));
      fakeGbrainio(mail);
      await runGoogleSync(engine, f.id, cfg, options);
      await settleConnectorWrites(engine, f.id);
      await engine.executeRaw(
        "UPDATE pages SET frontmatter = frontmatter || '{\"visibility\":\"private\"}'::jsonb WHERE source_id = $1 AND frontmatter->>'thread_id' = 'e5e5e5e5e5e5e500'", [f.id]);
      mail.splice(mail.findIndex((m) => m.id === 'a1a1a1a1a1a1a101'), 1);
      mail.find((m) => m.id === 'a1a1a1a1a1a1a102')!.subject = 'Dinner instead';
      writeFileSync(file, 'nobody@elsewhere.example.invalid\nother@example.invalid\npeer@example.invalid\n');
      fakeGbrainio(mail);
      expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
      await settleConnectorWrites(engine, f.id);
      const rows = await engine.executeRaw<{ slug: string; frontmatter: unknown }>(
        "SELECT slug, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'thread_id' IN ('a1a1a1a1a1a1a100', 'e5e5e5e5e5e5e500')", [f.id]);
      const fm = (r: { frontmatter: unknown }) => (typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown>;
      const lunch = rows.filter((r) => fm(r).thread_id === 'a1a1a1a1a1a1a100');
      expect(lunch).toHaveLength(1);
      expect(fm(lunch[0]!).visibility).toBe('private');
      const starred = rows.filter((r) => fm(r).thread_id === 'e5e5e5e5e5e5e500');
      expect(starred).toHaveLength(1);
      expect(fm(starred[0]!).ingest_tier).toBe('private');
      expect(fm(starred[0]!).extract_atoms).toBe(false);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }
}), 180_000);


test('gbrain.io source: a missing private-senders list stops the run before any write', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig({ g_private_senders_file: join(tmpdir(), 'gbrainio-missing-' + Date.now(), 'private-senders.txt') });
    const f = await source(engine, config);
    const io = fakeGbrainio(MAIL.map((m) => ({ ...m })));
    const err = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect((err as CredentialError).code).toBe('private_senders_unreadable');
    expect(io.shows()).toEqual([]);
    expect((await pages(engine, f.id)).size).toBe(0);
  }
}), 120_000);

test('gbrain.io source: an unconnected terminal and an answer for another mailbox write nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    fakeGbrainio(MAIL, { override: () => ({ exitCode: 4, stdout: '', stderr: 'terminal not connected' }) });
    const err = await runGoogleSync(engine, f.id, cfg, options).then(() => null, (e: unknown) => e);
    expect((err as CredentialError).code).toBe('gbrainio_not_connected');

    fakeGbrainio(MAIL, { override: (args) => args[3] === 'search'
      ? { exitCode: 0, stdout: JSON.stringify({ account: 'someone-else@example.invalid', messages: [] }), stderr: '' } : null });
    const result = await runGoogleSync(engine, f.id, cfg, options);
    expect(result.status).toBe('partial');
    expect((await pages(engine, f.id)).size).toBe(0);

    fakeGbrainio(MAIL, { override: (args) => args[3] === 'search'
      ? { exitCode: 0, stdout: JSON.stringify({ messages: [{ id: 'a1a1a1a1a1a1a101', thread_id: 'a1a1a1a1a1a1a100', received_at: new Date(NOW_MS).toISOString() }] }), stderr: '' } : null });
    expect((await runGoogleSync(engine, f.id, cfg, options)).status).toBe('partial');
    expect((await pages(engine, f.id)).size).toBe(0);
  }
}), 120_000);

test('gbrain.io source: a tag listing that fails keeps the window open and the source not fresh', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const io = fakeGbrainio(MAIL, { override: (args) => args[3] === 'search' && /is:important/.test(args[4] ?? '')
      ? { exitCode: 1, stdout: '', stderr: 'upstream error' } : null });
    const result = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options);
    expect(result.status).toBe('partial');
    expect(io.shows()).toEqual([]);
    const fresh = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(fresh[0]!.last_sync_at).toBeNull();
    expect((await managedState(engine, f.id))?.gmail_backfill_done ?? false).toBe(false);
  }
}), 120_000);

test('gbrain.io source: a re-tier stopped only by a usage limit is a usage-limit stop', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const file = privateList(['nobody@elsewhere.example.invalid']);
    const config = gbrainioConfig({ g_private_senders_file: file });
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    fakeGbrainio(MAIL.map((m) => ({ ...m })));
    await runGoogleSync(engine, f.id, cfg, options);
    writeFileSync(file, 'nobody@elsewhere.example.invalid\nstranger@example.invalid\n');
    fakeGbrainio(MAIL, { override: (args) => args[2] === 'thread' ? { exitCode: 1, stdout: '', stderr: 'daily limit reached for this terminal' } : null });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect(limited.status).toBe('partial');
    expect(limited.stopped_on).toBe('usage_limit');
    expect(limited.partial_causes).toEqual(['usage limit reached']);
  }
}), 180_000);

test('gbrain.io source: a partial run records why it ended partial', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    fakeGbrainio(MAIL, { override: (args) => args[3] === 'search' && /is:important/.test(args[4] ?? '')
      ? { exitCode: 1, stdout: '', stderr: 'upstream error' } : null });
    const result = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options);
    expect(result.status).toBe('partial');
    expect(result.partial_causes).toHaveLength(1);
    expect(result.partial_causes![0]).toStartWith('gmail sweep failed: ');
    expect(result.partial_causes![0]).toContain('upstream error');
  }
}), 120_000);

test('gbrain.io limits are rate limits; record pages opt out of atoms; existing sources keep their identity', async () => {
  expect(classifyConnectorError(new CredentialError('gbrainio_limit_reached')).scope).toBe('rate_limit');
  for (const engine of engines) expect(await connectorAtomExclusionSql(engine)).toContain("frontmatter->>'extract_atoms'");
  const vault = { kind: 'google', g_account: OWNER, g_services: 'gmail' };
  const withDefaults = connectorIdentity('google', { ...vault, g_ingest_tiers: false }, '/tmp/x');
  expect(connectorIdentity('google', vault, '/tmp/x').digest).toBe(withDefaults.digest);
  expect(parseGoogleSourceConfig(vault, '/tmp/x').ingestTiers).toBeUndefined();
  expect(parseGoogleSourceConfig(gbrainioConfig(), '/tmp/x').gbrainioCommand).toBe('gbrainio');
  // Value: protects=a gbrainio source sweeps Gmail only and honours an explicit ingest-tiers opt-out; fails_when=the gmail-only override or the g_ingest_tiers boolean read is dropped;
  // why_new=only the default command and vault tiers were asserted; seam=none; no_claim=sweep behaviour (config parse only)
  const forced = parseGoogleSourceConfig(gbrainioConfig({ g_services: 'gmail,calendar,contacts', g_ingest_tiers: false }), '/tmp/x');
  expect(forced.services).toEqual(['gmail']);
  expect(forced.ingestTiers).toBeUndefined();
});

test('gbrain.io source on an unmanaged brain: the same window walk, tiers and skip of unchanged threads', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const cfg = parseGoogleSourceConfig(config, f.dir);
      const io = fakeGbrainio(MAIL.map((m) => ({ ...m })));
      expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
      const rows = await engine.executeRaw<{ frontmatter: unknown }>("SELECT frontmatter FROM pages WHERE source_id=$1 AND slug LIKE 'emails/%'", [f.id]);
      const tiers = rows.map((r) => ((typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter) as Record<string, unknown>).ingest_tier).sort();
      expect(tiers).toEqual(['full', 'full', 'record', 'record']);
      const state = JSON.parse(readFileSync(join(f.dir, '.google-source.json'), 'utf-8')) as Record<string, unknown>;
      expect(state.gmail_backfill_done).toBe(true);
      expect(state.gmail_history_id).toBeNull();
      io.calls.length = 0;
      expect((await runGoogleSync(engine, f.id, cfg, options)).status).not.toBe('partial');
      expect(io.shows()).toEqual([]);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }
}), 120_000);

test('gbrain.io source: a run stopped only by a usage limit says so, even when it landed nothing; a real failure or a bare 403 does not', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const limit = { exitCode: 1, stdout: '', stderr: 'daily usage limit reached' };
    fakeGbrainio(MAIL, { override: (args) => args[2] === 'thread' && args[4] === 'b2b2b2b2b2b2b200' ? limit : null });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect(limited.status).toBe('partial');
    expect((limited as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    const fresh = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(fresh[0]!.last_sync_at).toBeNull();

    fakeGbrainio(MAIL, { override: (args) => args[3] === 'search' ? limit : null });
    const listing = await runGoogleSync(engine, f.id, cfg, options);
    expect(listing.status).toBe('partial');
    expect((listing as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    expect(listing.added + listing.modified + listing.deleted).toBe(0);

    // The thread gets a new message: from here on it lists at its new date.
    const answered = MAIL.map((m) => m.tid === 'b2b2b2b2b2b2b200' ? { ...m, id: m.id.slice(0, -1) + 'f', ms: NOW_MS - 60_000 } : m);
    fakeGbrainio(answered,
      { override: (args) => { if (args[2] === 'thread' && args[4] === 'b2b2b2b2b2b2b200') throw new Error('Gmail API HTTP 403: forbidden'); return null; } });
    const denied = await runGoogleSync(engine, f.id, cfg, options);
    expect(denied.status).toBe('partial');
    expect((denied as { stopped_on?: string }).stopped_on).toBeUndefined();

    fakeGbrainio(answered, { override: (args) => args[2] === 'thread' && args[4] === 'b2b2b2b2b2b2b200' ? { exitCode: 1, stdout: '', stderr: 'upstream error' } : null });
    const failed = await runGoogleSync(engine, f.id, cfg, options);
    expect(failed.status).toBe('partial');
    expect((failed as { stopped_on?: string }).stopped_on).toBeUndefined();
  }
}), 180_000);


test('gbrain.io source: a usage limit hit while reading the send-as identity stops the run as a usage limit, not a failure', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const limit = { exitCode: 1, stdout: '', stderr: 'daily usage limit reached' };
    const io = fakeGbrainio(MAIL, { override: (args) => args[2] === 'send-as' ? limit : null });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect(limited.status).toBe('partial');
    expect((limited as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    expect(io.shows()).toEqual([]);
    const fresh = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]);
    expect(fresh[0]!.last_sync_at).toBeNull();
  }
}), 180_000);

test('gbrain.io source: a bare 403 on one thread does not stop the rest of the batch as if a limit were spent', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const io = fakeGbrainio(MAIL, { override: (args) => { if (args[2] === 'thread' && args[4] === 'a1a1a1a1a1a1a100') throw new Error('Gmail API HTTP 403: forbidden'); return null; } });
    const denied = await runGoogleSync(engine, f.id, cfg, options);
    expect(denied.status).toBe('partial');
    expect(io.shows()).toContain('b2b2b2b2b2b2b200');
  }
}), 180_000);

test('gbrain.io source: a usage limit on the profile read stops the run as a usage limit, not a failure', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const io = fakeGbrainio(MAIL, { override: (args) => args[2] === 'label' ? { exitCode: 1, stdout: '', stderr: 'daily usage limit reached' } : null });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect(limited.status).toBe('partial');
    expect((limited as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    expect(io.shows()).toEqual([]);
  }
}), 180_000);

test('gbrain.io source: after a usage limit the sweep sends no more searches, not even a checkpoint proof', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const limit = { exitCode: 1, stdout: '', stderr: 'daily usage limit reached' };
    const io = fakeGbrainio(MAIL, { override: (args) => args[2] === 'thread' && args[4] === 'c3c3c3c3c3c3c300' ? limit : null });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect((limited as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    const stop = io.calls.findIndex((a) => a[2] === 'thread' && a[4] === 'c3c3c3c3c3c3c300');
    expect(stop).toBeGreaterThan(0);
    expect(io.calls.slice(stop + 1).filter((a) => a[3] === 'search')).toEqual([]);
  }
}), 120_000);

test('GST-4026: a usage limit raised by the checkpoint proof search stops the sweep at once, with no more thread reads or searches', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = gbrainioConfig();
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const mail: Msg[] = Array.from({ length: 30 }, (_, i) => ({ id: `9a9a9a9a9a9a9${String(i).padStart(3, '0')}`, tid: `9b9b9b9b9b9b9${String(i).padStart(3, '0')}`,
      ms: NOW_MS - (i + 1) * 12 * HOUR, from: 'Peer Example <peer@example.invalid>', to: OWNER, subject: `Topic ${i}` }));
    // The proof after the first 25-thread batch lists from the 25th thread's second down to the floor.
    const proofSec = Math.floor(mail[24]!.ms / 1000);
    const limit = { exitCode: 1, stdout: '', stderr: 'daily usage limit reached' };
    let proofAt = -1;
    const io = fakeGbrainio(mail, { override: (args) => {
      if (args[3] !== 'search' || proofAt >= 0) return null;
      const q = args[4]!;
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? -1);
      if (q.replace(/after:\d+|before:\d+/g, '').trim() || after < proofSec - 1 || after > proofSec) return null;
      proofAt = io.calls.length - 1;
      return limit;
    } });
    const limited = await runGoogleSync(engine, f.id, cfg, options);
    expect(proofAt).toBeGreaterThan(0);
    expect((limited as { stopped_on?: string }).stopped_on).toBe('usage_limit');
    expect(io.calls.slice(proofAt + 1).filter((a) => a[2] === 'thread' || a[3] === 'search')).toEqual([]);
  }
}), 120_000);

