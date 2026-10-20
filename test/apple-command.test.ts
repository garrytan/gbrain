/**
 * `gbrain apple` (#6855): envelope shape, exit codes (0 done / 1 failed /
 * 2 waiting), the Mail confirmation gate, permission guidance and idempotent
 * registration. In-process runs inject readers, platform, engine and sync, so
 * no macOS permission or helper is ever touched; the spawned cases only use
 * paths that never reach a probe. Placeholders only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { deriveAppleSourceId, runApple, type AppleCommandDeps } from '../src/commands/apple.ts';
import type { AppleReaders, AppleService } from '../src/core/apple/types.ts';
import { buildMailRouting } from '../src/core/apple/mail-routing.ts';
import type { AppleReaderErrorCode } from '../src/core/apple/readers/errors.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); home = mkdtempSync(join(tmpdir(), 'apple-cmd-')); });

type Probe = { ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string };
function readersWith(probes: Partial<Record<AppleService, Probe>> = {}, log: AppleService[] = []): AppleReaders {
  return {
    async calendar() { throw new Error('command must not read Apple data'); },
    async contacts() { throw new Error('command must not read Apple data'); },
    async mail() { throw new Error('command must not read Apple data'); },
    async probe(service) { log.push(service); return probes[service] ?? { ok: true as const }; },
  };
}
async function run(args: string[], deps: AppleCommandDeps = {}): Promise<{ code: number; out: string; json: any }> {
  let out = '';
  const code = await runApple(args, { platform: 'darwin', engine, write: (t) => { out += t; }, ...deps });
  let json: any;
  try { json = JSON.parse(out); } catch { /* human output */ }
  return { code, out, json };
}
const okSync = async () => ({ status: 'first_sync', added: 3, modified: 0, deleted: 0 });

describe('help and parsing', () => {
  test('--help exits 0 and names every subcommand and the exit codes', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const word of ['setup', 'status', 'services', '--confirm-mail', '--no-sync', 'Exit codes']) expect(r.out).toContain(word);
  });
  test('unknown subcommand is exit 2; a flag parse error is exit 1 (failed, not waiting on the user)', async () => {
    const a = await run(['bogus', '--json']);
    expect(a.code).toBe(2);
    expect(a.json).toMatchObject({ ok: false, status: 'error', error: { code: 'unknown_subcommand' } });
    const b = await run(['setup', '--wat', '--json']);
    expect(b.code).toBe(1);
    expect(b.json.error.code).toBe('invalid_value');
  });
});

describe('setup', () => {
  test('non-darwin: coded unsupported_platform, exit 1, nothing probed or registered', async () => {
    const probed: AppleService[] = [];
    const r = await run(['setup', '--json', '--yes'], { platform: 'linux', readers: readersWith({}, probed) });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, status: 'error', error: { code: 'unsupported_platform' } });
    expect(Object.keys(r.json.error).sort()).toEqual(['cause', 'code', 'doc_url', 'fix', 'problem']);
    expect(probed).toEqual([]);
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
  });

  test('Mail needs explicit confirmation before any probe: awaiting_confirmation, exit 2, next_action.command carries --confirm-mail', async () => {
    const probed: AppleService[] = [];
    const r = await run(['setup', '--json'], { readers: readersWith({}, probed) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, status: 'awaiting_confirmation' });
    expect(r.json.next_action.command).toContain('--confirm-mail');
    expect(r.json.next_action.user_message).toContain('most sensitive');
    expect(probed).toEqual([]);
    const human = await run(['setup'], { readers: readersWith() });
    expect(human.code).toBe(2);
    expect(human.out).toContain('[SHOW USER]');
    expect(human.out).toContain('[/SHOW USER]');
  });

  test('--services without mail needs no confirmation', async () => {
    const r = await run(['setup', '--json', '--services', 'calendar,contacts', '--no-sync'], { readers: readersWith() });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, status: 'ok', registered: true, services: ['calendar', 'contacts'] });
  });

  test('an existing broader source is not synced by narrower setup consent', async () => {
    const initial = await run(['setup', '--json', '--services', 'calendar,contacts', '--no-sync'], { readers: readersWith() });
    expect(initial.code).toBe(0);
    const probed: AppleService[] = [];
    let synced = false;
    const r = await run(['setup', '--json', '--services', 'contacts'], {
      readers: readersWith({}, probed), sync: (async () => { synced = true; return okSync(); }) as never,
    });
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('service_scope_mismatch');
    expect(probed).toEqual([]);
    expect(synced).toBe(false);
  });

  test('--yes and --confirm-mail both confirm; unknown service is a coded error, never widened', async () => {
    for (const flag of ['--yes', '--confirm-mail']) {
      await resetPgliteState(engine);
      const r = await run(['setup', '--json', flag, '--no-sync'], { readers: readersWith() });
      expect(r.code).toBe(0);
      expect(r.json.services).toEqual(['calendar', 'contacts', 'mail']);
    }
    await resetPgliteState(engine);
    const bad = await run(['setup', '--json', '--services', 'calender'], { readers: readersWith() });
    expect(bad.code).toBe(1);
    expect(bad.json.error.code).toBe('unknown_service');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
  });

  test('Google-only Mail probe waits for gbrain google setup before registration or sync; the relay explains the exclusion', async () => {
    const google = buildMailRouting([{ id: 'google-account-example', serverName: 'imap.gmail.com', accountType: 'imap', enabled: true }]);
    let synced = false;
    const rd: AppleReaders = {
      async calendar() { throw new Error('setup never reads Calendar data'); },
      async contacts() { throw new Error('setup never reads Contacts data'); },
      async mail() { throw new Error('setup never reads Mail data'); },
      async probe(service) { return service === 'mail' ? { ok: true as const, routing: google } : { ok: true as const }; },
    };
    const r = await run(['setup', '--json', '--yes'], { readers: rd, sync: (async () => { synced = true; return okSync(); }) as never });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, status: 'awaiting_google_setup', mail_routing: { status: 'google_only', google_accounts_excluded: 1 } });
    expect(r.json.next_action.command).toBe('gbrain google setup');
    expect(r.json.next_action.user_message).toContain('never through Apple Mail');
    expect(synced).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).toHaveLength(0);
  });

  test('Apple status points a Google-only Mail account to gbrain google setup, without exposing the Mail account id', async () => {
    const google = buildMailRouting([{ id: 'google-account-example', serverName: 'imap.gmail.com', accountType: 'imap', enabled: true }]);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)`,
      ['apple-status-example', home, JSON.stringify({ kind: 'apple', a_services: 'mail', a_account: 'status-example' })]);
    const rd: AppleReaders = {
      async calendar() { throw new Error('status never reads Calendar data'); }, async contacts() { throw new Error('status never reads Contacts data'); },
      async mail() { throw new Error('status never reads Mail data'); },
      async probe(service) { return service === 'mail' ? { ok: true as const, routing: google } : { ok: true as const }; },
    };
    const r = await run(['status', '--json', '--source', 'apple-status-example'], { readers: rd });
    expect(r.code).toBe(0);
    expect(r.json.next_action.command).toBe('gbrain google setup');
    expect(r.json.sources[0].services.mail.routing.status).toBe('google_only');
    expect(JSON.stringify(r.json)).not.toContain('google-account-example');
  });

  test('an unknown Mail provider stops setup explicitly before registration/sync; Calendar and Contacts may still sync in ordinary syncs', async () => {
    const rd: AppleReaders = {
      async calendar() { throw new Error('setup never reads Calendar data'); },
      async contacts() { throw new Error('setup never reads Contacts data'); },
      async mail() { throw new Error('setup never reads Mail data'); },
      async probe(service) { return service === 'mail' ? { ok: false as const, code: 'mail_routing_unknown', fix: 'Disable the account or opt Mail out.' } : { ok: true as const }; },
    };
    let synced = false;
    const r = await run(['setup', '--json', '--yes'], { readers: rd, sync: (async () => { synced = true; return okSync(); }) as never });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('mail_routing_unknown');
    expect(r.json.error.cause).toContain('stopped before registering or syncing');
    expect(r.json.error.fix).toContain('Disable the account');
    expect(synced).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).toHaveLength(0);
  });

  test('mixed Mail setup surfaces the Google exclusion without placing account ids/hosts in its public routing summary', async () => {
    const mixed = buildMailRouting([
      { id: 'apple-account-example', serverName: 'imap.example.com', accountType: 'imap', enabled: true },
      { id: 'google-account-example', serverName: 'imap.gmail.com', accountType: 'imap', enabled: true },
    ]);
    const rd: AppleReaders = {
      async calendar() { throw new Error('setup never reads Calendar data'); }, async contacts() { throw new Error('setup never reads Contacts data'); },
      async mail() { throw new Error('setup never reads Mail data'); },
      async probe(service) { return service === 'mail' ? { ok: true as const, routing: mixed } : { ok: true as const }; },
    };
    const r = await run(['setup', '--json', '--yes', '--no-sync'], { readers: rd });
    expect(r.code).toBe(0);
    expect(r.json.mail_routing).toMatchObject({ status: 'mixed', apple_accounts: 1, google_accounts_excluded: 1 });
    expect(JSON.stringify(r.json.mail_routing)).not.toContain('google-account-example');
    expect(r.out).not.toContain('imap.gmail.com');
    expect(r.json.next_action.user_message).toContain('gbrain google setup');
  });

  test('a denied service prints a [SHOW USER] block with the exact pane and app, status awaiting_permission, exit 2, nothing registered', async () => {
    const denied: Partial<Record<AppleService, Probe>> = {
      calendar: { ok: false, code: 'permission_denied', fix: 'Open System Settings > Privacy & Security > Calendars and enable the app.' },
      mail: { ok: false, code: 'automation_denied', fix: 'Open System Settings > Privacy & Security > Automation and enable Mail.' },
    };
    const r = await run(['setup', '--json', '--yes'], { readers: readersWith(denied) });
    expect(r.code).toBe(2);
    expect(r.json.status).toBe('awaiting_permission');
    expect(r.json.denied.map((d: any) => d.service)).toEqual(['calendar', 'mail']);
    expect(r.json.denied[0].pane).toContain('Privacy & Security > Calendars');
    expect(r.json.denied[1].pane).toContain('Automation');
    expect(r.json.next_action.command).toContain('gbrain apple setup');
    expect(r.json.next_action.user_message).toContain('Terminal');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
    const human = await run(['setup', '--yes'], { readers: readersWith(denied) });
    expect(human.code).toBe(2);
    expect(human.out).toContain('[SHOW USER]');
    expect(human.out).toContain('Privacy & Security > Calendars');
    expect(human.out).toContain('[/SHOW USER]');
  });

  test('a broken helper (not a permission) is a coded probe_failed, exit 1', async () => {
    const r = await run(['setup', '--json', '--services', 'contacts'], { readers: readersWith({ contacts: { ok: false, code: 'helper_failed', fix: 'Install the Command Line Tools.' } }) });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('probe_failed');
  });

  test('all probes pass: registers once, runs the budgeted first sync, and a re-run is idempotent', async () => {
    const synced: string[] = [];
    const sync = async (_e: unknown, o: { sourceId: string; signal: AbortSignal }) => { synced.push(o.sourceId); expect(o.signal.aborted).toBe(false); return okSync(); };
    const first = await run(['setup', '--json', '--yes', '--account', 'alice-example'], { readers: readersWith(), sync: sync as never });
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({ ok: true, status: 'ok', source_id: 'apple-alice-example', registered: true, sync: { status: 'first_sync', added: 3 } });
    const second = await run(['setup', '--json', '--yes', '--account', 'alice-example'], { readers: readersWith(), sync: sync as never });
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ registered: false, already_registered: true, source_id: 'apple-alice-example' });
    expect(synced).toEqual(['apple-alice-example', 'apple-alice-example']);
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(1);
  });

  test('--no-sync registers without syncing; a sync failure is a coded error but the source stays registered', async () => {
    const never = async () => { throw new Error('must not sync'); };
    const a = await run(['setup', '--json', '--yes', '--no-sync'], { readers: readersWith(), sync: never as never });
    expect(a.json.sync).toBeUndefined();
    expect(a.json.next_action.command).toBe('gbrain sync --source apple-local');
    const b = await run(['setup', '--json', '--yes'], { readers: readersWith(), sync: (async () => { throw new Error('boom'); }) as never });
    expect(b.code).toBe(1);
    expect(b.json.error.code).toBe('sync_failed');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['apple-local'])).length).toBe(1);
  });

  test('a source id used by a non-apple source is refused, not overwritten', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('apple-local', 'x', '/tmp/x', '{}'::jsonb)`);
    const r = await run(['setup', '--json', '--yes', '--no-sync'], { readers: readersWith() });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('source_id_taken');
  });

  test('the command only probes: reader data methods are never called', async () => {
    const r = await run(['setup', '--json', '--yes'], { readers: readersWith(), sync: okSync as never });
    expect(r.code).toBe(0);
  });

  test('deriveAppleSourceId yields valid ids', () => {
    expect(deriveAppleSourceId('local')).toBe('apple-local');
    expect(deriveAppleSourceId('Work Laptop!')).toBe('apple-work-laptop');
    expect(deriveAppleSourceId('x'.repeat(80)).length).toBeLessThanOrEqual(32);
  });
});

describe('status and services', () => {
  async function register(services?: string) {
    await run(['setup', '--json', '--yes', '--no-sync', ...(services ? ['--services', services] : [])], { readers: readersWith() });
  }

  test('no source: not_configured, exit 1', async () => {
    const r = await run(['status', '--json']);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, status: 'not_configured', next_action: { command: 'gbrain apple setup' } });
  });

  test('live probes: all readable -> exit 0; an enabled unreadable service -> ok:false, exit 1 with the fix; a disabled one is not probed', async () => {
    await register('calendar,contacts');
    const probed: AppleService[] = [];
    const good = await run(['status', '--json'], { readers: readersWith({}, probed) });
    expect(good.code).toBe(0);
    expect(good.json.ok).toBe(true);
    expect(good.json.sources[0].services.mail).toEqual({ enabled: false });
    expect(probed.sort()).toEqual(['calendar', 'contacts']);
    const bad = await run(['status', '--json'], { readers: readersWith({ contacts: { ok: false, code: 'permission_denied', fix: 'grant it' } }) });
    expect(bad.code).toBe(1);
    expect(bad.json).toMatchObject({ ok: false, status: 'degraded' });
    expect(bad.json.sources[0].services.contacts).toMatchObject({ ok: false, code: 'permission_denied', fix: 'grant it' });
    expect(bad.json.sources[0].services.contacts.pane).toContain('Contacts');
  });

  test('--no-probe runs no helper and reports the last recorded probe', async () => {
    await register('contacts');
    const [src] = await engine.executeRaw<{ local_path: string }>("SELECT local_path FROM sources WHERE id='apple-local'");
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(src!.local_path, { recursive: true });
    writeFileSync(join(src!.local_path, '.apple-source.json'), JSON.stringify({ version: 1, calendar: { hashes: {} }, contacts: { hashes: {} }, mail: { hashes: {} },
      last_probe: { contacts: { ok: false, at: '2026-10-16T00:00:00Z', code: 'permission_denied' } } }));
    const probed: AppleService[] = [];
    const r = await run(['status', '--json', '--no-probe'], { readers: readersWith({}, probed) });
    expect(probed).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.json.sources[0].services.contacts).toMatchObject({ ok: false, live: false, code: 'permission_denied' });
    expect(r.json.sources[0]).toMatchObject({ held_items: 0, last_sync_at: null });
  });

  test('services lists enabled and disabled; names unknown, non-apple and ambiguous sources as coded errors', async () => {
    await register('calendar,mail');
    const r = await run(['services', 'apple-local', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.services).toEqual([{ service: 'calendar', enabled: true }, { service: 'contacts', enabled: false }, { service: 'mail', enabled: true }]);
    expect((await run(['services', 'nope', '--json'])).json.error.code).toBe('source_not_found');
    expect((await run(['services', 'default', '--json'])).json.error.code).toBe('not_apple_source');
    await run(['setup', '--json', '--yes', '--no-sync', '--account', 'second', '--services', 'contacts'], { readers: readersWith() });
    const ambiguous = await run(['services', '--json']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json.error.code).toBe('ambiguous_source');
  });
});

describe('spawned CLI', () => {
  test('apple --help and an unconfigured status --json: envelope and exit codes through the real entrypoint', async () => {
    const help = await runCli(['apple', '--help'], { home });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('gbrain apple');
    const status = await runCli(['apple', 'status', '--json'], { home });
    expect(status.exitCode).toBe(1);
    const envelope = JSON.parse(status.stdout);
    expect(envelope).toMatchObject({ ok: false, status: 'not_configured', next_action: { command: 'gbrain apple setup' } });
  });

  test('apple setup --json never reaches a probe without consent: Mail gate on macOS, unsupported_platform elsewhere', async () => {
    const r = await runCli(['apple', 'setup', '--json'], { home });
    const envelope = JSON.parse(r.stdout);
    if (process.platform === 'darwin') {
      expect(r.exitCode).toBe(2);
      expect(envelope.status).toBe('awaiting_confirmation');
    } else {
      expect(r.exitCode).toBe(1);
      expect(envelope.error.code).toBe('unsupported_platform');
    }
  });

  test('unknown subcommand through the entrypoint exits 2 with a coded envelope', async () => {
    const r = await runCli(['apple', 'wat', '--json'], { home });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('unknown_subcommand');
  });
});

describe('setup: permission_not_determined (a fresh Mac)', () => {
  // A reader whose service reports "not asked yet" until requestAccess runs, then is granted.
  function freshMac(opts: { grant?: boolean } = {}) {
    const calls: string[] = [];
    const asked = new Set<AppleService>();
    const readers: AppleReaders = {
      async calendar() { throw new Error('no read'); }, async contacts() { throw new Error('no read'); }, async mail() { throw new Error('no read'); },
      async probe(service) {
        calls.push(`probe:${service}`);
        if (asked.has(service) && opts.grant !== false) return { ok: true as const };
        if (asked.has(service)) return { ok: false as const, code: 'permission_denied' as const, fix: 'denied after prompt' };
        return { ok: false as const, code: 'permission_not_determined' as const, fix: 'macOS has not asked yet' };
      },
      async requestAccess(service) { calls.push(`request:${service}`); asked.add(service); return { ok: true as const }; },
    };
    return { readers, calls };
  }

  test('interactive: not_determined -> requestAccess -> re-probe -> granted, then registers and syncs', async () => {
    const { readers, calls } = freshMac();
    const r = await run(['setup', '--json', '--services', 'calendar,contacts'], { readers, interactive: true, sync: okSync as never });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, status: 'ok', registered: true });
    expect(calls).toEqual(['probe:calendar', 'request:calendar', 'probe:calendar', 'probe:contacts', 'request:contacts', 'probe:contacts']);
  });

  test('--yes also requests access without a terminal', async () => {
    const { readers, calls } = freshMac();
    const r = await run(['setup', '--json', '--yes', '--services', 'calendar'], { readers, interactive: false, sync: okSync as never });
    expect(r.code).toBe(0);
    expect(calls).toContain('request:calendar');
  });

  test('non-interactive without --yes: never requests; prints a [SHOW USER] saying a prompt will appear on the Mac, exit 2, nothing registered', async () => {
    const { readers, calls } = freshMac();
    const r = await run(['setup', '--services', 'calendar,contacts'], { readers, interactive: false });
    expect(r.code).toBe(2);
    expect(calls.some((c) => c.startsWith('request:'))).toBe(false);
    expect(r.out).toContain('[SHOW USER]');
    expect(r.out).toContain("prompt will appear on this Mac's screen");
    expect(r.out).not.toContain('permission_denied');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
    const j = await run(['setup', '--json', '--services', 'calendar'], { readers: freshMac().readers, interactive: false });
    expect(j.json).toMatchObject({ status: 'awaiting_permission' });
    expect(j.json.denied[0]).toMatchObject({ service: 'calendar', code: 'permission_not_determined' });
  });

  test('interactive but the user clicks Deny: the re-probe says permission_denied and setup waits with the pane', async () => {
    const { readers } = freshMac({ grant: false });
    const r = await run(['setup', '--json', '--services', 'contacts'], { readers, interactive: true });
    expect(r.code).toBe(2);
    expect(r.json.denied[0]).toMatchObject({ service: 'contacts', code: 'permission_denied' });
    expect(r.json.denied[0].pane).toContain('Contacts');
  });

  test('a reader without requestAccess does not crash: it waits like the non-interactive case', async () => {
    const readers: AppleReaders = { ...readersWith({ calendar: { ok: false, code: 'permission_not_determined', fix: 'ask' } }) };
    const r = await run(['setup', '--json', '--services', 'calendar'], { readers, interactive: true });
    expect(r.code).toBe(2);
  });
});

describe('setup: duplicate source detection', () => {
  test('re-running with the default account (no --account) reuses the source registered with a_account "local"', async () => {
    // A source registered through `sources add` under a different id but the default account label.
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('my-mac', 'my-mac', $1, $2::text::jsonb)`,
      [join(home, 'x'), JSON.stringify({ kind: 'apple', a_account: 'local', a_services: 'calendar,contacts', a_dir: join(home, 'x') })]);
    const r = await run(['setup', '--json', '--services', 'calendar,contacts', '--no-sync'], { readers: readersWith() });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ registered: false, already_registered: true, source_id: 'my-mac' });
    expect((await engine.executeRaw('SELECT id FROM sources WHERE config->>\'kind\'=\'apple\'')).length).toBe(1);
  });
});

describe('setup text', () => {
  test('does not promise autopilot will keep it synced; says unattended runs cannot show prompts and to run sync once interactively', async () => {
    const r = await run(['setup', '--yes', '--services', 'calendar', '--no-sync'], { readers: readersWith() });
    expect(r.out).not.toContain('Autopilot keeps it synced');
    expect(r.out).toContain('cannot show macOS permission prompts');
    expect(r.out).toContain('gbrain sync --source apple-local');
  });
});


// Final review F2: prior coverage checked only services on one source. These synthetic command tests
// protect id precedence, ALL explicit privacy selectors, exact shell retry scope, and a scope-change race.
// Credible mutations: OR account selection, omit scope comparison/flags or omit final revalidation.
// No new production seam: injected probe and sync are the existing public command test interface.
describe('Apple final review F2 — setup scope binding', () => {
  async function source(id: string, extra: Record<string,unknown>={}) {
    const raw={kind:'apple',a_account:'local',a_services:'mail',a_mail_mailboxes:'INBOX,Sent',a_mail_days:30,...extra};
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)',[id,home,JSON.stringify(raw)]);
  }
  test('explicit --source wins over an earlier same-label source; omitted source with ambiguous account is refused', async()=>{
    await source('apple-a');await source('apple-z');let selected='';
    const r=await run(['setup','--json','--source','apple-z','--services','mail','--confirm-mail'],{readers:readersWith(),sync:async(_e,o)=>{selected=o.sourceId;return okSync();}});
    expect(r.code).toBe(0);expect(selected).toBe('apple-z');
    const ambiguous=await run(['setup','--json','--services','mail','--confirm-mail'],{readers:readersWith()});
    expect(ambiguous.code).toBe(2);expect(ambiguous.json.error.code).toBe('ambiguous_source');
  });
  for(const [flag,value] of [['--mail-mailboxes','INBOX'],['--mail-days','1'],['--calendar-ids','only-calendar'],['--history-days','1'],['--future-days','1'],['--contacts-dir','contacts'],['--mail-owner-addresses','owner@example.com']] as const) {
    test(`explicit ${flag} cannot silently sync a different existing scope, before confirmation or probes`,async()=>{
      await source('apple-existing',{a_services:'calendar,contacts,mail'});const probed:AppleService[]=[];let synced=false;
      const r=await run(['setup','--json','--source','apple-existing',flag,value],{readers:readersWith({},probed),sync:async()=>{synced=true;return okSync();}});
      expect(r.code).toBe(2);expect(r.json).toMatchObject({status:'error',error:{code:'source_scope_mismatch'}});expect(probed).toEqual([]);expect(synced).toBe(false);
    });
  }
  test('confirmation and permission-retry commands round-trip exact selectors, quoting and extraction flags',async()=>withEnv({GBRAIN_HOME:home},async()=>{
    const args=['setup','--json','--source','apple-scoped','--account',"local example's",'--services','mail','--mail-mailboxes',"INBOX,Owner's Archive",'--mail-days','1','--mail-owner-addresses','owner@example.com','--consent-loops-extraction','--sync-budget-ms','1234','--no-sync'];
    const gate=await run(args,{readers:readersWith()});expect(gate.json.status).toBe('awaiting_confirmation');
    const split=(command:string)=>{
      const p=Bun.spawnSync(['python3','-c','import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))',command]);
      expect(p.exitCode).toBe(0);return JSON.parse(p.stdout.toString()) as string[];
    };
    const command=gate.json.next_action.command as string;
    const retry=split(command);expect(retry.slice(0,2)).toEqual(['gbrain','apple']);
    const denied=await run(retry.slice(2),{readers:readersWith({mail:{ok:false,code:'automation_denied',fix:'fixture denial'}})});
    expect(denied.json.status).toBe('awaiting_permission');expect(split(denied.json.next_action.command)).toEqual(retry);
    const done=await run(retry.slice(2),{readers:readersWith()});expect(done.code).toBe(0);
    const [row]=await engine.executeRaw<{config:Record<string,unknown>}>('SELECT config FROM sources WHERE id=$1',['apple-scoped']);
    expect(row!.config.a_mail_mailboxes).toBe("INBOX,Owner's Archive");expect(row!.config.a_mail_days).toBe(1);
    expect(row!.config.a_mail_owner_addresses).toBe('owner@example.com');expect(row!.config.a_loops_extract_consent).toBe(true);
  }));
  test('source scope changed during probes refuses execution instead of syncing newly widened config',async()=>{
    await source('apple-changing');let synced=false;
    const r=readersWith();r.probe=async()=>{await engine.executeRaw("UPDATE sources SET config=config||'{\"a_mail_days\":365}'::jsonb WHERE id='apple-changing'");return {ok:true};};
    const result=await run(['setup','--json','--source','apple-changing','--services','mail','--confirm-mail'],{readers:r,sync:async()=>{synced=true;return okSync();}});
    expect(result.code).toBe(2);expect(result.json.error.code).toBe('source_scope_changed');expect(synced).toBe(false);
  });
});


test('F2 setup never ignores an explicit extraction-revocation request and proceeds to sync with consent still on',async()=>{
  const probed:AppleService[]=[];let synced=false;
  const result=await run(['setup','--json','--services','mail','--confirm-mail','--revoke-loops-extraction'],{readers:readersWith({},probed),sync:async()=>{synced=true;return okSync();}});
  expect(result.code).toBe(1);expect(result.json.error.code).toBe('invalid_value');expect(probed).toEqual([]);expect(synced).toBe(false);
});
