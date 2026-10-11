import { app, dialog, nativeTheme, type BrowserWindow } from 'electron';
import type { MemoryWritebackStatus, MemoryWritebackUpdate } from '../../../../shared/contracts/brain.js';
import { askWritebackOnce } from './memory-writeback-prompt.js';
import {
  getDesktopPreferences,
  getSetupInfo,
  normalizeDesktopTheme,
  saveDesktopPreferences,
  saveDesktopTheme,
  type DesktopTheme,
} from '../config-manager.js';
import { listNetworkCandidates } from '../network-manager.js';
import type { LanController } from '../network/lan-controller.js';
import type { SidecarController } from '../sidecar/sidecar-controller.js';
import type {
  DesktopBehaviorInput,
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from '../system-settings.js';

export interface DesktopThemeState {
  source: DesktopTheme;
  resolved: 'light' | 'dark';
}

export interface SystemSettingsControllerDependencies {
  lan: LanController;
  sidecar: SidecarController;
  getMainWindow: () => BrowserWindow | null;
  refreshTray: () => void;
  convergeMemoryRules: () => Promise<void>;
}

export class SystemSettingsController {
  constructor(private readonly dependencies: SystemSettingsControllerDependencies) {}

  themeState(source = nativeTheme.themeSource as DesktopTheme): DesktopThemeState {
    return { source, resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' };
  }

  applyTheme(source: DesktopTheme): DesktopThemeState {
    const normalized = normalizeDesktopTheme(source);
    nativeTheme.themeSource = normalized;
    const state = this.themeState(normalized);
    this.dependencies.getMainWindow()?.webContents.send('desktop:theme-state', state);
    return state;
  }

  setTheme(source: DesktopTheme) {
    const backup = saveDesktopTheme(source);
    const result = { ...this.applyTheme(source), backup };
    this.sendState();
    return result;
  }

  currentState(): DesktopSystemSettingsState {
    const preferences = getDesktopPreferences();
    const candidates = listNetworkCandidates();
    const selectedCandidate = candidates.find(candidate => (
      candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
    ));
    const selectedAddressAvailable = selectedCandidate?.recommended === true;
    return {
      preferences,
      theme: this.themeState(getSetupInfo().current.theme),
      launchAtLogin: app.isReady() ? app.getLoginItemSettings(this.loginItemSettingsOptions()).openAtLogin : false,
      networkCandidates: candidates,
      selectedAddressAvailable,
      localMcpUrl: this.dependencies.sidecar.current?.mcpUrl,
      sharedMcpUrl: preferences.networkMode === 'shared' && preferences.sharedIp
        ? `http://${preferences.sharedIp}:3131/mcp`
        : undefined,
      gateway: this.dependencies.lan.status,
      ...(this.dependencies.lan.warning ? { warning: this.dependencies.lan.warning } : {}),
    };
  }

  async memoryWriteback(): Promise<MemoryWritebackStatus> {
    const sidecar = this.dependencies.sidecar.current;
    if (!sidecar) throw new Error('本地服务尚未启动，无法读取长期记忆设置。');
    return sidecar.adminRequest('/admin/api/memory/writeback');
  }

  async saveMemoryWriteback(payload: MemoryWritebackUpdate): Promise<MemoryWritebackStatus> {
    const sidecar = this.dependencies.sidecar.current;
    if (!sidecar) throw new Error('本地服务尚未启动，无法保存长期记忆设置。');
    const state=await sidecar.adminRequest<MemoryWritebackStatus>('/admin/api/memory/writeback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if(payload.mode){
      try { await this.dependencies.convergeMemoryRules(); }
      finally { await sidecar.restart(); }
    }
    return state;
  }

  private memoryPrompt: Promise<void> | null = null;

  async askMemoryWriteback(): Promise<void> {
    if(this.memoryPrompt)return this.memoryPrompt;
    this.memoryPrompt=askWritebackOnce({
      shared:getDesktopPreferences().networkMode==='shared',
      read:()=>this.memoryWriteback(),
      save:value=>this.saveMemoryWriteback(value),
      choose:async()=>{
        const result=await dialog.showMessageBox({type:'question',title:'AI 长期记忆',message:'是否让接入的 AI 跨会话记住你？',detail:'偏好、决定和承诺保存在 PMBrain Facts；临时记忆会过期。默认关闭，可随时在系统设置修改。',buttons:['关闭','重要内容（推荐）','全部事实','以后再说'],defaultId:3,cancelId:3,noLink:true});
        return result.response;
      },
    }).finally(()=>{this.memoryPrompt=null;});
    return this.memoryPrompt;
  }

  sendState(): DesktopSystemSettingsState {
    const state = this.currentState();
    this.dependencies.getMainWindow()?.webContents.send('desktop:system-settings-state', state);
    this.dependencies.refreshTray();
    return state;
  }

  async save(payload: DesktopSystemSettingsPayload): Promise<DesktopSystemSettingsSaveResult> {
    const current = getDesktopPreferences();
    const candidates = listNetworkCandidates();
    const selected = payload.networkMode === 'shared'
      ? candidates.find(candidate => (
        candidate.adapterName === payload.sharedAdapter
        && candidate.address === payload.sharedIp
      ))
      : undefined;
    const modeChanged = current.networkMode !== payload.networkMode;
    const endpointChanged = payload.networkMode === 'shared' && (
      current.sharedAdapter !== payload.sharedAdapter || current.sharedIp !== payload.sharedIp
    );
    const resumeRequired = payload.networkMode === 'shared'
      && (this.dependencies.lan.selectedAddressWasUnavailable || current.sharedResumeRequired)
      && Boolean(selected);
    const networkApplyRequested = modeChanged || endpointChanged || resumeRequired;
    if (payload.networkMode === 'shared' && networkApplyRequested && !selected) {
      throw new Error('所选局域网地址当前不可用。PMBrain 不会自动改用其他网卡，请重新选择。');
    }
    if (payload.networkMode === 'shared' && networkApplyRequested && selected && !selected.recommended) {
      throw new Error(selected.warning || '共享模式只允许真实 Wi-Fi 或有线网卡上的私有局域网 IPv4。');
    }
    const mainWindow = this.dependencies.getMainWindow();
    if (networkApplyRequested && mainWindow) {
      const enteringShared = payload.networkMode === 'shared';
      const detail = enteringShared
        ? [
          `将固定使用 ${payload.sharedAdapter} / ${payload.sharedIp}:3131。`,
          '本机 Agent 仍继续使用 127.0.0.1，不需要修改原配置。',
          '其他电脑必须使用新的局域网地址和独立 API Key；IP 变化后旧的远端配置会立即失效。',
          selected?.warning ? `注意：${selected.warning}` : '建议在路由器中为这台电脑设置 DHCP 地址保留。',
        ].join('\n')
        : [
          '关闭共享后，其他电脑现有的 PMBrain MCP 配置会立即断开。',
          '本机 127.0.0.1 MCP 与知识库数据不受影响。',
        ].join('\n');
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: resumeRequired && !modeChanged && !endpointChanged
          ? '确认恢复 PMBrain 局域网共享'
          : modeChanged ? '确认切换 PMBrain 网络模式' : '确认更换共享固定地址',
        message: enteringShared ? '即将启用局域网共享模式' : '即将恢复仅本机模式',
        detail,
        buttons: ['确认并应用', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) {
        return { canceled: true, state: this.currentState() };
      }
    }

    const saved = saveDesktopPreferences({
      networkMode: payload.networkMode,
      sharedAdapter: payload.sharedAdapter,
      sharedIp: payload.sharedIp,
      closeBehavior: payload.closeBehavior,
      sharedResumeRequired: payload.networkMode === 'local' || networkApplyRequested
        ? false
        : current.sharedResumeRequired,
    });
    const themeBackup = saveDesktopTheme(payload.theme);
    this.applyTheme(payload.theme);
    this.setLaunchAtLogin(payload.launchAtLogin === true);
    this.dependencies.lan.resetAfterSettingsSave(saved.preferences.sharedResumeRequired);
    const gateway = await this.dependencies.lan.reconcile();
    if (payload.networkMode === 'shared' && networkApplyRequested && !gateway) {
      throw new Error(`系统偏好已保存，但局域网共享入口未能启动：${this.dependencies.lan.warning || '请检查固定 IP 与 3131 端口。'}`);
    }
    return {
      canceled: false,
      state: this.currentState(),
      backup: saved.backup ?? themeBackup,
    };
  }


  async saveDesktopBehavior(input: DesktopBehaviorInput): Promise<DesktopSystemSettingsSaveResult> {
    saveDesktopPreferences({
      closeBehavior: input.closeBehavior,
      startMinimized: input.startMinimized === true,
    });
    this.setLaunchAtLogin(input.launchAtLogin === true);
    return { canceled: false, state: this.sendState() };
  }

  private loginItemSettingsOptions() {
    return {
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    };
  }

  private setLaunchAtLogin(openAtLogin: boolean): void {
    app.setLoginItemSettings({
      ...this.loginItemSettingsOptions(),
      openAtLogin,
    });
  }
}
