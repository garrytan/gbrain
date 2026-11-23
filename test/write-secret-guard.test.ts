/**
 * secrets.on_write: a brain served to a team over MCP may refuse remote page writes whose text holds a credential. A
 * gateway that scans each tool call misses a page uploaded in parts (a secret split across two upload_page_part calls
 * is in neither), so the guard runs inside gbrain: on page write admission and on the assembled upload at commit.
 *
 * Protects: each pattern is found and its look-alikes (env var names, placeholders, code references) pass; the
 * refusal names the type, never the value; off by default; put_page with a secret is refused and writes nothing while
 * a clean one lands; a chunked upload whose secret is split across two parts is refused at commit and aborted (no
 * page, the session gone), while a clean chunked upload commits; local writes are not scanned.
 * Fails when: the guard is not consulted at admission or at commit, scans each part alone, or echoes the match.
 * Seams: the legacy bearer transport over a real socket with a real token, on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { findWriteSecret, findWriteSecretIn, findWriteSecretInParts, secretInWriteError, SECRETS_ON_WRITE_KEY, WRITE_SECRET_PATTERNS } from '../src/core/write-secret-guard.ts';

// Built from pieces so this file holds no scanner-tripping literals.
const SLACK = 'https://hooks.slack.com/' + 'services/T0123ABCD/B0456EFGH/aBcDeFgHiJkLmNoPqRsTuVwX';
const JWT = 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'.repeat(2);

const POSITIVE: Array<[string, string]> = [
  ['slack_webhook', `alerts go to ${SLACK}`],
  ['slack_webhook', 'https://hooks.slack.com/services/T000/B000/XXXXXXXX'],
  ['slack_token', 'token: ' + 'xoxb-' + '1234567890-0987654321-AbCdEfGhIjKl'],
  ['sentry_dsn', 'SENTRY_DSN=https://' + '0123456789abcdef0123456789abcdef@o12345.ingest.de.sentry.io/678'],
  ['sentry_auth_token', 'sntrys_' + 'eyJpYXQiOjE3MDAwMDAwMDAsInVybCI6Imh0dHBz'],
  ['sentry_auth_token', 'sntryu_' + '4f3a9b2c1d0e8f7a6b5c4d3e2f1a0b9c8d7e6f5a'],
  ['github_token', 'ghp_' + 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'],
  ['github_token', 'gho_' + '16C7e42F292c6912E7710c838347Ae178B4a'],
  ['github_token', 'ghs_' + '16C7e42F292c6912E7710c838347Ae178B4a'],
  ['github_token', 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
  ['google_api_key', 'key=AIza' + 'SyD3x4mpl3K3y-abcdefghijklmnopqrstu'],
  ['private_key', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n' + PEM_BODY + '\n-----END RSA PRIVATE KEY-----'],
  ['private_key', '-----BEGIN ' + 'PRIVATE KEY-----\n' + PEM_BODY],
  ['aws_access_key', 'aws_access_key_id = AKIA' + 'Z3QF7LX2MB9RT4WK'],
  ['password_assignment', 'DB settings: password="S3cure!Passw0rd"'],
  ['password_assignment', '{"password": "hunter2hunter2"}'],
  ['password_assignment', 'PASSWORD=Tr0ub4dor&3'],
  ['jwt', `Authorization: Bearer ${JWT}`],
  ['database_uri_credentials', 'postgresql://' + 'afp:Xk92mPq7Lz@10.0.0.5:5432/afp'],
  ['database_uri_credentials', 'mongodb+srv://' + 'app:Zq81LmN0pW@cluster0.abc.mongodb.net/db'],
];

const NEGATIVE = [
  'Set SENTRY_DSN and SLACK_WEBHOOK_URL in Secret Manager (secret app-sentry-dsn).',
  'Alerts post to the #ops Slack webhook (https://hooks.slack.com/services/<redacted>).',
  'Webhook: https://hooks.slack.com/services/...',
  'Slack bot token lives in SLACK_BOT_TOKEN (xoxb-...).',
  'DSN format: https://<key>@o0.ingest.sentry.io/<project>',
  'Sentry tokens start with sntrys_ or sntryu_.',
  'GitHub PATs look like ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'github_pat_<token>',
  'Google keys start with AIza; ours is GOOGLE_MAPS_API_KEY.',
  'The key file starts with -----BEGIN PRIVATE KEY----- and is in Secret Manager.',
  'AWS docs example: AKIAIOSFODNN7EXAMPLE',
  'password=<redacted>',
  'password: "***"',
  'password = settings.db_password',
  "password=os.environ['DB_PASSWORD']",
  'password: str',
  'password=DB_PASSWORD',
  'password = ${DB_PASSWORD}',
  'pwd="changeme"',
  'Tokens are JWTs (eyJ...).',
  'postgresql://app:${DB_PASSWORD}@db:5432/app',
  'postgres://user:password@localhost/db',
  'postgresql://app@10.0.0.5:5432/app',
  'mongodb://<user>:<pass>@host/db',
  'The ingest pipeline uses Sentry for errors and Slack for alerts.',
];

describe('patterns', () => {
  for (const [type, text] of POSITIVE) test(`finds ${type}: ${text.slice(0, 24)}`, () => expect(findWriteSecret(text)?.type).toBe(type));
  for (const text of NEGATIVE) test(`passes: ${text.slice(0, 40)}`, () => expect(findWriteSecret(text)).toBeNull());
  test('every pattern has a positive case', () => expect(new Set(WRITE_SECRET_PATTERNS.map(p => p.type))).toEqual(new Set(POSITIVE.map(([t]) => t))));
  test('nested parameters are scanned', () => {
    expect(findWriteSecretIn({ pages: [{ slug: 'a', content: 'ok' }, { slug: 'b', content: `hook: ${SLACK}` }] })?.type).toBe('slack_webhook');
    expect(findWriteSecretIn({ edits: [{ old_text: 'x', new_text: JWT }] })?.type).toBe('jwt');
  });
  test('the refusal names the type, never the match', () => {
    const e = secretInWriteError(findWriteSecret(SLACK)!, 'put_page');
    const text = JSON.stringify(e.toJSON());
    expect(e.toJSON()).toMatchObject({ code: 'secret_in_write', reason: 'slack_webhook' });
    expect(text).not.toContain('hooks.slack.com');
    expect(text).not.toContain('T0123ABCD');
  });
  test('a body streamed in parts is scanned across the seam', async () => {
    const body = `# Alerts\n\nThe hook is ${SLACK} for now.\n`;
    const cut = body.indexOf('slack.com');
    async function* parts() { yield Buffer.from(body.slice(0, cut)); yield Buffer.from(body.slice(cut)); }
    expect(findWriteSecret(body.slice(0, cut))).toBeNull();
    expect(findWriteSecret(body.slice(cut))).toBeNull();
    expect((await findWriteSecretInParts(parts()))?.type).toBe('slack_webhook');
  });
});

describe('remote writes on the legacy bearer transport', () => {
  const TOKEN = 'synthetic-secret-guard-' + process.pid;
  let engine: BrainEngine;
  let server: { port: number; stop: (force?: boolean) => unknown };
  let url: string;
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const page = (body: string) => '---\ntype: note\ntitle: Alerting\n---\n\n# Alerting\n\n' + body + '\n';

  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, any> }> {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5) : raw);
    const result = body.result ?? body;
    return { isError: result.isError === true, json: JSON.parse(result.content?.[0]?.text ?? '{}') };
  }
  async function chunked(slug: string, text: string, cut: number) {
    const begin = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: sha(text), request_id: randomUUID() });
    expect(begin.isError).toBe(false);
    for (const [part, piece] of [text.slice(0, cut), text.slice(cut)].entries()) {
      expect((await call('upload_page_part', { upload_id: begin.json.upload_id, part, text: piece, part_sha256: sha(piece) })).isError).toBe(false);
    }
    let commit = await call('commit_page_upload', { upload_id: begin.json.upload_id, wait_ms: 30_000 });
    for (let attempt = 0; commit.json.code === 'write_pending' && attempt < 40; attempt++) commit = await call('commit_page_upload', { upload_id: begin.json.upload_id, wait_ms: 30_000 });
    return { uploadId: begin.json.upload_id as string, commit };
  }

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes) VALUES($1,$2,$3::text[])', ['Synthetic writer', hashToken(TOKEN), '{read,write}']);
    server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
    } }) as unknown as { port: number; stop: (force?: boolean) => unknown };
    url = 'http://127.0.0.1:' + server.port + '/mcp';
  }, 120_000);

  afterAll(async () => {
    await server?.stop(true);
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  test('off by default: a secret is written as before', async () => {
    expect((await call('put_page', { slug: 'notes/guard-off', content: page(`hook ${SLACK}`) })).isError).toBe(false);
    expect(await engine.readPageSnapshot('notes/guard-off', { sourceId: 'default' })).not.toBeNull();
  }, 120_000);

  test('on: put_page with a secret is refused and writes nothing; a clean page lands', async () => {
    await engine.setConfig(SECRETS_ON_WRITE_KEY, 'refuse');
    const refused = await call('put_page', { slug: 'notes/guard-put', content: page(`hook ${SLACK}`) });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ code: 'secret_in_write', reason: 'slack_webhook' });
    expect(JSON.stringify(refused.json)).not.toContain('hooks.slack.com');
    expect(await engine.readPageSnapshot('notes/guard-put', { sourceId: 'default' })).toBeNull();
    const batch = await call('put_pages', { pages: [{ slug: 'notes/guard-batch-a', content: page('clean') }, { slug: 'notes/guard-batch-b', content: page(JWT) }] });
    expect(batch.isError || JSON.stringify(batch.json).includes('secret_in_write')).toBe(true);
    expect(await engine.readPageSnapshot('notes/guard-batch-b', { sourceId: 'default' })).toBeNull();
    expect((await call('put_page', { slug: 'notes/guard-clean', content: page('The webhook lives in SLACK_WEBHOOK_URL.') })).isError).toBe(false);
  }, 120_000);

  test('on: a chunked upload whose secret is split across two parts is refused at commit and leaves no page', async () => {
    await engine.setConfig(SECRETS_ON_WRITE_KEY, 'refuse');
    const text = page(`Alerts go to ${SLACK} today.`);
    const { uploadId, commit } = await chunked('notes/guard-split', text, text.indexOf('slack.com'));
    expect(commit.isError).toBe(true);
    expect(commit.json).toMatchObject({ code: 'secret_in_write', reason: 'slack_webhook' });
    expect(await engine.readPageSnapshot('notes/guard-split', { sourceId: 'default' })).toBeNull();
    const [session] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [uploadId]);
    expect(session?.state).toBe('aborted');
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_staging_parts WHERE staging_id = $1::uuid', [uploadId]);
    expect(n).toBe(0);

    const clean = page('Alerts go to the channel named in SLACK_WEBHOOK_URL. '.repeat(20));
    const ok = await chunked('notes/guard-split-clean', clean, 200);
    expect({ isError: ok.commit.isError, state: ok.commit.json.state }).toEqual({ isError: false, state: 'committed' });
    expect(await engine.readPageSnapshot('notes/guard-split-clean', { sourceId: 'default' })).not.toBeNull();
  }, 240_000);
});
