import React, { useState, useEffect } from 'react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';

interface LogEntry {
  id: number;
  token_name: string;
  agent_name: string;
  operation: string;
  latency_ms: number;
  status: string;
  params: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}

function statusLabel(status: string): string {
  return status === 'success' ? '成功' : status === 'error' ? '错误' : status;
}

export function RequestLogPage() {
  const [data, setData] = useState<{ rows: LogEntry[]; total: number; page: number; pages: number }>({
    rows: [], total: 0, page: 1, pages: 1,
  });
  const [page, setPage] = useState(1);
  const [agentFilter, setAgentFilter] = useState('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  useEffect(() => { loadPage(page); }, [page, agentFilter]);

  const loadPage = (p: number) => {
    const qs = agentFilter !== 'all' ? `&agent=${encodeURIComponent(agentFilter)}` : '';
    api.requests(p, qs).then(setData).catch(() => {});
  };

  const timeAgo = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return new Date(ts).toLocaleDateString();
  };

  const formatParams = (params: Record<string, unknown> | null) => {
    if (!params) return null;
    const { query, slug, partial, limit, ...rest } = params as any;
    const parts: string[] = [];
    if (query) parts.push(`"${query}"`);
    if (slug) parts.push(slug);
    if (partial) parts.push(`~${partial}`);
    if (limit) parts.push(`limit=${limit}`);
    if (Object.keys(rest).length > 0) parts.push(`+${Object.keys(rest).length} 个参数`);
    return parts.join(' ');
  };

  // Collect unique agents for filter (use name for display, token_name for value)
  const agentMap = new Map<string, string>();
  data.rows.forEach(r => { if (r.token_name) agentMap.set(r.token_name, r.agent_name || r.token_name); });

  return (
    <div className="pm-page request-log-page">
      <div className="pm-section-head page-command-head">
        <h1 className="page-title title-with-info">
          请求日志
          <InfoIcon title="请求日志">
            记录外部 Agent 通过 MCP 调用 PMBrain 的时间、操作、参数、延迟和状态。用它排查 CodeBuddy 等工具是否接入成功。
          </InfoIcon>
        </h1>
        <label className="request-agent-filter">
          <span>Agent</span>
          <select value={agentFilter} onChange={e => { setAgentFilter(e.target.value); setPage(1); }}>
            <option value="all">全部 Agent</option>
            {[...agentMap.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      {data.rows.length === 0 ? (
        <div className="pm-card pm-empty request-log-empty">
          暂无请求。
        </div>
      ) : (
        <div className="pm-card request-log-card">
          <div className="table-scroll">
          <table className="request-log-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>Agent</th>
                <th>操作</th>
                <th>参数</th>
                <th>延迟</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setExpandedRow(expandedRow === r.id ? null : r.id)}
                      className="request-log-row">
                    <td className="request-log-time">{timeAgo(r.created_at)}</td>
                    <td>
                      <button type="button" className="request-agent-link"
                         onClick={(e) => { e.stopPropagation(); setAgentFilter(r.token_name); setPage(1); }}>
                        {r.agent_name || r.token_name}
                      </button>
                    </td>
                    <td className="mono">{r.operation}</td>
                    <td className="request-log-params" title={formatParams(r.params) ?? undefined}>
                      {formatParams(r.params)}
                    </td>
                    <td className="mono">{r.latency_ms}ms</td>
                    <td><span className={`badge badge-${r.status}`}>{statusLabel(r.status)}</span></td>
                  </tr>
                  {expandedRow === r.id && (
                    <tr className="request-detail-row">
                      <td colSpan={6}>
                        <div className="request-detail-grid">
                          <span>时间</span>
                          <span>{new Date(r.created_at).toLocaleString()}</span>
                          <span>Agent</span>
                          <span className="mono">{r.token_name}</span>
                          <span>操作</span>
                          <span className="mono">{r.operation}</span>
                          <span>延迟</span>
                          <span>{r.latency_ms}ms</span>
                          {r.params && (
                            <>
                              <span>参数</span>
                              <pre className="mono">
                                {JSON.stringify(r.params, null, 2)}
                              </pre>
                            </>
                          )}
                          {r.error_message && (
                            <>
                              <span className="request-error-text">错误</span>
                              <span className="request-error-text">{r.error_message}</span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          </div>

          <div className="pagination request-pagination">
            <span>第 {data.page} / {data.pages} 页（共 {data.total} 条）</span>
            <div className="pagination-actions">
              <button disabled={data.page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
              <button disabled={data.page >= data.pages} onClick={() => setPage(p => p + 1)}>下一页</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
