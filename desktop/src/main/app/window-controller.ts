import { BrowserWindow, nativeTheme, shell } from 'electron';
import { getDesktopPreferences, getSetupInfo, isTrayHintShown, markTrayHintShown } from '../config-manager.js';
import type { DesktopLogger } from '../logs.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';
import { isAllowedWindowNavigationUrl, type DesktopWindowTrustContext } from '../window-security.js';

export interface WindowControllerDependencies {
  rendererPath: string;
  preloadPath: string;
  getRendererUrl: () => string | undefined;
  getQuitting: () => boolean;
  getLogger: () => DesktopLogger | null;
  sidecar: SidecarController;
  hideStartupProgress: () => void;
  showNotification: (title: string, body: string) => void;
}

export class WindowController {
  private window: BrowserWindow | null = null;
  private trayHintShown = false;

  constructor(private readonly dependencies: WindowControllerDependencies) {}

  get current(): BrowserWindow | null {
    return this.window;
  }

  trustContext(): DesktopWindowTrustContext {
    return {
      rendererPath: this.dependencies.rendererPath,
      rendererUrl: this.dependencies.getRendererUrl(),
      sidecarPort: this.dependencies.sidecar.current?.port,
    };
  }

  reveal(): void {
    if (!this.window) {
      void this.create();
      return;
    }
    if (this.window.isMinimized()) this.window.restore();
    if (!this.window.isVisible()) this.window.show();
    this.window.focus();
  }

  async showShell(): Promise<void> {
    if (!this.window) return;
    if (isAllowedWindowNavigationUrl(this.window.webContents.getURL(), { rendererPath: this.dependencies.rendererPath, rendererUrl: this.dependencies.getRendererUrl() })) return;
    const rendererUrl = this.dependencies.getRendererUrl();
    if (rendererUrl) await this.window.loadURL(rendererUrl);
    else await this.window.loadFile(this.dependencies.rendererPath);
  }

  async create(): Promise<void> {
    this.window = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 760,
      minHeight: 560,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#101312' : '#f5f7f4',
      title: 'PMBrain',
      show: false,
      webPreferences: {
        preload: this.dependencies.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const window = this.window;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (this.dependencies.getQuitting() || getDesktopPreferences().closeBehavior === 'quit') return;
      event.preventDefault();
      window.hide();
      if (!this.trayHintShown && !isTrayHintShown()) {
        this.trayHintShown = true;
        this.dependencies.showNotification(
          'PMBrain 仍在运行',
          '窗口已最小化到系统托盘，本地服务和局域网共享会继续运行。',
        );
        try {
          markTrayHintShown();
        } catch (error) {
          console.error('[desktop] 无法保存托盘提示状态：', error);
        }
      } else {
        this.trayHintShown = true;
      }
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isAllowedWindowNavigationUrl(url, this.trustContext())) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    };
    window.webContents.on('will-navigate', guardNavigation);
    window.webContents.on('will-redirect', guardNavigation);
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
    await this.showShell();
    if (!window.isVisible()) window.show();
    if (!getSetupInfo().needsSetup) {
      try {
        await this.dependencies.sidecar.ensureReady();
      } catch (error) {
        const { sanitizeStartupFailureMessage } = await import('../startup/post-upgrade-startup.js');
        const raw = error instanceof Error ? error.message : String(error);
        const message = sanitizeStartupFailureMessage(raw);
        this.dependencies.getLogger()?.write('desktop', `startup failed after auto-retry: ${raw}`);
        this.dependencies.sidecar.reportFailure(message);
        this.dependencies.hideStartupProgress();
      }
    }
  }
}
