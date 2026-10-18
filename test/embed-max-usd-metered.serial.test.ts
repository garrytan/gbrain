/**
 * Fix wave 13 P1.18 (from PR #6400, credit @daveove): `gbrain embed` checked an
 * approved `--max-usd` only against the pre-run estimate, which is null for
 * `--slugs` and `--images`, so the run was never metered.
 * Protects: the CLI runs under the approved cap. A provider priced past it
 * after batch 1 stops the run with `reason: cost_cap`, exit
 * BUDGET_STOP_EXIT_CODE (not 1), batch 1's vectors kept, zero calls after the
 * stop, no failures recorded (no quarantine strike, no per-chunk fan-out),
 * and a resume command. `--images` stops the same way. A free provider (no
 * authorization) runs as before. PGLite `--background` runs inline, metered.
 * Serial: configures the AI gateway and fetch for the whole file.
 * Seams: __setEmbedTransportForTests, a fetch stub, GBRAIN_HOME temp dir.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { importFromContent, importImageFile } from '../src/core/import-file.ts';
import { run as runEmbedCli } from '../src/cli/commands/embed.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { requireEmbedBackfillConsent } from '../src/core/embed-consent.ts';
import { noteEmbedCostStop } from '../src/core/embed-cost-cap.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { BUDGET_STOP_EXIT_CODE } from '../src/core/exit-codes.ts';
import { runSources } from '../src/commands/sources.ts';
import { withEnv } from './helpers/with-env.ts';
import type { CliDispatchContext } from '../src/cli/command-table.ts';

const DIMS = 1536;
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d'];
let engine: PGLiteEngine;
let home: string;
let calls = 0;
let tokensPerCall = 1_000_000;
const origFetch = globalThis.fetch;
const ctx = { SELECTED_CONFIG_BY_ENGINE: new Map() } as unknown as CliDispatchContext;

function textGateway() {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    calls++;
    return { embeddings: values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: tokensPerCall } };
  }) as never);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-embed-cap-'));
  textGateway();
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60_000);
afterAll(async () => { __setEmbedTransportForTests(null); globalThis.fetch = origFetch; resetGateway(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  calls = 0; tokensPerCall = 1_000_000; _resetCliExitVerdictForTests(); textGateway();
  for (const slug of SLUGS) await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n\nA short note about ${slug} for the embedding cap test.\n`, { noEmbed: true });
  await engine.executeRaw('UPDATE content_chunks SET embedding = NULL, embedded_at = NULL');
});

const embedded = async () => (await engine.executeRaw<{ slug: string }>(
  'SELECT DISTINCT p.slug FROM pages p JOIN content_chunks c ON c.page_id = p.id WHERE c.embedding IS NOT NULL ORDER BY p.slug')).map(r => r.slug);
async function cli(args: string[]) {
  const out: string[] = [];
  const log = console.log;
  const write = process.stdout.write;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home }, () => runEmbedCli(engine, args, ctx)); } finally { console.log = log; process.stdout.write = write; }
  return { out: out.join('\n'), exit: currentExitCode() };
}

describe('embed --max-usd is metered', () => {
  test('--slugs: stops at the cap after batch 1, exit 11, batch 1 kept, no calls after, resume command printed', async () => {
    const { out, exit } = await cli(['--slugs', ...SLUGS, '--max-usd', '0.10']);
    expect(exit).toBe(BUDGET_STOP_EXIT_CODE);
    expect(calls).toBe(1);
    expect(await embedded()).toEqual(['notes/a']);
    expect(out).toContain('[embed] stopped (reason: cost_cap)');
    expect(out).toContain(`gbrain embed --slugs ${SLUGS.join(' ')} --max-usd <usd>`);
  });

  test('the result records the stop and no failure (no quarantine strike, no per-chunk fan-out)', async () => {
    const authorization = await withEnv({ GBRAIN_HOME: home }, () => requireEmbedBackfillConsent(engine, { command: 'embed', argv: ['gbrain', 'embed'], args: ['--max-usd', '0.10'], scope: { unestimated: true } }));
    const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home }, () => runEmbed(engine, ['--slugs', ...SLUGS, '--max-usd', '0.10', '--yes'], null, { authorization }));
    expect(result).toMatchObject({ reason: 'cost_cap', budget_reason: 'cost', cap_usd: 0.1, failures: 0, embedded: 1, failure_samples: [],
      resume_command: `gbrain embed --slugs ${SLUGS.join(' ')}` });
    expect(calls).toBe(1);
    const quoted = { reason: 'x' } as { reason?: string; resume_command?: string };
    noteEmbedCostStop(quoted, new BudgetExhausted('cap', { reason: 'cost', spent: 0.2, cap: 0.1 }), ['--slugs', 'notes/$(id)', '--max-usd', '0.1', '--yes']);
    expect(quoted.resume_command).toBe("gbrain embed --slugs 'notes/$(id)'");
  });

  test('--stale with multi-chunk pages: one provider call, then a clean stop (no per-chunk fan-out, no failures)', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${'Plain words about the cap test and its pages. '.repeat(40)}`).join('\n\n');
    for (const slug of ['long/one', 'long/two']) await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: note\n---\n\n${long}\n`, { noEmbed: true });
    await engine.executeRaw('UPDATE content_chunks SET embedding = NULL, embedded_at = NULL');
    const authorization = await withEnv({ GBRAIN_HOME: home }, () => requireEmbedBackfillConsent(engine, { command: 'embed', argv: ['gbrain', 'embed'], args: ['--max-usd', '0.10'], scope: { unestimated: true } }));
    const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home, GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbed(engine, ['--stale', '--max-usd', '0.10'], null, { authorization }));
    expect(result).toMatchObject({ reason: 'cost_cap', failures: 0, failure_samples: [], resume_command: 'gbrain embed --stale' });
    expect(calls).toBe(1);
  });

  test('a cap the run stays under changes nothing', async () => {
    tokensPerCall = 10;
    const { exit } = await cli(['--slugs', ...SLUGS, '--max-usd', '0.10']);
    expect(exit).toBe(0);
    expect(await embedded()).toEqual(SLUGS);
  });

  test('PGLite --background runs inline under the same cap', async () => {
    const { exit } = await cli(['--slugs', ...SLUGS, '--max-usd', '0.10', '--background']);
    expect(exit).toBe(BUDGET_STOP_EXIT_CODE);
    expect(calls).toBe(1);
  });

  test('a free provider needs no authorization and runs unmetered', async () => {
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: DIMS, env: {} });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { calls++; return { embeddings: values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: tokensPerCall } }; }) as never);
    const { exit } = await cli(['--slugs', ...SLUGS]);
    expect(exit).toBe(0);
    expect(calls).toBe(SLUGS.length);
  });
});

describe('embed --stale --images --max-usd is metered', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  test('stops before the second image once the first exceeded the cap', async () => {
    const dir = join(home, 'imgs'); mkdirSync(join(dir, 'photos'), { recursive: true });
    await withEnv({ GBRAIN_HOME: home }, () => runSources(engine, ['add', 'img', '--path', dir, '--no-federated', '--force']));
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, () => 0.1) }], usage: { total_tokens: 1_000_000 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    configureGateway({ embedding_model: 'voyage:voyage-multimodal-3', embedding_multimodal_model: 'voyage:voyage-multimodal-3', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'test-key' } });
    for (const name of ['one.png', 'two.png']) {
      writeFileSync(join(dir, 'photos', name), PNG);
      await importImageFile(engine, join(dir, 'photos', name), `photos/${name}`, { noEmbed: true, sourceId: 'img' });
    }
    const { out, exit } = await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => cli(['--stale', '--images', '--source', 'img', '--max-usd', '0.10', '--json']));
    expect(JSON.parse(out.slice(out.search(/^\{/m)))).toMatchObject({ reason: 'cost_cap', rebuilt: 1, failures: 0 });
    expect(exit).toBe(BUDGET_STOP_EXIT_CODE);
    expect(fetches).toBe(1);
  });
});
