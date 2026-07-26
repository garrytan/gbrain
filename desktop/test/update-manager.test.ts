import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { normalizeReleaseNotes, UpdateManager, type UpdateState } from '../src/main/update-manager.js';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  downloaded = false;
  installed = false;

  async checkForUpdates() {
    this.emit('checking-for-update');
    this.emit('update-available', {
      version: '1.0.22',
      releaseDate: '2026-07-25T10:00:00.000Z',
      releaseNotes: '## 搜索增强\n\n- 提升中文召回\n- 修复更新检查',
      files: [{ url: 'PMBrain%20Desktop-1.0.22.exe', size: 8_000_000 }],
    });
  }

  async downloadUpdate() {
    this.downloaded = true;
    this.emit('download-progress', {
      percent: 51.2,
      transferred: 4_096_000,
      total: 8_000_000,
      bytesPerSecond: 1_024_000,
    });
    this.emit('update-downloaded', {
      version: '1.0.22',
      downloadedFile: 'C:\\cache\\PMBrain Desktop-1.0.22.exe',
    });
  }

  quitAndInstall() { this.installed = true; }
}

const logger = { write() {}, close() {}, directory: '', filePath: '' } as any;

describe('desktop update manager', () => {
  test('shows release notes before download, then stops sidecar before install', async () => {
    const updater = new FakeUpdater();
    let stopped = false;
    const states: UpdateState[] = [];
    const manager = new UpdateManager({
      updater, packaged: true, currentVersion: '1.0.21', previousVersion: '1.0.20', logger,
      beforeInstall: async () => { stopped = true; },
      onState: (state) => states.push(state),
    });
    await manager.check();
    expect(updater.autoDownload).toBe(false);
    expect(updater.downloaded).toBe(false);
    expect(manager.currentState.phase).toBe('available');
    expect(manager.currentState.releaseDate).toBe('2026-07-25T10:00:00.000Z');
    expect(manager.currentState.releaseNotes).toContain('提升中文召回');
    await manager.download();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updater.downloaded).toBe(true);
    expect(manager.currentState.phase).toBe('downloaded');
    const initialDownload = states.find((state) => state.phase === 'downloading' && state.percent === 0);
    expect(initialDownload?.fileName).toBe('PMBrain Desktop-1.0.22.exe');
    expect(initialDownload?.total).toBe(8_000_000);
    expect(states.some((state) => state.phase === 'downloading')).toBe(true);
    expect(manager.currentState.fileName).toBe('PMBrain Desktop-1.0.22.exe');
    expect(manager.currentState.previousVersion).toBe('1.0.20');
    expect(manager.currentState.transferred).toBe(8_000_000);
    expect(manager.currentState.total).toBe(8_000_000);
    expect(manager.currentState.bytesPerSecond).toBe(1_024_000);
    await manager.install();
    expect(stopped).toBe(true);
    expect(updater.installed).toBe(true);
  });

  test('normalizes array-shaped GitHub release notes', () => {
    expect(normalizeReleaseNotes([
      { version: '1.0.22', note: '- Added search diagnostics' },
      { version: '1.0.21', note: 'Fixed updater state' },
    ])).toBe('### 1.0.22\n- Added search diagnostics\n\n### 1.0.21\nFixed updater state');
    expect(normalizeReleaseNotes(undefined)).toBe('');
  });
});
