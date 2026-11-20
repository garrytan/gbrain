/**
 * BrainEngine parity: the request_tools `{surface}` persist (src/core/ops/request-tools.ts) end to end: the client's
 * surface and pin are patched, and the `surface_change` audit row (src/core/surface-audit.ts, `logMcpRequest`) is written.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a client that persists a surface ends with that surface and `surface_set_by = 'self'`, and the request log
 *    holds one successful `surface_change` row under its token name; a client the operator pinned is refused with
 *    `permission_denied`, keeps its surface and gets no audit row. The same answer on every engine arm, and no
 *    `[surface-audit]` warning (the audit write swallows its own failure, so a refused audit would be silent otherwise).
 *  - Regression: an engine that persists the surface but loses the audit row (the write is best-effort and says so only on
 *    stderr), or one that audits a refused persist.
 *  - Why existing coverage misses it: test/request-tools.test.ts reads `mcp_request_log` with raw SQL on PGLite.
 *  - Seam: the op handler is called directly (dispatchToolCall's caller-access reads are raw SQL that a Rust brain refuses, a separate gap). The audit row is read back through `readClientOpUsage`, the typed per-token operation tally of the log.
 */
import { describe, expect } from 'bun:test';
import { operations, __resetRequestToolsPersistLimiterForTests } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const requestTools = operations.find((o) => o.name === 'request_tools')!;

describe('engine parity: request_tools surface persist', () => {
  parityTest('a persisted surface patches the client and writes one surface_change audit row; an operator pin is refused and not audited',
    { methods: ['insertOauthClient', 'readOauthClient', 'patchOauthClient', 'logMcpRequest', 'readClientOpUsage'] }, async (engine) => {
      __resetRequestToolsPersistLimiterForTests();
      await engine.insertOauthClient({ client_id: 'free', client_name: 'free' });
      await engine.insertOauthClient({ client_id: 'self-pinned', client_name: 'self-pinned', surface: 'full', surface_set_by: 'self' });
      await engine.insertOauthClient({ client_id: 'op-pinned', client_name: 'op-pinned', surface: 'verbs', surface_set_by: 'operator' });
      const warnings: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (String(chunk).includes('[surface-audit]')) { warnings.push(String(chunk)); return true; }
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      const answers: Record<string, unknown> = {};
      try {
        for (const [id, surface] of [['free', 'starter'], ['self-pinned', 'verbs'], ['op-pinned', 'starter']] as const) {
          const ctx = {
            engine, config: { engine: engine.kind } as OperationContext['config'], remote: true, transport: 'http', sourceId: 'default', dryRun: false,
            logger: { info() {}, warn() {}, error() {} }, surfaceCeiling: 'full', auth: { token: 't', clientId: id, scopes: ['read'] },
          } as unknown as OperationContext;
          try {
            const body = await requestTools.handler(ctx, { surface }) as Record<string, unknown>;
            answers[id] = { persisted: body.persisted, surface: body.surface, error: null };
          } catch (e) {
            answers[id] = { persisted: false, surface: surface, error: (e as { code?: string }).code ?? String(e) };
          }
        }
      } finally {
        process.stderr.write = write;
      }
      const rows = await Promise.all(['free', 'self-pinned', 'op-pinned'].map(async id => {
        const r = await engine.readOauthClient(id);
        return { id, surface: r?.surface, surface_set_by: r?.surface_set_by };
      }));
      const audits = (await engine.readClientOpUsage(1))
        .filter(r => r.operation === 'surface_change')
        .map(r => ({ token_name: r.token_name, operation: r.operation, n: r.n }))
        .sort((a, b) => ((a.token_name ?? '') < (b.token_name ?? '') ? -1 : 1));
      expect(warnings).toEqual([]);
      expect(audits).toEqual([{ token_name: 'free', operation: 'surface_change', n: 1 }, { token_name: 'self-pinned', operation: 'surface_change', n: 1 }]);
      expect(rows).toEqual([
        { id: 'free', surface: 'starter', surface_set_by: 'self' },
        { id: 'self-pinned', surface: 'verbs', surface_set_by: 'self' },
        { id: 'op-pinned', surface: 'verbs', surface_set_by: 'operator' },
      ]);
      return { answers, rows, audits };
    });
});
