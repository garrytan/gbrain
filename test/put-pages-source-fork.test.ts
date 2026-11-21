/**
 * pages-02 follow-up: a batch put, an upload commit and a put from inside a source's checkout.
 * 1. Protects: with 'default' and one git source `vault`, a local `put_pages` with no source_id refuses, page by
 *    page and with the same text as put_page, a page whose slug lives only in vault (the other pages of the batch
 *    are still written, as for any per-page refusal); a begin_page_upload (mode create) with no source_id refuses
 *    before anything is staged, and a commit_page_upload refuses a new page that appeared in vault after its begin;
 *    an explicit source_id still writes there. A put run from inside a source's checkout (the local_path tier, via
 *    cliRequestContext) counts as naming that source: it writes there with no refusal, for put, put_pages and
 *    begin_page_upload, while a cwd outside every checkout still refuses. An upload commit writes to the source fixed
 *    at its begin, so its checkout names nothing: a refused commit retried from the holder's checkout is still
 *    refused. The routing-flip notice is silent under --quiet.
 * 2. Fails when: put_pages or an upload writes a second copy into 'default' (the old behavior), a named source or a
 *    checkout is refused, an upload commit from another source's checkout forks, the refusal text differs from
 *    put_page's, or --quiet still prints the flip notice.
 * 3. Real seams: MCP dispatch with remote=false and localSourceImplicit (the CLI's path), the CLI context builder
 *    that resolves the cwd tier, the durable write path and the real sources table, on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';
import { cliRequestContext, mergedRequestConfig } from '../src/core/cli-socket/execute.ts';
import { sourceNamedByCheckout } from '../src/core/persistence/unsourced-put-fork.ts';

const SLUG = 'people/erin-example';
const page = (body: string) => ['---', 'type: person', 'title: Erin Example', '---', '# Erin Example', '', body].join('\n');
const refusal = (slug: string) => `Page ${slug} lives in source vault. This put names no source, so it would write a second copy to source default. `
  + `To update the page in vault, run the same put with its source: gbrain put ${slug} --source-id vault`;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('put_pages and uploads that name no source do not fork a page that lives in another source (PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;

  const call = async (tool: string, params: Record<string, unknown>, implicit = true) => {
    const out = await dispatchToolCall(engine, tool, params,
      { remote: false, sourceId: 'default', ...(implicit ? { localSourceImplicit: true } : {}), takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    return { isError: out.isError === true, text, body: JSON.parse(text) as Record<string, any> };
  };
  const putPages = (pages: Array<{ slug: string; content: string; expected_revision?: string }>, params: Record<string, unknown> = {}, implicit = true) =>
    call('put_pages', { request_id: randomUUID(), pages, ...params }, implicit);
  const compiled = async (slug: string, sourceId: string) => (await engine.getPage(slug, { sourceId }))?.compiled_truth ?? null;
  const row = (slug: string, sourceId: string) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  const stagings = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_stagings'))[0]!.n);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pages02-batch-'));
    mkdirSync(join(dir, 'vault'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('vault', 'vault', $1, '{"federated": true}'::jsonb)`, [join(dir, 'vault')]);
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
      expect((await call('put_page', { slug: SLUG, content: page('Erin is at acme-example.'), source_id: 'vault' })).body.source_id).toBe('vault');
      expect((await call('put_page', { slug: 'notes/scratch', content: '# scratch', source_id: 'default' })).body.source_id).toBe('default');
    });
  }, 240_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('put_pages with no source refuses the page that lives in vault, names the retry, and writes the rest', async () => {
    const out = await putPages([{ slug: SLUG, content: page('Erin moved again.') }, { slug: 'notes/batch-new', content: '# batch new' }]);
    expect(out.isError, out.text).toBe(false);
    expect(out.body.state).toBe('partial');
    expect(out.body.counts).toMatchObject({ total: 2, committed: 1, failed: 1 });
    expect(out.body.pages[0]).toMatchObject({ slug: SLUG, state: 'refused', error: { detail: 'slug_in_other_source', message: refusal(SLUG) } });
    expect(out.body.pages[1]).toMatchObject({ slug: 'notes/batch-new', state: 'committed' });
    expect(await row(SLUG, 'default')).toBeNull();
    expect(await compiled(SLUG, 'vault')).toContain('Erin is at acme-example.');
    expect(await compiled('notes/batch-new', 'default')).toContain('batch new');
  }, 120_000);

  test('put_pages where every page lives in vault refuses them all and forks nothing', async () => {
    const other = 'people/finn-example';
    expect((await call('put_page', { slug: other, content: page('Finn is at widget-co.'), source_id: 'vault' })).isError).toBe(false);
    const out = await putPages([{ slug: SLUG, content: page('Erin again.') }, { slug: other, content: page('Finn again.') }]);
    expect(out.body.state).toBe('failed');
    expect(out.body.pages.map((entry: any) => [entry.state, entry.error?.detail])).toEqual([['refused', 'slug_in_other_source'], ['refused', 'slug_in_other_source']]);
    for (const slug of [SLUG, other]) expect(await row(slug, 'default')).toBeNull();
  }, 120_000);

  test('put_pages with --source-id vault still updates the page in vault', async () => {
    const revision = (await row(SLUG, 'vault'))!.revision;
    const out = await putPages([{ slug: SLUG, content: page('Erin moved to fund-a.'), expected_revision: revision }], { source_id: 'vault' });
    expect(out.isError, out.text).toBe(false);
    expect(out.body).toMatchObject({ state: 'committed', source_id: 'vault' });
    expect(await compiled(SLUG, 'vault')).toContain('Erin moved to fund-a.');
    expect(await row(SLUG, 'default')).toBeNull();
  }, 120_000);

  test('put_pages with --source-id default may still make a separate copy', async () => {
    const out = await putPages([{ slug: SLUG, content: page('A separate copy.') }], { source_id: 'default' });
    expect(out.body).toMatchObject({ state: 'committed', source_id: 'default' });
    expect(await compiled(SLUG, 'default')).toContain('separate copy');
    expect(await compiled(SLUG, 'vault')).toContain('fund-a');
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [SLUG]);
  }, 120_000);

  test('put_pages is not refused for a caller that is not the unsourced local CLI', async () => {
    const slug = 'people/gina-example';
    expect((await call('put_page', { slug, content: page('Gina is at vault-co.'), source_id: 'vault' })).isError).toBe(false);
    const out = await putPages([{ slug, content: page('Gina copy.') }], {}, false); // the source was named (a flag or GBRAIN_SOURCE), so the context is not implicit
    expect(out.body.state).toBe('committed');
    expect(await compiled(slug, 'default')).toContain('Gina copy.');
  }, 120_000);

  test('begin_page_upload (create) with no source is refused before anything is staged', async () => {
    const text = page('Erin by upload.');
    const before = await stagings();
    const out = await call('begin_page_upload', { slug: SLUG, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ detail: 'slug_in_other_source', message: refusal(SLUG) });
    expect(await stagings()).toBe(before);
    expect(await row(SLUG, 'default')).toBeNull();
  }, 120_000);

  test('an upload begun on a named source commits there; an unsourced one for a new slug commits to default', async () => {
    const upload = async (slug: string, text: string, params: Record<string, unknown>, commitImplicit = true) => {
      const begun = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(), ...params });
      expect(begun.isError, begun.text).toBe(false);
      const sent = await call('upload_page_part', { upload_id: begun.body.upload_id, part: 0, text, part_sha256: hex(text) });
      expect(sent.isError, sent.text).toBe(false);
      return call('commit_page_upload', { upload_id: begun.body.upload_id }, commitImplicit);
    };
    // commit_page_upload takes no source of its own: a deliberate separate copy names it again on the commit (the global --source flag).
    const copy = await upload(SLUG, page('Erin upload copy.'), { source_id: 'default' }, false);
    expect(copy.isError, copy.text).toBe(false);
    expect(copy.body.source_id).toBe('default');
    expect(await compiled(SLUG, 'default')).toContain('upload copy');
    expect(await compiled(SLUG, 'vault')).toContain('fund-a');
    const fresh = await upload('notes/upload-new', '# upload new', {});
    expect(fresh.isError, fresh.text).toBe(false);
    expect(await compiled('notes/upload-new', 'default')).toContain('upload new');
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'default' AND slug = $1`, [SLUG]);
  }, 120_000);

  test('commit_page_upload refuses a new page that appeared in vault after its begin, and forks nothing', async () => {
    const slug = 'people/hana-example';
    const text = page('Hana by upload.');
    const begun = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    expect(begun.isError, begun.text).toBe(false); // nothing lives at the slug yet, so the begin is fine
    expect((await call('upload_page_part', { upload_id: begun.body.upload_id, part: 0, text, part_sha256: hex(text) })).isError).toBe(false);
    expect((await call('put_page', { slug, content: page('Hana is at vault-co.'), source_id: 'vault' })).isError).toBe(false);
    const out = await call('commit_page_upload', { upload_id: begun.body.upload_id });
    expect(out.isError).toBe(true);
    expect(out.body).toMatchObject({ detail: 'slug_in_other_source', message: refusal(slug) });
    expect(await row(slug, 'default')).toBeNull();
    expect(await compiled(slug, 'vault')).toContain('vault-co');
  }, 120_000);
});

describe('the fork check names the single holder among many sources (PGLite)', () => {
  let engine: BrainEngine;
  // A snapshot-restored PGLite carries the snapshot's brain id, so an earlier engine in this file already left a writer
  // credential file for that id in the shared home. A private home keeps this engine from reading that file.
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pages02-holder-'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (const id of ['s1', 's2', 's3', 's4', 's5']) await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [id]);
    await engine.putPage('notes/held-in-s4', { type: 'note', title: 'Held', compiled_truth: 'Held in s4.', timeline: '' }, { sourceId: 's4' });
  }, 240_000);
  afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);

  const unsourced = (slug: string) => withEnv({ GBRAIN_HOME: home }, () => operationsByName.put_page!.handler({ engine, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId: 'default',
    localSourceImplicit: true, dryRun: true, logger: { info() {}, warn() {}, error() {} } } as OperationContext, { slug, content: '# held' }));

  test('the single holder among five sources is named', async () => {
    await expect(unsourced('notes/held-in-s4')).rejects.toMatchObject({ message: expect.stringContaining('lives in source s4.') });
  }, 120_000);
});

describe('the routing-flip notice honours --quiet (PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pages02-quiet-'));
    mkdirSync(join(dir, 'vault'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('vault', 'vault', $1, '{"federated": true}'::jsonb)`, [join(dir, 'vault')]);
    await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'Scratch.', timeline: '' });
  }, 240_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function stderrOf(quiet: boolean): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined }, () => operationsByName.put_page!.handler({ engine, config: { engine: 'pglite', embedding_disabled: true } as never,
        remote: false, sourceId: 'default', localSourceImplicit: true, dryRun: false, logger: { info() {}, warn() {}, error() {} },
        cliOpts: { quiet, progressJson: false, progressInterval: 1000 } } as OperationContext, { slug: `notes/quiet-${quiet}`, content: '# quiet' }));
    } finally {
      console.error = original;
    }
    return lines.filter(line => line.includes('#3070 emptiness guard'));
  }

  test('--quiet prints no notice; without it the notice prints', async () => {
    expect(await stderrOf(true)).toEqual([]);
    expect(await stderrOf(false)).toHaveLength(1);
  }, 120_000);
});

describe('a put from inside a source checkout names that source (PGLite)', () => {
  let engine: BrainEngine;
  let dir: string;
  const NOOP = { emitResponseMeta: () => {}, emitNotice: () => {} };
  const page2 = (body: string) => page(body);

  /** The CLI's own context for a command run in `cwd` with no flag, env or dotfile. */
  const cliFlags = async (cwd: string) => {
    const ctx = await cliRequestContext(engine, {}, { params: {} }, { routing: { cwd, source_env: null }, cli: { quiet: false, timeout_ms: null } }, await mergedRequestConfig(engine), NOOP);
    return { sourceId: ctx.sourceId, ...(ctx.localSourceImplicit ? { localSourceImplicit: true } : {}), ...(ctx.localSourceFromCheckout ? { localSourceFromCheckout: true } : {}) };
  };
  const callFrom = async (cwd: string, tool: string, params: Record<string, unknown>) => {
    const out = await dispatchToolCall(engine, tool, params, { remote: false, ...(await cliFlags(cwd)), takesHoldersAllowList: ['world'] });
    const text = out.content.map(c => c.text).join('\n');
    return { isError: out.isError === true, text, body: JSON.parse(text) as Record<string, any> };
  };
  const compiled = async (slug: string, sourceId: string) => (await engine.getPage(slug, { sourceId }))?.compiled_truth ?? null;
  const row = (slug: string, sourceId: string) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pages02-checkout-'));
    for (const name of ['vault', 'notes-b', 'elsewhere']) mkdirSync(join(dir, name, 'sub'), { recursive: true });
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (const id of ['vault', 'notes-b']) {
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{"federated": true}'::jsonb)`, [id, join(dir, id)]);
    }
    await engine.putPage('notes/scratch', { type: 'note', title: 'Scratch', compiled_truth: 'Scratch.', timeline: '' });
    await withEnv({ GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: '1' }, async () => {
      expect((await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: page2('Erin is at acme-example.'), source_id: 'vault' },
        { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] })).isError).not.toBe(true);
    });
  }, 240_000);
  afterAll(async () => {
    await engine?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('the CLI context marks a cwd inside a checkout, and not one outside every checkout', async () => {
    expect(await cliFlags(join(dir, 'notes-b', 'sub'))).toEqual({ sourceId: 'notes-b', localSourceImplicit: true, localSourceFromCheckout: true });
    expect(await cliFlags(join(dir, 'elsewhere'))).toEqual({ sourceId: 'default', localSourceImplicit: true });
  }, 120_000);

  test('put_page, put_pages and an upload run inside notes-b write to notes-b and are not refused', async () => {
    const cwd = join(dir, 'notes-b', 'sub');
    const single = await callFrom(cwd, 'put_page', { slug: SLUG, content: page2('Erin, written from the notes-b checkout.') });
    expect(single.isError, single.text).toBe(false);
    expect(single.body.source_id).toBe('notes-b');
    const batch = await callFrom(cwd, 'put_pages', { request_id: randomUUID(), pages: [{ slug: 'people/ida-example', content: page2('Ida.') }] });
    expect(batch.body).toMatchObject({ state: 'committed', source_id: 'notes-b' });
    const text = page2('Erin by upload from notes-b.');
    const begun = await callFrom(cwd, 'begin_page_upload', { slug: 'people/jo-example', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    expect(begun.isError, begun.text).toBe(false);
    expect((await callFrom(cwd, 'upload_page_part', { upload_id: begun.body.upload_id, part: 0, text, part_sha256: hex(text) })).isError).toBe(false);
    const committed = await callFrom(cwd, 'commit_page_upload', { upload_id: begun.body.upload_id });
    expect(committed.isError, committed.text).toBe(false);
    expect(committed.body.source_id).toBe('notes-b');
    expect(await compiled(SLUG, 'notes-b')).toContain('notes-b checkout');
    expect(await compiled('people/jo-example', 'notes-b')).toContain('upload from notes-b');
    expect(await compiled(SLUG, 'vault')).toContain('acme-example'); // vault's page is untouched
    expect(await row(SLUG, 'default')).toBeNull();
  }, 120_000);

  test('the same puts run outside every checkout still refuse the fork', async () => {
    const cwd = join(dir, 'elsewhere');
    const slug = 'people/kai-example';
    expect((await dispatchToolCall(engine, 'put_page', { slug, content: page2('Kai.'), source_id: 'vault' }, { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] })).isError).not.toBe(true);
    const single = await callFrom(cwd, 'put_page', { slug, content: page2('Kai again.') });
    expect(single.isError).toBe(true);
    expect(single.body).toMatchObject({ detail: 'slug_in_other_source', message: refusal(slug) });
    const batch = await callFrom(cwd, 'put_pages', { request_id: randomUUID(), pages: [{ slug, content: page2('Kai again.') }] });
    expect(batch.body.pages[0]).toMatchObject({ state: 'refused', error: { detail: 'slug_in_other_source' } });
    const text = page2('Kai by upload.');
    const begun = await callFrom(cwd, 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    expect(begun.body).toMatchObject({ detail: 'slug_in_other_source' });
    expect(await row(slug, 'default')).toBeNull();
  }, 120_000);

  test('an upload commit retried from inside the holding source checkout is still refused, and forks nothing', async () => {
    // The commit writes to the source fixed at its begin (default here), so running it from vault's checkout names nothing.
    const slug = 'people/lea-example';
    const text = page2('Lea by upload.');
    const begun = await callFrom(join(dir, 'elsewhere'), 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() });
    expect(begun.isError, begun.text).toBe(false); // nothing lives at the slug yet, so the begin is fine
    expect((await callFrom(join(dir, 'elsewhere'), 'upload_page_part', { upload_id: begun.body.upload_id, part: 0, text, part_sha256: hex(text) })).isError).toBe(false);
    expect((await dispatchToolCall(engine, 'put_page', { slug, content: page2('Lea is at vault-co.'), source_id: 'vault' }, { remote: false, sourceId: 'default', localSourceImplicit: true, takesHoldersAllowList: ['world'] })).isError).not.toBe(true);
    const outside = await callFrom(join(dir, 'elsewhere'), 'commit_page_upload', { upload_id: begun.body.upload_id });
    expect(outside.isError).toBe(true);
    expect(outside.body.detail).toBe('slug_in_other_source');
    expect(outside.body.message).toBe(refusal(slug));
    const fromVault = await callFrom(join(dir, 'vault', 'sub'), 'commit_page_upload', { upload_id: begun.body.upload_id });
    expect(fromVault.isError, fromVault.text).toBe(true);
    expect(fromVault.body.detail).toBe('slug_in_other_source');
    expect(fromVault.body.message).toBe(refusal(slug));
    expect(await row(slug, 'default')).toBeNull();
    expect(await compiled(slug, 'vault')).toContain('vault-co');
    expect(await compiled(slug, 'vault')).not.toContain('Lea by upload.');
    expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE slug = $1', [slug]))[0]!.n)).toBe(1);
    // The live owner's request path marks a checkout for put_page, put_pages and begin_page_upload, never for a commit.
    expect(await sourceNamedByCheckout(engine, 'begin_page_upload', join(dir, 'vault', 'sub'), 'vault')).toBe(true);
    expect(await sourceNamedByCheckout(engine, 'commit_page_upload', join(dir, 'vault', 'sub'), 'vault')).toBe(false);
  }, 120_000);
});
