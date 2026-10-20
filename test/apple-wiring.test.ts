/**
 * apple-wiring — the Apple connector's wiring into existing surfaces (#6855):
 * `sources add --kind apple` (legacy and connected parsers), validation,
 * `sources set-services`, connector identity, and `sync --source` dispatch
 * reaching runAppleSync with fake readers on PGLite. No macOS needed.
 * Placeholders only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSources } from '../src/commands/sources.ts';
import { runAddApple } from '../src/commands/sources-apple-add.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { AppleAddFlagError, buildAppleAddOptions, parseAppleServicesFlag } from '../src/commands/sources-apple-flags.ts';
import { connectorIdentity, connectorIdentityLeaves, connectorConfigLeaves, classifyConnectorLeaf, CONNECTOR_LEAF_RULES, isConnectorSourceKind } from '../src/core/persistence/connector-identity.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { sameConnectorAccount, describeConnectorAccount } from '../src/core/persistence/connector-state.ts';
import { performSync } from '../src/commands/sync.ts';
import type { AppleReaders } from '../src/core/apple/types.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'apple-wiring-'));
});

async function cli(fn: () => Promise<void>): Promise<{ out: string; err: string; exit: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | null = null;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const write = spyOn(process.stderr, 'write').mockImplementation(((c: string) => { err.push(String(c)); return true; }) as never);
  const ex = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
  try { await fn(); } catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; } finally {
    log.mockRestore(); error.mockRestore(); write.mockRestore(); ex.mockRestore();
  }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}

const row = async (id: string) => (await engine.executeRaw<{ config: Record<string, unknown>; local_path: string }>('SELECT config, local_path FROM sources WHERE id=$1', [id]))[0];

describe('sources add --kind apple (legacy path)', () => {
  test('writes the a_* config, creates a private managed dir, defaults to calendar and contacts only (never Mail)', async () => {
    const dir = join(home, 'clone');
    const r = await cli(() => runAddApple(engine, ['apple-local', '--kind', 'apple', '--dir', dir]));
    expect(r.exit).toBeNull();
    const src = (await row('apple-local'))!;
    expect(src.config).toMatchObject({ kind: 'apple', a_account: 'local', a_services: 'calendar,contacts', a_history_days: 90, a_managed: false, federated: true });
    expect(src.local_path).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(r.out).toContain('gbrain sync --source apple-local');
  });

  test('tuning flags land as config keys; non-default only', async () => {
    await cli(() => runAddApple(engine, ['apple-t', '--kind', 'apple', '--dir', join(home, 't'), '--services', 'mail,calendar', '--confirm-mail', '--account', 'work laptop',
      '--history-days', '30', '--future-days', '14', '--calendar-ids', 'cal-a, cal-b', '--contacts-dir', 'contacts', '--mail-mailboxes', 'INBOX,Archive', '--mail-days', '7']));
    const { config } = (await row('apple-t'))!;
    expect(config).toMatchObject({ a_account: 'work laptop', a_services: 'calendar,mail', a_history_days: 30, a_future_days: 14, a_calendar_ids: 'cal-a,cal-b',
      a_contacts_dir: 'contacts', a_mail_mailboxes: 'INBOX,Archive', a_mail_days: 7 });
    const cfg = parseAppleSourceConfig(config, '');
    expect(cfg.services).toEqual(['calendar', 'mail']);
  });

  test('default dir under the clones root is marked a_managed', async () => {
    const r = await cli(() => runAddApple(engine, ['apple-d', '--kind', 'apple']));
    expect(r.exit).toBeNull();
    expect((await row('apple-d'))!.config.a_managed).toBe(true);
  });

  test.each([
    [['--services', 'calender'], 'Unknown Apple service: calender'],
    [['--services', ','], 'at least one service'],
    [['--services', 'calendar,notes'], 'notes'],
    [['--history-days', '0'], 'history-days'],
    [['--history-days', '99999'], 'between 1 and 3650'],
    [['--mail-days', '400'], 'between 1 and 365'],
    [['--contacts-dir', '../x'], 'contacts-dir'],
    [['--calendar-ids', ' , '], 'calendar-ids'],
    [['--bogus', 'x'], 'Unknown or unsupported flag'],
    [['--path', '/tmp/x'], 'cannot be combined'],
  ])('validation: %j is refused with exit 2 and registers nothing', async (flags, message) => {
    const r = await cli(() => runAddApple(engine, ['apple-bad', '--kind', 'apple', '--dir', join(home, 'bad'), ...(flags as string[])]));
    expect(r.exit).toBe(2);
    expect(r.err).toContain(message as string);
    expect(await row('apple-bad')).toBeUndefined();
  });

  test('an unknown service is a coded error, never widened to all services', () => {
    try { parseAppleServicesFlag('calender'); throw new Error('should have thrown'); } catch (e) {
      expect(e).toBeInstanceOf(AppleAddFlagError);
      expect((e as AppleAddFlagError).code).toBe('unknown_service');
    }
    try { buildAppleAddOptions({ services: '', dir: '/x' }); throw new Error('should have thrown'); } catch (e) {
      expect((e as AppleAddFlagError).code).toBe('empty_services');
    }
  });

  test('a non-darwin host gets a warning, not a refusal', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const r = await cli(() => runAddApple(engine, ['apple-linux', '--kind', 'apple', '--dir', join(home, 'l')]));
      expect(r.exit).toBeNull();
      expect(r.err).toContain('only syncs on a Mac');
      expect(await row('apple-linux')).toBeDefined();
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  test('runSources add --kind apple dispatches here', async () => {
    const r = await cli(() => runSources(engine, ['add', 'apple-via', '--kind', 'apple', '--dir', join(home, 'via'), '--services', 'contacts']));
    expect(r.exit).toBeNull();
    expect((await row('apple-via'))!.config.a_services).toBe('contacts');
  });
});

describe('sources add --kind apple (connected parser)', () => {
  const parse = (...args: string[]) => parseSourceLifecycleArgs(['add', 'apple-x', '--kind', 'apple', ...args], randomUUID());

  test('builds typed apple options with the same defaults and validation', () => {
    const parsed = parse('--services', 'mail', '--confirm-mail', '--dir', join(home, 'p'), '--mail-days', '5');
    const opts = (parsed.params as { options: { apple: Record<string, unknown> } }).options.apple;
    expect(opts).toMatchObject({ services: ['mail'], mailDays: 5 });
    expect(opts.dir).toBe(join(home, 'p'));
  });

  test('refuses unknown services, google-only flags and bare apple-only flags with coded errors', () => {
    expect(() => parse('--services', 'calender')).toThrow(/Unknown Apple service/);
    expect(() => parse('--access', 'env')).toThrow(/requires --kind google/);
    expect(() => parse('--token-env', 'X')).toThrow(/does not apply to --kind apple/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--mail-days', '5'], randomUUID())).toThrow(/requires --kind apple/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--mail-days', '5'], randomUUID())).toThrow(/requires --kind/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'dropbox'], randomUUID())).toThrow(/github, google or apple/);
  });
});

describe('sources set-services', () => {
  async function seed(services = 'calendar,contacts,mail') {
    await cli(() => runAddApple(engine, ['apple-s', '--kind', 'apple', '--dir', join(home, 's'), '--services', services, '--confirm-mail']));
  }
  const managedProxy = () => new Proxy(engine, { get(target, prop, recv) {
    if (prop !== 'executeRaw') return Reflect.get(target, prop, recv);
    return (sql: string, ...rest: unknown[]) => sql.includes('FROM persistence_brain') ? Promise.resolve([{ enabled: true }])
      : (target.executeRaw as (...a: unknown[]) => Promise<unknown>).call(target, sql, ...rest);
  } }) as PGLiteEngine;

  test('--remove drops a service and keeps the others; --add restores it; pages are untouched', async () => {
    await seed();
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth) VALUES ('emails/2026/10/x', 'apple-s', 'email', 'x', 'body')`);
    const removed = await cli(() => runSources(engine, ['set-services', 'apple-s', '--remove', 'mail']));
    expect(removed.exit).toBeNull();
    expect(removed.out).toContain('calendar, contacts');
    expect(removed.out).toContain('stay');
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts');
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id='apple-s'`))[0]!.n).toBe(1);
    await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail', '--confirm-mail']));
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts,mail');
  });

  test('refuses removing the last service, an unknown service, a non-apple source, a missing source and ambiguous flags', async () => {
    await seed('mail');
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s', '--remove', 'mail']))).exit).toBe(2);
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'notes']))).exit).toBe(2);
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s']))).exit).toBe(2);
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail', '--remove', 'mail']))).exit).toBe(2);
    expect((await cli(() => runSources(engine, ['set-services', 'default', '--add', 'mail', '--confirm-mail']))).exit).toBe(2);
    expect((await cli(() => runSources(engine, ['set-services', 'nope', '--add', 'mail', '--confirm-mail']))).exit).toBe(4);
    expect((await row('apple-s'))!.config.a_services).toBe('mail');
  });

  test('already-set service is a no-op message', async () => {
    await seed();
    const r = await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail']));
    expect(r.exit).toBeNull();
    expect(r.out).toContain('already syncs mail');
  });

  test('managed brain: a cursor-identity change asks first (exit 3), then writes with --yes', async () => {
    await seed();
    const managed = managedProxy();
    const asked = await cli(() => runSources(managed, ['set-services', 'apple-s', '--remove', 'mail']));
    expect(asked.exit).toBe(3);
    expect(asked.err).toContain('fresh cursor');
    expect(asked.err).toContain('--yes');
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts,mail');
    const yes = await cli(() => runSources(managed, ['set-services', 'apple-s', '--remove', 'mail', '--yes']));
    expect(yes.exit).toBeNull();
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts');
  });
});

describe('connector identity for apple', () => {
  const base = { kind: 'apple', a_account: 'alice-example', a_services: 'calendar,contacts,mail' };
  const id = (raw: Record<string, unknown>) => connectorIdentity('apple', { ...base, ...raw }, '/brain/apple').digest;

  test('every parser leaf is classified', () => {
    const parsed = parseAppleSourceConfig({ ...base, a_calendar_ids: 'a,b', a_contacts_dir: 'contacts', a_dir: '/brain/apple' }, '/brain');
    for (const leaf of Object.keys(connectorConfigLeaves(parsed))) {
      expect(classifyConnectorLeaf('apple', parsed, leaf), `apple:${leaf}`).toMatch(/^(identity|excluded)$/);
      expect(Object.hasOwn(CONNECTOR_LEAF_RULES.apple, leaf), `apple:${leaf} has a rule`).toBe(true);
    }
  });

  test('apple is a connector kind', () => { expect(isConnectorSourceKind('apple')).toBe(true); });

  test('services, calendar ids and mailboxes are order- and duplicate-independent sets', () => {
    expect(id({ a_services: 'mail,calendar,contacts' })).toBe(id({}));
    expect(id({ a_services: 'mail,calendar,contacts,mail' })).toBe(id({}));
    expect(id({ a_calendar_ids: 'b,a,a' })).toBe(id({ a_calendar_ids: 'a,b' }));
    expect(id({ a_mail_mailboxes: 'Sent,INBOX' })).toBe(id({ a_mail_mailboxes: 'INBOX,Sent,INBOX' }));
    const leaves = connectorIdentityLeaves('apple', parseAppleSourceConfig({ ...base, a_calendar_ids: 'b,a', a_mail_mailboxes: 'Sent,INBOX' }, '/x'));
    expect(leaves.calendarIds).toEqual(['a', 'b']);
    expect(leaves.mailMailboxes).toEqual(['INBOX', 'Sent']);
  });

  test('stable across bookkeeping stamps; content changes isolate', () => {
    expect(id({ last_source_cycle_at: '2026-10-16T00:00:00Z' })).toBe(id({}));
    for (const change of [{ a_services: 'calendar' }, { a_account: 'other' }, { a_history_days: 30 }, { a_future_days: 7 }, { a_mail_days: 5 },
      { a_calendar_ids: 'a' }, { a_mail_mailboxes: 'INBOX' }, { a_dir: '/elsewhere' }, { a_contacts_dir: 'contacts' }]) {
      expect(id(change), JSON.stringify(change)).not.toBe(id({}));
    }
  });

  test('account pin compares and describes the label', () => {
    expect(sameConnectorAccount({ kind: 'apple', account: 'a' }, { kind: 'apple', account: 'a' })).toBe(true);
    expect(sameConnectorAccount({ kind: 'apple', account: 'a' }, { kind: 'apple', account: 'b' })).toBe(false);
    expect(sameConnectorAccount({ kind: 'apple', account: 'a' }, { kind: 'google', email: 'a' })).toBe(false);
    expect(describeConnectorAccount({ kind: 'apple', account: 'a' })).toContain('a');
  });
});

describe('sync dispatch reaches runAppleSync', () => {
  const readers: AppleReaders = {
    async calendar() { return []; },
    async contacts() {
      return [{ id: 'c-1', givenName: 'Alice', familyName: 'Example', emails: ['alice@example.com'], phones: [], groups: [] }];
    },
    async mail() { return []; },
    async probe() { return { ok: true as const }; },
  };

  test('performSync --source <apple id> runs the apple sweep (injected via the readers module seam)', async () => {
    const dir = join(home, 'sync');
    await cli(() => runAddApple(engine, ['apple-sync', '--kind', 'apple', '--dir', dir, '--services', 'contacts']));
    const mod = await import('../src/core/apple/readers/index.ts');
    const spy = spyOn(mod, 'createAppleReaders').mockReturnValue(readers);
    try {
      const result = await withEnv({ GBRAIN_HOME: home }, () => performSync(engine, { sourceId: 'apple-sync', noEmbed: true, noExtract: true, noSchemaPack: true }));
      expect(spy).toHaveBeenCalled();
      expect(result.added).toBe(1);
      const pages = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id='apple-sync'`);
      expect(pages.map((p) => p.slug)).toEqual(['people/alice-example']);
      const second = await withEnv({ GBRAIN_HOME: home }, () => performSync(engine, { sourceId: 'apple-sync', noEmbed: true, noExtract: true, noSchemaPack: true }));
      expect(second.added + second.modified + second.deleted).toBe(0);
    } finally { spy.mockRestore(); }
  });

  test('a disabled service is not read by the dispatched sync', async () => {
    const dir = join(home, 'sync2');
    await cli(() => runAddApple(engine, ['apple-sync2', '--kind', 'apple', '--dir', dir, '--services', 'calendar']));
    let contactsReads = 0;
    const counting: AppleReaders = { ...readers, async contacts() { contactsReads++; return readers.contacts({}); } };
    const mod = await import('../src/core/apple/readers/index.ts');
    const spy = spyOn(mod, 'createAppleReaders').mockReturnValue(counting);
    try {
      await withEnv({ GBRAIN_HOME: home }, () => performSync(engine, { sourceId: 'apple-sync2', noEmbed: true, noExtract: true, noSchemaPack: true }));
      expect(contactsReads).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

describe('Mail consent on sources add / set-services (#7)', () => {
  const parse = (...args: string[]) => parseSourceLifecycleArgs(['add', 'apple-x', '--kind', 'apple', ...args], randomUUID());
  const optsOf = (p: ReturnType<typeof parse>) => (p.params as { options: { apple: { services: string[] } } }).options.apple;

  test('the default services of `sources add --kind apple` exclude Mail (managed parser and flag builder)', () => {
    expect(optsOf(parse('--dir', join(home, 'd'))).services).toEqual(['calendar', 'contacts']);
    expect(buildAppleAddOptions({ dir: join(home, 'd') }).services).toEqual(['calendar', 'contacts']);
  });

  test('mail in --services without --confirm-mail is a coded mail_confirmation_required error and nothing is registered', async () => {
    expect(() => parse('--services', 'calendar,mail', '--dir', join(home, 'm'))).toThrow(/explicit confirmation/);
    let code = '';
    try { buildAppleAddOptions({ services: 'mail', dir: join(home, 'm') }); } catch (e) { code = (e as AppleAddFlagError).code; }
    expect(code).toBe('mail_confirmation_required');
    const r = await cli(() => runAddApple(engine, ['apple-m', '--kind', 'apple', '--dir', join(home, 'm'), '--services', 'calendar,mail']));
    expect(r.exit).toBe(2);
    expect(r.err).toContain('mail_confirmation_required');
    expect(r.err).toContain('--confirm-mail');
    expect(await row('apple-m')).toBeFalsy();
  });

  test('--confirm-mail alone (no explicit mail in --services) does not add Mail; with both it does', async () => {
    expect(optsOf(parse('--confirm-mail', '--dir', join(home, 'c'))).services).toEqual(['calendar', 'contacts']);
    expect(optsOf(parse('--services', 'contacts,mail', '--confirm-mail', '--dir', join(home, 'c'))).services).toEqual(['contacts', 'mail']);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--confirm-mail'], randomUUID())).toThrow(/requires --kind apple/);
  });

  test('set-services --add mail needs --confirm-mail; --yes alone is not consent for Mail; removing and adding other services are unaffected', async () => {
    await cli(() => runAddApple(engine, ['apple-s', '--kind', 'apple', '--dir', join(home, 's')]));
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts');
    const refused = await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail']));
    expect(refused.exit).toBe(2);
    expect(refused.err).toContain('mail_confirmation_required');
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail', '--yes']))).exit).toBe(2);
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts');
    const ok = await cli(() => runSources(engine, ['set-services', 'apple-s', '--add', 'mail', '--confirm-mail']));
    expect(ok.exit).toBeNull();
    expect((await row('apple-s'))!.config.a_services).toBe('calendar,contacts,mail');
    expect((await cli(() => runSources(engine, ['set-services', 'apple-s', '--remove', 'calendar']))).exit).toBeNull();
  });

  test('apple setup builds its add options without tripping the consent gate (setup has its own gate before any probe)', () => {
    expect(buildAppleAddOptions({ services: 'calendar,contacts,mail', confirmMail: true, dir: join(home, 'x') }).services).toEqual(['calendar', 'contacts', 'mail']);
  });
});

describe('mail_max config', () => {
  test('a_mail_max defaults to 500, is capped at 5000, and is not part of the checkpoint identity', () => {
    expect(parseAppleSourceConfig({ kind: 'apple' }, '/d').mailMax).toBe(500);
    expect(parseAppleSourceConfig({ kind: 'apple', a_mail_max: 40 }, '/d').mailMax).toBe(40);
    expect(parseAppleSourceConfig({ kind: 'apple', a_mail_max: 999999 }, '/d').mailMax).toBe(5000);
    const base = { kind: 'apple', a_account: 'alice-example', a_services: 'calendar' };
    const id = (raw: Record<string, unknown>) => connectorIdentity('apple', { ...base, ...raw }, '/brain/apple').digest;
    expect(id({ a_mail_max: 10 })).toBe(id({}));
  });
});
