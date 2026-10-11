import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync('admin/src/App.tsx', 'utf8');
const apiSource = readFileSync('admin/src/api.ts', 'utf8');
const dreamSource = readFileSync('admin/src/pages/Dream.tsx', 'utf8');
const taskCenterSource = readFileSync('admin/src/pages/TaskCenter.tsx', 'utf8');
const consoleSource = readFileSync('admin/src/pages/Knowledge.tsx', 'utf8');
const adminCss = readFileSync('admin/src/index.css', 'utf8');
const progressSource = readFileSync('admin/src/product/TaskProgress.tsx', 'utf8');
const technicalSource = readFileSync('admin/src/product/TaskTechnicalLogs.tsx', 'utf8');
const taskNames = readFileSync('shared/task-progress.ts', 'utf8');
const maintenanceSource = readFileSync('admin/src/product/MaintenanceTasks.tsx', 'utf8');

describe('Admin 任务中心与 Dream 忙碌态', () => {
  test('任务中心位于集成导航并显示现有长任务', () => {
    expect(appSource).toContain("{ page: 'tasks', label: '任务中心', icon: 'tasks' }");
    expect(appSource).toContain('<TaskCenterPage />');
    expect(taskCenterSource).toContain('api.taskCenter(true)');
    expect(taskCenterSource).toContain('useProductTasks');
    expect(taskCenterSource).toContain('if (!snapshot) return liveTasks.rows');
    expect(taskCenterSource).toContain('task-table');
    expect(technicalSource).toContain('技术日志');
    expect(taskCenterSource).toContain('停止任务');
  });

  test('查看任务使用已经拿到的进度，离开整理页时不把地址改回去', () => {
    expect(taskCenterSource).toContain('preferLiveRun');
    expect(taskCenterSource).toContain('正在读取后台任务…');
    expect(taskCenterSource).toContain('!liveTasks.loaded');
    expect(maintenanceSource).toContain("split('?')[0] || 'home') === 'dream'");
    expect(maintenanceSource).toContain('查看任务');
  });

  test('任务中心展示 PGLite 残留占用进程并提供安全恢复入口', () => {
    expect(taskCenterSource).toContain('pglite_owner');
    expect(taskCenterSource).toContain('发现残留 PGLite 占用进程');
    expect(taskCenterSource).toContain('结束占用进程');
    expect(apiSource).toContain('terminatePgliteOwner');
  });

  test('有实际运行任务时不显示 PGLite 残留占用恢复卡片', () => {
    expect(taskCenterSource).toContain('activeRows.length === 0 && snapshot?.pglite_owner');
    expect(taskCenterSource).toContain("const activeRows = rows.filter(isActive);");
    expect(taskCenterSource).toContain('暂无任务记录');
  });

  test('PGlite 忙碌时 Dream 页面保留任务状态和取消路径', () => {
    expect(apiSource).toContain('error.status = res.status');
    expect(apiSource).toContain('taskCenter: (summary = false) => apiFetch');
    expect(dreamSource).toContain('isPgliteBusyError');
    expect(dreamSource).toContain('<DreamBusyRecovery');
    expect(dreamSource).toContain('api.cancelRun(run.id)');
  });

  test('PGLite 忙碌提示直接引导到任务中心', () => {
    expect(consoleSource).toContain('PgliteBusyNotice');
    expect(consoleSource).toContain('<h1>总体概览</h1>');
    expect(consoleSource).toContain('可去任务中心查看任务进度和取消任务。');
    expect(consoleSource).toContain('打开任务中心');
  });

  test('PGLite 恢复后概览会自动重试，而不是永久停留在忙碌态', () => {
    const sharedSource = readFileSync('admin/src/pages/console-shared.tsx', 'utf8');
    expect(sharedSource).toContain('if (!pgliteBusy) return;');
    expect(sharedSource).toContain('window.setInterval(() => void load(), 1500)');
  });

  test('取消任务显示用户说明而不是把取消当成错误', () => {
    expect(progressSource).toContain('已完成的内容会保留');
    expect(progressSource).toContain('任务已停止');
    expect(progressSource).toContain("run.status === 'cancelled'");
  });

  test('Dream 任务显示统一产品进度，JSON 心跳只用于技术日志', () => {
    expect(taskCenterSource).toContain('TaskProgressCard');
    expect(taskCenterSource).toContain('当前阶段');
    expect(progressSource).toContain('当前阶段');
    expect(technicalSource).toContain('api.run(run.id)');
  });

  test('独立观点提炼不会冒充完整 AI 深度整理', () => {
    expect(taskNames).toContain("if (kind === 'dream_propose_takes') return '观点提炼'");
    expect(taskNames).not.toContain("return 'AI 深度整理 · 观点提炼'");
  });

  test('Dream 阶段执行页在深色主题使用控制台配色', () => {
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-phase-rail section');
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-run-mode');
    expect(adminCss).toContain('html[data-theme="dark"] .dream-page .dream-ops-diagnostics');
  });
});
