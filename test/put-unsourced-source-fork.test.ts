/**
 * pages-02: a local put that names no source must not fork a page that lives in another source.
 * 1. Protects: once 'default' holds a page, an unsourced `gbrain put <slug>` (with or without --force) of a slug
 *    that lives only in the git source is refused with the holding source and the exact retry command, and no
 *    second copy appears in 'default'; `put --force --source-id <source>` still writes to that source; an unsourced
 *    put of a new slug still goes to 'default' and prints the documented routing-flip notice even when the git
 *    source is federated.
 * 2. Fails when: the put forks a shadow copy that an unscoped get prefers (the old behavior), the refusal text
 *    changes, a sourced put is refused, or the flip notice is silent.
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
