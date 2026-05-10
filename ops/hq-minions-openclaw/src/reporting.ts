import { isWorkItem, matchesWorkItem } from './domain.ts';
import type { MinionQueueLike } from './gbrain.ts';

const statuses = ['active', 'failed', 'dead', 'waiting', 'paused', 'delayed', 'waiting-children', 'completed', 'cancelled'];

export async function listWorkItems(
  queue: MinionQueueLike,
  opts: { project?: string; workstream?: string; owner?: string; status?: string; limit?: number }
): Promise<Record<string, unknown>[]> {
  const jobs: Record<string, unknown>[] = [];
  if (opts.status) {
    jobs.push(...await queue.getJobs({ status: opts.status, limit: opts.limit ?? 100 }));
  } else {
    for (const status of statuses) {
      jobs.push(...await queue.getJobs({ status, limit: opts.limit ?? 100 }));
    }
  }

  return jobs
    .filter(job => matchesWorkItem(job, opts))
    .slice(0, opts.limit ?? 100);
}

export async function board(
  queue: MinionQueueLike,
  opts: { project?: string; workstream?: string; owner?: string; limit?: number }
): Promise<{ counts: Record<string, unknown>[]; items: Record<string, unknown>[] }> {
  const items = await listWorkItems(queue, { ...opts, limit: opts.limit ?? 500 });
  const map = new Map<string, { project: string; workstream: string; status: string; count: number }>();

  for (const job of items) {
    if (!isWorkItem(job)) continue;
    const data = (job.data ?? {}) as Record<string, unknown>;
    const project = String(data.project_id ?? 'unassigned');
    const workstream = String(data.workstream_id ?? 'default');
    const status = String(job.status ?? 'unknown');
    const key = `${project}\0${workstream}\0${status}`;
    const existing = map.get(key) ?? { project, workstream, status, count: 0 };
    existing.count += 1;
    map.set(key, existing);
  }

  return {
    counts: Array.from(map.values()).sort((a, b) =>
      a.project.localeCompare(b.project) ||
      a.workstream.localeCompare(b.workstream) ||
      a.status.localeCompare(b.status)
    ),
    items
  };
}
