/**
 * pages-02: a local put that names no source must not fork a page that lives in another source.
 * 1. Protects: once 'default' holds a page, an unsourced `gbrain put <slug>` (with or without --force) of a slug
 *    that lives only in the git source is refused with the holding source and the exact retry command, and no
 *    second copy appears in 'default'; `put --force --source-id <source>` still writes to that source; an unsourced
 *    put of a new slug still goes to 'default' and prints the documented routing-flip notice even when the git
 *    source is federated; an explicit --source-id may still make a separate copy; a slug held by two other
 *    sources, or only by a source outside a restricted local writer's grant, is not refused; a retry of a stored
 *    request_id keeps its receipt after the page moved elsewhere; a dry run refuses like the real put.
 * 2. Fails when: the put forks a shadow copy that an unscoped get prefers (the old behavior), the refusal text
 *    changes, a sourced put is refused, or the flip notice is silent.
 *    Also fails when the refusal runs before the stored-request replay, probes sources the writer's grant does not
 *    cover, or makes a first-use dry run (no writer registered yet) fail.
 * 3. Real seams: MCP dispatch with remote=false and localSourceImplicit (the path the CLI uses), the durable write
 *    path and the real sources table, on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/erin-example';
const page = (body: string) => ['---', 'type: person', 'title: Erin Example', '---', '# Erin Example', '', body].join('\n');
const refusal = (retry: string) => `Page ${SLUG} lives in source vault. This put names no source, so it would write a second copy to source default. `
  + `To update the page in vault, run the same put with its source: ${retry}`;

describe('an unsourced local put does not fork a page that lives in another source (PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;

  async function put(slug: string, content: string, opts: { implicit: boolean; ctxSource: string; params?: Record<string, unknown> }) {
    const out = await dispatchToolCall(engine, 'put_page', { slug, content, request_id: randomUUID(), ...opts.params },
      { remote: false, sourceId: opts.ctxSource, ...(opts.implicit ? { localSourceImplicit: true } : {}), takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    return { isError: out.isError === true, text, body: out.isError ? null : JSON.parse(text) as { source_id: string } };
  }
  const unsourced = (slug: string, content: string, params: Record<string, unknown> = {}) =>
    put(slug, content, { implicit: true, ctxSource: 'default', params });
  const compiled = async (sourceId: string) => (await engine.getPage(SLUG, { sourceId }))?.compiled_truth ?? null;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pages02-fork-'));
    mkdirSync(join(dir, 'vault'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('vault', 'vault', $1, '{"federated": true}'::jsonb)`, [join(dir, 'vault')]);
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
      expect((await put(SLUG, page('Erin is at acme-example.'), { implicit: false, ctxSource: 'vault' })).body?.source_id).toBe('vault');
      expect((await put('notes/scratch', '# scratch', { implicit: false, ctxSource: 'default' })).body?.source_id).toBe('default');
    });
  }, 240_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('an unsourced put without --force is refused, names vault and the retry, and forks nothing', async () => {
    const out = await unsourced(SLUG, page('Erin moved again.'));
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.text) as { message: string; error: string; detail?: string };
    expect(err.message).toBe(refusal(`gbrain put ${SLUG} --source-id vault`));
    expect(err.detail).toBe('slug_in_other_source');
    expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toBeNull();
    expect(await compiled('vault')).toContain('Erin is at acme-example.');
  }, 120_000);

  test('an unsourced put with --force is refused the same way, and an unscoped get still reads vault', async () => {
    const out = await unsourced(SLUG, page('Erin moved to fund-a.'), { force: true });
    expect(out.isError).toBe(true);
    expect((JSON.parse(out.text) as { message: string }).message).toBe(refusal(`gbrain put ${SLUG} --source-id vault --force`));
    expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toBeNull();
    const read = await dispatchToolCall(engine, 'get_page', { slug: SLUG }, { remote: false, sourceId: 'default', localSourceImplicit: true, localFederatedSourceIds: ['default', 'vault'] });
    expect(read.isError, read.content.map(c => c.text).join('\n')).toBeFalsy();
    const got = JSON.parse(read.content.map(c => c.text).join('\n')) as { source_id: string; compiled_truth: string };
    expect(got.source_id).toBe('vault');
    expect(got.compiled_truth).toContain('Erin is at acme-example.');
  }, 120_000);

  test('put --force --source-id vault writes to vault and is not refused', async () => {
    const slug = 'people/frank-example';
    expect((await put(slug, page('Frank is at widget-co.'), { implicit: false, ctxSource: 'vault' })).body?.source_id).toBe('vault');
    const out = await unsourced(slug, page('Frank moved to fund-b.'), { force: true, source_id: 'vault' });
    expect(out.isError).toBe(false);
    expect(out.body?.source_id).toBe('vault');
    expect((await engine.getPage(slug, { sourceId: 'vault' }))?.compiled_truth).toContain('Frank moved to fund-b.');
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
  }, 120_000);

  test('an explicit --source-id may still make a separate copy in another source', async () => {
    const slug = 'people/gina-example';
    expect((await put(slug, page('Gina is at vault-co.'), { implicit: false, ctxSource: 'vault' })).body?.source_id).toBe('vault');
    const out = await unsourced(slug, page('Gina has a separate copy.'), { source_id: 'default' });
    expect(out.isError, out.text).toBe(false);
    expect(out.body?.source_id).toBe('default');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('separate copy');
    expect((await engine.getPage(slug, { sourceId: 'vault' }))?.compiled_truth).toContain('vault-co');
  }, 120_000);

  test('a dry run refuses the same fork and writes nothing', async () => {
    const out = await unsourced(SLUG, page('Erin dry run.'), { dry_run: true });
    expect(out.isError).toBe(true);
    expect((JSON.parse(out.text) as { detail?: string }).detail).toBe('slug_in_other_source');
    expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toBeNull();
  }, 120_000);

  test('a slug held by two other sources is not refused (no single source to name)', async () => {
    const slug = 'people/hana-example';
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('vault-two', 'vault-two', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    for (const source of ['vault', 'vault-two']) {
      const written = await put(slug, page(`Hana in ${source}.`), { implicit: false, ctxSource: source });
      expect(written.isError, written.text).toBe(false);
    }
    const out = await unsourced(slug, page('Hana unsourced.'));
    expect(out.isError, out.text).toBe(false);
    expect(out.body?.source_id).toBe('default');
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'vault-two'`); // later cases see one non-default source again
  }, 120_000);

  test('a retry of a stored request keeps its receipt after the page moved to another source', async () => {
    const slug = 'notes/iris-example';
    const params = { request_id: randomUUID() };
    const first = await unsourced(slug, page('Iris first.'), params);
    expect(first.isError, first.text).toBe(false);
    expect((await put(slug, page('Iris elsewhere.'), { implicit: false, ctxSource: 'vault' })).isError).toBe(false);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
    const retry = await unsourced(slug, page('Iris first.'), params);
    expect(retry.isError, retry.text).toBe(false);
    expect(retry.body).toEqual(first.body);
    expect(await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true })).toBeNull();
  }, 120_000);

  test('an unsourced put of a new slug goes to default and prints the routing-flip notice', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let out: Awaited<ReturnType<typeof unsourced>>;
    try {
      out = await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined }, () => unsourced('notes/two', '# note two'));
    } finally {
      console.error = original;
    }
    expect(out.body?.source_id).toBe('default');
    expect(lines).toContain("[gbrain] sole non-default source 'vault' exists, but 'default' is non-empty — routing to 'default' (#3070 emptiness guard). Pass --source vault or set sources.default to target it.");
  }, 120_000);
});

describe('a restricted local writer is not told about pages in sources its grant does not cover (PGLite)', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await registerLocalWriter(engine, 'cli', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('vault', 'vault', '{}'::jsonb)`);
    await engine.putPage('notes/jo-example', { type: 'note', title: 'Jo', compiled_truth: 'Held in vault.', timeline: '' }, { sourceId: 'vault' });
  }, 240_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('an unsourced put is not refused for a page in a source outside the grant', async () => {
    const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/jo-example', content: page('Jo copy.'), request_id: randomUUID() },
      { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    expect(text).not.toContain('slug_in_other_source');
    expect(text).not.toContain('lives in source vault');
  }, 120_000);
});

describe('a first-use dry run, before any local writer is registered (PGLite)', () => {
  test('previewing an unsourced put of a new slug succeeds and writes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pages02-first-use-'));
    const engine = new PGLiteEngine();
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.connect({ engine: 'pglite' } as never);
        await engine.initSchema();
        const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/first-use-example', content: '# First use', dry_run: true },
          { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] });
        const text = out.content.map(c => c.text).join('\n');
        expect(out.isError, text).not.toBe(true);
        expect(JSON.parse(text)).toMatchObject({ dry_run: true });
        expect(await engine.readPageSnapshot('notes/first-use-example', { sourceId: 'default', includeDeleted: true })).toBeNull();
      });
    } finally {
      await engine.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  }, 240_000);
});
