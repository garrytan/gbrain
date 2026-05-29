/**
 * v0.42.0.0 — world_knowledge consensus-refresh minion (Confer fork).
 *
 * Pure structural tests against a mock BrainEngine — no real Postgres, no live
 * brain (there is an active fail2ban jail on S1; these stay entirely local).
 * The minion's contract is exercised through its public surface
 * (runConsensusRefresh) + the engine's executeRaw stub, exactly like
 * propose-takes.test.ts.
 *
 * Coverage (the task's required cases):
 *   - promotion fires ONLY when all 3 conditions hold (take + escalated_from
 *     lineage + consensus >= 0.8) — boundary at 0.8, below-threshold, and
 *     missing-lineage cases reuse the merged classifier;
 *   - idempotency: a second pass over already-promoted / already-cached rows
 *     issues zero kind UPDATEs and zero consensus UPDATEs;
 *   - dry-run writes NOTHING but still reports what WOULD promote;
 *   - no demotion: an already-world_knowledge row is never rewritten/demoted;
 *   - fact/bet/hunch are NEVER promoted, even with high consensus + lineage;
 *   - consensus cache is refreshed from the view (view value copied to column);
 *   - Postgres-only: skips cleanly on PGLite (no view) and when the view is
 *     absent on Postgres;
 *   - lock-busy: skips when another pass holds the per-source lock.
 */

import { describe, test, expect } from 'bun:test';
import {
  runConsensusRefresh,
  consensusRefreshLockId,
  ESCALATED_FROM_LINK_TYPE,
  __testing,
} from '../src/core/facts/consensus-refresh.ts';
import { WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD } from '../src/core/facts/world-knowledge.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ─── Mock engine ────────────────────────────────────────────────────
//
// One joined `take_proposals` row as the REFRESH_SELECT would return it.
interface MockRow {
  take_proposal_id: number;
  page_slug: string;
  claim_text: string;
  kind: string;
  stored_consensus: number | null;
  view_consensus: number | null;
  has_escalated_from: boolean;
}

interface CapturedSql {
  sql: string;
  params: unknown[];
}

interface MockOpts {
  rows: MockRow[];
  /** Engine kind. Default 'postgres' (the only kind where the view exists). */
  kind?: 'postgres' | 'pglite';
  /** Whether the confer_world_consensus view exists (postgres only). Default true. */
  viewExists?: boolean;
  /** Force the lock acquire to fail (simulate a busy lock). Default false. */
  lockBusy?: boolean;
}

function buildMockEngine(opts: MockOpts): {
  engine: BrainEngine;
  captured: CapturedSql[];
  // mutable snapshot the UPDATEs apply to, so we can assert idempotency on re-run
  state: MockRow[];
} {
  const captured: CapturedSql[] = [];
  const kind = opts.kind ?? 'postgres';
  const viewExists = opts.viewExists ?? true;
  // Live mutable copy the UPDATEs mutate (so a second pass sees the new state).
  const state: MockRow[] = opts.rows.map(r => ({ ...r }));

  const engine = {
    kind,
    // db-lock.ts postgres path uses a tagged-template `sql`. Return a row
    // (acquired) unless lockBusy, then []. We don't model release writes.
    sql: async (..._args: unknown[]): Promise<Array<{ id: string }>> => {
      return opts.lockBusy ? [] : [{ id: 'lock' }];
    },
    async executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
      captured.push({ sql, params: params ?? [] });

      // viewExists() probe
      if (sql.includes('information_schema.views')) {
        return [{ exists: viewExists } as unknown as T];
      }
      // The REFRESH_SELECT join — return the current (possibly mutated) rows.
      if (sql.includes('FROM take_proposals tp') && sql.includes('confer_world_consensus')) {
        return state.map(r => ({ ...r })) as unknown as T[];
      }
      // Consensus cache UPDATE — apply to state (only when value differs, like SQL).
      if (sql.includes('SET world_consensus =')) {
        const id = params?.[0] as number;
        const newVal = (params?.[1] as number | null) ?? 0.0;
        const row = state.find(r => r.take_proposal_id === id);
        if (row) row.stored_consensus = newVal;
        return [];
      }
      // Re-kind UPDATE — apply only when row is still 'take' (mirrors WHERE guard).
      if (sql.includes('SET kind =')) {
        const id = params?.[0] as number;
        const newKind = params?.[1] as string;
        const guardKind = params?.[2] as string;
        const row = state.find(r => r.take_proposal_id === id);
        if (row && row.kind === guardKind) row.kind = newKind;
        return [];
      }
      return [];
    },
  } as unknown as BrainEngine;

  return { engine, captured, state };
}

function kindUpdates(captured: CapturedSql[]): CapturedSql[] {
  return captured.filter(c => c.sql.includes('SET kind ='));
}
function consensusUpdates(captured: CapturedSql[]): CapturedSql[] {
  return captured.filter(c => c.sql.includes('SET world_consensus ='));
}

// ─── promotion rule: all 3 conditions ───────────────────────────────

describe('runConsensusRefresh — promotion fires only when all 3 conditions hold', () => {
  test('take + escalated_from + consensus >= 0.8 → promotes (and re-kinds the row)', async () => {
    const { engine, captured, state } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'distribution wins', kind: 'take', stored_consensus: 0.82, view_consensus: 0.82, has_escalated_from: true },
      ],
    });
    const r = await runConsensusRefresh(engine, { sourceId: 'default' });
    expect(r.status).toBe('ok');
    expect(r.promoted).toBe(1);
    expect(r.promotions[0]!.take_proposal_id).toBe(1);
    expect(kindUpdates(captured)).toHaveLength(1);
    expect(state[0]!.kind).toBe('world_knowledge');
  });

  test('consensus exactly 0.8 promotes (inclusive bound, matches classifier)', async () => {
    const { engine } = buildMockEngine({
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.8, view_consensus: 0.8, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(1);
  });

  test('consensus 0.79 (below threshold) does NOT promote', async () => {
    const { engine, captured } = buildMockEngine({
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.79, view_consensus: 0.79, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(0);
    expect(kindUpdates(captured)).toHaveLength(0);
  });

  test('no escalated_from lineage does NOT promote even at high consensus', async () => {
    const { engine, captured } = buildMockEngine({
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.99, view_consensus: 0.99, has_escalated_from: false }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(0);
    expect(kindUpdates(captured)).toHaveLength(0);
  });

  test('null view consensus is treated as 0 → no promotion', async () => {
    const { engine } = buildMockEngine({
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: null, view_consensus: null, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(0);
  });

  test('the threshold the minion enforces is the merged pack-stated 0.8', () => {
    expect(WORLD_KNOWLEDGE_CONSENSUS_THRESHOLD).toBe(0.8);
  });
});

// ─── never promotes fact/bet/hunch ──────────────────────────────────

describe('runConsensusRefresh — never touches fact/bet/hunch', () => {
  test('fact/bet/hunch with lineage + high consensus stay unchanged (no kind UPDATE)', async () => {
    const { engine, captured, state } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/f', claim_text: 'f', kind: 'fact', stored_consensus: 0.95, view_consensus: 0.95, has_escalated_from: true },
        { take_proposal_id: 2, page_slug: 'p/b', claim_text: 'b', kind: 'bet', stored_consensus: 0.95, view_consensus: 0.95, has_escalated_from: true },
        { take_proposal_id: 3, page_slug: 'p/h', claim_text: 'h', kind: 'hunch', stored_consensus: 0.95, view_consensus: 0.95, has_escalated_from: true },
      ],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(0);
    expect(kindUpdates(captured)).toHaveLength(0);
    expect(state.map(s => s.kind)).toEqual(['fact', 'bet', 'hunch']);
  });
});

// ─── no demotion ────────────────────────────────────────────────────

describe('runConsensusRefresh — never demotes', () => {
  test('an already-world_knowledge row is never rewritten or demoted, even with low/no consensus', async () => {
    const { engine, captured, state } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/w', claim_text: 'w', kind: 'world_knowledge', stored_consensus: 0.9, view_consensus: 0.1, has_escalated_from: false },
      ],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.promoted).toBe(0);
    // The classifier returns world_knowledge unchanged; the WHERE kind='take'
    // guard means zero kind UPDATEs — never demoted.
    expect(kindUpdates(captured)).toHaveLength(0);
    expect(state[0]!.kind).toBe('world_knowledge');
  });
});

// ─── consensus cache refresh ────────────────────────────────────────

describe('runConsensusRefresh — refreshes the world_consensus cache from the view', () => {
  test('when the view value differs from the stored column, it writes the view value', async () => {
    const { engine, captured, state } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.3, view_consensus: 0.6, has_escalated_from: false },
      ],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.consensus_refreshed).toBe(1);
    const upd = consensusUpdates(captured);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.params[1]).toBe(0.6); // view value written
    expect(state[0]!.stored_consensus).toBe(0.6);
  });

  test('when the view value equals the stored column, no consensus write (idempotent)', async () => {
    const { engine, captured } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.5, view_consensus: 0.5, has_escalated_from: false },
      ],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.consensus_refreshed).toBe(0);
    expect(consensusUpdates(captured)).toHaveLength(0);
  });

  test('stored 0.0 vs view NULL is treated as equal (no churn)', async () => {
    const { engine, captured } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.0, view_consensus: null, has_escalated_from: false },
      ],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.consensus_refreshed).toBe(0);
    expect(consensusUpdates(captured)).toHaveLength(0);
  });
});

// ─── idempotency ────────────────────────────────────────────────────

describe('runConsensusRefresh — idempotency', () => {
  test('re-running after a promotion is a no-op (zero kind + zero consensus writes)', async () => {
    const { engine, captured } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.82, view_consensus: 0.82, has_escalated_from: true },
      ],
    });
    // First pass: promotes + (consensus already equal → no consensus write).
    const r1 = await runConsensusRefresh(engine);
    expect(r1.promoted).toBe(1);

    // Second pass over the now-mutated state: row is world_knowledge, consensus equal.
    captured.length = 0;
    const r2 = await runConsensusRefresh(engine);
    expect(r2.promoted).toBe(0);
    expect(r2.consensus_refreshed).toBe(0);
    expect(kindUpdates(captured)).toHaveLength(0);
    expect(consensusUpdates(captured)).toHaveLength(0);
  });
});

// ─── dry-run ────────────────────────────────────────────────────────

describe('runConsensusRefresh — dry-run writes nothing', () => {
  test('dry-run reports the same promotion + refresh counts but issues NO write SQL', async () => {
    const { engine, captured, state } = buildMockEngine({
      rows: [
        { take_proposal_id: 1, page_slug: 'p/a', claim_text: 'promote me', kind: 'take', stored_consensus: 0.3, view_consensus: 0.9, has_escalated_from: true },
      ],
    });
    const r = await runConsensusRefresh(engine, { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.promoted).toBe(1);          // WOULD promote
    expect(r.consensus_refreshed).toBe(1); // WOULD refresh
    expect(r.promotions[0]!.page_slug).toBe('p/a');
    // No write SQL issued.
    expect(kindUpdates(captured)).toHaveLength(0);
    expect(consensusUpdates(captured)).toHaveLength(0);
    // State unchanged — proves the dry-run touched nothing.
    expect(state[0]!.kind).toBe('take');
    expect(state[0]!.stored_consensus).toBe(0.3);
  });
});

// ─── Postgres-only / skip paths ─────────────────────────────────────

describe('runConsensusRefresh — skip paths', () => {
  test('PGLite engine: skips cleanly (view_unavailable), no throw, no writes', async () => {
    const { engine, captured } = buildMockEngine({
      kind: 'pglite',
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.9, view_consensus: 0.9, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('view_unavailable');
    expect(kindUpdates(captured)).toHaveLength(0);
  });

  test('Postgres but view missing: skips with view_unavailable + apply-migrations hint', async () => {
    const { engine } = buildMockEngine({
      viewExists: false,
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.9, view_consensus: 0.9, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('view_unavailable');
    expect(r.warnings.some(w => w.includes('apply-migrations'))).toBe(true);
  });

  test('lock busy: another pass holds the lock → skips with lock_busy', async () => {
    const { engine, captured } = buildMockEngine({
      lockBusy: true,
      rows: [{ take_proposal_id: 1, page_slug: 'p/a', claim_text: 'c', kind: 'take', stored_consensus: 0.9, view_consensus: 0.9, has_escalated_from: true }],
    });
    const r = await runConsensusRefresh(engine);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('lock_busy');
    expect(kindUpdates(captured)).toHaveLength(0);
  });

  test('empty source (no proposals) → skipped/no_proposals', async () => {
    const { engine } = buildMockEngine({ rows: [] });
    const r = await runConsensusRefresh(engine);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('no_proposals');
  });
});

// ─── constants / helpers ────────────────────────────────────────────

describe('runConsensusRefresh — constants + lock id', () => {
  test('escalated_from link_type matches the pack declaration', () => {
    expect(ESCALATED_FROM_LINK_TYPE).toBe('escalated_from');
  });

  test('lock id is per-source (no cross-source serialization)', () => {
    expect(consensusRefreshLockId('default')).toBe('gbrain-consensus-refresh:default');
    expect(consensusRefreshLockId('clientX')).toBe('gbrain-consensus-refresh:clientX');
    expect(consensusRefreshLockId('a')).not.toBe(consensusRefreshLockId('b'));
  });

  test('numericEq treats null and 0 as equal, distinct values as unequal', () => {
    expect(__testing.numericEq(null, null)).toBe(true);
    expect(__testing.numericEq(0, null)).toBe(true);
    expect(__testing.numericEq(0.5, 0.5)).toBe(true);
    expect(__testing.numericEq(0.5, 0.6)).toBe(false);
    expect(__testing.numericEq(null, 0.9)).toBe(false);
  });

  test('the REFRESH_SELECT scopes by source and resolves escalated_from via links+pages', () => {
    expect(__testing.REFRESH_SELECT).toContain('confer_world_consensus');
    expect(__testing.REFRESH_SELECT).toContain('link_type = $2');
    expect(__testing.REFRESH_SELECT).toContain('tp.source_id = $1');
  });
});
