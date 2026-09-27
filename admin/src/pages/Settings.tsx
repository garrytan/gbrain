import React, { useEffect, useState } from 'react';
import { Clock3, Download, MonitorCog, Sparkles } from 'lucide-react';
import { api } from '../api';
import { RunOutput, type ConsoleRun } from '../lib/shared';
import type { ThemeMode } from '../lib/theme';
import { MainSourceSettings } from './Knowledge';
import { SourceManagementSettings } from './Sources';
import { LoadingBlock, useOverview } from './console-shared';
import type {
  DreamScheduleResponse,
  DreamSettingsResponse,
} from '../../../shared/contracts/index.ts';
export function ModelConfigPage() {
  const { overview, reload } = useOverview();
  if (!overview) return <LoadingBlock />;
  return (
    <div className="pm-page">
      <h1>模型配置快照</h1>
      <p className="pm-page-intro">模型和 API Key 由桌面端统一管理。本页只显示当前实际读取到的脱敏配置。</p>
      <div className="pm-grid two-col">
        <div className="pm-card">
          <h2>模型路由</h2>
          <div className="pm-kv"><span>Chat</span><b>{overview.chat_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Embedding</span><b>{overview.embedding_model ?? '未配置'}</b></div>
          <div className="pm-kv"><span>Dimensions</span><b>{overview.embedding_dimensions ?? '-'}</b></div>
          <div className="pm-kv"><span>Expansion</span><b>{overview.expansion_model ?? '-'}</b></div>
        </div>
        <div className="pm-card">
          <h2>Provider Key 状态</h2>
          {Object.entries(overview.provider_status.providers).map(([name, ok]) => (
            <div className="pm-kv" key={name}>
              <span>{name}</span>
              <b className={ok ? 'pm-ok' : 'pm-warn'}>{ok ? '已配置' : '未配置'}</b>
            </div>
          ))}
        </div>
      </div>
      <div className="pm-card">
        <h2>脱敏配置</h2>
        <pre>{JSON.stringify(overview.config, null, 2)}</pre>
      </div>
    </div>
  );
}

function MarkdownExportSettings() {
  const [rootPath, setRootPath] = useState('');
  const [run, setRun] = useState<ConsoleRun | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'queued')) return;
    const timer = window.setInterval(async () => {
      try {
        setRun(await api.run(run.id) as ConsoleRun);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  const startExport = async () => {
    if (!rootPath.trim()) return;
    setError('');
    setOutputDir('');
    try {
      const response = await api.startMarkdownExportRun(rootPath.trim()) as { runId: string; outputDir: string };
      setOutputDir(response.outputDir);
      setRun(await api.run(response.runId) as ConsoleRun);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };

  return (
    <div className="pm-card markdown-export-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Download /></span>
          <div>
            <h2>导出本地 Markdown</h2>
            <p className="pm-hint">可选择 Obsidian Vault 的上级目录。每次都会创建新的 PMBrain-Export 快照目录，并按 Source 保留原有目录结构。</p>
          </div>
        </div>
      </div>
      <label>保存到哪个目录</label>
      <div className="export-path-row">
        <input value={rootPath} onChange={event => setRootPath(event.target.value)} placeholder="D:\\Obsidian\\Vault" />
        <button className="pm-primary" onClick={() => void startExport()} disabled={!rootPath.trim() || run?.status === 'running'}>导出快照</button>
      </div>
      <p className="pm-hint">当前能力会导出全部 Source，并按 Source 分目录保存；这是安全的全库快照，不是双向同步，也不会增量覆盖或同步删除。</p>
      {outputDir && <div className="export-output"><span>输出目录</span><code>{outputDir}</code></div>}
      {error && <div className="pm-error-text">{error}</div>}
      {run && <RunOutput run={run} />}
    </div>
  );
}

type DreamSettingsValue = DreamSettingsResponse;

function DreamSettings() {
  const [settings, setSettings] = useState<DreamSettingsValue>({
    outputDir: 'output',
    dualWrite: true,
    includeUncommitted: false,
    defaultBrainDir: null,
    resolvedOutputDir: null,
    directoryExists: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOutputDir, setSavedOutputDir] = useState('output');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.dreamSettings()
      .then(value => {
        const loaded = value;
        setSettings(loaded);
        setSavedOutputDir(loaded.outputDir);
      })
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const outputDir = settings.outputDir.trim();
    if (!outputDir) {
      setError('请填写 Dream 输出目录');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveDreamSettings({ ...settings, outputDir });
      setSettings(current => ({ ...current, ...saved }));
      setSavedOutputDir(saved.outputDir);
      setMessage('知识整理设置已保存');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const saveDualWrite = async (dualWrite: boolean) => {
    const outputDir = settings.outputDir.trim();
    if (!outputDir) {
      setError('请先填写 Dream 输出目录');
      return;
    }
    const previousValue = settings.dualWrite;
    setSettings(current => ({ ...current, dualWrite }));
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveDreamSettings({ outputDir, dualWrite, includeUncommitted: settings.includeUncommitted });
      setSettings(current => ({ ...current, ...saved }));
      setSavedOutputDir(saved.outputDir);
      setMessage(dualWrite ? '已开启本地 Markdown 写入' : '已关闭本地 Markdown 写入');
    } catch (nextError) {
      setSettings(current => ({ ...current, dualWrite: previousValue }));
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const saveIncludeUncommitted = async (includeUncommitted: boolean) => {
    const previousValue = settings.includeUncommitted;
    setSettings(current => ({ ...current, includeUncommitted }));
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await api.saveDreamSettings({
        outputDir: settings.outputDir.trim() || 'output',
        dualWrite: settings.dualWrite,
        includeUncommitted,
      });
      setSettings(current => ({ ...current, ...saved }));
      setMessage(includeUncommitted ? '快速维护将包含未提交内容' : '快速维护只同步 Git 已提交内容');
    } catch (nextError) {
      setSettings(current => ({ ...current, includeUncommitted: previousValue }));
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const outputDirDirty = settings.outputDir.trim() !== savedOutputDir.trim();
  const outputIsAbsolute = /^[A-Za-z]:[\\/]/.test(settings.outputDir)
    || /^\\\\/.test(settings.outputDir)
    || settings.outputDir.startsWith('/');
  const separator = settings.defaultBrainDir?.includes('\\') ? '\\' : '/';
  const liveResolvedOutputDir = outputIsAbsolute
    ? settings.outputDir
    : settings.defaultBrainDir
      ? `${settings.defaultBrainDir.replace(/[\\/]+$/, '')}${separator}${settings.outputDir.replace(/^[\\/]+/, '')}`
      : null;

  return (
    <section className="pm-card dream-settings-card settings-panel">
      <div className="pm-section-head settings-panel-head">
        <div className="settings-panel-title">
          <span className="settings-panel-icon"><Sparkles /></span>
          <div>
            <h2>知识整理设置</h2>
            <p className="pm-hint">设置 Dream 生成内容的本地保存位置，以及是否同时保留 Markdown 文件。</p>
          </div>
        </div>
      </div>
      <div className="dream-settings-grid">
        <div className="dream-output-setting">
          <label htmlFor="dream-output-dir">Dream 输出目录（相对目录或完整路径）</label>
          <div className="dream-output-action-row">
            <input
              id="dream-output-dir"
              value={settings.outputDir}
              onChange={event => setSettings(current => ({ ...current, outputDir: event.target.value }))}
              placeholder="output"
              disabled={loading || saving}
            />
            <button className="pm-primary" onClick={() => void save()} disabled={loading || saving || !outputDirDirty || !settings.outputDir.trim()}>
              {saving ? '正在保存…' : '保存'}
            </button>
          </div>
          <div className="dream-output-preview">
            <span>默认 Dream 目录</span>
            <code>{settings.defaultBrainDir ?? '尚未配置本地知识库目录'}</code>
            <span>当前实际输出目录</span>
            <code>{liveResolvedOutputDir ?? '请先配置本地知识库目录，或填写带盘符的完整路径'}</code>
          </div>
          <p className="pm-hint">
            填写 <code>output</code> 不需要盘符，它会保存到上面的默认 Dream 目录中。高级设置选择其他 Source 时，会改为该 Source 的本地目录下的同名文件夹。
            保存设置时，目录不存在会自动创建；已经存在则直接复用，不会清空目录。
          </p>
        </div>
        <label className="dream-dual-write-setting" htmlFor="dream-dual-write">
          <span>
            <b>写入本地 Markdown</b>
            <small>开启后，Dream 会同时写入数据库和本地文件，相当于持续维护一套 LLM Wiki。默认开启，不建议关闭。</small>
          </span>
          <input
            id="dream-dual-write"
            type="checkbox"
            checked={settings.dualWrite}
            onChange={event => void saveDualWrite(event.target.checked)}
            disabled={loading || saving}
          />
        </label>
        <label className="dream-dual-write-setting" htmlFor="sync-include-uncommitted">
          <span>
            <b>包含未提交内容</b>
            <small>默认关闭。关闭时快速维护只同步 Git 已提交版本，并提示尚未提交的变化；开启后才同步工作区修改和新文件。</small>
          </span>
          <input
            id="sync-include-uncommitted"
            type="checkbox"
            checked={settings.includeUncommitted}
            onChange={event => void saveIncludeUncommitted(event.target.checked)}
            disabled={loading || saving}
          />
        </label>
      </div>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}

type DreamScheduleSettingsValue = DreamScheduleResponse;

const DEFAULT_DREAM_SCHEDULE: DreamScheduleSettingsValue = {
  enabled: false,
  time: '02:00',
  lastStartedDate: null,
  timeZone: 'local',
};

function DreamScheduleSettings() {
  const [value, setValue] = useState<DreamScheduleSettingsValue>(DEFAULT_DREAM_SCHEDULE);
  const [saved, setSaved] = useState<DreamScheduleSettingsValue>(DEFAULT_DREAM_SCHEDULE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.dreamSchedule()
      .then(next => {
        const loaded = next;
        setValue(loaded);
        setSaved(loaded);
      })
      .catch(nextError => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, []);

  const dirty = value.enabled !== saved.enabled || value.time !== saved.time;
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time);

  const save = async () => {
    if (!validTime) {
      setError('请选择有效的执行时间');
      return;
    }
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const next = await api.saveDreamSchedule({ enabled: value.enabled, time: value.time });
      setValue(next);
      setSaved(next);
      setMessage(next.enabled ? `已设置每天 ${next.time} 自动整理` : '已关闭定时一键整理');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pm-card dream-schedule-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><Clock3 /></span>
        <div>
          <h2>定时一键整理</h2>
          <p>每天到设定时间后，自动执行一次与“知识整理”页面「快速维护」相同的整理（同一套 quick 入口，不另起流程）。</p>
        </div>
      </div>
      <div className="dream-schedule-row">
        <label className="dream-schedule-toggle" htmlFor="dream-schedule-enabled">
          <span>
            <b>每天自动整理</b>
            <small>默认关闭。开启后按本机时间运行。</small>
          </span>
          <input
            id="dream-schedule-enabled"
            type="checkbox"
            checked={value.enabled}
            onChange={event => setValue(current => ({ ...current, enabled: event.target.checked }))}
            disabled={loading || saving}
          />
        </label>
        <div className="dream-schedule-time">
          <label htmlFor="dream-schedule-time">每日执行时间</label>
          <input
            id="dream-schedule-time"
            type="time"
            value={value.time}
            onChange={event => setValue(current => ({ ...current, time: event.target.value }))}
            disabled={loading || saving}
          />
          <button className="pm-primary" onClick={() => void save()} disabled={loading || saving || !dirty || !validTime}>
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </div>
      <p className="pm-hint dream-schedule-note">
        PMBrain 服务需要保持运行；如果设定时间已过，会在当天服务恢复后补跑。已有整理任务时会等待，避免重复执行。
        当前时区：{value.timeZone}。{value.lastStartedDate ? `上次自动启动：${value.lastStartedDate}` : '尚未自动启动。'}
      </p>
      {(message || error) && <div className="settings-feedback" aria-live="polite">
        {message && <span className="pm-ok">{message}</span>}
        {error && <span className="pm-error-text">{error}</span>}
      </div>}
    </section>
  );
}
export type SettingsSection = 'general' | 'knowledge' | 'dream';

const SETTINGS_SECTIONS: Array<{
  key: SettingsSection;
  label: string;
  description: string;
}> = [
  { key: 'general', label: '其他设置', description: '管理界面外观等其他选项' },
  { key: 'knowledge', label: '知识库设置', description: '主源、数据源与导出' },
  { key: 'dream', label: '自动化', description: '管理稳定的知识整理和定时任务' },
];

export function AppearanceSettings({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  return (
    <section className="pm-card appearance-settings settings-panel">
      <div className="settings-panel-title">
        <span className="settings-panel-icon"><MonitorCog /></span>
        <div><h2>界面外观</h2><p>调整 PMBrain 工作台与设置的统一外观。</p></div>
      </div>
      <div className="theme-choice" role="radiogroup" aria-label="界面主题">
        {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={themeMode === value}
            className={themeMode === value ? 'active' : ''}
            onClick={() => onThemeModeChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SettingsPage({
  section,
  themeMode,
  onThemeModeChange,
}: {
  section: SettingsSection;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const { overview, error, reload } = useOverview();
  if (error) return <div className="pm-card pm-error">{error}</div>;
  if (!overview) return <LoadingBlock />;
  const currentSection = SETTINGS_SECTIONS.find(item => item.key === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="pm-page settings-page">
      <header className="settings-heading">
        <div className="pm-eyebrow">SYSTEM · PREFERENCES</div>
        <h1>设置</h1>
        <p className="pm-page-intro">按用途管理 PMBrain，只显示当前分类需要的选项。</p>
      </header>

      <div className="settings-content settings-content-standalone">
        <div className="settings-content-heading">
          <div><h2>{currentSection.label}</h2><p>{currentSection.description}</p></div>
        </div>

        {section === 'general' && (
          <div className="settings-section-stack">
            <AppearanceSettings themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
          </div>
        )}
        {section === 'knowledge' && (
          <div className="settings-section-stack">
            <MainSourceSettings overview={overview} onSaved={reload} />
            <SourceManagementSettings />
            <MarkdownExportSettings />
          </div>
        )}
        {section === 'dream' && (
          <div className="settings-section-stack">
            <DreamSettings />
            <DreamScheduleSettings />
          </div>
        )}
      </div>
    </div>
  );
}
