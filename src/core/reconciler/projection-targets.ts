export const PROJECTION_TARGET_TYPES = [
  'markdown_page',
  'page_timeline',
  'profile_memory',
  'personal_episode',
  'task_resume',
  'project_doc',
  'system_doc',
  'source_summary',
  'daily_report',
] as const;

export type ProjectionTargetType = typeof PROJECTION_TARGET_TYPES[number];

export const PROJECTION_TARGET_STATUSES = [
  'applied',
  'pending_reconcile',
  'reconciled',
  'failed',
  'conflict',
] as const;

export type ProjectionTargetStatus = typeof PROJECTION_TARGET_STATUSES[number];

const TARGET_TYPE_SET = new Set<string>(PROJECTION_TARGET_TYPES);

export function isProjectionTargetType(value: string): value is ProjectionTargetType {
  return TARGET_TYPE_SET.has(value);
}

export function assertProjectionTargetType(value: string): ProjectionTargetType {
  if (!isProjectionTargetType(value)) {
    throw new Error(`projection target type must be one of: ${PROJECTION_TARGET_TYPES.join(', ')}`);
  }
  return value;
}

export function isRuntimeOnlyProjectionTarget(input: { runtime_only?: boolean }): boolean {
  return input.runtime_only === true;
}
