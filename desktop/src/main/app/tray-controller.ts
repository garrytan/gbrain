import { Menu, Tray } from 'electron';
import type { DesktopPreferences } from '../config-manager.js';
import type { LanMcpGatewayStatus } from '../lan-mcp-gateway.js';
import { desktopIcon } from './desktop-notifications.js';

export interface TrayControllerDependencies {
  getPreferences: () => DesktopPreferences;
  getLanStatus: () => LanMcpGatewayStatus | null;
  openDesktop: () => void;
  openAdmin: (hash?: string) => Promise<void>;
  openSystemSettings: () => Promise<void>;
  reportError: (title: string, error: unknown) => void;
  quit: () => void;
}

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly dependencies: TrayControllerDependencies) {}

  initialize(): void {
    if (this.tray) return;
    this.tray = new Tray(desktopIcon(16));
    this.tray.setToolTip('PMBrain');
    this.tray.on('double-click', this.dependencies.openDesktop);
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const preferences = this.dependencies.getPreferences();
    const status = this.dependencies.getLanStatus();
    const shareLabel = preferences.networkMode === 'shared'
      ? status?.running ? `局域网共享：${status.bindAddress}:${status.port}` : '局域网共享：已停止'
      : '局域网共享：未启用';
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 PMBrain', click: this.dependencies.openDesktop },
      {
        label: '打开知识工作台',
        click: () => void this.dependencies.openAdmin()
          .catch(error => this.dependencies.reportError('无法打开知识工作台', error)),
      },
      {
        label: '系统设置',
        click: () => void this.dependencies.openSystemSettings()
          .catch(error => this.dependencies.reportError('无法打开系统设置', error)),
      },
      { type: 'separator' },
      { label: shareLabel, enabled: false },
      { type: 'separator' },
      { label: '退出 PMBrain', click: this.dependencies.quit },
    ]));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
