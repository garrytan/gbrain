/**
 * GBRA-215 L3: the durable state of one ingest attempt, in the database on both storages (operational
 * state, never page content). A row exists before the first provider call and advances per window, so a
 * process that dies between paid windows resumes without paying for the windows it finished.
 *
 * Rows live in op_checkpoints (completed_keys holds one JSON object):
 *   ingest-attempt   fingerprint attempt_id        the attempt's state (windows, spend, plan, report)
 *   ingest-identity  fingerprint identity digest   which attempt answers an identical repeat
 * purgeStaleCheckpoints keeps both: undo reads ownership evidence from the attempt row.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { Principal } from '../persistence/model.ts';
import type { ExtractedWindow } from './extract.ts';
import type { IngestReport } from './report.ts';

export const INGEST_ATTEMPT_OP = 'ingest-attempt';
export const INGEST_IDENTITY_OP = 'ingest-identity';
export const INGEST_EXTRACTOR_VERSION = 'ingest-extractor-v1';

export type IngestStorage = 'git' | 'database';
export type IngestPhase = 'extracting' | 'planned' | 'committing' | 'complete' | 'failed' | 'undone';

export interface IngestOptions {
  type: string;
  visibility: 'world' | 'private';
  valid_from: string | null;
  no_facts: boolean;
  trusted_extraction: boolean;
  keyed: boolean;
}

export interface IngestTopology { storage: IngestStorage; root: string | null; source_incarnation: string }

export interface IngestAttemptState {
  v: 1;
  attempt_id: string;
  identity: string;
  source_id: string;
  document_hash: string;
  chars_total: number;
  principal: Principal;
  options: IngestOptions;
  extractor_version: string;
  model: string | null;
  topology: IngestTopology;
  phase: IngestPhase;
  created_at: string;
  updated_at: string;
  windows_total: number;
  windows: Record<string, ExtractedWindow>;
  in_flight: number | null;
  spent_usd: number;
  source_slug: string;
  report_slug: string;
  /** Fact ids this attempt counted as support for an existing claim: undo of another attempt skips them. */
  support_fact_ids: number[];
  report: IngestReport | null;
}

export function newAttemptId(): string {
  return `a${randomBytes(8).toString('hex')}`;
}

const ATTEMPT_ID = /^a[0-9a-f]{16}$/;
export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID.test(value);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The principal as identity text: kind and id, never credentials. */
export function principalKey(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

/**
 * An attempt is (document, principal, options); the extractor version is recorded, not part of identity. A caller's
 * request_id stands in for the document and options, so the same request_id always addresses the same attempt.
 */
export function attemptIdentity(input: { sourceId: string; documentHash: string; principal: Principal; options: IngestOptions; requestId?: string }): string {
  const key = input.requestId
    ? ['ingest-identity-v1', input.sourceId, principalKey(input.principal), 'request', input.requestId]
    : ['ingest-identity-v1', input.sourceId, principalKey(input.principal), input.documentHash, input.options.type, input.options.visibility,
      input.options.valid_from ?? '', String(input.options.no_facts), String(input.options.trusted_extraction), String(input.options.keyed)];
  return sha256(JSON.stringify(key));
}

async function readRow<T>(engine: BrainEngine, op: string, fingerprint: string): Promise<T | null> {
  const rows = await engine.executeRaw<{ state: T | string | null }>(
    `SELECT completed_keys->0 AS state FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`, [op, fingerprint]);
  const state = rows[0]?.state;
  if (state == null) return null;
  return (typeof state === 'string' ? JSON.parse(state) : state) as T;
}

async function writeRow(engine: BrainEngine, op: string, fingerprint: string, state: unknown): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
     ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
    [op, fingerprint, JSON.stringify([state])]);
}

export function readAttempt(engine: BrainEngine, attemptId: string): Promise<IngestAttemptState | null> {
  return readRow<IngestAttemptState>(engine, INGEST_ATTEMPT_OP, attemptId);
}

export async function saveAttempt(engine: BrainEngine, state: IngestAttemptState): Promise<IngestAttemptState> {
  state.updated_at = new Date().toISOString();
  await writeRow(engine, INGEST_ATTEMPT_OP, state.attempt_id, state);
  return state;
}

/** Remove an attempt row that lost the identity race before it did anything. */
export async function dropAttempt(engine: BrainEngine, attemptId: string): Promise<void> {
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2', [INGEST_ATTEMPT_OP, attemptId]);
}

/**
 * Bind an identity to an attempt unless another attempt already holds it: of two concurrent identical ingests exactly
 * one creates the attempt and the other answers with it. A binding to an undone attempt is replaced.
 */
export async function claimIdentity(engine: BrainEngine, identity: string, attemptId: string): Promise<string> {
  const rows = await engine.executeRaw<{ attempt_id: string }>(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       VALUES ($1, $2, jsonb_build_array(jsonb_build_object('attempt_id', $3::text)), now())
     ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()
       WHERE NOT EXISTS (SELECT 1 FROM op_checkpoints a WHERE a.op = $4
         AND a.fingerprint = op_checkpoints.completed_keys->0->>'attempt_id' AND a.completed_keys->0->>'phase' <> 'undone')
     RETURNING completed_keys->0->>'attempt_id' AS attempt_id`,
    [INGEST_IDENTITY_OP, identity, attemptId, INGEST_ATTEMPT_OP]);
  if (rows[0]?.attempt_id) return rows[0].attempt_id;
  const held = await readRow<{ attempt_id: string }>(engine, INGEST_IDENTITY_OP, identity);
  return held?.attempt_id ?? attemptId;
}

export async function findAttemptByIdentity(engine: BrainEngine, identity: string): Promise<IngestAttemptState | null> {
  const held = await readRow<{ attempt_id: string }>(engine, INGEST_IDENTITY_OP, identity);
  if (!held) return null;
  const attempt = await readAttempt(engine, held.attempt_id);
  return attempt && attempt.phase !== 'undone' ? attempt : null;
}

/** Other live attempts that counted `factId` as support (their claims depend on the row). */
export async function supportingAttempts(engine: BrainEngine, factId: number, exceptAttemptId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ fingerprint: string }>(
    `SELECT fingerprint FROM op_checkpoints WHERE op = $1 AND fingerprint <> $2
       AND completed_keys->0->>'phase' <> 'undone' AND (completed_keys->0->'support_fact_ids') @> to_jsonb($3::int)`,
    [INGEST_ATTEMPT_OP, exceptAttemptId, factId]);
  return rows.map(r => r.fingerprint);
}

/** Other live attempts of the same document in this source (they share its source page). */
export async function attemptsOfDocument(engine: BrainEngine, sourceId: string, documentHash: string, exceptAttemptId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ fingerprint: string }>(
    `SELECT fingerprint FROM op_checkpoints WHERE op = $1 AND fingerprint <> $2 AND completed_keys->0->>'phase' <> 'undone'
       AND completed_keys->0->>'source_id' = $3 AND completed_keys->0->>'document_hash' = $4`,
    [INGEST_ATTEMPT_OP, exceptAttemptId, sourceId, documentHash]);
  return rows.map(r => r.fingerprint);
}
