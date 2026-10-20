/**
 * apple-readers — hermetic tests for the Apple connector's reader layer.
 *
 * run-helper is exercised against a tiny fake helper (a node script in a temp
 * dir), so everything runs on any OS. The real Swift/JXA helpers are only
 * type/syntax-checked (darwin); they are NOT run here, so nothing in this file
 * verifies them against real Calendar/Contacts/Mail data. Placeholder data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

import { AppleReaderError, fixFor } from '../src/core/apple/readers/errors.ts';
import { runHelper, scrubEnv, MAX_STDERR_BYTES } from '../src/core/apple/readers/run-helper.ts';
import { createAppleReaders } from '../src/core/apple/readers/index.ts';
import { CALENDAR_SCRIPT, normalizeEvent } from '../src/core/apple/readers/calendar.ts';
import { CONTACTS_SCRIPT, normalizeContact } from '../src/core/apple/readers/contacts.ts';
import { MAIL_SCRIPT, MAIL_BODY_CAP, normalizeMessage } from '../src/core/apple/readers/mail.ts';
import { ROUTE_ARGV, singleAccountApp } from './helpers/apple-mail-vm.ts';

let dir = '';
let fake = '';

const FAKE = `
const mode = process.argv[2];
const out = (s) => process.stdout.write(s);
switch (mode) {
  case 'ok': out(JSON.stringify({ items: [{ id: 'alice-example-1' }] })); break;
  case 'ok-noitems': out(JSON.stringify({ other: 1 })); break;
  case 'error-json':
    out(JSON.stringify({ error: { code: 'permission_denied', message: 'no access for alice-example' } }));
    process.exit(1); break;
  case 'error-json-unknown-code':
    out(JSON.stringify({ error: { code: 'weird', message: 'boom' } }));
    process.exit(1); break;
  case 'error-json-exit0':
    out(JSON.stringify({ error: { code: 'automation_denied', message: 'no' } })); break;
  case 'crash': process.stderr.write('x'.repeat(5000)); process.exit(7); break;
  case 'malformed': out('{not json'); break;
  case 'garbage-exit1': out('hello'); process.exit(1); break;
  case 'hang': setInterval(() => {}, 1000); break;
  case 'flood': { const b = 'a'.repeat(65536); const t = setInterval(() => out(b), 0); break; }
  case 'env': out(JSON.stringify({ items: [Object.keys(process.env).sort()] })); break;
  case 'args': out(JSON.stringify({ items: [process.argv.slice(3)] })); break;
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-readers-'));
  fake = join(dir, 'fake-helper.js');
  writeFileSync(fake, FAKE);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(mode: string, extra: Partial<Parameters<typeof runHelper>[0]> = {}) {
  return runHelper({
    service: 'calendar',
    command: process.execPath,
    args: [fake, mode],
    platform: 'darwin',
    ...extra,
  });
}

async function fails(p: Promise<unknown>): Promise<AppleReaderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppleReaderError);
    return e as AppleReaderError;
  }
  throw new Error('expected rejection');
}

describe('runHelper', () => {
  test('success returns items', async () => {
    expect(await run('ok')).toEqual([{ id: 'alice-example-1' }]);
  });

  test('success without items array is malformed_output', async () => {
    expect((await fails(run('ok-noitems'))).code).toBe('malformed_output');
  });

  test('error JSON maps to code, message and an actionable fix', async () => {
    const e = await fails(run('error-json'));
    expect(e.code).toBe('permission_denied');
    expect(e.service).toBe('calendar');
    expect(e.message).toContain('no access for alice-example');
    expect(e.fix).toContain('Privacy & Security');
    expect(e.fix).toContain('Calendars');
  });

  test('unknown error code collapses to helper_failed', async () => {
    expect((await fails(run('error-json-unknown-code'))).code).toBe('helper_failed');
  });

  test('error document wins even with exit 0', async () => {
    expect((await fails(run('error-json-exit0'))).code).toBe('automation_denied');
  });

  test('non-zero exit without JSON is helper_failed with truncated stderr', async () => {
    const e = await fails(run('crash'));
    expect(e.code).toBe('helper_failed');
    expect(e.message).toContain('code 7');
    expect(e.message).toContain('[truncated]');
    expect(e.message.length).toBeLessThan(MAX_STDERR_BYTES + 300);
  });

  test('non-zero exit with non-JSON stdout is helper_failed', async () => {
    expect((await fails(run('garbage-exit1'))).code).toBe('helper_failed');
  });

  test('malformed JSON on exit 0 is malformed_output', async () => {
    expect((await fails(run('malformed'))).code).toBe('malformed_output');
  });

  test('timeout is helper_timeout', async () => {
    const t0 = Date.now();
    const e = await fails(run('hang', { timeoutMs: 300 }));
    expect(e.code).toBe('helper_timeout');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test('stdout over the cap is malformed_output and the child is killed', async () => {
    const e = await fails(run('flood', { maxStdoutBytes: 100_000, timeoutMs: 20_000 }));
    expect(e.code).toBe('malformed_output');
    expect(e.message).toContain('cap');
  });

  test('abort signal stops the helper', async () => {
    const ac = new AbortController();
    const p = run('hang', { signal: ac.signal, timeoutMs: 20_000 });
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const e = await fails(p);
    expect(e.code).toBe('helper_failed');
    expect(e.message).toContain('aborted');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test('already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await fails(run('ok', { signal: ac.signal }))).message).toContain('aborted');
  });

  test('environment is scrubbed to PATH/HOME/TMPDIR/LANG', async () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: '/tmp/alice-example-home',
      TMPDIR: dir,
      LANG: 'en_US.UTF-8',
      SECRET_TOKEN: 'should-not-leak',
      OPENAI_API_KEY: 'should-not-leak',
    };
    const [keys] = (await run('env', { env })) as string[][];
    expect(keys.filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k))).toEqual([]);
    expect(keys).not.toContain('SECRET_TOKEN');
    expect(keys).not.toContain('OPENAI_API_KEY');
    expect(scrubEnv(env)).toEqual({ PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG });
  });

  test('args are passed as an argv array, never through a shell', async () => {
    const evil = 'a b; touch /tmp/pwned-alice-example $(id)';
    const [argv] = (await run('args', { args: [fake, 'args', evil, '--x'] })) as string[][];
    expect(argv).toEqual([evil, '--x']);
  });

  test('missing executable is helper_failed', async () => {
    const e = await fails(run('ok', { command: join(dir, 'does-not-exist') }));
    expect(e.code).toBe('helper_failed');
  });

  test('non-darwin returns unsupported_platform before spawning', async () => {
    const e = await fails(run('ok', { platform: 'linux' }));
    expect(e.code).toBe('unsupported_platform');
    expect(e.fix).toContain('macOS');
  });
});

describe('fix strings', () => {
  test('name the pane and the app to grant, and do not claim verification', () => {
    expect(fixFor('permission_denied', 'contacts')).toContain('Privacy & Security > Contacts');
    expect(fixFor('permission_denied', 'calendar')).toContain('Privacy & Security > Calendars');
    const a = fixFor('automation_denied', 'mail');
    expect(a).toContain('Privacy & Security > Automation');
    expect(a).toContain('"Mail"');
    expect(fixFor('mail_not_running_or_unconfigured', 'mail')).toContain('Mail.app');
    for (const c of ['unsupported_platform', 'permission_denied', 'helper_failed', 'helper_timeout', 'malformed_output', 'automation_denied', 'mail_not_running_or_unconfigured'] as const) {
      expect(fixFor(c, 'calendar').length).toBeGreaterThan(20);
      expect(fixFor(c, 'calendar').toLowerCase()).not.toContain('verified');
    }
  });
});

describe('createAppleReaders with a fake helper', () => {
  const fakeOverrides = (mode: string) => ({ command: process.execPath, scriptArgs: [fake, mode], platform: 'darwin' as const });

  test('non-darwin: every reader rejects with unsupported_platform; probe reports it', async () => {
    const r = createAppleReaders({ platform: 'linux' });
    const now = new Date();
    expect((await fails(r.calendar({ from: now, to: now, calendarIds: [] }))).code).toBe('unsupported_platform');
    expect((await fails(r.contacts({}))).code).toBe('unsupported_platform');
    expect((await fails(r.mail({ since: now, mailboxes: ['INBOX'] }))).code).toBe('unsupported_platform');
    for (const s of ['calendar', 'contacts', 'mail'] as const) {
      const p = await r.probe(s);
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.code).toBe('unsupported_platform');
        expect(p.fix.length).toBeGreaterThan(10);
      }
    }
  });

  test('probe maps helper error to code + fix; ok maps to ok', async () => {
    const bad = await createAppleReaders(fakeOverrides('error-json')).probe('contacts');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('permission_denied');
      expect(bad.fix).toContain('Contacts');
    }
    // Mail's probe is the account-metadata read: a helper that returns no `accounts` cannot classify anything, so it is a failure, never a silent pass.
    const noAccounts = await createAppleReaders(fakeOverrides('ok')).probe('mail');
    expect(noAccounts.ok).toBe(false);
    if (!noAccounts.ok) expect(noAccounts.code).toBe('malformed_output');
    const accounts = join(dir, 'probe-accounts.js');
    writeFileSync(accounts, `process.stdout.write(JSON.stringify({items:[],accounts:[{id:'a1',server_name:'imap.example.com',account_type:'imap',enabled:true}]}))`);
    const okMail = await createAppleReaders({ command: process.execPath, scriptArgs: [accounts], platform: 'darwin' }).probe('mail');
    expect(okMail.ok).toBe(true);
    if (okMail.ok) expect(okMail.routing?.status).toBe('apple');
  });

  test('calendar/contacts/mail normalize helper items', async () => {
    const ev = normalizeEvent({
      id: 'e1', calendarId: 'c1', calendarTitle: 'Work', title: 'Sync alice-example', start: '2026-01-02T10:00:00Z',
      end: '2026-01-02T11:00:00Z', allDay: false, attendees: [{ name: 'Alice Example', email: 'alice-example@example.com' }, {}], recurring: true, junk: 1,
    });
    expect(ev.attendees).toEqual([{ name: 'Alice Example', email: 'alice-example@example.com' }]);
    expect(ev.recurring).toBe(true);
    expect(() => normalizeEvent({ id: 'x' })).toThrow(AppleReaderError);

    const c = normalizeContact({ id: 'p1', givenName: 'Alice', emails: ['alice-example@example.com', 5], phones: [], groups: ['acme-example'] });
    expect(c).toEqual({ id: 'p1', givenName: 'Alice', emails: ['alice-example@example.com'], phones: [], groups: ['acme-example'] });
    expect(() => normalizeContact({})).toThrow(AppleReaderError);

    const m = normalizeMessage({ id: 'm1', date: '2026-01-02T10:00:00Z', body: 'x'.repeat(MAIL_BODY_CAP + 50), to: ['alice-example@example.com'] });
    expect(m.body.length).toBe(MAIL_BODY_CAP);
    expect(m.threadId).toBe('m1');
    expect(m.cc).toEqual([]);
    expect(() => normalizeMessage({ id: 'm1' })).toThrow(AppleReaderError);
  });

  test('a reader with a malformed item reports malformed_output', async () => {
    const r = createAppleReaders(fakeOverrides('ok')); // items: [{id}] lacks start/end
    const e = await fails(r.calendar({ from: new Date(0), to: new Date(1000), calendarIds: [] }));
    expect(e.code).toBe('malformed_output');
  });
});

describe.skipIf(process.platform !== 'darwin')('helper scripts compile (darwin only; NOT run against real data)', () => {
  for (const [name, script] of [['calendar.swift', CALENDAR_SCRIPT], ['contacts.swift', CONTACTS_SCRIPT]] as const) {
    test(`swiftc -typecheck ${name}`, () => {
      const r = spawnSync('/usr/bin/swiftc', ['-typecheck', script], { encoding: 'utf8', timeout: 120_000 });
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return; // no Command Line Tools
      expect(r.stderr || '').not.toContain('error:');
      expect(r.status).toBe(0);
    }, 120_000);
  }

  test('mail.js compiles with osacompile (syntax only; Mail is not launched)', () => {
    const out = join(dir, 'mail.scpt');
    const r = spawnSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', out, MAIL_SCRIPT], { encoding: 'utf8', timeout: 60_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return;
    expect(r.stderr || '').toBe('');
    expect(r.status).toBe(0);
  });
});

// ── #2 embedded scripts, #1 not-determined, #9 old macOS, #4/#8 mail listing ───────────────────────────────

describe('embedded helper scripts (compiled-binary safe)', () => {
  test('the embedded text equals the bytes of scripts/apple/*, the single source of truth', async () => {
    const { CALENDAR_SWIFT_TEXT, CONTACTS_SWIFT_TEXT, MAIL_JS_TEXT } = await import('../src/core/apple/readers/embedded-scripts.ts');
    const { readFileSync } = await import('node:fs');
    expect(CALENDAR_SWIFT_TEXT).toBe(readFileSync(CALENDAR_SCRIPT, 'utf8'));
    expect(CONTACTS_SWIFT_TEXT).toBe(readFileSync(CONTACTS_SCRIPT, 'utf8'));
    expect(MAIL_JS_TEXT).toBe(readFileSync(MAIL_SCRIPT, 'utf8'));
    expect(CALENDAR_SWIFT_TEXT.length).toBeGreaterThan(1000);
  });

  test('a bundle inlines the scripts (no import.meta.url file path is needed at run time)', async () => {
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'src/core/apple/readers/embedded-scripts.ts')], target: 'bun' });
    expect(out.success).toBe(true);
    const text = await out.outputs[0]!.text();
    expect(text).toContain('requestFullAccessToEvents');
    expect(text).toContain('enumerateContacts');
    expect(text).toContain("Application('Mail')");
  });

  test('withHelperScript writes a private 0700 dir with a 0600 file, unique per run, and removes it afterwards (also on throw)', async () => {
    const { withHelperScript, HELPER_SCRIPT_TEXT } = await import('../src/core/apple/readers/embedded-scripts.ts');
    const { readFileSync, statSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const seen: string[] = [];
    await withHelperScript('mail.js', async (p) => {
      seen.push(p);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
      expect(readFileSync(p, 'utf8')).toBe(HELPER_SCRIPT_TEXT['mail.js']);
    });
    await withHelperScript('mail.js', async (p) => { seen.push(p); });
    await withHelperScript('contacts.swift', async () => { throw new Error('boom'); }).catch(() => {});
    expect(new Set(seen).size).toBe(2);
    for (const p of seen) expect(existsSync(dirname(p))).toBe(false);
  });

  test('a reader with no scriptArgs override runs the interpreter on a temp copy of the embedded script, then removes it', async () => {
    // A fake interpreter: prints its first argument (the script path it was handed) as the contact id.
    const interp = join(dir, 'fake-interp.sh');
    writeFileSync(interp, '#!/bin/sh\nprintf \'{"items":[{"id":"%s"}]}\' "$1"\n', { mode: 0o755 });
    const [c] = await createAppleReaders({ command: interp, platform: 'darwin' }).contacts({});
    const { existsSync } = await import('node:fs');
    expect(c!.id.endsWith('/contacts.swift')).toBe(true);
    expect(c!.id).not.toBe(CONTACTS_SCRIPT); // not the source-tree (or /$bunfs) path
    expect(existsSync(c!.id)).toBe(false); // removed after the run
  });
});

describe('permission_not_determined, selection_not_found, macos_too_old', () => {
  test('are codes with their own fix text, distinct from permission_denied', () => {
    const nd = fixFor('permission_not_determined', 'calendar');
    expect(nd).toContain('not a denial');
    expect(nd).not.toBe(fixFor('permission_denied', 'calendar'));
    expect(fixFor('selection_not_found', 'mail')).toContain('mailbox');
    expect(fixFor('selection_not_found', 'calendar')).toContain('calendar id');
    expect(fixFor('macos_too_old', 'calendar')).toContain('macOS 14');
    expect(fixFor('macos_too_old', 'calendar')).toContain('Command Line Tools 15');
  });

  test('a helper error document with permission_not_determined keeps its code through probe', async () => {
    const script = join(dir, 'nd.js');
    writeFileSync(script, "process.stdout.write(JSON.stringify({error:{code:'permission_not_determined',message:'not asked'}}));process.exit(1)");
    const p = await createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' }).probe('contacts');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('permission_not_determined');
  });

  test('swiftc availability errors on stderr map to macos_too_old with a fix, not a cryptic compile error', async () => {
    const script = join(dir, 'old.js');
    writeFileSync(script, "process.stderr.write('error: x.swift:3: error: \\'requestFullAccessToEvents\\' is only available in macOS 14.0 or newer\\n');process.exit(1)");
    const p = await createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' }).probe('calendar');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.code).toBe('macos_too_old');
      expect(p.fix).toContain('macOS 14');
    }
  });

  test('the availability text is found even when it is past the 2 KB shown in messages', async () => {
    const script = join(dir, 'old-late.js');
    writeFileSync(script, "process.stderr.write('x'.repeat(5000)+' is only available in macOS 14.0');process.exit(1)");
    const e = await fails(runHelper({ service: 'calendar', command: process.execPath, args: [script], platform: 'darwin' }));
    expect(e.code).toBe('macos_too_old');
    expect(e.message.length).toBeLessThan(MAX_STDERR_BYTES + 400);
  });

  test('requestAccess maps a helper failure to a code and success to ok', async () => {
    const okScript = join(dir, 'ra-ok.js');
    writeFileSync(okScript, "process.stdout.write(JSON.stringify({items:[]}))");
    const ok = await createAppleReaders({ command: process.execPath, scriptArgs: [okScript], platform: 'darwin' }).requestAccess!('calendar');
    expect(ok).toEqual({ ok: true });
    const badScript = join(dir, 'ra-bad.js');
    writeFileSync(badScript, "process.stdout.write(JSON.stringify({error:{code:'permission_denied',message:'no'}}));process.exit(1)");
    const bad = await createAppleReaders({ command: process.execPath, scriptArgs: [badScript], platform: 'darwin' }).requestAccess!('contacts');
    expect(bad.ok).toBe(false);
  });
});

describe('mail listing document', () => {
  test('truncated / unavailable / incomplete flow through; a bare array stays "complete"', async () => {
    const script = join(dir, 'mail-doc.js');
    writeFileSync(script, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z'}],truncated:true,unavailable:['t-bad'],incomplete:true,args:process.argv.slice(2)}))`);
    const r = createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' });
    const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'], max: 7 });
    expect(Array.isArray(listing)).toBe(false);
    if (!Array.isArray(listing)) {
      expect(listing.messages.map((m) => m.id)).toEqual(['m1']);
      expect(listing.truncated).toBe(true);
      expect(listing.unavailableThreads).toEqual(['t-bad']);
      expect(listing.incomplete).toBe(true);
    }
  });

  test('real JXA pagination emits an exact cap and advances through 600 timestamp ties by stable id', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    const dates = Array.from({ length: 600 }, () => new Date('2026-10-10T08:00:00.000Z'));
    const mailbox: any = { name: () => 'INBOX', id: () => 'inbox-example' };
    mailbox.messages = { whose: (query: any) => {
      let indexes = dates.map((_, i) => i);
      const newerThan = query?.dateReceived?._greaterThan;
      if (newerThan instanceof Date) indexes = indexes.filter((i) => dates[i]!.getTime() > newerThan.getTime());
      if (Array.isArray(query?._or)) {
        const selected = new Set(query._or.map((x: any) => x.id._equals));
        indexes = indexes.filter((i) => selected.has(i));
      }
      return {
        id: () => indexes,
        messageId: () => indexes.map((i) => `<id-${String(i).padStart(3, '0')}>`),
        subject: () => indexes.map(() => 'same timestamp'), sender: () => indexes.map(() => 'Alice Example <alice@example.com>'),
        dateReceived: () => indexes.map((i) => dates[i]), readStatus: () => indexes.map(() => true),
        allHeaders: () => indexes.map((i) => `Message-ID: <id-${String(i).padStart(3, '0')}>`),
        content: () => indexes.map((i) => `body-${i}`),
      };
    } };
    const mailApp = singleAccountApp({ INBOX: mailbox });
    const invoke = (argv: string[]): any => {
      let output = '';
      const $: any = (value: string) => ({ dataUsingEncoding: () => value });
      $.NSUTF8StringEncoding = 1;
      $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (s: string) => { output = s; } } };
      let exitCode = 0;
      $.exit = (code: number) => { exitCode = code; };
      const sandbox = { ObjC: { import() {} }, $, Application: () => mailApp, console };
      try { runInNewContext(`${js}\nrun(${JSON.stringify(argv)});`, sandbox); } catch (e) { if (!(e as { code?: number }).code) throw e; }
      expect(exitCode).toBe(0);
      return JSON.parse(output);
    };
    const argv = ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', '--max', '500', ...ROUTE_ARGV];
    const first = invoke(argv);
    expect(first.items).toHaveLength(500);
    expect(first.truncated).toBe(true);
    const boundary = first.items.at(-1)!;
    const second = invoke([...argv, '--after-date', boundary.date, '--after-id', boundary.id]);
    expect(second.items).toHaveLength(100);
    expect(second.truncated).toBe(false);
    expect(second.items[0].id).not.toBe(boundary.id);
    expect(new Set([...first.items, ...second.items].map((m: { id: string }) => m.id)).size).toBe(600);
  });

  test('real JXA body budget: one slow batch spends it, the helper reports budget_exhausted, and later runs drain the rest', () => {
    // Live-Mac finding: Mail.app took ~20 s to produce `content` for each HTML newsletter, so a single
    // bulk body read of 35 messages overran the 120 s helper timeout. The helper now reads bodies in
    // batches of 3 under --budget-ms and resumes from the last message it returned.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    const dates = Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 9, 10, 8, i)));
    let fakeNow = 1_000_000;
    let bodyMs = 20_000; // what one body costs Mail.app
    class FakeDate extends Date { static override now(): number { return fakeNow; } }
    let contentCalls = 0;
    const mailbox: any = { name: () => 'INBOX', id: () => 'inbox-example' };
    mailbox.messages = { whose: (query: any) => {
      let indexes = dates.map((_, i) => i);
      const newerThan = query?.dateReceived?._greaterThan;
      if (newerThan instanceof Date) indexes = indexes.filter((i) => dates[i]!.getTime() > newerThan.getTime());
      if (Array.isArray(query?._or)) {
        const selected = new Set(query._or.map((x: any) => x.id._equals));
        indexes = indexes.filter((i) => selected.has(i));
      }
      return {
        id: () => indexes,
        messageId: () => indexes.map((i) => `<id-${String(i).padStart(3, '0')}>`),
        subject: () => indexes.map(() => 'slow newsletter'), sender: () => indexes.map(() => 'Alice Example <alice@example.com>'),
        dateReceived: () => indexes.map((i) => dates[i]), readStatus: () => indexes.map(() => true),
        allHeaders: () => indexes.map((i) => `Message-ID: <id-${String(i).padStart(3, '0')}>`),
        content: () => { contentCalls++; fakeNow += bodyMs * indexes.length; return indexes.map((i) => `body-${i}`); },
      };
    } };
    const mailApp = singleAccountApp({ INBOX: mailbox });
    const invoke = (argv: string[]): any => {
      let output = '';
      const $: any = (value: string) => ({ dataUsingEncoding: () => value });
      $.NSUTF8StringEncoding = 1;
      $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (s: string) => { output = s; } } };
      let exitCode = 0;
      $.exit = (code: number) => { exitCode = code; };
      const sandbox = { ObjC: { import() {} }, $, Application: () => mailApp, console, Date: FakeDate };
      try { runInNewContext(`${js}\nrun(${JSON.stringify(argv)});`, sandbox); } catch (e) { if (!(e as { code?: number }).code) throw e; }
      expect(exitCode).toBe(0);
      return JSON.parse(output);
    };
    const argv = ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX', '--max', '500', '--budget-ms', '45000', ...ROUTE_ARGV];
    // Run 1: the first batch (3 bodies, 60 s of Mail time) spends the budget; the helper keeps it and stops.
    const first = invoke(argv);
    expect(first.items.map((m: { id: string }) => m.id)).toEqual(['<id-000>', '<id-001>', '<id-002>']);
    expect(first.truncated).toBe(true);
    expect(first.budget_exhausted).toBe(true);
    expect(first.incomplete).toBe(false);
    expect(contentCalls).toBe(1);
    // Run 2 resumes after the stable (date,id) boundary and reads the next batch.
    const b1 = first.items.at(-1)!;
    const second = invoke([...argv, '--after-date', b1.date, '--after-id', b1.id]);
    expect(second.items.map((m: { id: string }) => m.id)).toEqual(['<id-003>', '<id-004>', '<id-005>']);
    expect(second.budget_exhausted).toBe(true);
    // Run 3: bodies are fast now; the remaining four come back in one run, complete.
    bodyMs = 100;
    const b2 = second.items.at(-1)!;
    const third = invoke([...argv, '--after-date', b2.date, '--after-id', b2.id]);
    expect(third.items).toHaveLength(4);
    expect(third.truncated).toBe(false);
    expect(third.budget_exhausted).toBe(false);
    expect(new Set([...first.items, ...second.items, ...third.items].map((m: { id: string }) => m.id)).size).toBe(10);
  });

  test('--max is passed to the helper', async () => {
    const script = join(dir, 'mail-args.js');
    writeFileSync(script, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z',subject:process.argv.slice(2).join(' ')}]}))`);
    const r = createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' });
    const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'], max: 7 });
    const messages = Array.isArray(listing) ? listing : listing.messages;
    expect(messages[0]!.subject).toContain('--max 7');
  });

  test('the real helper timeout is passed to the helper as --timeout-ms (default and override)', async () => {
    const script = join(dir, 'mail-timeout-args.js');
    writeFileSync(script, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z',subject:process.argv.slice(2).join(' ')}]}))`);
    const subjectOf = async (timeoutMs?: number) => {
      const r = createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin', ...(timeoutMs ? { timeoutMs } : {}) });
      const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'] });
      return (Array.isArray(listing) ? listing : listing.messages)[0]!.subject;
    };
    expect(await subjectOf()).toContain('--timeout-ms 120000');
    expect(await subjectOf(90_000)).toContain('--timeout-ms 90000');
  });
});

// ── Mail helper (real JXA run in a vm against a synthetic Mail.app; no Apple app, no private data) ──
type FakeBox = { ids: number[]; dates: Record<number, Date> };
type MailVmOpts = {
  boxes: Record<string, FakeBox>;
  bodyMs?: number; // fake clock cost of one body
  accountsMs?: number; // fake clock spent before the body phase (accounts(), listing: the "pre-phase")
  throwFor?: (ids: number[]) => boolean; // `content` throws for this id set
  vanishAfterMeta?: Set<string>; // `${box}${id}` disappears once the metadata has been read
  vanishBeforeMeta?: Set<string>; // disappears from the id-filtered selection before any property is read
  shortBodies?: boolean; // content() returns one body fewer than ids
  nullBodyFor?: Set<string>; // content() has null at that message
  emptyBodyFor?: Set<string>; // content() has '' at that message (a genuinely empty body)
  driftIdsOnContent?: boolean; // the id list changes while content() runs
};
const mailDates = (m: number) => new Date(Date.UTC(2026, 9, 10, 8, m));
const MAIL_ARGV = ['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX,Sent', '--max', '500', '--budget-ms', '45000', ...ROUTE_ARGV];

function makeMailVm(opts: MailVmOpts) {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const js = readFileSync(MAIL_SCRIPT, 'utf8');
  const clock = { now: 1_000_000 };
  class FakeDate extends Date { static override now(): number { return clock.now; } }
  const contentCalls: number[][] = [];
  let metaDone = false;
  let driftNext = false;
  const mboxes: Record<string, any> = {};
  for (const [label, box] of Object.entries(opts.boxes)) {
    const mb: any = { name: () => label, id: () => `${label}-example` };
    mb.messages = { whose: (query: any) => {
      let idx = [...box.ids];
      for (const clause of Array.isArray(query?._and) ? query._and : [query]) {
        const newerThan = clause?.dateReceived?._greaterThan;
        const notAfter = clause?.dateReceived?._lessThanEquals;
        if (newerThan instanceof Date) idx = idx.filter((i) => box.dates[i]!.getTime() > newerThan.getTime());
        if (notAfter instanceof Date) idx = idx.filter((i) => box.dates[i]!.getTime() <= notAfter.getTime());
      }
      let selection = false;
      if (Array.isArray(query?._or)) {
        selection = true;
        const wanted = new Set(query._or.map((x: any) => x.id._equals));
        idx = idx.filter((i) => wanted.has(i));
        if (!metaDone) idx = idx.filter((i) => !opts.vanishBeforeMeta?.has(`${label}${i}`));
        if (metaDone) idx = idx.filter((i) => !opts.vanishAfterMeta?.has(`${label}${i}`));
      }
      const rfc = (i: number) => `<${label}-${i}>`;
      return {
        id: () => { const out = [...idx]; if (selection && driftNext) { driftNext = false; return out.reverse(); } return out; },
        messageId: () => idx.map(rfc), subject: () => idx.map((i) => `subject ${i}`), sender: () => idx.map(() => 'Alice Example <alice@example.com>'),
        dateReceived: () => idx.map((i) => box.dates[i]),
        readStatus: () => { if (selection) metaDone = true; return idx.map(() => true); },
        allHeaders: () => idx.map((i) => `Message-ID: ${rfc(i)}`),
        content: () => {
          metaDone = true;
          contentCalls.push([...idx]);
          if (opts.throwFor?.(idx)) throw new Error('synthetic -1712');
          clock.now += (opts.bodyMs ?? 20_000) * idx.length;
          const out: any[] = idx.map((i) => (opts.nullBodyFor?.has(`${label}${i}`) ? null : opts.emptyBodyFor?.has(`${label}${i}`) ? '' : `body-${label}-${i}`));
          if (opts.shortBodies) out.pop();
          if (opts.driftIdsOnContent) driftNext = true;
          return out;
        },
      };
    } };
    mboxes[label] = mb;
  }
  const mailApp: any = singleAccountApp(mboxes, { accountsHook: () => { clock.now += opts.accountsMs ?? 0; } });
  const invoke = (argv: string[]): any => {
    let output = '';
    const $: any = (value: string) => ({ dataUsingEncoding: () => value });
    $.NSUTF8StringEncoding = 1;
    $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (v: string) => { output = v; } } };
    let exitCode = 0;
    $.exit = (code: number) => { exitCode = code; };
    const sandbox = { ObjC: { import() {} }, $, Application: () => mailApp, console, Date: FakeDate };
    try { runInNewContext(`${js}\nrun(${JSON.stringify(argv)});`, sandbox); } catch (e) { if (!(e as { code?: number }).code) throw e; }
    expect(exitCode).toBe(0);
    return JSON.parse(output);
  };
  return { invoke, contentCalls, clock };
}
const ids6 = (extra: Partial<MailVmOpts> = {}) => makeMailVm({
  bodyMs: 100,
  boxes: { INBOX: { ids: [0, 1, 2, 3, 4, 5], dates: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [i, mailDates(i)])) }, Sent: { ids: [], dates: {} } },
  ...extra,
});
const idsOf = (doc: any): string[] => doc.items.map((m: { id: string }) => m.id);

describe('mail.js bounded body reads (real helper in a vm, synthetic mailbox)', () => {
  test('interleaved INBOX/Sent drain in strict (date,id) order across budget-limited runs without skips or repeats', () => {
    const t = makeMailVm({ boxes: {
      INBOX: { ids: [0, 1, 2, 3], dates: { 0: mailDates(0), 1: mailDates(2), 2: mailDates(4), 3: mailDates(6) } },
      Sent: { ids: [10, 11, 12, 13], dates: { 10: mailDates(1), 11: mailDates(3), 12: mailDates(5), 13: mailDates(7) } },
    } });
    const seen: string[] = [];
    let argv = [...MAIL_ARGV];
    for (let run = 0; run < 6; run++) {
      const doc = t.invoke(argv);
      expect(doc.incomplete).toBe(false);
      expect(doc.unavailable).toEqual([]);
      seen.push(...idsOf(doc));
      if (!doc.truncated) break;
      expect(doc.budget_exhausted).toBe(true);
      const last = doc.items.at(-1)!;
      argv = [...MAIL_ARGV, '--after-date', last.date, '--after-id', last.id];
    }
    expect(seen).toEqual(['<INBOX-0>', '<Sent-10>', '<INBOX-1>', '<Sent-11>', '<INBOX-2>', '<Sent-12>', '<INBOX-3>', '<Sent-13>']);
  });

  test('a poison batch no longer hides its healthy neighbours: they are retried singly and only the unreadable thread is unavailable', () => {
    const t = ids6({ throwFor: (ids) => ids.includes(1) });
    const doc = t.invoke(MAIL_ARGV);
    expect(idsOf(doc)).toEqual(['<INBOX-0>', '<INBOX-2>', '<INBOX-3>', '<INBOX-4>', '<INBOX-5>']);
    expect(doc.unavailable).toEqual(['<INBOX-1>']);
    expect(doc.incomplete).toBe(false);
    expect(doc.truncated).toBe(false);
    expect(t.contentCalls).toContainEqual([1]); // the poison message was tried alone
  });

  test('individual retries stay inside the budget: when time runs out the unretried messages are unavailable, never silently dropped', () => {
    // 50 s per body: the 3-batch throws instantly, retry of #0 costs 50 s, then the 45 s soft budget is spent.
    const t = ids6({ bodyMs: 50_000, throwFor: (ids) => ids.length > 1 });
    const doc = t.invoke(MAIL_ARGV);
    expect(idsOf(doc)).toEqual(['<INBOX-0>']);
    expect(doc.unavailable.sort()).toEqual(['<INBOX-1>', '<INBOX-2>']);
    expect(doc.budget_exhausted).toBe(true);
    expect(doc.truncated).toBe(true);
    expect(t.contentCalls.map((c) => c.length)).toEqual([3, 1]);
  });

  test('a missing (null) body is unavailable, not an empty body; an empty string is a real empty body', () => {
    const t = ids6({ nullBodyFor: new Set(['INBOX1']), emptyBodyFor: new Set(['INBOX4']) });
    const doc = t.invoke(MAIL_ARGV);
    expect(idsOf(doc)).not.toContain('<INBOX-1>');
    expect(doc.unavailable).toEqual(['<INBOX-1>']);
    expect(doc.items.find((m: { id: string }) => m.id === '<INBOX-4>').body).toBe('');
    expect(doc.items.filter((m: { body: string }) => m.body !== '' ).every((m: { id: string; body: string }) => m.body === `body-INBOX-${m.id.match(/-(\d+)>/)![1]}`)).toBe(true);
  });

  test('a short bodies array is never read positionally: nothing becomes an empty body and every thread stays unavailable', () => {
    const t = makeMailVm({ bodyMs: 100, shortBodies: true, boxes: { INBOX: { ids: [0, 1, 2], dates: { 0: mailDates(0), 1: mailDates(1), 2: mailDates(2) } }, Sent: { ids: [], dates: {} } } });
    const doc = t.invoke(MAIL_ARGV);
    expect(doc.items).toEqual([]);
    expect(doc.unavailable.sort()).toEqual(['<INBOX-0>', '<INBOX-1>', '<INBOX-2>']);
  });

  test('id list that shifts while content() runs is rejected as an id/body association drift, then re-read singly', () => {
    const t = ids6({ driftIdsOnContent: true });
    const doc = t.invoke(MAIL_ARGV);
    // The drifting read is discarded; single-message re-reads (reverse of one id is itself) are consistent.
    expect(idsOf(doc)).toEqual(['<INBOX-0>', '<INBOX-1>', '<INBOX-2>', '<INBOX-3>', '<INBOX-4>', '<INBOX-5>']);
    expect(t.contentCalls.some((c) => c.length === 1)).toBe(true);
    for (const m of doc.items) expect(m.body).toBe(`body-INBOX-${m.id.match(/-(\d+)>/)[1]}`);
  });

  test('an id that disappears between the metadata and body reads keeps its thread unavailable (the cursor must not skip it)', () => {
    const t = ids6({ vanishAfterMeta: new Set(['INBOX1']) });
    const doc = t.invoke(MAIL_ARGV);
    expect(idsOf(doc)).toEqual(['<INBOX-0>', '<INBOX-2>', '<INBOX-3>', '<INBOX-4>', '<INBOX-5>']);
    expect(doc.unavailable).toEqual(['<INBOX-1>']);
  });

  test('an id that disappears before its metadata is read makes the run incomplete (thread unknown)', () => {
    const t = ids6({ vanishBeforeMeta: new Set(['INBOX2']) });
    const doc = t.invoke(MAIL_ARGV);
    expect(idsOf(doc)).not.toContain('<INBOX-2>');
    expect(doc.incomplete).toBe(true);
  });

  test('slow pre-phase: the body phase is sized to the real helper timeout, not the soft budget alone', () => {
    // 70 s spent in accounts() before any body read; 20 s per body; default 120 s hard timeout.
    const t = ids6({ bodyMs: 20_000, accountsMs: 70_000 });
    const t0 = t.clock.now;
    const doc = t.invoke(MAIL_ARGV);
    expect((t.clock.now - t0) / 1000).toBeLessThanOrEqual(110); // 120 s timeout - 10 s reserve
    expect(doc.items.length).toBe(2); // a batch of 3 would end at 130 s; 2 end at 110 s
    expect(doc.truncated).toBe(true);
    expect(doc.budget_exhausted).toBe(true);
  });

  test('pre-phase so slow that no body read fits: nothing is started, nothing is claimed complete', () => {
    const t = ids6({ bodyMs: 20_000, accountsMs: 100_000 });
    const t0 = t.clock.now;
    const doc = t.invoke(MAIL_ARGV);
    expect(t.contentCalls).toEqual([]);
    expect(t.clock.now - t0).toBe(100_000);
    expect(doc.items).toEqual([]);
    expect(doc.truncated).toBe(true);
    expect(doc.budget_exhausted).toBe(true);
  });

  test('--timeout-ms is the hard limit the helper plans against: a 60 s caller never has a body read projected past 50 s', () => {
    const t = ids6({ bodyMs: 20_000 });
    const t0 = t.clock.now;
    const doc = t.invoke([...MAIL_ARGV, '--timeout-ms', '60000']);
    expect((t.clock.now - t0) / 1000).toBeLessThanOrEqual(50); // 60 s timeout - 10 s reserve
    expect(doc.items.length).toBeGreaterThanOrEqual(1);
    expect(doc.items.length).toBeLessThan(6);
    expect(doc.truncated).toBe(true);
  });

  test('the slowest body seen so far raises the projected cost of the next batch', () => {
    // Batch 1 projects 3 x 20 s (the floor) = 60 s and fits; it really costs 3 x 30 s = 90 s.
    const t = ids6({ bodyMs: 30_000 });
    const doc = t.invoke([...MAIL_ARGV, '--budget-ms', '300000']);
    // After batch 1 (ends at 90 s) a second batch would project 3 x 30 s = 90 s -> 180 s > 110 s: stop.
    expect(doc.items).toHaveLength(3);
    expect(doc.budget_exhausted).toBe(true);
    expect(t.contentCalls).toHaveLength(1);
  });
});

describe('mail.js message-level verdicts (real helper in a vm, synthetic mailbox)', () => {
  const idOf = (n: number): string => `<INBOX-${n}>`;
  const proven = (doc: any): Array<{ id: string; date: string; thread_id: string }> => [...doc.unavailable_messages].sort((a, b) => (a.id < b.id ? -1 : 1));

  test('only the message read on its own and found unreadable is proven; its healthy batch neighbours are not blamed', () => {
    const t = ids6({ throwFor: (ids) => ids.includes(1) });
    const doc = t.invoke(MAIL_ARGV);
    expect(proven(doc)).toEqual([{ id: idOf(1), date: mailDates(1).toISOString(), thread_id: idOf(1) }]);
    expect(doc.deferred).toEqual([]);
    expect(doc.unavailable).toEqual([idOf(1)]);
  });

  test('a batch that failed and could not be retried in time is deferred, never proven (nothing may count it)', () => {
    const t = ids6({ bodyMs: 50_000, throwFor: (ids) => ids.length > 1 });
    const doc = t.invoke(MAIL_ARGV);
    expect(doc.unavailable.sort()).toEqual([idOf(1), idOf(2)]);
    expect(doc.unavailable_messages).toEqual([]);
    expect(doc.deferred.sort()).toEqual([idOf(1), idOf(2)]);
  });

  test('a missing (null) body is proven unreadable; a body whose id vanished mid-read is deferred; an id with no metadata is incomplete', () => {
    const nul = ids6({ nullBodyFor: new Set(['INBOX1']) }).invoke(MAIL_ARGV);
    expect(proven(nul).map((m) => m.id)).toEqual([idOf(1)]);
    expect(nul.deferred).toEqual([]);
    const vanished = ids6({ vanishAfterMeta: new Set(['INBOX1']) }).invoke(MAIL_ARGV);
    expect(vanished.unavailable_messages).toEqual([]);
    expect(vanished.deferred).toEqual([idOf(1)]);
    const noMeta = ids6({ vanishBeforeMeta: new Set(['INBOX2']) }).invoke(MAIL_ARGV);
    expect(noMeta.unavailable_messages).toEqual([]);
    expect(noMeta.incomplete).toBe(true);
  });

  test('--exclude: a held message is never listed, read or reported, costs no body time and does not count toward the cap', () => {
    const t = ids6({ throwFor: (ids) => ids.includes(1) });
    const doc = t.invoke([...MAIL_ARGV, '--exclude', JSON.stringify([idOf(1)])]);
    expect(idsOf(doc)).toEqual([0, 2, 3, 4, 5].map(idOf));
    expect(doc.unavailable).toEqual([]);
    expect(doc.unavailable_messages).toEqual([]);
    expect(t.contentCalls.flat()).not.toContain(1);
    const capped = ids6().invoke(['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX,Sent', '--max', '3', '--budget-ms', '45000', '--exclude', JSON.stringify([idOf(1)]), ...ROUTE_ARGV]);
    expect(idsOf(capped)).toEqual([0, 2, 3].map(idOf));
    expect(capped.truncated).toBe(true);
  });

  test('--targets reads exactly the named messages wherever they are (outside any window), reports the missing ones, and proves unreadable ones', () => {
    const argv = (targets: Array<{ id: string; date: string }>) => ['--targets', JSON.stringify(targets), '--mailboxes', 'INBOX,Sent', '--budget-ms', '45000', ...ROUTE_ARGV];
    const t = ids6({ throwFor: (ids) => ids.includes(4) });
    const doc = t.invoke(argv([
      { id: idOf(2), date: mailDates(2).toISOString() },
      { id: idOf(4), date: mailDates(4).toISOString() },
      { id: '<gone@example.com>', date: mailDates(3).toISOString() },
    ]));
    expect(idsOf(doc)).toEqual([idOf(2)]);
    expect(doc.target_missing).toEqual(['<gone@example.com>']);
    expect(proven(doc)).toEqual([{ id: idOf(4), date: mailDates(4).toISOString(), thread_id: idOf(4) }]);
    // Nothing but the two found messages was ever read for a body.
    expect(new Set(t.contentCalls.flat())).toEqual(new Set([2, 4]));
    expect(doc.truncated).toBe(false);
  });
});

describe('mail reader listing documents carry message identity', () => {
  const readerFor = (doc: Record<string, unknown>) => {
    const script = join(dir, `mail-doc-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(script, `process.stdout.write(JSON.stringify(Object.assign({items:[{id:'m1',date:'2026-01-02T10:00:00Z'}]}, ${JSON.stringify(doc)}, {args:process.argv.slice(2)})))`);
    return createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' });
  };

  test('proven unreadable messages, deferred threads and missing targets flow through; an old document without them stays unchanged', async () => {
    const r = readerFor({ unavailable: ['t1', 't2'], unavailable_messages: [{ id: 'm9', date: '2026-01-01T10:00:00Z', thread_id: 't1' }], deferred: ['t2'], target_missing: ['m7'] });
    const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'] }) as import('../src/core/apple/types.ts').AppleMailListing;
    expect(listing.unavailableMessages).toEqual([{ id: 'm9', date: '2026-01-01T10:00:00Z', threadId: 't1' }]);
    expect(listing.deferredThreads).toEqual(['t2']);
    expect(listing.targetMissing).toEqual(['m7']);
    expect(listing.incomplete).toBe(false);
    const old = await readerFor({ unavailable: ['t1'] }).mail({ since: new Date(0), mailboxes: ['INBOX'] }) as import('../src/core/apple/types.ts').AppleMailListing;
    expect(old.unavailableMessages).toBeUndefined();
    expect(old.deferredThreads).toBeUndefined();
    expect(old.unavailableThreads).toEqual(['t1']);
  });

  test('an unreadable-message entry without a stable id, a date or a thread is dropped and the listing is incomplete (unknown identity stays conservative)', async () => {
    for (const bad of [{ date: '2026-01-01T10:00:00Z', thread_id: 't1' }, { id: 'm9', thread_id: 't1' }, { id: 'm9', date: '2026-01-01T10:00:00Z' }, { id: 'm9', date: 'not a date', thread_id: 't1' }]) {
      const listing = await readerFor({ unavailable: ['t1'], unavailable_messages: [bad] }).mail({ since: new Date(0), mailboxes: ['INBOX'] }) as import('../src/core/apple/types.ts').AppleMailListing;
      expect(listing.unavailableMessages).toEqual([]);
      expect(listing.incomplete).toBe(true);
    }
  });

  test('--exclude and --targets are passed as JSON argv entries; a targeted read sends no --since', async () => {
    const r = readerFor({});
    const main = await r.mail({ since: new Date(0), mailboxes: ['INBOX'], exclude: ['<a b,c@x>'] }) as any;
    expect(Array.isArray(main) ? [] : main.messages).toHaveLength(1);
    const echo = createAppleReaders({ command: process.execPath, scriptArgs: [(() => { const f = join(dir, 'mail-echo.js'); writeFileSync(f, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z',subject:JSON.stringify(process.argv.slice(2))}]}))`); return f; })()], platform: 'darwin' });
    const argsOf = async (read: () => Promise<any>): Promise<string[]> => JSON.parse((await read()).messages[0].subject);
    const mainArgs = await argsOf(() => echo.mail({ since: new Date(0), mailboxes: ['INBOX'], exclude: ['<a b,c@x>'] }));
    expect(JSON.parse(mainArgs[mainArgs.indexOf('--exclude') + 1]!)).toEqual(['<a b,c@x>']);
    const targetArgs = await argsOf(() => echo.mailMessages!({ mailboxes: ['INBOX'], targets: [{ id: '<a@x>', date: '2026-01-02T10:00:00Z' }] }));
    expect(JSON.parse(targetArgs[targetArgs.indexOf('--targets') + 1]!)).toEqual([{ id: '<a@x>', date: '2026-01-02T10:00:00Z' }]);
    expect(targetArgs).not.toContain('--since');
    expect(targetArgs).toContain('--timeout-ms');
  });
});

describe('helper scripts: source-level guards (static; the scripts are not run here)', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  test('mail.js never launches Mail: running() gates probe and sync, and NSWorkspace is gone', () => {
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    expect(js).toContain('Mail.running()');
    expect(js).not.toContain('NSWorkspace');
    const run = js.slice(js.indexOf('function run(argv)'));
    expect(run.indexOf('Mail.running()')).toBeGreaterThan(0);
    expect(run.indexOf('Mail.running()')).toBeLessThan(run.indexOf('Mail.accounts()'));
    expect(run.indexOf('args.probe')).toBeGreaterThan(run.indexOf('Mail.running()')); // the check precedes the probe branch
    expect(js).not.toContain('byId');
    // The unified application mailboxes mix every account (Google included): the helper reads only the accounts it is given.
    const code = js.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const unified of ['Mail.inbox', 'Mail.sentMailbox', 'Mail.draftsMailbox', 'Mail.junkMailbox', 'Mail.trash', 'Mail.outbox']) expect(code).not.toContain(unified);
    // Public account metadata only: never a credential, an address or a display name.
    for (const secret of ['password', 'userName', 'emailAddresses', 'fullName', '.name()']) {
      const metaFn = code.slice(code.indexOf('function accountMeta'), code.indexOf('function verifyRouting'));
      expect(metaFn).not.toContain(secret);
    }
  });
  test('swift helpers separate not-determined from denied and honour --request-access', () => {
    for (const f of [CALENDAR_SCRIPT, CONTACTS_SCRIPT]) {
      const swift = readFileSync(f, 'utf8');
      expect(swift).toContain('permission_not_determined');
      expect(swift).toContain('--request-access');
      if (f === CALENDAR_SCRIPT) expect(swift).toContain('calendarIds.filter { !resolvedIds.contains($0) }');
    }
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('selection_not_found');
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('.birthday');
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('calendarItemExternalIdentifier');
  });
});
