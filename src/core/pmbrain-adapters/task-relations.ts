import type { BrainEngine } from '../engine.ts';
import type { TaskRelation } from '../../../shared/task-progress.ts';
import { executeRawJsonb } from '../sql-query.ts';
export type LinkAudit = { taskId: number; phase: string };

export async function recordCreatedTaskLinks(engine: Pick<BrainEngine, 'executeRaw'>, audit: LinkAudit | undefined, ids: number[]) {
  if (!audit || !ids.length) return;
  const rows = await engine.executeRaw<TaskRelation>(`SELECT l.id::int, f.id::int AS "fromId", t.id::int AS "toId",
    f.source_id AS "fromSourceId", t.source_id AS "toSourceId", f.slug AS "fromSlug", t.slug AS "toSlug",
    f.title AS "fromTitle", t.title AS "toTitle", l.link_type AS type, l.link_source AS producer,
    l.context, $2::text AS phase, true AS present
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE l.id=ANY($1::bigint[])`, [ids, audit.phase]);
  if (rows.length !== ids.length) throw new Error('本次新增关联的数据库凭据不完整');
  const entries = Object.fromEntries(rows.map(row => [row.id, row]));
  const saved = await executeRawJsonb(engine, `UPDATE minion_jobs SET data=jsonb_set(data,'{relations}',
    COALESCE(data->'relations','{}'::jsonb) || $2::jsonb), updated_at=now() WHERE id=$1 RETURNING id`, [audit.taskId], [entries]);
  if (!saved.length) throw new Error('关联所属任务不存在');
}
