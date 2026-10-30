/**
 * #7305 part 1: put_page and capture admit a NEW slug with a hyphen run (`notes/x-1900---2000-ab`) or a segment-final
 * hyphen, publish its file at that slug path, and every path-derived reader (sync, import) folds the file's slug to
 * `notes/x-1900-2000-ab`: the page keeps its identity only through the `slug:` line the render stamps (#5966), and a
 * file that loses it imports as a second page. Such a new slug is refused before admission with the folded slug as the
 * recovery (the #4807 `.md` rule); a live page that already holds the exact slug keeps accepting updates with a
 * `slug_advisory`, and the folded slug's own page is never touched.
 *
 * Trusted local CLI (remote=false) and MCP (remote=true) callers, PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { resolveSlugForPath } from '../src/core/sync.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

const HYPHEN_RUN = 'notes/x-1900---2000-ab';
const FOLDED = 'notes/x-1900-2000-ab';
const content = '---\ntitle: Example\n---\n\nexample body';

for (const backend of testBackends()) describe(`[${backend}] #7305 hyphen-run slugs at write time`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let tmpRoot: string;
  let brainDir: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7305-'));
    brainDir = path.join(tmpRoot, 'brain');
    fs.mkdirSync(brainDir, { recursive: true });
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
    await engine.setConfig('sync.repo_path', brainDir);
    // Postgres refuses writes to an unbound classic checkout, so the source gets a canonical owner on both engines.
    execFileSync('git', ['-C', brainDir, 'init', '-q']);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, () => claimWorktree(engine, 'default', brainDir));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await close(); resetGateway(); fs.rmSync(tmpRoot, { recursive: true, force: true }); }, 60_000);
  beforeEach(() => resetGateway());

  const ctx = (overrides: Partial<OperationContext> = {}): OperationContext => ({
    engine, config: { engine: backend, embedding_disabled: true } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', ...overrides,
  });
  const run = (name: 'put_page' | 'capture', c: OperationContext, params: Record<string, unknown>) =>
    withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, () => operations.find(o => o.name === name)!.handler(c, params)) as Promise<Record<string, unknown>>;
  async function refusalOf(promise: Promise<unknown>): Promise<OperationError> {
    try { await promise; } catch (error) { return error as OperationError; }
    throw new Error('expected a refusal');
  }
  const requests = async () => Number((await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM persistence_requests'))[0]!.n);
  const row = async (slug: string) => (await engine.executeRaw<{ id: number; compiled_truth: string }>(
    "SELECT id, compiled_truth FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0] ?? null;
  const fixture = (slug: string, body: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
    tx.putPage(slug, { type: 'note', title: 'Example', compiled_truth: body, timeline: '' }, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
  /** A page an earlier gbrain wrote under a hyphen-run slug, with its stamped file. */
  async function legacyPage(slug: string, body: string) {
    await fixture(slug, body);
    const file = path.join(brainDir, `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ntype: note\ntitle: Example\nslug: ${slug}\n---\n\n${body}\n`);
    await engine.executeRaw("UPDATE pages SET source_path=$2 WHERE source_id='default' AND slug=$1", [slug, `${slug}.md`]);
    return (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  }

  test('put_page from the trusted CLI refuses a new hyphen-run or hyphen-ended slug before admission, naming the folded slug', async () => {
    const before = await requests();
    for (const [slug, folded] of [[HYPHEN_RUN, FOLDED], ['notes/x-example-', 'notes/x-example'], ['Notes/A--B/c-example', 'notes/a-b/c-example']]) {
      const error = await refusalOf(run('put_page', ctx(), { slug, content }));
      expect(error).toBeInstanceOf(OperationError);
      expect(error.code).toBe('invalid_params');
      expect(error.detail).toBe('slug_hyphen_run');
      expect(error.suggestion).toBe(`Write the page as ${folded}: gbrain put ${folded}`);
      expect(error.fix).toMatchObject({ argv: ['gbrain', 'get', folded], verify: { argv: ['gbrain', 'get', folded] } });
    }
    expect(await requests()).toBe(before);
    expect(await row(HYPHEN_RUN)).toBeNull();
    expect(fs.existsSync(path.join(brainDir, `${HYPHEN_RUN}.md`))).toBe(false);
  });

  test('put_page from an MCP caller (remote=true) gets the same refusal with the MCP recovery; the CLI envelope carries why and fix', async () => {
    const remote = await refusalOf(run('put_page', ctx({ remote: true }), { slug: 'notes/m-1900---2000-ab', content }));
    expect(remote.code).toBe('invalid_params');
    expect(remote.detail).toBe('slug_hyphen_run');
    expect(remote.suggestion).toBe(`Call put_page again with slug "${'notes/m-1900-2000-ab'}" and the same content.`);
    expect(remote.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug: 'notes/m-1900-2000-ab' } });
    const { toAgentError, cliRenderContext } = await import('../src/core/agent-output.ts');
    const cli = toAgentError(await refusalOf(run('put_page', ctx(), { slug: 'notes/m-1900---2000-ab', content })), { transport: 'cli', command: 'put', render: cliRenderContext() });
    expect(cli).toMatchObject({ code: 'invalid_params', class: 'caller', contract_version: 1 });
    expect(cli.why).toContain('notes/m-1900-2000-ab');
    expect(cli.fix).toMatchObject({ argv: ['gbrain', 'get', 'notes/m-1900-2000-ab'], next: 'run' });
    expect(await row('notes/m-1900---2000-ab')).toBeNull();
  });

  test('capture refuses a new hyphen-run slug for CLI and MCP callers, and dry runs of put_page and capture refuse too', async () => {
    const before = await requests();
    const cli = await refusalOf(run('capture', ctx(), { slug: 'notes/c-1900---2000-ab', content: 'captured example text' }));
    expect(cli.code).toBe('invalid_params');
    expect(cli.detail).toBe('slug_hyphen_run');
    expect(cli.suggestion).toBe(`Write the page as ${'notes/c-1900-2000-ab'}: gbrain capture --slug ${'notes/c-1900-2000-ab'}`);
    const remote = await refusalOf(run('capture', ctx({ remote: true }), { slug: 'notes/c-1900---2000-ab', content: 'captured example text' }));
    expect(remote.detail).toBe('slug_hyphen_run');
    expect(remote.suggestion).toBe(`Call capture again with slug "${'notes/c-1900-2000-ab'}" and the same content.`);
    for (const name of ['put_page', 'capture'] as const) {
      const dry = await refusalOf(run(name, ctx({ dryRun: true }), { slug: 'notes/c-1900---2000-ab', content }));
      expect(dry.detail).toBe('slug_hyphen_run');
    }
    expect(await requests()).toBe(before);
    expect(await row('notes/c-1900---2000-ab')).toBeNull();
  });

  test('the folded slug writes with no advisory, and its file imports as that same slug', async () => {
    const put = await run('put_page', ctx({ remote: true }), { slug: FOLDED, content });
    expect(put.slug_advisory).toBeUndefined();
    const captured = await run('capture', ctx(), { slug: 'notes/y-example', content: 'captured example text' });
    expect(captured.slug_advisory).toBeUndefined();
    const [page] = await engine.executeRaw<{ source_path: string }>("SELECT source_path FROM pages WHERE source_id='default' AND slug=$1", [FOLDED]);
    expect(resolveSlugForPath(page!.source_path)).toBe(FOLDED);
  });

  test('a live page that already holds a hyphen-run slug stays writable by that slug (put and capture, CLI and MCP) with an advisory; the folded page is untouched', async () => {
    const existing = 'notes/z-1900---2000-ab', other = 'notes/z-1900-2000-ab';
    await fixture(other, 'a different page');
    const snapshot = await legacyPage(existing, 'old body');
    const advisory = `This page's slug has a hyphen run or a segment-final hyphen, which new pages cannot use: its file path imports as "${other}", so the page keeps its identity only through the slug: line in its file. To move it, put_page its content under "${other}", then delete_page "${existing}".`;

    const cli = await run('put_page', ctx(), { slug: existing, content: '---\ntitle: Example\n---\n\ncli body', expected_revision: snapshot.revision });
    expect(cli.slug_advisory).toBe(advisory);
    expect(Number((await row(existing))!.id)).toBe(Number(snapshot.page.id));
    expect((await row(existing))!.compiled_truth).toContain('cli body');

    const afterCli = (await engine.readPageSnapshot(existing, { sourceId: 'default' }))!;
    const mcp = await run('put_page', ctx({ remote: true }), { slug: existing, content: '---\ntitle: Example\n---\n\nmcp body', expected_revision: afterCli.revision });
    expect(mcp.slug_advisory).toBe(advisory);
    expect((await row(existing))!.compiled_truth).toContain('mcp body');

    for (const remote of [false, true]) {
      const current = (await engine.readPageSnapshot(existing, { sourceId: 'default' }))!;
      const captured = await run('capture', ctx({ remote }), { slug: existing, content: `captured ${remote ? 'mcp' : 'cli'} text`, expected_revision: current.revision });
      expect(captured.slug_advisory).toBe(advisory);
      expect(Number((await row(existing))!.id)).toBe(Number(snapshot.page.id));
    }
    expect((await row(other))!.compiled_truth).toBe('a different page');
    expect(fs.readFileSync(path.join(brainDir, `${existing}.md`), 'utf8')).toContain(`slug: ${existing}`);
  });

  test('a soft-deleted hyphen-run row is not live: re-creating it is refused', async () => {
    await legacyPage('notes/gone--example', 'gone');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
      tx.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='default' AND slug='notes/gone--example'"), TEST_WRITE_ATTRIBUTION));
    const error = await refusalOf(run('put_page', ctx(), { slug: 'notes/gone--example', content }));
    expect(error.detail).toBe('slug_hyphen_run');
  });
});
