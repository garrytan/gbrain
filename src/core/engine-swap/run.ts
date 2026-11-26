/**
 * `gbrain engine swap --to rust --yes --expect <hash>` (PR S5b): the persisted states of a swap run
 * (docs/designs/RUST_ENGINE.md "Swap and the way back"), each resumable with `--resume` and visible with `--status`:
 *
 *   planned -> checkpointed  write and verify an immutable recovery checkpoint of the primary;
 *   checkpointed -> fenced   drain, then the database-enforced write fence on the primary (graduation custody);
 *   fenced -> verified       final reconcile, allocators raised, a confirming reconcile, the probe, full digests;
 *   verified -> switched     the authority switch (config), recorded before the probe;
 *   switched -> succeeded    a fresh process resolves the route and confirms the Rust engine at the store.
 *
 * Every step re-checks what the step before it left (the checkpoint hash, the fence) before it goes on. A failure
 * leaves the run at its last state with a sanitized diagnostic, and authority on the old engine: the switch is undone
 * at once when the probe fails, and success is reported only after the probe passes.
 */
import { verifyPostgresCheckpoint, writePostgresCheckpoint, type PgTools } from './pg-checkpoint.ts';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { verifyCheckpoint, writeCheckpoint } from './checkpoint.ts';
import { DrainBlockedError, fencePrimary, markPrimaryCutover, primaryFenced } from './fence.ts';
import {
  readSwapRecord, REAL_FS, swapRunDir, writeSwapRecord, type SwapFs, type SwapRecord, type SwapState,
} from './record.ts';
import { swapRefusal, type SwapRefusalReason } from './refusals.ts';
import { probePassed, restoreAuthority, switchAuthority, type RouteProber } from './route.ts';
import { SwapVerifyError, verifyEngines, type Rpc } from './verify.ts';
import type { ReadSource } from '../../shadow/read-pool.ts';

/** The Rust side of state 3: the shadow store's RPC and a read source on the primary. */
export interface RustSide { rpc: Rpc; reads: ReadSource; close(): Promise<void> }

export interface SwapRunDeps {
  /** The connected primary: PGLite (this process holds its writer lock for the whole run) or Postgres. */
  primary: BrainEngine;
  /** A Postgres primary's checkpoint inputs: the database URL pg_dump reads (never stored) and the client tools. */
  postgres?: { url: string; tools?: PgTools };
  config: GBrainConfig;
  brainKey: string;
  shadowDir: string;
  rustStore: string;
  hostId: string;
  openRust: () => Promise<RustSide>;
  prober: RouteProber;
  /** Re-checked right before the switch: a refusal when anything still selects the old engine. */
  routeCheck: () => OperationError | null;
  recordPath: string;
  fs?: SwapFs;
  now?: () => Date;
  progress?: (line: string) => void;
  /** Test-only: called as each state is about to start; tests throw here to simulate a kill. */
  beforeState?: (state: SwapState) => void;
  intervalRows?: number;
}

const DIAG = (): string => randomUUID().slice(0, 8);

function fail(record: SwapRecord, deps: SwapRunDeps, state: SwapState, code: string, reason: SwapRefusalReason | null): void {
  record.error = { state, code, reason, diagnostic_id: DIAG(), at: (deps.now?.() ?? new Date()).toISOString() };
  record.updated_at = record.error.at;
  writeSwapRecord(deps.recordPath, record, deps.fs ?? REAL_FS);
}

function advance(record: SwapRecord, deps: SwapRunDeps, to: SwapState): void {
  record.state = to;
  record.error = null;
  record.updated_at = (deps.now?.() ?? new Date()).toISOString();
  writeSwapRecord(deps.recordPath, record, deps.fs ?? REAL_FS);
  deps.progress?.(`engine swap: ${to}`);
}

/** A new run record for `planHash`; refuses when a run of this brain is already recorded. */
export function startRecord(deps: SwapRunDeps, planHash: string, policyHash: string): SwapRecord {
  const existing = readSwapRecord(deps.recordPath);
  if (existing && existing.state !== 'succeeded') {
    throw opError('invalid_params', `A swap run (${existing.run_id}) of this brain stopped at ${existing.state}.`,
      'Continue it with gbrain engine swap --to rust --resume, or read it with --status.',
      { docs: 'docs/guides/engine-swap.md#resume', fix: { argv: ['gbrain', 'engine', 'swap', '--to', 'rust', '--resume', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Continues the recorded run from its last state.' } });
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const record: SwapRecord = {
    version: 1, run_id: randomUUID(), plan_hash: planHash, policy_hash: policyHash,
    brain: { key: deps.brainKey, engine: String(deps.primary.kind), database_path: String(deps.config.database_path ?? '') },
    rust_store: deps.rustStore, shadow_dir: deps.shadowDir, state: 'planned', started_at: at, updated_at: at, error: null,
  };
  writeSwapRecord(deps.recordPath, record, deps.fs ?? REAL_FS);
  return record;
}

/** Runs (or resumes) `record` to `succeeded`. Throws a typed error at the first state that cannot finish. */
export async function runSwapStates(record: SwapRecord, deps: SwapRunDeps): Promise<SwapRecord> {
  const fs = deps.fs ?? REAL_FS;
  for (;;) {
    const state = record.state;
    if (state === 'succeeded') return record;
    deps.beforeState?.(state);
    if (state === 'planned') {
      const path = join(swapRunDir(deps.brainKey), `checkpoint-${record.run_id}.${deps.postgres ? 'dump' : 'tar'}`);
      // A file here was never recorded (the run stopped before `checkpointed`), so nothing trusts it: replace it.
      rmSync(path, { force: true });
      try {
        record.checkpoint = deps.postgres
          ? await writePostgresCheckpoint(deps.primary, path, { url: deps.postgres.url, tools: deps.postgres.tools })
          : await writeCheckpoint(deps.primary, path, fs);
      } catch (error) {
        fail(record, deps, state, 'checkpoint_failed', 'verification_incomplete');
        throw swapRefusal('verification_incomplete', `the recovery checkpoint could not be written and verified (${(error as Error).message}).`,
          'No write fence is in place and nothing changed on the primary. Free space or fix the path, then run --resume.');
      }
      advance(record, deps, 'checkpointed');
      continue;
    }
    if (!record.checkpoint) throw new Error('the run record has no checkpoint');
    const cp = record.checkpoint;
    try { await (cp.format === 'pg_dump_custom' ? verifyPostgresCheckpoint({ ...cp, format: 'pg_dump_custom' }) : verifyCheckpoint(cp)); } catch (error) {
      fail(record, deps, state, 'checkpoint_changed', 'verification_incomplete');
      throw swapRefusal('verification_incomplete', `the recovery checkpoint no longer verifies (${(error as Error).message}).`,
        'A checkpoint that changed after it was written is never trusted. The primary keeps authority.');
    }
    if (state === 'checkpointed') {
      try {
        const fence = await fencePrimary(deps.primary, record.run_id, { hostId: deps.hostId, config: deps.config });
        record.fence = { tables: fence.tables, drained: fence.drained.length, at: (deps.now?.() ?? new Date()).toISOString() };
      } catch (error) {
        fail(record, deps, state, error instanceof DrainBlockedError ? 'drain_blocked' : 'fence_failed', 'verification_incomplete');
        throw swapRefusal('verification_incomplete', `the write fence could not be put in place (${(error as Error).message}).`,
          'The drain must finish every admitted request before the fence; nothing was copied or switched.');
      }
      advance(record, deps, 'fenced');
      continue;
    }
    if (!(await primaryFenced(deps.primary, record.run_id))) {
      fail(record, deps, state, 'fence_missing', 'verification_incomplete');
      throw swapRefusal('verification_incomplete', 'the write fence on the primary is gone.', 'Without the fence a write could land after the final digest. Run --resume from the fence step.');
    }
    if (state === 'fenced') {
      const rust = await deps.openRust();
      try {
        record.verify = await verifyEngines({ primary: deps.primary, reads: rust.reads, rpc: rust.rpc, dir: deps.shadowDir, intervalRows: deps.intervalRows });
      } catch (error) {
        const reason: SwapRefusalReason = error instanceof SwapVerifyError ? error.reason : 'verification_incomplete';
        fail(record, deps, state, error instanceof SwapVerifyError ? reason : 'verify_failed', reason);
        throw swapRefusal(reason, `the final verification stopped: ${error instanceof SwapVerifyError ? error.message : 'the Rust store did not answer'}.`,
          'The primary keeps authority and stays fenced; the diagnostics are kept in the run record.');
      } finally {
        await rust.close();
      }
      advance(record, deps, 'verified');
      continue;
    }
    if (state === 'verified') {
      const override = deps.routeCheck();
      if (override) { fail(record, deps, state, 'route_override', 'route_override'); throw override; }
      const previous = switchAuthority(deps.rustStore, { runDir: swapRunDir(deps.brainKey), runId: record.run_id });
      record.switch = { previous, at: (deps.now?.() ?? new Date()).toISOString() };
      advance(record, deps, 'switched');
      continue;
    }
    if (state === 'switched') {
      const probe = await deps.prober();
      record.probe = { ...probe, at: (deps.now?.() ?? new Date()).toISOString() };
      if (!probePassed(probe, deps.rustStore)) {
        if (record.switch) restoreAuthority(record.switch.previous, { runDir: swapRunDir(deps.brainKey), runId: record.run_id });
        record.state = 'verified';
        fail(record, deps, 'switched', 'route_probe_failed', 'verification_incomplete');
        throw swapRefusal('verification_incomplete', `a fresh process did not open the Rust engine at the store (it saw ${probe.effective_engine ?? 'no engine'}${probe.ok ? '' : ', probe failed'}).`,
          'The switch was undone at once, so the old engine keeps authority. Run --resume after fixing what the probe names.');
      }
      await markPrimaryCutover(deps.primary, record.run_id);
      advance(record, deps, 'succeeded');
      continue;
    }
  }
}
