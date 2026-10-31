/**
 * GST-359 C1: the dependency-free part of the attested actor (access/actor.ts): the constants, the stored-actor shape and
 * the attest right a credential row carries. Verifiers and stored-authority parsers import this module alone.
 */

/** The header the trusted system sets on every HTTP request of a call (case-insensitive). */
export const ACTOR_HEADER = 'x-qm-actor';
/** The tool argument the system also sends; equal to the header on an attested call, stripped before the handler. */
export const ACTOR_ARGUMENT = 'acting_user';
export const ATTEST_SYSTEMS: readonly string[] = ['qm'];
export const DEFAULT_ATTEST_OPS: readonly string[] = ['memory_recall', 'memory_write'];
/**
 * Operations no attested call may run yet: what they read or write is not keyed to the person, so one person could
 * change or see another's (a fact withdrawn by id, a conflict list across writers) or write facts and takes every
 * reader sees. GST-359 C2 keyed remember (the member page), delta cursors, write receipts and agent jobs to the person
 * and removed them. Refused at `--attest-ops`, at every call and when a stored write or job tool call is re-resolved.
 */
export const ACTOR_DEFERRED_OPS: ReadonlySet<string> = new Set([
  'list_write_conflicts',
  'capture', 'extract_facts', 'forget', 'forget_fact',
  'takes_add', 'takes_update', 'takes_resolve', 'takes_supersede',
]);

/** Canonical person ids: 1-256 visible ASCII characters (QM's credential broker rule), no case folding. */
export const EXTERNAL_ID_RE = /^[\x21-\x7e]{1,256}$/;

export interface AttestRight { system: string; ops: string[] }
export interface AttestedActor { system: string; external_id: string; member: string }

/**
 * The attest right a credential row carries, given the grant that issued the token (`legacy` for a legacy token,
 * else the OAuth grant type) and its member binding. Null unless the system is known, the credential is bound to no
 * member, and the token is a legacy token or a client-credentials token.
 */
export function attestRightFrom(row: Record<string, unknown> | undefined, grant: unknown, member: unknown): AttestRight | null {
  const system = row?.attest_actor;
  if (typeof system !== 'string' || !ATTEST_SYSTEMS.includes(system) || member != null) return null;
  if (grant !== 'legacy' && grant !== 'client_credentials') return null;
  const ops = Array.isArray(row!.attest_ops) ? (row!.attest_ops as unknown[]).filter((v): v is string => typeof v === 'string') : [...DEFAULT_ATTEST_OPS];
  return { system, ops };
}

/** The verify join plus the live attest right, for AuthInfo (a verifier spreads the result). */
export function withAttestRight<T extends { member: unknown }>(binding: T, row: Record<string, unknown>, grant: unknown): T & { attest: AttestRight | null } {
  return { ...binding, attest: attestRightFrom(row, grant, binding.member) };
}

/** A stored actor value (WriteAuthority.actingFor, a job grant's actor), or null when it is not one. */
export function parseStoredActor(value: unknown): AttestedActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return typeof v.system === 'string' && ATTEST_SYSTEMS.includes(v.system) && typeof v.external_id === 'string' && EXTERNAL_ID_RE.test(v.external_id)
    && typeof v.member === 'string' ? { system: v.system, external_id: v.external_id, member: v.member } : null;
}
