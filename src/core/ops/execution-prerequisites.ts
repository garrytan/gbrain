/**
 * #6621/#6663: what an operation needs at execution time beyond the scope its
 * definition declares. The grant diagnosis (harness/capabilities.ts) reads
 * this table so it never tells a connection that a snapshot or scope change
 * alone makes these operations work. Enforcement stays where it is:
 * `memory_confirm` in trust/confirm.ts (requireOwnerConfirmation) and explicit
 * snapshot approval in shared-skills/membership-authority.ts (memberAuthority).
 * Kept as data beside the operations so the generated operation manifest does
 * not change; test/grant-execution-prerequisites.test.ts pins every key to a
 * registered operation and to the enforcement it describes.
 */
/** trust/confirm.ts MEMORY_CONFIRM_SCOPE; a literal keeps this table a leaf of the schema-migration import closure (v202 imports grants/legacy-token.ts). */
const MEMORY_CONFIRM_SCOPE = 'memory_confirm';

export type ExecutionPrerequisiteKind = 'owner_granted_scope' | 'explicit_operation_approval';

export interface ExecutionPrerequisite {
  kind: ExecutionPrerequisiteKind;
  /** owner_granted_scope: the scope the operation's real work also needs. */
  scope?: string;
  /** What lifts it, for the diagnosis. */
  fix: string;
}

const MEMBERSHIP_APPROVAL: ExecutionPrerequisite = {
  kind: 'explicit_operation_approval',
  fix: 'The brain owner approves this membership operation by name in the grant\'s operation snapshot; a grant with no snapshot does not reach it.',
};

export const EXECUTION_PREREQUISITES: Readonly<Record<string, ExecutionPrerequisite>> = {
  confirm_memory: {
    kind: 'owner_granted_scope', scope: MEMORY_CONFIRM_SCOPE,
    fix: `Snapshot admission does not grant trust promotion: confirming memory needs the ${MEMORY_CONFIRM_SCOPE} scope, which only the brain owner grants from the local CLI.`,
  },
  join_brain: MEMBERSHIP_APPROVAL,
  sync_brain_skills: MEMBERSHIP_APPROVAL,
  leave_brain: MEMBERSHIP_APPROVAL,
};

/** Operations a grant reaches only when its operation snapshot names them (never through a missing snapshot). */
export function requiresExplicitApproval(operation: string): boolean {
  return EXECUTION_PREREQUISITES[operation]?.kind === 'explicit_operation_approval';
}
