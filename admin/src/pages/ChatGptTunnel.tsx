import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface TunnelStatus {
  binaryPath: string;
  binaryFound: boolean;
  binaryVersion?: string;
  profileFile: string;
  profileExists: boolean;
  runtimeKeyConfigured: boolean;
  authorizationConfigured: boolean;
  tunnelId?: string;
  suggestedTunnelId?: string;
  pid?: number;
  processRunning: boolean;
  healthUrl: string;
  localMcpUrl: string;
  health: { ok: boolean; status: number | null };
  ready: { ok: boolean; status: number | null };
}

interface DoctorResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

function StatusPill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`tunnel-pill ${ok ? 'is-ok' : 'is-idle'}`}><i />{children}</span>;
}

export function ChatGptTunnelPanel() {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [binaryPath, setBinaryPath] = useState('D:\\tools\\tunnel-client\\tunnel-client.exe');
  const [tunnelId, setTunnelId] = useState('');
  const [runtimeApiKey, setRuntimeApiKey] = useState('');
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadStatus = async (path = binaryPath) => {
    try {
      const next = await api.chatGptTunnelStatus(path) as TunnelStatus;
      setStatus(next);
      setBinaryPath(next.binaryPath);
      setTunnelId(current => current || next.tunnelId || next.suggestedTunnelId || '');
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '读取 Tunnel 状态失败' });
    }
  };

  useEffect(() => { void loadStatus(); }, []);

  const act = async (name: string, action: () => Promise<unknown>, success: string) => {
    setBusy(name);
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'ok', text: success });
      await loadStatus();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : '操作失败' });
    } finally {
      setBusy(null);
    }
  };

  const configure = () => act('setup', async () => {
    await api.setupChatGptTunnel({
      tunnelId,
      runtimeApiKey: runtimeApiKey || undefined,
      binaryPath,
    });
    setRuntimeApiKey('');
    setDoctor(null);
  }, 'Tunnel 配置已生成，只读凭证已轮换。');

  const runDoctor = () => act('doctor', async () => {
    const result = await api.doctorChatGptTunnel(binaryPath) as DoctorResult;
    setDoctor(result);
    if (!result.ok) throw new Error('Doctor 未通过，请查看下方诊断输出。');
  }, 'Doctor 检查通过，可以启动 Tunnel。');

  return (
    <section className="tunnel-shell" aria-labelledby="chatgpt-tunnel-title">
      <div className="tunnel-hero">
        <div>
          <span className="tunnel-kicker">OUTBOUND-ONLY / READ-ONLY</span>
          <h2 id="chatgpt-tunnel-title">ChatGPT Secure MCP Tunnel</h2>
          <p>让 ChatGPT 通过 OpenAI 官方出站隧道读取 PMBrain。本机不开放公网端口，ChatGPT 不接触本地 Bearer Token。</p>
        </div>
        <div className="tunnel-signal" aria-label="Tunnel 状态">
          <span>{status?.ready.ok ? 'READY' : status?.processRunning ? 'CONNECTING' : 'OFFLINE'}</span>
          <strong>{status?.processRunning ? `PID ${status.pid}` : '手动启动'}</strong>
        </div>
      </div>

      <div className="tunnel-status-row">
        <StatusPill ok={!!status?.binaryFound}>客户端 {status?.binaryFound ? '已发现' : '未发现'}</StatusPill>
        <StatusPill ok={!!status?.profileExists}>Profile {status?.profileExists ? '已配置' : '待配置'}</StatusPill>
        <StatusPill ok={!!status?.runtimeKeyConfigured}>Runtime Key {status?.runtimeKeyConfigured ? '已保存' : '待输入'}</StatusPill>
        <StatusPill ok={!!status?.ready.ok}>通道 {status?.ready.ok ? 'Ready' : '未就绪'}</StatusPill>
      </div>

      <div className="tunnel-layout">
        <div className="tunnel-config-card">
          <div className="tunnel-card-head">
            <div><span>01</span><h3>本机配置</h3></div>
            <small>密钥只写入用户私有目录，不进入仓库</small>
          </div>
          <label className="tunnel-field">
            <span>tunnel-client 路径</span>
            <input value={binaryPath} onChange={event => setBinaryPath(event.target.value)} spellCheck={false} />
          </label>
          <label className="tunnel-field">
            <span>OpenAI Tunnel ID</span>
            <input value={tunnelId} onChange={event => setTunnelId(event.target.value)} placeholder="tunnel_..." spellCheck={false} />
          </label>
          <label className="tunnel-field">
            <span>Runtime API Key</span>
            <input
              type="password"
              value={runtimeApiKey}
              onChange={event => setRuntimeApiKey(event.target.value)}
              placeholder={status?.runtimeKeyConfigured ? '已保存；留空表示保持原值' : '首次配置必须填写'}
              autoComplete="off"
            />
          </label>
          <div className="tunnel-scope-lock">
            <span>权限锁</span>
            <b>READ ONLY</b>
            <p>只开放 search、query、list_pages、get_page、get_chunks、recall、get_brain_identity；写入、删除与管理工具不会出现在 ChatGPT 工具列表中。</p>
          </div>
          <button className="pm-primary tunnel-wide-button" disabled={busy !== null || !tunnelId} onClick={configure}>
            {busy === 'setup' ? '正在生成配置…' : status?.profileExists ? '重新生成并轮换凭证' : '生成安全配置'}
          </button>
        </div>

        <div className="tunnel-ops-card">
          <div className="tunnel-card-head">
            <div><span>02</span><h3>诊断与运行</h3></div>
            <small>不创建 Windows 服务或开机任务</small>
          </div>
          <div className="tunnel-route">
            <code>ChatGPT</code><i>→</i><code>OpenAI Tunnel</code><i>→</i><code>{status?.localMcpUrl || '127.0.0.1/mcp'}</code>
          </div>
          <dl className="tunnel-facts">
            <div><dt>客户端版本</dt><dd>{status?.binaryVersion || '—'}</dd></div>
            <div><dt>Profile</dt><dd title={status?.profileFile}>{status?.profileFile || '—'}</dd></div>
            <div><dt>Health</dt><dd>{status?.health.ok ? '200 / healthy' : 'offline'}</dd></div>
            <div><dt>Ready</dt><dd>{status?.ready.ok ? '200 / polling' : 'offline'}</dd></div>
          </dl>
          <div className="tunnel-actions">
            <button className="pm-secondary-action" disabled={busy !== null || !status?.profileExists} onClick={runDoctor}>
              {busy === 'doctor' ? '检查中…' : '运行 Doctor'}
            </button>
            <button
              className="pm-primary"
              disabled={busy !== null || !status?.profileExists || !!status?.processRunning}
              onClick={() => act('start', () => api.startChatGptTunnel(binaryPath), 'Tunnel 已启动。')}
            >{busy === 'start' ? '启动中…' : '启动 Tunnel'}</button>
            <button
              className="pm-secondary-action"
              disabled={busy !== null || !status?.processRunning}
              onClick={() => act('stop', () => api.stopChatGptTunnel(), 'Tunnel 已停止。')}
            >停止</button>
          </div>
          {message && <div className={`tunnel-message ${message.kind}`}>{message.text}</div>}
          {doctor && <pre className={`tunnel-doctor ${doctor.ok ? 'ok' : 'error'}`}>{doctor.output || '无输出'}</pre>}
        </div>
      </div>

      <div className="tunnel-connect-note">
        <span>03</span>
        <div>
          <h3>在 ChatGPT 中连接</h3>
          <p>设置 → Apps & Connectors → 创建自定义 App；连接选择 <b>Tunnel</b>，选择上面的 Tunnel ID，身份验证选择 <b>无身份验证</b>。本地 PMBrain 仍由只读 Token 保护。</p>
        </div>
      </div>
    </section>
  );
}
