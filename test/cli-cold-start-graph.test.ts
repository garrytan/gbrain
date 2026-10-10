/**
 * CLI cold start (GBRA-75 wave 11): pins the module-graph cuts that keep a
 * local command off code it never runs, and that each cut leaves behavior
 * unchanged.
 *
 * - runSharedOperation loads only the module that defines the op
 *   (src/core/operation-load.ts) and finalizes it exactly as
 *   src/core/operations.ts does: same object, same area, same redaction
 *   wrapper, never wrapped twice when the registry loads later.
 * - factEmbeddingDisabled reads the persistence consumer's config through a
 *   reader persistence/service.ts registers as it loads, so a read-only
 *   command never imports that graph.
 * - Importing the CLI dispatcher loads neither the MCP SDK (remote calls only)
 *   nor the search evidence-delivery graph; configuring the AI gateway loads
 *   no AI SDK until a provider call runs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { resolve } from 'path';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { loadOperation } from '../src/core/operation-load.ts';
import { operations, operationsByName } from '../src/core/operations.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
// The gateway probe configures only its own subprocess; reset anyway so this
// file never leaves a configured gateway behind in its shard.
afterAll(() => resetGateway());

function probe(lines: string[]): unknown {
  const out = Bun.spawnSync([process.execPath, '-e', lines.join('\n')], {
    cwd: REPO_ROOT,
    env: { ...process.env, GBRAIN_HOME: '/nonexistent-gbrain-home' },
  });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString().trim().split('\n').pop()!);
}

describe('per-op loading', () => {
  test('every registry op loads as the same finalized object', async () => {
    for (const op of operations) {
      expect(await loadOperation(op.name)).toBe(operationsByName[op.name]!);
    }
    expect(await loadOperation('no_such_op')).toBeUndefined();
  });

  test('a lone load finalizes like the registry, and the registry never re-wraps it', () => {
    const result = probe([
      "const { loadOperation } = await import('./src/core/operation-load.ts');",
      "const names = ['search', 'query', 'get_stats', 'get_page', 'remember', 'volunteer_context', 'list_pages'];",
      'const loaded = {};',
      'for (const n of names) { const op = await loadOperation(n); loaded[n] = { op, handler: op.handler, area: op.area }; }',
      "const registryLoaded = Object.keys(require.cache).some(k => k.endsWith('/src/core/operations.ts'));",
      "const { operationsByName } = await import('./src/core/operations.ts');",
      'console.log(JSON.stringify({ registryLoaded, rows: names.map(n => ({ n, same: operationsByName[n] === loaded[n].op, handler: operationsByName[n].handler === loaded[n].handler, area: loaded[n].area ?? null })) }));',
    ]) as { registryLoaded: boolean; rows: Array<{ n: string; same: boolean; handler: boolean; area: string | null }> };
    expect(result.registryLoaded).toBe(false);
    for (const row of result.rows) {
      expect(row).toEqual({ n: row.n, same: true, handler: true, area: operationsByName[row.n]!.area ?? null });
    }
  });

  test('retrieval ops carry the output-redaction wrapper on the lone-load path', () => {
    const result = probe([
      "const { loadOperation } = await import('./src/core/operation-load.ts');",
      "const { searchOperations } = await import('./src/core/ops/search.ts');",
      "const raw = searchOperations.find(o => o.name === 'search').handler;",
      "const op = await loadOperation('search');",
      "console.log(JSON.stringify({ policy: op.outputRedaction, wrapped: op.handler !== raw }));",
    ]) as { policy: unknown; wrapped: boolean };
    expect(result.policy).toBe(operationsByName.search!.outputRedaction);
    expect(result.wrapped).toBe(true);
  });
});

describe('cold-start module graph', () => {
  test('factEmbeddingDisabled without a running consumer does not load persistence/service.ts', () => {
    const loaded = probe([
      "const { factEmbeddingDisabled } = await import('./src/core/embedding-disabled.ts');",
      "const disabled = await factEmbeddingDisabled({ getConfig: async () => null });",
      "console.log(JSON.stringify({ disabled, service: Object.keys(require.cache).some(k => k.endsWith('/src/core/persistence/service.ts')) }));",
    ]);
    expect(loaded).toEqual({ disabled: false, service: false });
  });

  test('the CLI dispatcher and a configured gateway load no MCP SDK, AI SDK or evidence-delivery graph', () => {
    const loaded = probe([
      "await import('./src/cli/main.ts');",
      "const { configureGateway } = await import('./src/core/ai/gateway.ts');",
      "configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });",
      "console.log(JSON.stringify(Object.keys(require.cache).filter(k => /node_modules\\/(@modelcontextprotocol|ai|@opentelemetry)\\//.test(k) || k.endsWith('/src/core/search/evidence-delivery.ts') || k.endsWith('/src/core/mcp-client.ts')).map(k => k.replace(/.*node_modules\\//, '').split('/').slice(0, 2).join('/')).filter((v, i, a) => a.indexOf(v) === i)));",
    ]);
    expect(loaded).toEqual([]);
  });
});
