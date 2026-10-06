/**
 * #5052 (kept suspended): every remote code read is refused with an error
 * that names the follow-up and the code search that still works, while the
 * trusted local CLI keeps the read. Authoring gate: (1) protects the refusal
 * text and fix for all six code-read ops on stdio and HTTP and the local
 * lane; (2) fails when a refusal stops naming the follow-up or the local
 * read starts refusing; (3) code-intel-source-scope pins the suspension
 * itself, not what it tells the agent; (4) no production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const CODE_READS = ['code_callers', 'code_callees', 'code_def', 'code_refs', 'code_blast', 'code_flow'] as const;
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

const ctxOf = (overrides: Partial<OperationContext>): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: true, transport: 'stdio', ...overrides,
} as OperationContext);
const paramsFor = (name: string) => ('entry_point' in operationsByName[name]!.params ? { entry_point: 'exampleFn' } : { symbol: 'exampleFn' });

describe('remote code reads stay suspended with a useful refusal', () => {
  for (const name of CODE_READS) {
    for (const transport of ['stdio', 'http'] as const) {
      test(`${name} over ${transport}`, async () => {
        let thrown: unknown;
        try { await operationsByName[name]!.handler(ctxOf({ transport }), paramsFor(name)); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(OperationError);
        const error = thrown as OperationError;
        expect(error.code).toBe('permission_denied');
        expect(error.message).toContain('remote code reads stay suspended');
        expect(error.message).toContain('garrytan/gbrain#5052');
        expect(error.message).toContain('Code search (search, query) still works here.');
        expect(JSON.stringify(error.toJSON())).toContain(`"gbrain","call","${name}"`);
      });
    }
    test(`${name} through MCP stdio dispatch`, async () => {
      const result = await dispatchToolCall(engine, name, paramsFor(name), { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('garrytan/gbrain#5052');
    });
    test(`${name} on the trusted local CLI still runs`, async () => {
      await expect(operationsByName[name]!.handler(ctxOf({ remote: false, transport: undefined }), paramsFor(name))).resolves.toBeDefined();
    });
  }
});
