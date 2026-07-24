import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ADMIN_DREAM_SCHEDULE_TIME,
  adminDreamScheduleDateKey,
  isAdminDreamScheduleDue,
  isValidAdminDreamScheduleTime,
} from '../src/commands/admin-dream-schedule.ts';

const ROOT = join(import.meta.dir, '..');

describe('Admin scheduled one-click organization', () => {
  test('validates a 24-hour HH:MM time', () => {
    expect(DEFAULT_ADMIN_DREAM_SCHEDULE_TIME).toBe('02:00');
    expect(isValidAdminDreamScheduleTime('00:00')).toBe(true);
    expect(isValidAdminDreamScheduleTime('23:59')).toBe(true);
    expect(isValidAdminDreamScheduleTime('24:00')).toBe(false);
    expect(isValidAdminDreamScheduleTime('2:00')).toBe(false);
  });

  test('runs once per local day at or after the selected time', () => {
    const before = new Date(2026, 6, 24, 1, 59);
    const after = new Date(2026, 6, 24, 2, 1);
    const nextDay = new Date(2026, 6, 25, 2, 1);
    const dateKey = adminDreamScheduleDateKey(after);

    expect(isAdminDreamScheduleDue({ enabled: false, time: '02:00', lastStartedDate: null }, after)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: null }, before)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: null }, after)).toBe(true);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: dateKey }, after)).toBe(false);
    expect(isAdminDreamScheduleDue({ enabled: true, time: '02:00', lastStartedDate: dateKey }, nextDay)).toBe(true);
  });

  test('reuses the existing one-click Dream run and persists settings', () => {
    const serveSource = readFileSync(join(ROOT, 'src/commands/serve-http.ts'), 'utf8');
    expect(serveSource).toContain("app.get('/admin/api/dream/schedule'");
    expect(serveSource).toContain("app.post('/admin/api/dream/schedule'");
    expect(serveSource).toContain("engine.setConfig(ADMIN_DREAM_SCHEDULE_ENABLED_KEY");
    expect(serveSource).toContain("preset: 'full'");
    expect(serveSource).toContain('drainProposals: true');
    expect(serveSource).toContain('await ensureAdminWorkerStarted()');
    expect(serveSource).toContain('const dreamScheduleTimer = setInterval(');
  });

  test('settings UI has a daily time and a dirty-state save button', () => {
    const consoleSource = readFileSync(join(ROOT, 'admin/src/pages/Console.tsx'), 'utf8');
    const apiSource = readFileSync(join(ROOT, 'admin/src/api.ts'), 'utf8');
    expect(consoleSource).toContain('<h2>定时一键整理</h2>');
    expect(consoleSource).toContain('type="time"');
    expect(consoleSource).toContain('!dirty || !validTime');
    expect(consoleSource).toContain('当天服务恢复后补跑');
    expect(apiSource).toContain("apiFetch('/admin/api/dream/schedule'");
  });
});
