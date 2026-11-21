/**
 * BrainEngine parity — the git-canonical write fence (`git_protocol_required`, GBRA-95 G7a).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on an unmanaged brain, a page write to a source whose `config.canonical` is `git` is admitted on every
 *    arm, with or without the git protocol declared. On a managed brain (persistence_brain.enabled), the SQL engines'
 *    managed writer guard (`gbrain_require_managed_writer`, src/core/persistence/writer-guard-schema.ts) refuses the
 *    same write from a writer in the source scope that does not declare `gbrain.git_protocol`, with SQLSTATE P0001,
 *    constraint `git_canonical_fence:mutation` and detail `{op, target_source, old_source}`, and admits it once the
 *    writer declares the protocol.
 *  - Regression: a Rust guard that refused unmanaged writes would split the arms on the first case; a guard change that
 *    stopped the managed refusal, or changed its code or detail, fails the second.
 *  - Why existing coverage misses it: no parity case wrote to a git-canonical source, so nothing pinned that the fence
 *    is a branch of the managed writer guard and therefore never fires on a brain that is not managed.
 *  - Seam: the second case turns managed mode on with raw SQL (activation has no typed member), so it declares
 *    `requires: 'raw_sql'` and the Rust arm stops on that refusal. The Rust store keeps one unmanaged brain
 *    (readManagedModeRows answers enabled: false), so the fence arrives with managed_persistence
 *    (rust/docs/store/write-guards.md). Neither case is fail-first: both pin behaviour all arms already have.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Fenced', compiled_truth: 'Body.', timeline: '' };
const STRICT = 'strict';
const SCOPE = JSON.stringify([STRICT]);

/** Thrown to roll a transaction back after it reported what it saw. */
class Rollback extends Error {}

/** The fields a refusal is compared on; PGLite and postgres.js name the constraint and table fields differently. */
function refusalView(error: unknown) {
  const e = error as { code?: unknown; message?: unknown; detail?: unknown; constraint?: unknown; constraint_name?: unknown;
    table?: unknown; table_name?: unknown };
  return {
    code: e.code ?? null,
    message: typeof e.message === 'string' ? e.message : String(error),
    constraint: e.constraint ?? e.constraint_name ?? null,
    table: e.table ?? e.table_name ?? null,
    detail: typeof e.detail === 'string' ? JSON.parse(e.detail) : null,
  };
}

/** Runs a scoped page write in its own transaction and reports `admitted` or the refusal; `managed` turns the guard on. */
async function scopedWrite(engine: BrainEngine, slug: string, opts: { managed: boolean; gitProtocol: boolean }) {
  let outcome: unknown = null;
  try {
    await engine.transaction(async (tx) => {
      if (opts.managed) await tx.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const names = ['gbrain.write_sources', ...(opts.gitProtocol ? ['gbrain.git_protocol'] : [])];
      await tx.applyTransactionSettings(names, [SCOPE, ...(opts.gitProtocol ? ['1'] : [])]);
      try {
        await tx.putPage(slug, NOTE, { sourceId: STRICT });
        outcome = 'admitted';
      } catch (error) {
        outcome = refusalView(error);
      }
      // Managed mode never outlives the case: every managed write rolls back after it reported.
      if (opts.managed) throw new Rollback('roll back the managed probe');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return outcome;
}

describe('engine parity: the git-canonical write fence', () => {
  parityTest(
    'an unmanaged brain admits a write to a git-canonical source, with or without the git protocol',
    { methods: ['getSourceStrictness', 'putPage', 'transaction', 'applyTransactionSettings', 'getPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, STRICT, { canonical: 'git' });
      expect(await engine.getSourceStrictness(STRICT)).toBe(true);
      await engine.putPage('plain', NOTE, { sourceId: STRICT });
      const outcomes = {
        scoped: await scopedWrite(engine, 'scoped', { managed: false, gitProtocol: false }),
        declared: await scopedWrite(engine, 'declared', { managed: false, gitProtocol: true }),
      };
      expect(outcomes).toEqual({ scoped: 'admitted', declared: 'admitted' });
      const stored: Record<string, boolean> = {};
      for (const slug of ['plain', 'scoped', 'declared']) stored[slug] = (await engine.getPage(slug, { sourceId: STRICT })) !== null;
      expect(stored).toEqual({ plain: true, scoped: true, declared: true });
      return { outcomes, stored };
    },
  );

  parityTest(
    'a managed brain refuses git_protocol_required to a scoped writer without the git protocol, and admits a declared one',
    { methods: ['putPage', 'transaction', 'applyTransactionSettings', 'getPage'], requires: 'raw_sql' },
    async (engine, backend) => {
      await createSource(engine, backend, STRICT, { canonical: 'git' });
      const refused = await scopedWrite(engine, 'undeclared', { managed: true, gitProtocol: false });
      expect(refused).toEqual({
        code: 'P0001',
        message: 'git_protocol_required: this source is git-canonical and the writer does not declare the git protocol',
        constraint: 'git_canonical_fence:mutation',
        table: 'pages',
        detail: { op: 'INSERT', target_source: STRICT, old_source: null },
      });
      const declared = await scopedWrite(engine, 'declared', { managed: true, gitProtocol: true });
      expect(declared).toBe('admitted');
      // Both probes rolled back: neither page stays.
      const stored = {
        undeclared: (await engine.getPage('undeclared', { sourceId: STRICT })) !== null,
        declared: (await engine.getPage('declared', { sourceId: STRICT })) !== null,
      };
      expect(stored).toEqual({ undeclared: false, declared: false });
      return { refused, declared, stored };
    },
  );
});
