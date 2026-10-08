/**
 * Wave 12 W4.5: `gbrain reindex --markdown` re-embeds pages, which is paid
 * work, so it asks first. A non-interactive run without `--yes`/`--max-usd`
 * exits 3 with an ask_user payload naming the page count and estimate and
 * makes no provider call; `--dry-run`, `--no-embed` and a keyless brain stay
 * free. A queued `reindex` job re-embeds only under the spend authorization
 * stored at submit time; one queued without it fails with the refusal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { run as runReindexCli } from '../src/cli/commands/reindex.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isConsentRefusal } from '../src/core/consent.ts';
import { makeReindexHandler } from '../src/core/minions/handlers/reindex.ts';
import { jobSpendAuthorization } from '../src/core/minions/spend-authorization.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let engine: PGLiteEngine;
let embedCalls = 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  _resetCliExitVerdictForTests();
  embedCalls = 0;
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake-reindex-consent' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    embedCalls++;
    return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)), usage: { tokens: 1 } };
  }) as never);
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  for (const slug of ['notes/one', 'notes/two', 'notes/three']) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, chunker_version, contextual_retrieval_mode)
       VALUES ('default', $1, 'note', $1, $2, 'markdown', 1, NULL)`,
      [slug, `Body of ${slug} with enough words to chunk and embed.`]);
  }
});
afterEach(() => { __setEmbedTransportForTests(null); resetGateway(); });

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = '';
  (process.stdout.write as unknown as (c: unknown) => boolean) = (c: unknown) => { stdout += String(c); return true; };
  (process.stderr.write as unknown as (c: unknown) => boolean) = () => true;
  try { return { result: await fn(), stdout }; } finally { process.stdout.write = out; process.stderr.write = err; }
}

const lagging = async () => Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE chunker_version = 1`))[0]!.n);

describe('W4.5: reindex --markdown asks before re-embedding', () => {
  test('the CLI without approval exits 3 with an ask_user payload (page count, estimate, --yes command) and spends nothing', async () => {
    const { stdout } = await quiet(() => runReindexCli(engine, ['--markdown', '--json']));
    expect(currentExitCode()).toBe(3);
    const doc = JSON.parse(stdout);
    expect(doc.code).toBe('confirmation_required');
    expect(doc.effects).toEqual(['paid']);
    expect(doc.user_message).toContain('3 page(s)');
    expect(typeof doc.est_usd).toBe('number');
    expect(doc.fix.next).toBe('ask_user');
    expect(doc.fix.argv).toEqual(['gbrain', 'reindex', '--markdown', '--yes']);
    expect(doc.preview.argv).toEqual(['gbrain', 'reindex', '--markdown', '--dry-run']);
    expect(embedCalls).toBe(0);
    expect(await lagging()).toBe(3);
  });

  test('runReindex itself refuses for an unattended caller, so no path skips the gate', async () => {
    let thrown: unknown;
    try { await quiet(() => runReindex(engine, ['--markdown'], { interactive: false })); } catch (e) { thrown = e; }
    expect(isConsentRefusal(thrown)).toBe(true);
    expect(embedCalls).toBe(0);
  });

  test('--dry-run, --no-embed and a keyless brain never ask', async () => {
    await quiet(() => runReindexCli(engine, ['--markdown', '--dry-run']));
    expect(currentExitCode()).toBe(0);
    await quiet(() => runReindexCli(engine, ['--markdown', '--no-embed']));
    expect(currentExitCode()).toBe(0);
    expect(await lagging()).toBe(0);
    expect(embedCalls).toBe(0);
    await engine.executeRaw(`UPDATE pages SET chunker_version = 1, contextual_retrieval_mode = NULL`);
    __setEmbedTransportForTests(null);
    resetGateway();
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: {} });
    await quiet(() => runReindexCli(engine, ['--markdown']));
    expect(currentExitCode()).not.toBe(3);
  });

  test('--yes approves the run', async () => {
    await quiet(() => runReindexCli(engine, ['--markdown', '--yes']));
    expect(currentExitCode()).toBe(0);
    expect(await lagging()).toBe(0);
  });

  test('a cap below the estimate refuses before anything runs', async () => {
    await engine.executeRaw(`UPDATE pages SET compiled_truth = repeat('word ', 2000000) WHERE slug = 'notes/one'`);
    await quiet(() => runReindexCli(engine, ['--markdown', '--max-usd', '0.0001', '--json']));
    expect(currentExitCode()).toBe(1);
    expect(embedCalls).toBe(0);
    expect(await lagging()).toBe(3);
  });
});

describe('W12 P1: the inline run enforces the approved cap while it spends', () => {
  test('--max-usd stops the run once measured spend passes the cap; the rest stays pending', async () => {
    // Each embedding call reports 10M tokens (about $0.20 on text-embedding-3-small); the up-front estimate is tiny.
    __setEmbedTransportForTests((async (args: { values: string[] }) => {
      embedCalls++;
      return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.01)), usage: { tokens: 10_000_000 } };
    }) as never);
    const { stdout } = await quiet(() => runReindexCli(engine, ['--markdown', '--max-usd', '0.05', '--json']));
    expect(currentExitCode()).toBe(1);
    const doc = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(doc.budget_exhausted).toMatchObject({ cap_usd: 0.05 });
    expect(embedCalls).toBeLessThan(3);
    expect(await lagging()).toBeGreaterThan(0);
  });
});

describe('W4.5: the reindex job handler', () => {
  const ctx = (spend?: boolean): MinionJobContext => ({
    id: 41, name: 'reindex', data: { markdown: true }, attempts_made: 0, signal: new AbortController().signal,
    ...(spend ? { spend: { record: jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 5, cap_source: 'user', via: 'yes' }, { command: 'jobs submit reindex', of: 1 }), budget_key: 'group:x' } } : {}),
  }) as unknown as MinionJobContext;

  test('a queued job without a stored authorization fails with confirmation_required and spends nothing', async () => {
    let thrown: unknown;
    try { await quiet(() => makeReindexHandler(engine)(ctx(false))); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(String((thrown as Error).message)).toContain('confirmation_required');
    expect(embedCalls).toBe(0);
    expect(await lagging()).toBe(3);
  });

  test('a queued job with its stored authorization runs', async () => {
    const { result } = await quiet(() => makeReindexHandler(engine)(ctx(true)));
    expect((result as { ran: string }).ran).toBe('reindex');
    expect(await lagging()).toBe(0);
  });
});

describe('W4.5: jobs submit reindex stores the approval on the job', () => {
  let home: string;
  let brainPath: string;
  const env = { GBRAIN_INTERACTIVE: undefined, OPENAI_API_KEY: 'sk-fake-reindex-submit' };
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-reindex-submit-'));
    brainPath = join(home, '.gbrain', 'brain.pglite');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: brainPath,
      embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536 }));
    const e = new PGLiteEngine();
    await e.connect({ engine: 'pglite', database_path: brainPath });
    await e.initSchema();
    await e.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, chunker_version)
      VALUES ('default', 'notes/queued', 'note', 'Queued', 'Body to re-embed.', 'markdown', 1)`);
    await e.disconnect();
  }, 120_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const rows = async () => {
    const e = new PGLiteEngine();
    await e.connect({ engine: 'pglite', database_path: brainPath });
    try { return await e.executeRaw<{ name: string; spend_authorization: Record<string, unknown> | null }>('SELECT name, spend_authorization FROM minion_jobs ORDER BY id'); }
    finally { await e.disconnect(); }
  };

  test('without --yes it exits 3 and queues nothing; with --yes the row carries an authorized record', async () => {
    const refused = await runCli(['jobs', 'submit', 'reindex', '--params', '{"markdown":true}', '--queue-only', '--json'], { home, env, timeoutMs: 90_000 });
    expect(refused.exitCode).toBe(3);
    expect(JSON.parse(refused.stdout)).toMatchObject({ code: 'confirmation_required', effects: ['paid'] });
    expect(await rows()).toEqual([]);
    const approved = await runCli(['jobs', 'submit', 'reindex', '--params', '{"markdown":true}', '--queue-only', '--yes'], { home, env, timeoutMs: 90_000 });
    expect(approved.exitCode).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({ name: 'reindex', spend_authorization: { kind: 'authorized', command: 'jobs submit reindex' } });
  }, 200_000);
});
