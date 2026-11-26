/**
 * secrets.on_write: an opt-in policy for page text a remote (MCP) caller writes. `off` (the default) changes nothing,
 * `block` refuses the write with `secret_in_write` before anything is journaled, `redact` stores the page with each
 * value secret-scan.ts claims replaced by its `<REDACTED:pattern>` token. A chunked upload is screened on its
 * assembled text at commit, so a secret split across two upload_page_part calls is found, and the refused upload is
 * aborted with its parts deleted. Local (remote=false) writes are never screened.
 *
 * Protects: the policy's three values and its fail-closed reading of an unknown value; every refusal and receipt
 * names pattern names and a count, never the value (checked over the error, the response and every journaled
 * request row); documentation placeholders pass under block.
 * Runs on an in-memory PGLite brain with no repository (no embedding, no model calls).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const TOKEN = 'ghp_' + 'Zx8Kq2Lm4Np6Rs8Tu0Vw2Xy4Za6Bc8De0Fg2';
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

let engine: BrainEngine;
let home: string;
const logger = { info() {}, warn() {}, error() {} };
const remote = (): OperationContext => ({
  engine, config: {} as GBrainConfig, logger, dryRun: false, remote: true, sourceId: 'default', transport: 'http', inboundFrameBytes: 4 * 1024 ** 2,
  auth: { token: 'fixture', clientId: 'on-write', principal: { kind: 'oauth_client', id: 'on-write' }, scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] },
} as unknown as OperationContext);
const local = (): OperationContext => ({ engine, config: {} as GBrainConfig, logger, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext);
const call = async (ctx: OperationContext, name: string, params: Record<string, unknown>) => await op(name).handler(ctx, params) as Record<string, any>;

/** Runs `fn` with secrets.on_write set to `mode` in a fresh file-plane config (undefined: no config file). */
async function withMode<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(home, 'case-'));
  if (mode !== undefined) {
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ secrets: { on_write: mode } }));
  }
  return await withEnv({ GBRAIN_HOME: dir }, fn);
}

const page = async (slug: string) => (await engine.executeRaw<{ compiled_truth: string; timeline: string }>(
  'SELECT compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0] ?? null;
const journaledWithToken = async (slug = '%') => Number((await engine.executeRaw<{ n: unknown }>(
  'SELECT count(*) AS n FROM persistence_requests r WHERE r.slug LIKE $1 AND r::text LIKE $2', [slug, '%' + TOKEN + '%']))[0]!.n);

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected a refusal');
}

function expectSecretRefusal(error: OperationError) {
  expect(error.canonical ?? error.code).toBe('secret_in_write');
  const wire = JSON.stringify({ ...error.toJSON(), message: error.message, why: error.why, detail: error.detail, reason: error.reason });
  expect(wire).toContain('github_token');
  expect(wire).not.toContain(TOKEN);
  expect(wire).not.toContain(TOKEN.slice(4, 20));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-on-write-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
    VALUES('on-write','fixture-hash','on-write-client','read write','default') ON CONFLICT (client_id) DO NOTHING`);
  await engine.executeRaw("INSERT INTO config (key, value) VALUES ('write_gate.agent_mode', 'off') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

describe('secrets.on_write off (the default)', () => {
  test('a remote put_page holding a token is written unchanged', async () => {
    await withMode(undefined, async () => {
      const result = await call(remote(), 'put_page', { slug: 'notes/off-default', content: '# Off\n\nThe deploy key is ' + TOKEN + '.\n' });
      expect(result.secrets_redacted).toBeUndefined();
      expect((await page('notes/off-default'))!.compiled_truth).toContain(TOKEN);
    });
  });
});

describe('secrets.on_write block', () => {
  test('put_page is refused, nothing is written or journaled, and the error names the pattern only', async () => {
    await withMode('block', async () => {
      const before = await journaledWithToken();
      expectSecretRefusal(await refusal(() => call(remote(), 'put_page', { slug: 'notes/block-put', content: '# Put\n\nkey ' + TOKEN + '\n' })));
      expect(await page('notes/block-put')).toBeNull();
      expect(await journaledWithToken()).toBe(before);
    });
  });

  test('put_pages refuses the page holding a token and writes nothing for it', async () => {
    await withMode('block', async () => {
      const result = await call(remote(), 'put_pages', { pages: [{ slug: 'notes/block-batch', content: '# Batch\n\nkey ' + TOKEN + '\n' }], request_id: randomUUID() });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(result.pages[0].state).toBe('refused');
      expect(JSON.stringify(result.pages[0].error)).toContain('secret_in_write');
      expect(await page('notes/block-batch')).toBeNull();
      expect(await journaledWithToken('notes/block-batch')).toBe(0);
    });
  });

  test('edit_page adding a token is refused; one removing a stored token (old_text) is not', async () => {
    await withMode('block', async () => {
      await call(local(), 'put_page', { slug: 'notes/block-edit', content: '# Edit\n\nold line ' + TOKEN + '\n' });
      expectSecretRefusal(await refusal(() => call(remote(), 'edit_page', { slug: 'notes/block-edit', edits: [{ old_text: 'old line', new_text: 'new ' + TOKEN + ' line' }] })));
      expect((await page('notes/block-edit'))!.compiled_truth).not.toContain('new ' + TOKEN);
      const { revision } = (await engine.readPageSnapshot('notes/block-edit', { sourceId: 'default' }))!;
      await call(remote(), 'edit_page', { slug: 'notes/block-edit', expected_revision: revision, edits: [{ old_text: 'old line ' + TOKEN, new_text: 'old line (key moved to the secret store)' }] });
      expect((await page('notes/block-edit'))!.compiled_truth).not.toContain(TOKEN);
    });
  });

  test('capture, add_timeline_entry and remember are refused', async () => {
    await withMode('block', async () => {
      const before = await journaledWithToken();
      expectSecretRefusal(await refusal(() => call(remote(), 'capture', { content: 'A note with ' + TOKEN + ' in it' })));
      await call(remote(), 'put_page', { slug: 'notes/block-timeline', content: '# Timeline\n\nClean page.\n' });
      expectSecretRefusal(await refusal(() => call(remote(), 'add_timeline_entry', { slug: 'notes/block-timeline', date: '2026-01-02', summary: 'rotated ' + TOKEN })));
      expect((await page('notes/block-timeline'))!.timeline).not.toContain(TOKEN);
      const remembered = await refusal(() => call(remote(), 'remember', { fact: 'The deploy token is ' + TOKEN, provenance: 'test' }));
      expect(remembered.code).toBe('invalid_params');
      expectSecretRefusal(remembered);
      expect(await journaledWithToken()).toBe(before);
    });
  });

  test('a token split across two upload parts is refused at commit and the upload is aborted with its parts deleted', async () => {
    await withMode('block', async () => {
      const slug = 'notes/block-upload';
      const text = '# Upload\n\nThe key is ' + TOKEN + ' and nothing else.\n';
      const cut = text.indexOf(TOKEN) + 10;
      const session = await call(remote(), 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
      for (const [part, piece] of [text.slice(0, cut), text.slice(cut)].entries()) {
        expect(piece).not.toContain(TOKEN);
        await call(remote(), 'upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: hex(piece) });
      }
      expectSecretRefusal(await refusal(() => call(remote(), 'commit_page_upload', { upload_id: session.upload_id })));
      expect(await page(slug)).toBeNull();
      const [staging] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
      expect(staging!.state).toBe('aborted');
      const [parts] = await engine.executeRaw<{ n: unknown }>('SELECT count(*) AS n FROM page_body_staging_parts WHERE staging_id = $1::uuid', [session.upload_id]);
      expect(Number(parts!.n)).toBe(0);
    });
  });

  test('documentation placeholders, masks and environment variable names pass', async () => {
    const DOC_DB_URL = `${'postgres'}://user:password@localhost:5432/app`;
    const MASK = '***';
    await withMode('block', async () => {
      const content = ['# Docs', '', 'Example key: AKIA...EXAMPLE, and the AWS docs key AKIAIOSFODNN7EXAMPLE.',
        `Connect with ${DOC_DB_URL}.`, 'Set GITHUB_TOKEN and OPENAI_API_KEY in the environment.',
        `token: <redacted>, password: ${MASK}`, ''].join('\n');
      await call(remote(), 'put_page', { slug: 'notes/block-docs', content });
      expect((await page('notes/block-docs'))!.compiled_truth).toContain(`${DOC_DB_URL}.`);
    });
  });

  test('a local (remote=false) write is not screened', async () => {
    await withMode('block', async () => {
      await call(local(), 'put_page', { slug: 'notes/block-local', content: '# Local\n\nkey ' + TOKEN + '\n' });
      expect((await page('notes/block-local'))!.compiled_truth).toContain(TOKEN);
    });
  });

  test('an unknown value fails closed to block', async () => {
    await withMode('yes', async () => {
      expectSecretRefusal(await refusal(() => call(remote(), 'put_page', { slug: 'notes/unknown-mode', content: 'key ' + TOKEN + '\n' })));
      expect(await page('notes/unknown-mode')).toBeNull();
    });
  });
});

describe('secrets.on_write redact', () => {
  test('put_page is written with each token replaced and the receipt names only patterns and a count', async () => {
    await withMode('redact', async () => {
      const result = await call(remote(), 'put_page', { slug: 'notes/redact-put', content: '# Redact\n\nThe key is ' + TOKEN + '; again ' + TOKEN + '.\n' });
      expect(result.secrets_redacted).toEqual({ count: 2, patterns: ['github_token'] });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      const stored = (await page('notes/redact-put'))!.compiled_truth;
      expect(stored).toContain('The key is <REDACTED:github_token>; again <REDACTED:github_token>.');
      expect(stored).not.toContain(TOKEN);
      expect(await journaledWithToken('notes/redact-put')).toBe(0);
    });
  });

  test('a chunked upload holding a token is refused, since an uploaded body is never rewritten', async () => {
    await withMode('redact', async () => {
      const slug = 'notes/redact-upload';
      const text = '# Upload\n\nThe key is ' + TOKEN + '.\n';
      const session = await call(remote(), 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
      await call(remote(), 'upload_page_part', { upload_id: session.upload_id, part: 0, text, part_sha256: hex(text) });
      expectSecretRefusal(await refusal(() => call(remote(), 'commit_page_upload', { upload_id: session.upload_id })));
      expect(await page(slug)).toBeNull();
    });
  });
});
