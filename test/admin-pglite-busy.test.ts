import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = [
  'src/commands/serve-http.ts',
  'src/commands/pmbrain-admin-routes.ts',
].map(path => readFileSync(path, 'utf8')).join('\n');

describe('PGLite 后台任务忙碌提示', () => {
  test('导入期间保留任务进度和取消入口，其他管理页显示自动恢复提示', () => {
    expect(source).toContain("code: 'pglite_busy'");
    expect(source).toContain('PGLite 正在执行导入或知识整理，完成后会自动恢复连接。');
    expect(source).toContain('reconnectPgliteWithRetry');
    expect(source).toContain('maxElapsedMs: 5 * 60_000');
    expect(source).toContain('maxAttempts: 150');
    expect(source).toMatch(/pgliteConnected = true;\r?\n\s+pgliteBusy = false;/);
    expect(source).toContain('pgliteBusy || (engine.kind === \'pglite\' && !pgliteConnected)');
    expect(source).toContain('getPgliteConnected: () => pgliteConnected');
    expect(source).toContain("req.path.startsWith('/runs')");
    expect(source).toContain("const canReadTaskCenter = req.method === 'GET' && req.path === '/task-center';");
    expect(source).toContain("const canRecoverPgliteOwner = req.method === 'POST' && req.path === '/pglite-owner/terminate';");
    expect(source).toContain("app.get('/admin/api/task-center'");
    expect(source).toContain("app.post('/admin/api/pglite-owner/terminate'");
    expect(source).toContain("rows: req.query.summary === '1' ? runs.map(taskRunSummary) : runs");
    expect(source).toContain('requireAdmin(req, res, () => {');
    expect(source).toContain("const hasActiveRun = runs.some(run => run.status === 'queued' || run.status === 'running');");
    expect(source).toContain('if (!getPgliteBusy() && !hasActiveRun)');
    expect(source).toContain('config.database_path && !hasActiveRun');
  });
});
