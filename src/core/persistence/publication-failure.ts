import { OperationError } from '../ops/contract.ts';
import { writerStamp } from './writer-versions.ts';
import type { FenceFailureDetail } from '../fence-repair/refusal.ts';

/**
 * #5974: a database refusal during preparation or publication becomes a
 * structured, bounded diagnostic instead of an opaque storage_error. Only
 * fixed identifiers are kept: trigger function, table, operation, guard
 * branch and the source relationship. Page text, SQL and row values never are.
 */
export type PublicationStage = 'preparation' | 'publication' | 'after_file_publication';
export interface PublicationFailureDetail {
  origin: 'database_guard' | 'database_trigger' | 'database';
  sqlstate: string;
  raiser?: string;
  table?: string;
  op?: string;
  branch?: string;
  relationship?: string;
  /** Owner-only: source identifiers can name private sources. */
  sources?: { target: string | null; old: string | null; allowed: string[] };
  stage?: PublicationStage;
  /** Owner-only: the build and host that executed the failed attempt. */
  attempt?: { consumer_version: string; consumer_host_id: string | null };
}
/** #6188: a typed fence refusal's location (`fence-repair/refusal.ts`), plus the attempt stamp. */
export type FenceRefusalDetail = FenceFailureDetail & Pick<PublicationFailureDetail, 'stage' | 'attempt'>;
export interface PublicationFailure { code: string; message: string; detail?: PublicationFailureDetail | FenceRefusalDetail }

const IDENT = /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/;
const ident = (value: unknown) => typeof value === 'string' && IDENT.test(value) ? value : undefined;
const GUARD_PREFIX = 'writer_coordinator_required:';
const RELATIONSHIP_TEXT: Record<string, string> = {
  different_source: 'a row in a source this publication does not own',
  missing_source: 'a row whose source could not be resolved',
  old_source_outside: 'a row moved from a source this publication does not own',
  checkpoint_outside_owner: 'a source sync checkpoint outside owner publication',
  topology_outside_administration: 'a source topology change outside writer administration',
};

function guardDetail(raw: unknown): Pick<PublicationFailureDetail, 'op' | 'relationship' | 'sources'> {
  if (typeof raw !== 'string' || raw.length > 4096) return {};
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const allowed = Array.isArray(parsed.allowed) ? parsed.allowed.map(ident).filter((v): v is string => !!v).slice(0, 32) : [];
  const target = ident(parsed.target_source) ?? null, old = ident(parsed.old_source) ?? null;
  return { op: ident(parsed.op), relationship: ident(parsed.relationship),
    ...(target || old || allowed.length ? { sources: { target, old, allowed } } : {}) };
}

/** Null when the error is not a database refusal this module recognizes. */
export function databaseRefusal(error: unknown): PublicationFailure | null {
  if (error instanceof OperationError || !error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const sqlstate = typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  if (sqlstate !== 'P0001') return null;
  const where = typeof e.where === 'string' ? e.where : '';
  const raiser = ident(/PL\/pgSQL function (?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)[( ]/.exec(where)?.[1]);
  const table = ident(e.table_name ?? e.table);
  const constraint = typeof (e.constraint_name ?? e.constraint) === 'string' ? String(e.constraint_name ?? e.constraint) : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.startsWith(GUARD_PREFIX) || constraint.startsWith('managed_writer_guard')) {
    const branch = constraint.startsWith('managed_writer_guard:') ? ident(constraint.slice('managed_writer_guard:'.length)) : undefined;
    const detail: PublicationFailureDetail = { origin: 'database_guard', sqlstate, raiser: raiser ?? 'gbrain_require_managed_writer',
      ...(table ? { table } : {}), ...(branch ? { branch } : {}), ...guardDetail(e.detail) };
    const what = detail.relationship ? RELATIONSHIP_TEXT[detail.relationship] ?? 'a row outside its allowlist' : 'a row outside its allowlist';
    return { code: 'writer_coordinator_required', detail, message:
      `The managed-writer database guard refused ${detail.op ? `an ${detail.op}` : 'a write'}${table ? ` on ${table}` : ''}: ${what}. Nothing was committed.` };
  }
  return { code: 'storage_error', message: `Publication failed (P0001${raiser ? ` in ${raiser}` : ''}). Inspect owner diagnostics.`,
    detail: { origin: raiser ? 'database_trigger' : 'database', sqlstate, ...(raiser ? { raiser } : {}), ...(table ? { table } : {}) } };
}

/** Stamps which build, host and stage ran the failed attempt. */
export function withAttempt(failure: PublicationFailure, stage: PublicationStage): PublicationFailure {
  if (!failure.detail) return failure;
  const stamp = writerStamp();
  return { ...failure, detail: { ...failure.detail, stage, attempt: { consumer_version: stamp.version, consumer_host_id: stamp.hostId } } };
}

/**
 * The receipt view any caller may read: fixed enums only, no source
 * identifiers, host or build. A fence location keeps its fence, section,
 * reason and problem classes; its row numbers stay owner-side (they can
 * number rows a remote caller never saw).
 */
export function publicFailureDetail(detail: unknown): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return undefined;
  const { sources: _sources, attempt: _attempt, ...rest } = detail as PublicationFailureDetail;
  if ((rest as { origin?: unknown }).origin === 'fence') {
    const { rows: _rows, issues, ...fence } = ((rest as unknown as FenceFailureDetail).fence ?? {}) as FenceFailureDetail['fence'];
    const publicIssues = Array.isArray(issues) ? issues.map(({ row: _row, ...issue }) => issue) : undefined;
    return { ...rest, fence: { ...fence, ...(publicIssues?.length ? { issues: publicIssues } : {}) } } as unknown as Record<string, unknown>;
  }
  return rest as unknown as Record<string, unknown>;
}
