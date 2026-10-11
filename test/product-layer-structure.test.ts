import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('PMBrain product-layer structure', () => {
  test('Desktop entry delegates IPC and window trust to product modules', () => {
    const entry = read('desktop/src/main/index.ts');
    const ipc = read('desktop/src/main/ipc-handlers.ts');
    const security = read('desktop/src/main/window-security.ts');

    expect(entry).toContain("from './ipc-handlers.js'");
    expect(entry).toContain("from './window-security.js'");
    expect(entry).toContain('registerDesktopIpcHandlers({');
    expect(entry).not.toContain('ipcMain.handle(');
    for (const controller of [
      'DatabaseUpgradeController',
      'PgliteBackupController',
      'LanController',
      'SidecarController',
      'SetupController',
      'SystemSettingsController',
      'UpdateController',
      'WindowController',
    ]) {
      expect(entry).toContain(controller);
    }
    expect(ipc).toContain('export function registerDesktopIpcHandlers');
    expect(security).toContain('export function isTrustedDesktopShellUrl');
    expect(security).toContain('export function isAllowedWindowNavigationUrl');
  });

  test('Admin pages are split by product task and Console stays a compatibility barrel', () => {
    const app = read('admin/src/App.tsx');
    const consolePage = read('admin/src/pages/Console.tsx');
    const settings = read('admin/src/pages/Settings.tsx');

    for (const page of ['Settings', 'BrainData', 'Import', 'Knowledge']) {
      expect(app).toContain(`React.lazy(() => import('./pages/${page}')`);
    }
    expect(settings).toContain('export function SettingsPage');
    expect(settings).toContain('export function ModelConfigPage');
    expect(consolePage.split(/\r?\n/).filter(Boolean)).toHaveLength(4);
    expect(consolePage).toContain("from './Sources'");
    expect(consolePage).toContain("from './BrainData'");
  });

  test('PMBrain Admin routes are registered outside the upstream-facing HTTP skeleton', () => {
    const http = read('src/commands/serve-http.ts');
    const productRoutes = read('src/commands/pmbrain-admin-routes.ts');

    expect(http).toContain("from './pmbrain-admin-routes.ts'");
    expect(http).toContain('registerPmbrainAdminRoutes({');
    expect(http).not.toContain("app.get('/admin/api/brain/overview'");
    expect(productRoutes).toContain('export function registerPmbrainAdminRoutes');
    expect(productRoutes).toContain("app.get('/admin/api/brain/overview'");
    expect(productRoutes).toContain("app.get('/admin/api/advisor'");
    expect(productRoutes).toContain("app.post('/admin/api/advisor/apply'");
    expect(productRoutes).toContain("app.get('/admin/api/waiting'");
    expect(productRoutes).toContain("app.post('/admin/api/google/connect'");
    expect(productRoutes).toContain("app.get('/admin/api/connectors'");
    expect(productRoutes).toContain("app.get('/admin/api/search-index-health'");
    expect(productRoutes).toContain("app.post('/admin/api/search-index-repair'");
    expect(productRoutes).toContain("app.post('/admin/api/export-runs'");
  });

  test('upstream-facing CLI and HTTP entry files do not depend on product UI modules', () => {
    const cli = read('src/cli.ts');
    const http = read('src/commands/serve-http.ts');

    for (const source of [cli, http]) {
      expect(source).not.toMatch(/from ['"].*(?:desktop\/|admin\/src\/pages)/);
    }
  });
});
