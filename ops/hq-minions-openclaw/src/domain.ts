import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { z } from 'zod';

export const WorkItemSchema = z.object({
  projectId: z.string().min(1),
  workstreamId: z.string().min(1).default('default'),
  title: z.string().min(1),
  owner: z.string().optional(),
  requester: z.string().optional(),
  labels: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(1000).default(100),
  queue: z.string().min(1).default('hq'),
  runNow: z.boolean().default(false),
  createdBy: z.string().default(userInfo().username),
  idempotencyKey: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

export type WorkItem = z.infer<typeof WorkItemSchema>;

export function toJobData(input: WorkItem): Record<string, unknown> {
  return {
    tracker_role: 'work_item',
    schema_version: 1,
    project_id: input.projectId,
    workstream_id: input.workstreamId,
    title: input.title,
    owner: input.owner ?? null,
    requester: input.requester ?? null,
    labels: input.labels,
    acceptance_criteria: input.acceptanceCriteria,
    source: 'hq-minions-openclaw',
    created_by: input.createdBy,
    created_at: new Date().toISOString()
  };
}

export function idempotencyKey(input: WorkItem): string {
  if (input.idempotencyKey) return input.idempotencyKey;
  const stable = JSON.stringify({
    projectId: input.projectId,
    workstreamId: input.workstreamId,
    title: input.title,
    source: 'hq-minions-openclaw'
  });
  return `hq-openclaw:${createHash('sha256').update(stable).digest('hex')}`;
}

export function isWorkItem(job: Record<string, unknown>): boolean {
  const data = (job.data ?? {}) as Record<string, unknown>;
  return data.tracker_role === 'work_item';
}

export function matchesWorkItem(job: Record<string, unknown>, filters: Record<string, unknown>): boolean {
  if (!isWorkItem(job)) return false;
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (filters.project && data.project_id !== filters.project) return false;
  if (filters.workstream && data.workstream_id !== filters.workstream) return false;
  if (filters.owner && data.owner !== filters.owner) return false;
  return true;
}
