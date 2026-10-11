import type { BrainEngine } from '../../core/engine.ts';
import type { TaskRelation, TaskRelations } from '../../../shared/task-progress.ts';

export async function readTaskRelations(engine: BrainEngine, jobId: number, after = 0, limit = 30): Promise<TaskRelations> {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('无效的关联分页位置');
  const pageSize = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 30;
  const counts = await engine.executeRaw<{ total: number; available: boolean }>(`SELECT
    COALESCE((SELECT count(*)::int FROM jsonb_object_keys(COALESCE(data->'relations','{}'::jsonb))),0) AS total,
    data ? 'relations' AS available FROM minion_jobs WHERE id=$1`, [jobId]);
  if (!counts.length) throw new Error('run_not_found');
  const rows = await engine.executeRaw<{ entry: TaskRelation; present: boolean }>(`SELECT v.value AS entry,
    l.id IS NOT NULL AND f.deleted_at IS NULL AND t.deleted_at IS NULL AS present
    FROM minion_jobs j CROSS JOIN LATERAL jsonb_each(COALESCE(j.data->'relations','{}'::jsonb)) v
    LEFT JOIN links l ON l.id=v.key::bigint LEFT JOIN pages f ON f.id=l.from_page_id LEFT JOIN pages t ON t.id=l.to_page_id
    WHERE j.id=$1 AND v.key::bigint>$2 ORDER BY v.key::bigint LIMIT $3`, [jobId, after, pageSize]);
  const entries = rows.map(row => ({ ...row.entry, present: row.present }));
  return { total: counts[0].total, available: counts[0].available, rows: entries, next: entries.length === pageSize ? entries.at(-1)!.id : null };
}
