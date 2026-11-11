/**
 * GST-359 C1: the dependency-free part of the attested actor (access/actor.ts): the constants, the stored-actor shape and
 * the attest right a credential row carries. Verifiers and stored-authority parsers import this module alone.
 */

/** The header the trusted system sets on every HTTP request of a call (case-insensitive). */
export const ACTOR_HEADER = 'x-qm-actor';
/** QM's channel-audience header (wave 2). Not served yet: any request carrying it is refused before any work. */
export const QM_AUDIENCE_HEADER = 'x-qm-audience';
/** The tool argument the system also sends; equal to the header on an attested call, stripped before the handler. */
export const ACTOR_ARGUMENT = 'acting_user';
export const ATTEST_SYSTEMS: readonly string[] = ['qm'];
export const DEFAULT_ATTEST_OPS: readonly string[] = ['get_write_request', 'memory_recall', 'memory_write'];
/** GST-1113: the attested operations a credential with attest_sources may run: the memory pair, receipts and own-page withdrawal. */
export const SCOPE_ATTEST_OPS: ReadonlySet<string> = new Set(['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write']);
/**
 * Operations no attested call may run yet: what they read or write is not keyed to the person, so one person could
 * change or see another's (a conflict list across writers) or write facts and takes every reader sees. GST-359 C2
 * keyed remember (the member page), delta cursors, write receipts and agent jobs to the person and removed them; D keyed
 * forget and forget_fact (the person's own member-page facts, withdrawn there alone). GST-1158 F9 deferred the direct
 * page writes (timeline entries, links, page puts and edits land on pages every reader of them sees) until an owner can
 * approve them, and GST-2249 W1 deferred every other page write: anything that writes a page's content, frontmatter,
 * links, tags, timeline, facts, attached data or files, or deletes or restores a page. The only attested writes left
 * are the person's own (memory_write, remember, forget and forget_fact on the member page) and memory_propose, which
 * holds a write for the owner. W1 also deferred the writes whose rows every reader shares without a page: answer
 * feedback (rate_answer, keyed to the client, not the person), the ingest log (log_ingest) and loop suppression
 * (loops_mute, loops_unmute). test/qm-attest-write-boundary.test.ts checks every attestable mutating operation in the
 * registry is either here or reviewed as not a page write. Refused at `--attest-ops`, at every call and when a stored
 * write or job tool call is re-resolved.
 */
export const ACTOR_DEFERRED_OPS: ReadonlySet<string> = new Set([
  'list_write_conflicts',
  'capture', 'extract_facts', 'ontology_propose', 'confirm_memory', 'loops_close',
  'takes_add', 'takes_update', 'takes_resolve', 'takes_supersede',
  'add_timeline_entry', 'add_link', 'remove_link', 'add_tag', 'remove_tag',
  'put_page', 'put_pages', 'edit_page', 'append_page', 'delete_page', 'restore_page', 'revert_version',
  'begin_page_upload', 'upload_page_part', 'commit_page_upload', 'abort_page_upload',
  'put_raw_data', 'extract_entities', 'questions_pin', 'questions_refresh', 'questions_unpin',
  'rate_answer', 'log_ingest', 'loops_mute', 'loops_unmute',
]);

/** Canonical person ids: 1-256 visible ASCII characters (QM's credential broker rule), no case folding. */
export const EXTERNAL_ID_RE = /^[\x21-\x7e]{1,256}$/;

/** GST-1158 F3: `read` is how an attested call that names sources reads them; absent (the column unset) reads as the scope. */
/** GST-1113: `sources` are the scope sources an attested memory_write may name per call (attest_sources); null = none. */
export interface AttestRight { system: string; ops: string[]; sources: string[] | null; read?: 'person' | 'scope' }
export interface AttestedActor { system: string; external_id: string; member: string }

/**
 * The attest right a credential row carries, given the grant that issued the token (`legacy` for a legacy token,
 * else the OAuth grant type) and its member binding. Null unless the system is known, the credential is bound to no
 * member, and the token is a legacy token or a client-credentials token. A credential listing scope sources keeps only
 * SCOPE_ATTEST_OPS, at every call, so a later default never widens it.
 */
export function attestRightFrom(row: Record<string, unknown> | undefined, grant: unknown, member: unknown): AttestRight | null {
  const system = row?.attest_actor;
  if (typeof system !== 'string' || !ATTEST_SYSTEMS.includes(system) || member != null) return null;
  if (grant !== 'legacy' && grant !== 'client_credentials') return null;
  const ops = Array.isArray(row!.attest_ops) ? (row!.attest_ops as unknown[]).filter((v): v is string => typeof v === 'string') : [...DEFAULT_ATTEST_OPS];
  const sources = Array.isArray(row!.attest_sources) ? (row!.attest_sources as unknown[]).filter((v): v is string => typeof v === 'string') : null;
  const read: 'person' | 'scope' | null = row!.attest_read === 'scope' ? 'scope' : row!.attest_read === 'person' && !sources?.length ? 'person' : null;
  const readField = read ? { read } : {};
  if (!sources?.length) return { system, ops, sources: null, ...readField };
  return { system, ops: ops.filter(op => SCOPE_ATTEST_OPS.has(op)), sources, ...readField };
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
