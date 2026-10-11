import type { BrainEngine } from '../../core/engine.ts';
import { ENTITY_CAPTURE_PENDING_PREFIX } from '../../core/pmbrain-adapters/entity-capture-request.ts';
import type { ProductTask, MaintenanceCheckpoint } from './types.ts';

export function maintenanceFailure(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const report = result as { status?: string; reason?: string; phases?: Array<{ status?: string; error?: { message?: string }; details?: { stop_reason?: string } }> };
  if (report.status === 'skipped') return report.reason === 'cycle_already_running' ? '未执行：其他整理任务占用数据库，请排队后继续。' : `未执行：${report.reason ?? '整理被跳过'}`;
  const failed = report.phases?.find(phase => phase.status === 'fail' || (phase.error?.message && !['tokens', 'cost'].includes(phase.details?.stop_reason ?? '')) || ['failure', 'ingest_validation', 'relation_failure', 'model_unavailable'].includes(phase.details?.stop_reason ?? ''));
  return failed ? failed.error?.message ?? '整理验收失败，请查看任务详情。' : report.status === 'failed' ? '整理执行失败，请查看任务详情。' : null;
}

export async function claimMaintenanceCapture(engine: BrainEngine, id: number, token: string, sourceId: string): Promise<string[] | undefined> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [`entity-capture:${sourceId}`]);
    const [owner] = await tx.executeRaw<{ data: { task: ProductTask } }>(`SELECT j.data FROM minion_jobs j JOIN sources s ON s.id=$3
      WHERE j.id=$1 AND j.status='active' AND j.lock_token=$2 AND NOT s.archived FOR UPDATE OF j`, [id, token, sourceId]);
    const task = owner?.data.task;
    if (!task || task.type !== 'dream' || task.input.preset !== 'quick' || (!task.input.allSources && (task.input.sourceId ?? 'default') !== sourceId)) throw new Error('实体识别不属于当前快速维护或Source已改变');
    const checkpoint: MaintenanceCheckpoint = task.input.checkpoint ?? { phases: {}, reports: {} };
    const key = ENTITY_CAPTURE_PENDING_PREFIX + sourceId;
    const [pending] = await tx.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1 FOR UPDATE', [key]);
    const request = pending ? JSON.parse(pending.value) as { slugs?: string[] } : undefined;
    const slugs = [...new Set([...(checkpoint.captureRequests?.[sourceId] ?? []), ...(request?.slugs ?? [])])];
    if (!slugs.length) return undefined;
    checkpoint.captureRequests = { ...checkpoint.captureRequests, [sourceId]: slugs };
    await tx.executeRaw(`UPDATE minion_jobs SET data=jsonb_set(data,'{task,input,checkpoint}',$3::jsonb),updated_at=now() WHERE id=$1 AND lock_token=$2`, [id, token, checkpoint]);
    if (pending) await tx.executeRaw('DELETE FROM config WHERE key=$1 AND value=$2', [key, pending.value]);
    return slugs;
  });
}
