import React, { useEffect, useMemo, useState } from 'react';
import { AgentsPage } from './Agents';
import { ChatGptTunnelPanel } from './ChatGptTunnel';
import { CopyButton } from '../lib/clipboard';
import { InfoIcon } from '../lib/shared';
import { useOverview } from './console-shared';
import { desktopApi } from '../lib/product-fetch';
import { mcpServiceOrigin } from '../lib/mcp-service-origin';
export function ConnectionCenterPage() {
  const { overview } = useOverview();
  const [origin, setOrigin] = useState(() => mcpServiceOrigin(window.location.origin));
  const [serviceError, setServiceError] = useState('');
  useEffect(() => {
    const desktop = desktopApi();
    if (!desktop) return;
    let live = true;
    const update = (state: { port?: number; phase?: string; message?: string } | null) => {
      if (!live) return;
      setOrigin(mcpServiceOrigin(window.location.origin, state));
      setServiceError(state?.phase === 'failed' ? state.message || '本地服务读取失败' : '');
    };
    const unsubscribe = desktop.onState(update);
    void desktop.getState().then(update).catch((error: unknown) => { if (live) setServiceError(String(error)); });
    return () => { live = false; unsubscribe(); };
  }, []);
  const endpoint = (path: string) => origin ? `${origin}${path}` : '';
  const [showCodeBuddyGuide, setShowCodeBuddyGuide] = useState(false);
  const codeBuddyConfig = useMemo(() => JSON.stringify({
    mcpServers: {
      pmbrain: {
        type: 'http',
        url: origin ? `${origin}/mcp` : '',
        headers: {
          Authorization: 'Bearer PASTE_PMBRAIN_API_KEY_HERE',
        },
      },
    },
  }, null, 2), [origin]);
  return (
    <div className="pm-page connection-center-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            MCP 接入
            <InfoIcon title="MCP 接入">
              MCP 接入负责告诉外部 AI 工具服务地址和认证方式。下方 Agent 凭证管理用于创建可连接 PMBrain 的身份凭证。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">
            把 PMBrain 作为 MCP Server 接入 CodeBuddy、Cursor、Claude 等 AI 工具，让它们可以安全读取、检索和写入你的本地知识库。
          </p>
        </div>
        <button className="pm-primary" onClick={() => setShowCodeBuddyGuide(true)}>MCP 接入教程</button>
      </div>
      {overview && (
        <div className="pm-card main-source-note mcp-main-source">
          <b>默认读取源：{overview.main_source_id}</b>
          <span>MCP 请求未指定 source 时，会读取主知识库源。需要修改时请到“设置”页调整主知识库源。</span>
        </div>
      )}
      {serviceError && <p className="pm-error" role="alert">{serviceError}</p>}
      <div className="mcp-endpoint-grid">
        {[
          ['MCP Server', endpoint('/mcp')],
          ['OAuth Discovery', endpoint('/.well-known/oauth-authorization-server')],
          ['Token URL', endpoint('/token')],
        ].map(([label, value]) => (
          <article className="mcp-endpoint-card" key={label}>
            <span>{label}</span>
            <code>{value || '正在读取本地服务地址…'}</code>
            {value && <CopyButton className="pm-ghost" value={value} />}
          </article>
        ))}
      </div>
      <AgentsPage
        title="Agent 凭证管理"
        titleHelp={(
          <InfoIcon title="Agent 凭证管理">
            这里就是原来的 Agent 管理。外部工具访问 PMBrain 必须携带一个 Agent 凭证，最简单方式是新建 API Key，然后把它填入教程里的 Authorization: Bearer。
          </InfoIcon>
        )}
        description="为 CodeBuddy、Cursor、Claude 等外部工具创建专用 API Key 或 OAuth 客户端。每个工具建议使用独立 Agent 凭证，后续可以单独撤销、审计请求日志和控制权限。"
      />
      <details className="mcp-tunnel-details">
        <summary>
          <span>ChatGPT Secure MCP Tunnel</span>
          <small>仅在需要让 ChatGPT 远程读取 PMBrain 时展开</small>
        </summary>
        <div className="mcp-tunnel-details-body">
          <ChatGptTunnelPanel />
        </div>
      </details>
      {showCodeBuddyGuide && (
        <div className="modal-overlay" onClick={() => setShowCodeBuddyGuide(false)}>
          <div className="modal mcp-tutorial-modal" onClick={e => e.stopPropagation()}>
            <button className="drawer-close" onClick={() => setShowCodeBuddyGuide(false)}>&#10005;</button>
            <div className="modal-title">MCP 接入教程</div>
            <div className="mcp-tutorial-body">
              <section>
                <h3>准备工作</h3>
                <ol>
                  <li>保持 PMBrain HTTP 服务运行，当前 MCP 地址是 <code>{endpoint('/mcp') || '正在读取本地服务地址…'}</code>。</li>
                  <li>在本页下方点击 <b>+ API Key</b>，创建一个给 CodeBuddy 使用的 Agent。</li>
                  <li>复制创建时显示的 API Key。离开弹窗后不会再次显示完整密钥。</li>
                </ol>
              </section>
              <section>
                <h3>CodeBuddy 配置</h3>
                <p>把下面内容保存到用户级 <code>~/.codebuddy/.mcp.json</code>，或当前项目根目录的 <code>.mcp.json</code>。</p>
                <div className="code-block">
                  <pre>{codeBuddyConfig}</pre>
                  <CopyButton value={codeBuddyConfig} />
                </div>
                <p className="pm-hint">把 <code>PASTE_PMBRAIN_API_KEY_HERE</code> 替换成刚创建的 API Key，只替换这段占位符。</p>
              </section>
              <section>
                <h3>验证连接</h3>
                <ol>
                  <li>保存配置后重启 CodeBuddy，或执行它的重新加载插件/刷新 MCP 操作。</li>
                  <li>在 CodeBuddy 中询问：<code>用 PMBrain 搜索一下最近的项目资料</code>。</li>
                  <li>回到本页的请求日志，确认出现来自 CodeBuddy 的 MCP 请求。</li>
                </ol>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
