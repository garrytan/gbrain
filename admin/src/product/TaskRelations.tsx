import React, { useState } from 'react';
import { api } from '../api';
import type { ConsoleRun } from '../lib/shared';
import type { TaskRelations } from '../../../shared/task-progress';

export function TaskRelationsDetails({ run }: { run: ConsoleRun }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<TaskRelations | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const count = run.product?.relations?.available ? run.product.relations.total
    : run.product?.metrics.find(metric => ['新增关联','新建关联','新增关系'].includes(metric.label))?.value;
  if (count == null) return null;
  const load = async (after = 0) => {
    setLoading(true); setError('');
    try { const value = await api.runRelations(run.id, after); setData(previous => after && previous ? { ...value, rows: [...previous.rows, ...value.rows] } : value); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  };
  const origin = (phase: string, producer: string | null) => /historical|backfill/.test(phase) ? '历史补扫'
    : phase.includes('capture_entities') ? '实体识别' : producer === 'mentions' ? '正文提及' : producer === 'frontmatter' ? '属性引用' : '知识引用';
  return <section className="product-task-relations">
    <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }}>新增关联 {count}</button>
    {open && <div>
      {loading && <p role="status">正在读取关联明细…</p>}
      {error && <p role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
      {data && !data.available && <p>此历史任务未保存逐条关联凭据，无法确认哪些关联由本轮新增。</p>}
      {data?.available && !data.rows.length && <p>本轮没有新增关联。</p>}
      {!!data?.rows.length && <div className="product-task-relation-table"><table><thead><tr><th>来源知识</th><th>关联知识</th><th>关联类型</th><th>来源</th><th>依据</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}
        className={row.present ? 'is-clickable' : undefined} tabIndex={row.present ? 0 : undefined}
        onClick={() => { if (row.present) window.location.hash = `graph?edge=${row.id}`; }}
        onKeyDown={event => { if (row.present && event.target === event.currentTarget && ['Enter',' '].includes(event.key)) { event.preventDefault(); window.location.hash = `graph?edge=${row.id}`; } }}>
        <td>{row.fromTitle}<small>{row.fromSourceId} · {row.fromSlug}</small></td>
        <td>{row.toTitle}<small>{row.toSourceId} · {row.toSlug}</small></td>
        <td>{row.type === 'mentions' ? '提及' : row.type || '引用'}</td><td>{origin(row.phase, row.producer)}<small>{row.phase}</small></td>
        <td>{row.context || '这条关联未记录原文上下文。'}<br/>{row.present ? <button type="button" onClick={() => { window.location.hash = `graph?edge=${row.id}`; }}>定位连线</button> : <small>该关联已清理或知识已移出</small>}</td>
      </tr>)}</tbody></table></div>}
      {data?.next && <button type="button" disabled={loading} onClick={() => void load(data.next!)}>查看更多关联</button>}
    </div>}
  </section>;
}
