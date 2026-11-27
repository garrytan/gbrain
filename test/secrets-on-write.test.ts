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

  test('put_pages never echoes a refused entry\'s slug when the slug holds the token; the index names it', async () => {
    await withMode('block', async () => {
      const slug = 'notes/key-' + TOKEN.toLowerCase();
      const result = await call(remote(), 'put_pages', { pages: [{ slug: 'notes/clean-neighbour', content: '# Clean\n' }, { slug, content: '# Leaky\n\nNothing here.\n' }], request_id: randomUUID() });
      expect(JSON.stringify(result).toLowerCase()).not.toContain(TOKEN.toLowerCase());
      expect(result.pages[1]).toMatchObject({ index: 1, state: 'refused' });
      expect(result.pages[1].slug).toBeUndefined();
      expect(JSON.stringify(result.pages[1].error)).toContain('secret_in_write');
      expect(result.pages[0]).toMatchObject({ index: 0, slug: 'notes/clean-neighbour' });

      const repeated = await call(remote(), 'put_pages', { pages: [{ slug, content: '# One\n' }, { slug, content: '# Two\n' }], request_id: randomUUID() });
      expect(JSON.stringify(repeated).toLowerCase()).not.toContain(TOKEN.toLowerCase());
      expect(repeated.pages.map((p: { index: number; state: string }) => [p.index, p.state])).toEqual([[0, 'refused'], [1, 'refused']]);

      const reasoned = await refusal(() => call(remote(), 'put_pages', { pages: [{ slug, content: '# One\n', reason: 'x'.repeat(5_000) }], request_id: randomUUID() }));
      expect(reasoned.message).toContain('pages[0]');
      expect(reasoned.message.toLowerCase()).not.toContain(TOKEN.toLowerCase());
    });
  });

  test('put_pages drops the slug of an entry the screen refused, even when the slug holds a value only the page text marks as a secret', async () => {
    await withMode('block', async () => {
      const opaque = ['q7hv2lz9', 'kp4rt6wm', '8yb3nc5x', 'd1fg0js'].join('');
      const result = await call(remote(), 'put_pages', { pages: [{ slug: 'notes/session-' + opaque, content: '# Call\n\nAuthorization: Bearer ' + opaque + '\n' }], request_id: randomUUID() });
      expect(result.pages[0]).toMatchObject({ index: 0, state: 'refused' });
      expect(result.pages[0].slug).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(opaque);
    });
  });

  test('a reserved kind hidden by NUL bytes stays refused when the write also carries a token (redact)', async () => {
    await withMode('redact', async () => {
      const before = Number((await engine.executeRaw<{ n: unknown }>("SELECT count(*) AS n FROM persistence_requests r WHERE r::text LIKE '%managed_sync_%'"))[0]!.n);
      for (const kind of ['managed\u0000_sync_import', 'managed\u0000_sync_' + TOKEN]) {
        await call(remote(), 'capture', { content: 'A note with ' + TOKEN + ' in it', kind }).catch(() => null);
      }
      expect(Number((await engine.executeRaw<{ n: unknown }>("SELECT count(*) AS n FROM persistence_requests r WHERE r::text LIKE '%managed_sync_%'"))[0]!.n)).toBe(before);
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

  test('a sealed upload resumed by a later commit is screened too, so a crash after sealing cannot skip the screen', async () => {
    const slug = 'notes/block-upload-resumed';
    const text = '# Upload\n\nThe key is ' + TOKEN + '.\n';
    const session = await call(remote(), 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    await call(remote(), 'upload_page_part', { upload_id: session.upload_id, part: 0, text, part_sha256: hex(text) });
    await engine.executeRaw("UPDATE page_body_stagings SET state = 'sealed' WHERE id = $1::uuid", [session.upload_id]);
    await withMode('block', async () => {
      expectSecretRefusal(await refusal(() => call(remote(), 'commit_page_upload', { upload_id: session.upload_id })));
    });
    expect(await page(slug)).toBeNull();
    const [staging] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [session.upload_id]);
    expect(staging!.state).toBe('aborted');
  });

  test('a token split by NUL bytes, which the stored page joins back, is refused', async () => {
    await withMode('block', async () => {
      const split = TOKEN.slice(0, 12) + '\u0000' + TOKEN.slice(12, 24) + '\u0000\u0000' + TOKEN.slice(24);
      expect(split).not.toContain(TOKEN);
      expectSecretRefusal(await refusal(() => call(remote(), 'put_page', { slug: 'notes/block-nul', content: '# Nul\n\nkey ' + split + '\n' })));
      expect(await page('notes/block-nul')).toBeNull();
      expect(await journaledWithToken('notes/block-nul')).toBe(0);
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

  test('a token split by NUL bytes is stored redacted, never joined back into the page', async () => {
    await withMode('redact', async () => {
      const split = TOKEN.slice(0, 12) + '\u0000' + TOKEN.slice(12);
      const result = await call(remote(), 'put_page', { slug: 'notes/redact-nul', content: '# Nul\n\nThe key is ' + split + '.\n' });
      expect(result.secrets_redacted).toEqual({ count: 1, patterns: ['github_token'] });
      const stored = (await page('notes/redact-nul'))!.compiled_truth;
      expect(stored).toContain('The key is <REDACTED:github_token>.');
      expect(stored).not.toContain(TOKEN);
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

describe('secrets.on_write on server-composed household writes (GST-4024)', () => {
  const stored = async (slug: string) => (await engine.executeRaw<{ compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }>(
    'SELECT compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]!;
  /** A bill whose body already holds a token: written while the policy was off, before the operator turned it on. */
  async function billWithStoredToken(name: string): Promise<string> {
    const added = await withMode(undefined, () => call(remote(), 'household_add', { kind: 'bill', title: name, due: '2026-12-09', recurs: 'monthly', note: 'Portal key ' + TOKEN }));
    expect((await stored(added.slug)).compiled_truth).toContain(TOKEN);
    return added.slug;
  }

  for (const mode of ['block', 'redact'] as const) {
    test(`${mode}: household_mark keeps the stored body as it is and screens only the caller's note`, async () => {
      const slug = await billWithStoredToken('Water bill ' + mode);
      await withMode(mode, async () => {
        const marked = await call(remote(), 'household_mark', { slug, event: 'paid', on: '2026-12-01', note: 'paid online' });
        expect(marked.secrets_redacted).toBeUndefined();
        const page = await stored(slug);
        expect(page.compiled_truth).toContain('Portal key ' + TOKEN);
        expect(page.timeline).toContain('paid online');
        if (mode === 'block') {
          const journaled = await journaledWithToken(slug);
          expectSecretRefusal(await refusal(() => call(remote(), 'household_mark', { slug, event: 'paid', on: '2026-12-02', note: 'card ' + TOKEN })));
          expectSecretRefusal(await refusal(() => call(remote(), 'household_mark', { slug, event: 'paid', on: '2026-12-02', request_id: TOKEN })));
          expect(await journaledWithToken(slug)).toBe(journaled);
          expect((await stored(slug)).timeline).not.toContain('2026-12-02');
        } else {
          const redacted = await call(remote(), 'household_mark', { slug, event: 'paid', on: '2026-12-02', note: 'card ' + TOKEN });
          expect(redacted.secrets_redacted).toEqual({ count: 1, patterns: ['github_token'] });
          const after = await stored(slug);
          expect(after.timeline).toContain('card <REDACTED:github_token>');
          expect(after.timeline).not.toContain(TOKEN);
          expect(after.compiled_truth).toContain('Portal key ' + TOKEN);
        }
      });
    });

    test(`${mode}: household_add marking a subject a child keeps the stored bodies of the subject page and the records it narrows, and still screens the new record`, async () => {
      const subject = 'people/subject-' + mode + '-example';
      await call(local(), 'put_page', { slug: subject, content: '---\ntype: person\nhousehold_role: adult\n---\n\n# Subject\n\nOld note ' + TOKEN + '\n' });
      const earlier = await withMode(undefined, () => call(remote(), 'household_add', { kind: 'supply', title: 'Shared supply ' + mode, cadence: '30d', about: [subject], note: 'Shop key ' + TOKEN }));
      expect((await stored(earlier.slug)).frontmatter.household_audience).not.toBe('adults');
      await withMode(mode, async () => {
        await call(remote(), 'household_add', { kind: 'bill', title: 'Phone bill ' + mode, due: '2026-12-09', about: [subject], about_role: 'child' });
        const page = await stored(subject);
        expect(page.frontmatter.household_role).toBe('child');
        expect(page.compiled_truth).toContain('Old note ' + TOKEN);
        const pinned = await stored(earlier.slug);
        expect(pinned.frontmatter.household_audience).toBe('adults');
        expect(pinned.compiled_truth).toContain('Shop key ' + TOKEN);
        if (mode === 'block') {
          expectSecretRefusal(await refusal(() => call(remote(), 'household_add', { kind: 'bill', title: 'Gas bill', due: '2026-12-09', note: 'key ' + TOKEN })));
          const other = 'people/other-subject-example';
          await call(local(), 'put_page', { slug: other, content: '---\ntype: person\nhousehold_role: adult\n---\n\n# Other\n' });
          expectSecretRefusal(await refusal(() => call(remote(), 'household_add', { kind: 'bill', title: 'Gym bill', due: '2026-12-09', about: [other], about_role: 'child', note: 'key ' + TOKEN })));
          expect((await stored(other)).frontmatter.household_role).toBe('adult');
        } else {
          const added = await call(remote(), 'household_add', { kind: 'bill', title: 'Gas bill', due: '2026-12-09', note: 'key ' + TOKEN });
          expect(added.secrets_redacted).toEqual({ count: 1, patterns: ['github_token'] });
          expect((await stored(added.slug)).compiled_truth).not.toContain(TOKEN);
        }
      });
    });
  }
});
