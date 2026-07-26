import type { DesktopLogger } from './logs.js';
import { basename } from 'node:path';

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  previousVersion?: string;
  availableVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  fileName?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message: string;
}

interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | Array<{ version?: string; note?: string }>;
  files?: Array<{ url: string; size?: number }>;
  downloadedFile?: string;
}
interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

function updateFileName(info: UpdateInfo): string | undefined {
  const candidate = info.downloadedFile || info.files?.[0]?.url;
  if (!candidate) return undefined;
  const clean = candidate.split(/[?#]/, 1)[0];
  // electron-updater may report a Windows path (C:\cache\file.exe) even when
  // unit tests run on POSIX. path.basename only splits on the host separator,
  // so normalize backslashes before taking the leaf name.
  const normalized = clean.replace(/\\/g, '/');
  try {
    return decodeURIComponent(basename(normalized)) || undefined;
  } catch {
    return basename(normalized) || undefined;
  }
}

export function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string {
  if (typeof notes === 'string') return notes.trim();
  if (!Array.isArray(notes)) return '';
  return notes
    .map(item => {
      const note = typeof item?.note === 'string' ? item.note.trim() : '';
      if (!note) return '';
      const version = typeof item.version === 'string' ? item.version.trim() : '';
      return version ? `### ${version}\n${note}` : note;
    })
    .filter(Boolean)
    .join('\n\n');
}

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): unknown;
  on(event: 'download-progress', listener: (progress: DownloadProgress) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateManagerOptions {
  updater: UpdaterLike;
  packaged: boolean;
  currentVersion: string;
  previousVersion?: string;
  logger: DesktopLogger;
  beforeInstall: () => Promise<void>;
  onState?: (state: UpdateState) => void;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class UpdateManager {
  private readonly options: UpdateManagerOptions;
  private initialTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private downloading = false;
  private state: UpdateState;

  constructor(options: UpdateManagerOptions) {
    this.options = options;
    this.state = options.packaged
      ? { phase: 'idle', currentVersion: options.currentVersion, previousVersion: options.previousVersion, message: '等待检查更新' }
      : { phase: 'disabled', currentVersion: options.currentVersion, previousVersion: options.previousVersion, message: '开发模式不检查更新' };
    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    this.bindEvents();
  }

  get currentState(): UpdateState {
    return this.state;
  }

  start(): void {
    this.emit(this.state);
    if (!this.options.packaged) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.check();
    }, 5_000);
    this.initialTimer.unref();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<UpdateState> {
    if (!this.options.packaged) return this.state;
    if (this.checking || this.downloading || this.state.phase === 'downloaded' || this.state.phase === 'installing') {
      return this.state;
    }
    this.checking = true;
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.checking = false;
    }
    return this.state;
  }

  async install(): Promise<void> {
    if (this.state.phase !== 'downloaded') throw new Error('更新包尚未下载完成。');
    const target = this.state.fileName ? ` ${this.state.fileName}` : '更新包';
    this.emit({ ...this.state, phase: 'installing', message: `正在停止 PMBrain 并安装${target}…` });
    await this.options.beforeInstall();
    this.options.updater.quitAndInstall(false, true);
  }

  async download(): Promise<UpdateState> {
    if (this.state.phase !== 'available' || !this.state.availableVersion) {
      throw new Error('当前没有等待下载的新版本。');
    }
    await this.startDownload(this.state.availableVersion);
    return this.state;
  }

  private bindEvents(): void {
    const updater = this.options.updater;
    updater.on('checking-for-update', () => {
      this.emit({ phase: 'checking', currentVersion: this.options.currentVersion, previousVersion: this.options.previousVersion, message: '正在检查 GitHub Releases…' });
    });
    updater.on('update-not-available', () => {
      this.emit({ phase: 'up-to-date', currentVersion: this.options.currentVersion, previousVersion: this.options.previousVersion, message: '当前已经是最新版本' });
    });
    updater.on('update-available', (info) => {
      const file = info.files?.[0];
      this.emit({
        phase: 'available', currentVersion: this.options.currentVersion, previousVersion: this.options.previousVersion,
        availableVersion: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        fileName: updateFileName(info),
        total: file?.size,
        message: `发现新版本 ${info.version}，查看更新记录后可开始下载`,
      });
    });
    updater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      this.emit({
        ...this.state,
        phase: 'downloading',
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
        message: `正在下载更新 ${percent}%`,
      });
    });
    updater.on('update-downloaded', (info) => {
      this.downloading = false;
      this.emit({
        ...this.state,
        phase: 'downloaded', currentVersion: this.options.currentVersion, previousVersion: this.options.previousVersion,
        availableVersion: info.version,
        releaseDate: info.releaseDate ?? this.state.releaseDate,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) || this.state.releaseNotes,
        fileName: updateFileName(info) ?? this.state.fileName,
        percent: 100,
        transferred: this.state.total ?? this.state.transferred,
        total: this.state.total,
        bytesPerSecond: this.state.bytesPerSecond,
        message: `版本 ${info.version} 已下载，可以安装`,
      });
    });
    updater.on('error', (error) => this.handleError(error));
  }

  private async startDownload(version: string): Promise<void> {
    if (this.downloading) return;
    this.downloading = true;
    this.emit({
      ...this.state, phase: 'downloading', currentVersion: this.options.currentVersion,
      availableVersion: version, percent: 0, message: `正在下载版本 ${version}…`,
    });
    try {
      await this.options.updater.downloadUpdate();
    } catch (error) {
      this.downloading = false;
      this.handleError(error);
    }
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const displayMessage = `更新失败：${message}`;
    if (this.state.phase === 'error' && this.state.message === displayMessage) return;
    this.options.logger.write('updater', message);
    this.emit({
      ...this.state,
      phase: 'error', currentVersion: this.options.currentVersion, previousVersion: this.options.previousVersion,
      message: displayMessage,
    });
  }

  private emit(state: UpdateState): void {
    this.state = state;
    this.options.logger.write('updater', state.message);
    this.options.onState?.(state);
  }
}
