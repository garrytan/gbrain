/**
 * #6712 PR 2 (L5): the public category of a fault, a small closed vocabulary an operator or agent can branch on without
 * knowing gbrain's internal codes. It sits beside the existing `category` (`terminal-classify.ts` `TerminalCategory`, the
 * diagnosis vocabulary), which is unchanged. The mapping is total: every terminal category, every `SYNC_FAULT_TABLE` code
 * and every registry code has one (a code this build does not know is `defect`), so `public_category` is never absent.
 *
 *   drift            the file or the database moved under the write (a working-tree edit, a page that changed since import)
 *   conflict         two writers changed the same page; a person or the caller picks
 *   content_refused  the file's own content was refused (frontmatter, fences, size, a gate)
 *   file_missing     the page's file is gone (a ghost page)
 *   permission       the principal may not do this
 *   storage          the database or the worktree refused or needs recovery
 *   config           a setting, a cap or a choice on the brain host decides
 *   superseded       another run or request made this one moot; nothing to fix
 *   transient        retry: a connection, a lease, back-pressure or a stalled preparation
 *   defect           a gbrain fault to report (or a cause this build cannot name)
 */
import { CODES } from '../error-registry.ts';
import type { TerminalCategory } from './terminal-classify.ts';

export const PUBLIC_CATEGORIES = ['drift', 'conflict', 'content_refused', 'file_missing', 'permission', 'storage', 'config', 'superseded', 'transient', 'defect'] as const;
export type PublicCategory = typeof PUBLIC_CATEGORIES[number];

/** Every terminal category; `sync_fault` and `caller_refusal` refine by code. */
export const PUBLIC_BY_TERMINAL: Readonly<Record<TerminalCategory, PublicCategory>> = {
  recovery_pending: 'transient', recovery_blocked: 'storage',
  knock_on: 'superseded', run_replaced: 'superseded', outside_fence: 'defect',
  operator_cancelled: 'superseded', caller_conflict: 'conflict', file_conflict: 'drift', canonical_file_missing: 'file_missing', fence_unrenderable: 'defect',
  writer_guard: 'defect', database_refusal: 'config', owner_exception: 'defect', legacy_publication_refusal: 'superseded',
  sync_fault: 'defect', transport: 'transient', caller_refusal: 'content_refused', gbrain_defect: 'defect', diagnosis_required: 'defect',
  schema_missing: 'storage',
};

/** Fault codes (holds, run stops, receipts) by name; a test pins that every `SYNC_FAULT_TABLE` code is here. */
export const PUBLIC_BY_CODE: Readonly<Record<string, PublicCategory>> = {
  worktree_dirty: 'drift', file_drift: 'drift', source_changed: 'drift', pinned_git_worktree_conflict: 'drift',
  concurrent_write: 'conflict', revision_conflict: 'conflict', page_identity_changed: 'conflict', legacy_slug_conflict: 'conflict', origin_conflict: 'conflict', origin_conflict_decision: 'conflict',
  invalid_fence: 'content_refused', invalid_frontmatter: 'content_refused', frontmatter_slug_conflict: 'content_refused', rename_held: 'content_refused',
  file_too_large: 'content_refused', content_rejected: 'content_refused', managed_image_sync_unsupported: 'content_refused',
  purged_content: 'content_refused', write_gate_rejected: 'content_refused',
  file_database_drift: 'drift', raw_file_changed: 'drift', pending_import: 'transient',
  source_binding_changed: 'config', unsafe_file_target: 'config',
  canonical_file_missing: 'file_missing',
  parser_regression: 'defect', outside_fence: 'defect', preparation_systemic: 'defect', drain_stalled: 'defect',
  cancelled: 'superseded', knock_on: 'superseded', run_replaced: 'superseded', knock_on_exhausted: 'superseded', cursor_incarnation_retired: 'superseded',
  preparation_stalled: 'transient', sync_incomplete: 'transient', connection_lost: 'transient', database_contention: 'transient', write_interrupted: 'transient', write_capacity: 'transient',
  write_capacity_backpressure: 'transient', capacity_paused: 'transient', sync_drain_lease_held: 'transient', graduation_in_progress: 'transient',
  storage_error: 'storage', recovery_required: 'storage',
  permission_denied: 'permission',
  owner_unavailable: 'config', writer_coordinator_required: 'config', write_quota_exhausted: 'config', write_quota_insufficient: 'config', plan_stale: 'config',
  slug_root_mode_mismatch: 'config', invalid_params: 'config',
};

/** A registry code's class, for a code neither table names. */
function byRegistryClass(code: string): PublicCategory {
  const entry = (CODES as Record<string, { class: string; retired_in?: string } | undefined>)[code];
  if (!entry) return 'defect';
  if (entry.retired_in) return 'superseded';
  switch (entry.class) {
    case 'retryable': case 'unavailable': return 'transient';
    case 'consent': case 'host_only': return 'config';
    case 'caller': return 'content_refused';
    default: return 'defect';
  }
}

/**
 * The public category of a verdict (`category` from `classifyTerminal`, when there is one) or of a bare code (a hold, a run
 * stop). A specific terminal category wins; `sync_fault`, `caller_refusal` and no category go by code.
 */
export function publicCategory(input: { category?: TerminalCategory | null; code: string }): PublicCategory {
  const category = input.category ?? null;
  if (category && category !== 'sync_fault' && category !== 'caller_refusal') return PUBLIC_BY_TERMINAL[category];
  return PUBLIC_BY_CODE[input.code] ?? (category === 'caller_refusal' ? (input.code.includes('permission') ? 'permission' : 'content_refused') : byRegistryClass(input.code));
}
