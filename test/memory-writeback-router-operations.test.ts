import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operationsByName, parseOpArgs, type OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const sourceRefs = ['Source: User, direct message, 2026-05-10 12:00 KST'];

async function withEngine<T>(run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-writeback-router-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function ctx(engine: OperationContext['engine'], dryRun = false): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun,
  };
}

describe('memory writeback router operation', () => {
  test('is registered as a mutating operation with CLI hint', () => {
    const op = operationsByName.route_memory_writeback;
    expect(op).toBeDefined();
    expect(op.mutating).toBe(true);
    expect(op.cliHints?.name).toBe('route-memory-writeback');
    expect(op.params.evidence_kind.enum).toContain('agent_inferred');
    expect(op.params.apply.type).toBe('boolean');
    expect(op.params.dry_run.type).toBe('boolean');
  });

  test('CLI parser accepts dry-run for the router operation', () => {
    const warnings: string[] = [];
    const params = parseOpArgs(operationsByName.route_memory_writeback, [
      '--content',
      'The router should expose dry-run through CLI parsing.',
      '--evidence-kind',
      'direct_user_statement',
      '--source-refs',
      JSON.stringify(sourceRefs),
      '--apply',
      '--dry-run',
    ], { warn: (msg) => warnings.push(msg) });

    expect(warnings).toEqual([]);
    expect(params.apply).toBe(true);
    expect(params.dry_run).toBe(true);
  });

  test('apply false does not read or mutate the engine', async () => {
    const engine = new Proxy({}, {
      get() {
        throw new Error('route_memory_writeback planning must not read the engine');
      },
    }) as unknown as OperationContext['engine'];

    const result = await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The router should create candidates for inferred claims.',
      evidence_kind: 'agent_inferred',
      source_refs: sourceRefs,
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
    }) as any;

    expect(result.decision).toBe('create_candidate');
    expect(result.applied).toBe(false);
    expect(result.created_candidate).toBeUndefined();
  });

  test('accepts source_refs as a CLI JSON array string', async () => {
    const engine = new Proxy({}, {
      get() {
        throw new Error('route_memory_writeback planning must not read the engine');
      },
    }) as unknown as OperationContext['engine'];

    const result = await operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'The router should accept source_refs from CLI JSON strings.',
      evidence_kind: 'direct_user_statement',
      source_refs: JSON.stringify(sourceRefs),
    }) as any;

    expect(result.decision).toBe('create_candidate');
    expect(result.candidate_input.source_refs).toEqual(sourceRefs);
  });

  test('rejects invalid source_refs JSON array strings', async () => {
    const engine = {} as unknown as OperationContext['engine'];

    await expect(operationsByName.route_memory_writeback.handler(ctx(engine), {
      content: 'This source ref shape is invalid.',
      evidence_kind: 'direct_user_statement',
      source_refs: '[123]',
    })).rejects.toThrow(/source_refs/);
  });

  test('dry run ignores apply true and does not create a candidate', async () => {
    await withEngine(async (engine) => {
      const result = await operationsByName.route_memory_writeback.handler(ctx(engine, true), {
        content: 'The router should keep dry-run planning non-mutating.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        apply: true,
      }) as any;

      expect(result.dry_run).toBe(true);
      expect(result.applied).toBe(false);
      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });

  test('apply true creates a candidate and status event with interaction id', async () => {
    await withEngine(async (engine) => {
      const result = await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The router stores inferred durable claims as reviewable candidates.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        interaction_id: 'trace-router-1',
        apply: true,
      }) as any;

      expect(result.decision).toBe('create_candidate');
      expect(result.applied).toBe(true);
      expect(result.created_candidate).toMatchObject({
        candidate_type: 'fact',
        source_refs: sourceRefs,
        extraction_kind: 'inferred',
        status: 'candidate',
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
      });
      expect(result.duplicate_review.decision).toBeDefined();

      const events = await engine.listMemoryCandidateStatusEvents({
        candidate_id: result.created_candidate.id,
        limit: 10,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.interaction_id).toBe('trace-router-1');
    });
  });

  test('duplicate review failure does not leave behind a created candidate', async () => {
    await withEngine(async (engine) => {
      (engine as any).listPages = async () => {
        throw new Error('duplicate review failed');
      };

      await expect(operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'The router should not create candidates when duplicate review fails.',
        evidence_kind: 'agent_inferred',
        source_refs: sourceRefs,
        target_object_type: 'curated_note',
        target_object_id: 'systems/mbrain',
        apply: true,
      })).rejects.toThrow('duplicate review failed');

      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });

  test('missing provenance defers and does not create a candidate', async () => {
    await withEngine(async (engine) => {
      const result = await operationsByName.route_memory_writeback.handler(ctx(engine), {
        content: 'This inferred claim has no source.',
        evidence_kind: 'agent_inferred',
        apply: true,
      }) as any;

      expect(result.decision).toBe('defer');
      expect(result.applied).toBe(false);
      expect(result.missing_requirements).toEqual(['source_refs']);
      expect(await engine.listMemoryCandidateEntries({ limit: 10 })).toEqual([]);
    });
  });
});
