import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDreamRun, isKnowledgeJourneyComplete, phaseSummaryZh } from '../admin/src/pages/Dream.tsx';
import type { ConsoleRun } from '../admin/src/lib/shared.tsx';

const dream = readFileSync(join(process.cwd(), 'admin/src/pages/Dream.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src/commands/natural-lang/api.ts'), 'utf8');

function completedRun(report: Record<string, unknown>, stderr = ''): ConsoleRun {
  return {
    id: 'dream-run-123',
    kind: 'dream_full',
    status: 'completed',
    command: ['pmbrain', 'dream', '--preset', 'full', '--json'],
    stdout: JSON.stringify(report),
    stderr,
    exitCode: 0,
    error: null,
    startedAt: '2026-07-11T00:00:00.000Z',
    completedAt: '2026-07-11T00:01:00.000Z',
    durationMs: 60_000,
  };
}

describe('Dream GUI product contract', () => {
  test('ordinary navigation exposes one beginner-friendly Dream entry', () => {
    expect(app).toContain("{ page: 'dream', label: '知识整理' }");
    expect(app).not.toContain("{ page: 'dream-execute', label: '阶段执行' }");
    expect(app).not.toContain("{ page: 'dream-insights', label: '项目洞察' }");
  });

  test('meeting mode calls the canonical CLI preset instead of synthesize-only', () => {
    expect(dream).toContain("preset: runMode === 'meeting' ? 'meeting'");
    expect(api).toContain("cmd.push('--preset', input.preset)");
  });

  test('phase ordering comes from the backend catalog', () => {
    expect(dream).toContain('phaseCatalog.map(item => <option');
    expect(dream).toContain('phaseCatalog={data.phase_catalog}');
  });

  test('removed project-management phases are not presented by Dream', () => {
    expect(dream).not.toContain('project_health');
    expect(dream).not.toContain('risk_detect');
    expect(dream).not.toContain('report_gen');
  });

  test('advanced observability remains available behind details', () => {
    expect(dream).toContain('查看阶段、模型与 Token');
    expect(dream).toContain('原始日志与命令');
    expect(dream).toContain('查看运行诊断');
  });

  test('a completed report is not misclassified by incidental lock text', () => {
    const run = completedRun({
      status: 'ok',
      phases: [
        { phase: 'patterns', status: 'ok', summary: '6 pattern page(s) written/updated', details: { patterns_written: 6 } },
        { phase: 'embed', status: 'ok', summary: '0 chunks newly embedded', details: { embedded: 0, skipped: 12 } },
      ],
      totals: { patterns_written: 6, pages_embedded: 0 },
    }, 'cycle lock cleanup: no locked rows remain');

    const summary = describeDreamRun(run);
    expect(summary.headline).toBe('Dream 已完成，产生 6 项知识更新');
    expect(summary.outputs).toContain('写入或更新 6 个模式知识页。');
    expect(summary.details).toContain('run id: dream-run-123');
    expect(summary.headline).not.toContain('没有执行');
  });

  test('a completed multi-phase run with search indexing marks the whole journey complete', () => {
    const run = completedRun({
      status: 'partial',
      phases: [
        { phase: 'sync', status: 'warn', summary: '+3 added', details: { added: 3 } },
        { phase: 'embed', status: 'ok', summary: '3 chunks newly embedded', details: { embedded: 3 } },
      ],
      totals: { pages_synced: 3, pages_embedded: 3 },
    });
    expect(isKnowledgeJourneyComplete(run)).toBe(true);
    expect(isKnowledgeJourneyComplete({ ...run, command: [...run.command, '--dry-run'] })).toBe(false);
  });

  test('technical phase explanations are rendered as Chinese user guidance', () => {
    expect(phaseSummaryZh({
      phase: 'sync',
      status: 'warn',
      summary: '+513 added, ~15 modified, -0 deleted',
      details: { added: 513, modified: 15, deleted: 0, failedFiles: 4 },
      pagesAffected: ['one', 'two', 'three'],
    })).toBe('检测到 528 个待同步文件，实际写入 3 个页面，4 个文件解析失败。');
    expect(phaseSummaryZh({
      phase: 'extract_atoms',
      status: 'skipped',
      summary: 'extract_atoms: active pack does not declare this phase',
    })).toContain('当前启用的 Skill 包未开放');
  });

  test('sync results distinguish detected files from pages actually written', () => {
    const run = completedRun({
      status: 'partial',
      phases: [{
        phase: 'sync',
        status: 'warn',
        summary: '+674 added, ~19 modified, -0 deleted',
        details: { added: 674, modified: 19, deleted: 0, failedFiles: 4 },
        pagesAffected: ['page/a', 'page/b', 'page/c'],
      }],
      totals: { pages_synced: 693 },
    });
    expect(describeDreamRun(run).outputs).toContain('检测到 693 个待同步文件，实际写入 3 个页面。');
    expect(dream).toContain('查看实际写入的 {phase.pagesAffected?.length ?? 0} 个页面');
  });

  test('selected run mode survives the data reload after a run completes', () => {
    expect(dream).toContain("const DREAM_RUN_MODE_KEY = 'pmbrain.dream.runMode'");
    expect(dream).toContain('window.localStorage.setItem(DREAM_RUN_MODE_KEY, mode)');
    expect(dream).toContain('if (!data) setLoading(true)');
  });

  test('full and meeting runs automatically ensure the existing Worker is available', () => {
    expect(dream).toContain('await api.startSupervisor()');
    expect(dream).toContain("runMode === 'cycle'");
    expect(dream).toContain("runMode === 'meeting'");
    expect(dream).toContain('通常不需要手动操作');
  });

  test('the overview does not duplicate a non-actionable start button', () => {
    expect(dream).not.toContain("scrollIntoView({ behavior: 'smooth' })");
  });
});
