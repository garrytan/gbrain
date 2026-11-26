/**
 * #9389: the Gmail-to-page path with google.gmail.redact_credentials on and off,
 * on a managed DB-only (repo-less) brain fed by a synthetic gbrain.io mailbox.
 *
 * Protects: with the key on, a one-time code and a magic sign-in link never
 * reach the page body, its chunks or its versions, including after a reply
 * re-renders the thread; ordinary text in the same message is kept.
 * Regression it catches: the redaction moving after the write, or a re-sync
 * rendering the raw body again. With the key unset the page is unchanged.
 * Seam: gbrainioRunner.run (the terminal), as in google-gbrainio-ingest.test.ts.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { gbrainioRunner, type GbrainioRun, type GbrainioRunResult } from '../src/core/google/gbrainio-gmail.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, settleConnectorWrites } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const OWNER = 'owner@example.invalid';
const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 3_600_000;
const realRun = gbrainioRunner.run;
afterEach(() => { gbrainioRunner.run = realRun; });

const CODE = '482913';
const TOKEN = ['Zk81Qp', '2Lm9Xa', '77Rt4Bv0'].join('');
const BODY = [
  'Hi,',
  `Your Acme verification code is ${CODE}.`,
  `Or sign in with this link: https://app.acme-example.invalid/auth/magic?token=${TOKEN}`,
  'Order #771204 ships to 94107 on 2026-12-01 for $129.99.',
].join('\n');

interface Msg { id: string; tid: string; ms: number; from: string; subject: string; body: string }

function fakeGbrainio(mail: Msg[]): void {
  const run: GbrainioRun = async (_command, args) => {
    const account = args[args.indexOf('-a') + 1]!;
    const out = (body: Record<string, unknown>): GbrainioRunResult => ({ exitCode: 0, stdout: JSON.stringify({ account, ...body }), stderr: '' });
    const row = (m: Msg) => ({ account, id: m.id, thread_id: m.tid, received_at: new Date(m.ms).toISOString(), from: m.from, to: OWNER, cc: '',
      subject: m.subject, state: 'received' });
    const [, , verb, sub] = args;
    if (verb === 'label' && sub === 'ls') return out({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }] });
    if (verb === 'send-as' && sub === 'ls') return out({ send_as: [{ email: account }] });
    if (verb === 'message' && sub === 'search') {
      const q = args[4]!;
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const tag = q.replace(/after:\d+|before:\d+/g, '').trim();
      const hits = tag ? [] : mail.filter((m) => m.ms / 1000 >= after && m.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return out({ count: hits.length, more: false, next_cursor: null, messages: hits.map(row) });
    }
    if (verb === 'thread' && sub === 'show') {
      const messages = mail.filter((m) => m.tid === args[4]).sort((a, b) => a.ms - b.ms);
      if (messages.length === 0) return { exitCode: 3, stdout: '', stderr: 'not found' };
      return out({ thread_id: args[4], count: messages.length, messages: messages.map((m) => ({ ...row(m), body: m.body, attachments: [] })) });
    }
    return { exitCode: 2, stdout: '', stderr: 'unexpected fixture command' };
  };
  gbrainioRunner.run = run;
}

async function stored(engine: BrainEngine, id: string): Promise<{ body: string; chunks: string; versions: string }> {
  await settleConnectorWrites(engine, id);
  const [page] = await engine.executeRaw<{ id: number; compiled_truth: string }>(
    "SELECT id, compiled_truth FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE 'emails/%'", [id]);
  expect(page).toBeDefined();
  const chunks = await engine.executeRaw<{ chunk_text: string }>('SELECT chunk_text FROM content_chunks WHERE page_id=$1', [page!.id]);
  expect(chunks.length).toBeGreaterThan(0);
  const versions = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM page_versions WHERE page_id=$1', [page!.id]);
  return { body: page!.compiled_truth, chunks: chunks.map((c) => c.chunk_text).join('\n'), versions: versions.map((v) => v.compiled_truth).join('\n') };
}

const config = { kind: 'google', g_account: OWNER, g_access: 'gbrainio', g_history_days: 30, g_ingest_tiers: false };
const mailbox = (): Msg[] => [{ id: 'a9a9a9a9a9a9a901', tid: 'a9a9a9a9a9a9a900', ms: NOW_MS - 5 * HOUR,
  from: 'Acme Example <hello@acme-example.invalid>', subject: 'Sign in to Acme', body: BODY }];

test('key unset: the Gmail body lands as it is', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, config);
    fakeGbrainio(mailbox());
    expect((await runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options)).status).not.toBe('partial');
    const { body, chunks } = await stored(engine, f.id);
    expect(body).toContain(CODE);
    expect(body).toContain(TOKEN);
    expect(chunks).toContain(CODE);
  }
}), 180_000);

test('key on: codes and sign-in links never reach the page, its chunks or its versions, also after a re-sync', async () => withEnv(env, async () => {
  for (const engine of engines) {
    await engine.setConfig('google.gmail.redact_credentials', 'true');
    try {
      const f = await source(engine, config);
      const mail = mailbox();
      fakeGbrainio(mail);
      const run = () => runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options);
      expect((await run()).status).not.toBe('partial');
      mail.push({ id: 'a9a9a9a9a9a9a902', tid: 'a9a9a9a9a9a9a900', ms: NOW_MS - HOUR, from: 'Acme Example <hello@acme-example.invalid>',
        subject: 'Re: Sign in to Acme', body: `A new code: your verification code is 739201.\n` + BODY });
      expect((await run()).status).not.toBe('partial');
      const { body, chunks, versions } = await stored(engine, f.id);
      for (const text of [body, chunks, versions]) {
        expect(text).not.toContain(CODE);
        expect(text).not.toContain('739201');
        expect(text).not.toContain(TOKEN);
      }
      expect(body).toContain('[redacted:otp]');
      expect(body).toContain('[redacted:login-link]');
      expect(body).toContain('Order #771204 ships to 94107 on 2026-12-01 for $129.99.');
      expect(chunks).toContain('[redacted:otp]');
    } finally {
      await engine.setConfig('google.gmail.redact_credentials', 'false');
    }
  }
}), 180_000);
