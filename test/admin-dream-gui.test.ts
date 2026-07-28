import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDreamOutcome, describeDreamRun, dreamRunDeltas, isKnowledgeJourneyComplete, phaseSummaryZh } from '../admin/src/pages/Dream.tsx';
import type { ConsoleRun } from '../admin/src/lib/shared.tsx';

const dream = readFileSync(join(process.cwd(), 'admin/src/pages/Dream.tsx'), 'utf8');
const consolePage = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
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
    expect(app).toContain("{ page: 'dream', label: '知识整理', icon: 'organize' }");
    expect(app).not.toContain("{ page: 'dream-execute', label: '阶段执行' }");
    expect(app).not.toContain("{ page: 'dream-insights', label: '项目洞察' }");
  });

  test('meeting mode calls the canonical CLI preset instead of synthesize-only', () => {
    expect(dream).toContain("preset: runMode === 'meeting'");
    expect(dream).toContain("? 'meeting'");
    expect(api).toContain("cmd.push('--preset', input.preset)");
  });

  test('one-click Dream uses the main source and only applies the page limit to proposals', () => {
    expect(dream).toContain("sourceId: runMode === 'advanced' ? sourceId.trim() || undefined : defaultSourceId");
    expect(dream).toContain("maxPages: runMode === 'advanced' && phase === 'propose_takes' && maxPages.trim() ? Number(maxPages) : undefined");
    expect(dream).toContain("showAdvancedControls && phase === 'propose_takes'");
    expect(dream).toContain('embed 会处理全部待向量分块');
    expect(dream).toContain("drainProposals: runMode === 'cycle'");
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

  test('only a fully successful indexed run marks the whole journey complete', () => {
    const partial = completedRun({
      status: 'partial',
      phases: [
        { phase: 'sync', status: 'warn', summary: '+3 added', details: { added: 3 } },
        { phase: 'embed', status: 'ok', summary: '3 chunks newly embedded', details: { embedded: 3 } },
      ],
      totals: { pages_synced: 3, pages_embedded: 3 },
    });
    const successful = completedRun({
      status: 'ok',
      phases: [
        { phase: 'sync', status: 'ok', summary: '+3 added', details: { added: 3 } },
        { phase: 'embed', status: 'ok', summary: '3 chunks newly embedded', details: { embedded: 3, pending: 0 } },
      ],
      totals: { pages_synced: 3, pages_embedded: 3 },
    });
    expect(isKnowledgeJourneyComplete(partial)).toBe(false);
    expect(isKnowledgeJourneyComplete(successful)).toBe(true);
    expect(isKnowledgeJourneyComplete({ ...successful, command: [...successful.command, '--dry-run'] })).toBe(false);
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
    expect(dream).toContain('phase.pagesAffectedCount ?? phase.pagesAffected?.length ?? 0');
  });

  test('overview metrics show deltas from the latest Dream report', () => {
    const run = completedRun({
      status: 'ok',
      totals: {
        synth_pages_written: 21,
        backlinks_added: 3,
        pages_extracted: 17,
        edges_resolved: 4,
      },
    });
    expect(dreamRunDeltas(run)).toEqual({ pages: 21, links: 24 });
    expect(dreamRunDeltas({ ...run, command: [...run.command, '--dry-run'] })).toEqual({ pages: 0, links: 0 });
    expect(dream).toContain('<b>{data.overview?.stats.page_count ?? 0}</b><span>知识页面</span><small>本次 +{latestDeltas.pages}</small>');
    expect(dream).toContain('<b>{data.overview?.stats.link_count ?? 0}</b><span>知识关联</span><small>本次 +{latestDeltas.links}</small>');
    expect(dream).toContain('最近一次新增内容');
    expect(dream).toContain('...latestOutcome.knowledgeItems.map(item => `知识：${item}`)');
    expect(dream).toContain('...latestOutcome.extractionItems');
    expect(dream).not.toContain('这些数字来自当前知识库，不会因为刷新页面而丢失。');
  });

  test('uses the separately captured result when the visible stdout log is truncated', () => {
    const run = {
      ...completedRun({ status: 'clean', totals: {} }),
      stdout: '...only the final 120k log tail...',
      result: {
        status: 'partial',
        phases: [
          {
            phase: 'sync',
            status: 'warn',
            details: { added: 988, modified: 3 },
            pagesAffected: ['knowledge/one'],
            pagesAffectedCount: 985,
          },
          {
            phase: 'embed',
            status: 'warn',
            details: { embedded: 12132, total_chunks: 14000, pending: 1868, errors_count: 1 },
          },
        ],
        totals: { pages_added: 988, pages_synced: 991, links_created: 183, pages_embedded: 12132 },
      },
    };

    expect(dreamRunDeltas(run)).toEqual({ pages: 988, links: 183 });
    expect(buildDreamOutcome(run).metrics.map(metric => [metric.label, metric.value])).toEqual([
      ['新增知识', 988],
      ['更新知识', 3],
      ['合并与去重', 0],
      ['新增关联', 183],
      ['未处理成功', 1869],
    ]);
    expect(describeDreamRun(run).headline).toBe('Dream 已部分完成，成果与待处理项如下');
  });

  test('proposal drain statistics are shown from the structured phase report', () => {
    const run = completedRun({
      status: 'partial',
      phases: [{
        phase: 'propose_takes',
        status: 'warn',
        details: {
          pages_processed: 100,
          proposals_inserted: 12,
          cache_hits: 40,
          pages_failed: 2,
          remaining: 33,
          batches: 1,
          stopped: 'window',
        },
      }],
      totals: {},
    });
    const summary = describeDreamRun(run);
    expect(summary.outputs).toContain('观点整理：处理 100 页，生成 12 条候选观点，跳过 40 页已处理内容，失败 2 页，剩余 33 页。');
  });

  test('completed runs expose concrete outcomes, extracted content and failures', () => {
    const run = completedRun({
      status: 'partial',
      phases: [
        {
          phase: 'sync',
          status: 'warn',
          details: { added: 2, modified: 3, failedFiles: 1 },
          pagesAffected: ['projects/new', 'projects/updated'],
        },
        {
          phase: 'synthesize',
          status: 'ok',
          details: {
            pages_written: 1,
            written_slugs: ['insights/new'],
            duplicate_skips: [{ filePath: 'same.md', duplicateOf: 'existing.md' }],
          },
        },
        {
          phase: 'extract_atoms',
          status: 'ok',
          details: { duplicates_skipped: 2 },
        },
        {
          phase: 'extract_facts',
          status: 'ok',
          details: { factsInserted: 4, affected_slugs: ['projects/updated'] },
        },
        {
          phase: 'synthesize_concepts',
          status: 'ok',
          details: { concepts_written: 1, concept_slugs: ['concepts/search-quality'] },
        },
        {
          phase: 'propose_takes',
          status: 'warn',
          details: {
            proposals_inserted: 1,
            pages_failed: 1,
            proposal_samples: [{
              claim_text: '搜索质量需要用固定问题集持续验证',
              page_slug: 'projects/updated',
              kind: 'take',
            }],
          },
        },
      ],
      totals: {
        pages_added: 3,
        links_created: 5,
        phantoms_redirected: 1,
      },
    });

    const outcome = buildDreamOutcome(run);
    expect(outcome.metrics.map(metric => [metric.label, metric.value])).toEqual([
      ['新增知识', 3],
      ['更新知识', 3],
      ['合并与去重', 4],
      ['新增关联', 5],
      ['未处理成功', 2],
    ]);
    expect(outcome.knowledgeItems).toContain('concepts/search-quality');
    expect(outcome.extractionItems).toContain('事实：写入 4 条，来自 projects/updated');
    expect(outcome.extractionItems).toContain('观点：搜索质量需要用固定问题集持续验证（来自 projects/updated）');
    expect(outcome.failureItems).toContain('读取最近新增和更新的内容：1 个文件未处理成功');
    expect(outcome.failureItems).toContain('观点提炼：1 个页面未处理成功');
    expect(dream).toContain('本次成果');
    expect(dream).toContain('查看本次整理内容');
    expect(dream).toContain('<summary>执行日志</summary>');
  });

  test('Dream settings explain relative paths with a resolved directory preview', () => {
    expect(consolePage).toContain('默认 Dream 目录');
    expect(consolePage).toContain('当前实际输出目录');
    expect(consolePage).toContain('填写 <code>output</code> 不需要盘符');
    expect(consolePage).toContain('高级设置选择其他 Source 时');
    expect(consolePage).toContain('目录不存在会自动创建；已经存在则直接复用，不会清空目录');
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

  test('manual Dream runs have no outer timeout unless advanced settings opt in', () => {
    expect(dream).toContain("const [timeoutMinutes, setTimeoutMinutes] = useState('')");
    expect(dream).toContain('placeholder="不限制"');
    expect(dream).toContain('留空表示不限制');
    expect(dream).toContain('手动整理默认不设外层时限');
  });

  test('the overview does not duplicate a non-actionable start button', () => {
    expect(dream).not.toContain("scrollIntoView({ behavior: 'smooth' })");
  });
});
