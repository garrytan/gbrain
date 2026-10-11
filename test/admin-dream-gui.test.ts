import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDreamOutcome,
  buildQuickMaintenanceStages,
  describeDreamRun,
  dreamRunDeltas,
  isKnowledgeJourneyComplete,
  phaseSummaryZh,
  quickMaintenanceRunSource,
  runForDreamMode,
} from '../admin/src/pages/Dream.tsx';
import type { ConsoleRun } from '../admin/src/lib/shared.tsx';

const dream = readFileSync(join(process.cwd(), 'admin/src/pages/Dream.tsx'), 'utf8');
const consolePage = [
  'admin/src/pages/Knowledge.tsx',
  'admin/src/pages/Sources.tsx',
].map(path => readFileSync(join(process.cwd(), path), 'utf8')).join('\n');
const settingsPage = readFileSync(join(process.cwd(), 'admin/src/pages/Settings.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src/commands/natural-lang/api.ts'), 'utf8');
const dreamCommand = readFileSync(join(process.cwd(), 'src/commands/dream.ts'), 'utf8');

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

function quickRun(report: Record<string, unknown>, status: ConsoleRun['status'] = 'completed'): ConsoleRun {
  return {
    ...completedRun(report),
    kind: 'dream_quick',
    status,
    command: ['pmbrain', 'dream', '--preset', 'quick', '--json'],
  };
}

describe('Dream GUI product contract', () => {
  test('search index failure shows a rebuild button instead of a dead end', () => {
    expect(dream).toContain('SearchIndexRepairCard');
    expect(dream).toContain('重建搜索索引');
    expect(consolePage).toContain('SearchIndexRepairCard');
    const summary = describeDreamRun({
      ...quickRun({
        status: 'partial',
        phases: [{
          phase: 'sync',
          status: 'fail',
          summary: '搜索索引修复失败，无法确认搜索已恢复。',
        }],
      }),
      stderr: '搜索索引修复失败，无法确认搜索已恢复。\n搜索索引异常，已停止后续数据库写入。',
    });
    expect(summary.headline).toBe('搜索索引异常，需要重建');
    expect(summary.diagnosis).toContain('重建搜索索引');
  });

  test('ordinary navigation exposes one beginner-friendly Dream entry', () => {
    expect(app).toContain("{ page: 'dream', label: '知识整理', icon: 'organize' }");
    expect(app).not.toContain("{ page: 'dream-execute', label: '阶段执行' }");
    expect(app).not.toContain("{ page: 'dream-insights', label: '项目洞察' }");
  });

  test('a running Dream keeps its reconnect state without blocking desktop navigation', () => {
    expect(dream).toContain('window.localStorage.getItem(DREAM_LAST_RUN_KEY)');
    expect(dream).toContain('window.localStorage.setItem(DREAM_LAST_RUN_KEY, run.id)');
    expect(dream).not.toContain("window.addEventListener('beforeunload'");
    expect(dream).not.toContain('event.returnValue');
  });

  test('meeting mode calls the canonical CLI preset instead of synthesize-only', () => {
    expect(dream).toContain("preset: runMode === 'meeting'");
    expect(dream).toContain("? 'meeting'");
    expect(api).toContain("cmd.push('--preset', input.preset)");
  });

  test('one-click Quick covers all Sources and one-click deep runs the complete Dream preset', () => {
    expect(dream).toContain("sourceId: runMode === 'advanced' ? sourceId.trim() || undefined : runMode === 'quick' ? undefined : defaultSourceId");
    expect(dream).toContain("allSources: runMode === 'quick'");
    expect(dream).toContain("maxPages: runMode === 'advanced' && phase === 'propose_takes' && maxPages.trim() ? Number(maxPages) : undefined");
    expect(dreamCommand).toContain('embedPageLimit: opts.maxPages ?? undefined');
    expect(dream).toContain("showAdvancedControls && phase === 'propose_takes'");
    expect(dream).toContain('embed 会处理全部待向量分块');
    expect(dream.replace(/\r\n/g, '\n')).toContain("runMode === 'cycle'\n            ? 'full'");
    expect(dream).toContain("phase: runMode === 'advanced' ? phase : undefined");
    expect(dream).toContain('drainProposals: false');
    expect(dream).not.toContain("phase: runMode === 'cycle' ? 'propose_takes'");
    expect(dream).not.toContain('本次只运行观点提炼');
  });

  test('Quick, deep, meeting and advanced progress never reuse another mode run', () => {
    const quick = { ...quickRun({}, 'running'), id: 'quick-running' };
    const deep: ConsoleRun = {
      ...completedRun({}),
      id: 'deep-running',
      kind: 'dream_full',
      status: 'running',
      command: ['pmbrain', 'dream', '--preset', 'full', '--json'],
    };
    const proposal: ConsoleRun = {
      ...completedRun({}),
      id: 'proposal-running',
      kind: 'dream_propose_takes',
      status: 'running',
      command: ['pmbrain', 'dream', '--phase', 'propose_takes', '--drain-proposals', '--json'],
    };
    const meeting: ConsoleRun = {
      ...completedRun({}),
      id: 'meeting-running',
      kind: 'dream_meeting',
      status: 'running',
      command: ['pmbrain', 'dream', '--preset', 'meeting', '--input', 'meeting.md', '--json'],
    };
    const advanced: ConsoleRun = {
      ...completedRun({}),
      id: 'advanced-running',
      kind: 'dream_embed',
      status: 'running',
      command: ['pmbrain', 'dream', '--phase', 'embed', '--json'],
    };

    expect(runForDreamMode(quick, 'quick')).toBe(quick);
    expect(runForDreamMode(quick, 'cycle')).toBeNull();
    expect(runForDreamMode(deep, 'cycle')).toBe(deep);
    expect(runForDreamMode(deep, 'advanced')).toBeNull();
    expect(runForDreamMode(proposal, 'advanced')).toBe(proposal);
    expect(runForDreamMode(proposal, 'cycle')).toBeNull();
    expect(runForDreamMode(meeting, 'meeting')).toBe(meeting);
    expect(runForDreamMode(meeting, 'quick')).toBeNull();
    expect(runForDreamMode(advanced, 'advanced')).toBe(advanced);
    expect(runForDreamMode(advanced, 'meeting')).toBeNull();
    expect(runForDreamMode(null, 'quick')).toBeNull();
  });

  test('only the selected mode run drives progress, results and cancellation controls', () => {
    expect(dream).toContain('const selectedRun = runForDreamMode(run, runMode)');
    expect(dream).toContain('<KnowledgeJourney run={selectedRun} mode={runMode} />');
    expect(dream).toContain('<DreamRunResult run={selectedRun} />');
    expect(dream).toContain('当前后台任务属于');
  });

  test('phase ordering comes from the backend catalog', () => {
    // Options are built with an expanded map body (capability tags for ordinary-model gate).
    expect(dream).toContain('phaseCatalog.map(item =>');
    expect(dream).toContain('phaseCatalog={data.phase_catalog}');
    expect(dream).toContain('phaseCapabilities={data.phase_capabilities}');
  });

  test('removed project-management phases are not presented by Dream', () => {
    expect(dream).not.toContain('project_health');
    expect(dream).not.toContain('risk_detect');
    expect(dream).not.toContain('report_gen');
  });

  test('advanced observability remains available behind details', () => {
    expect(dream).toContain('查看阶段、模型与 Token');
    expect(dream).not.toContain('原始日志与命令');
    expect(readFileSync('admin/src/product/TaskTechnicalLogs.tsx', 'utf8')).toContain('<summary>技术日志</summary>');
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

  test('Dream summary no longer advertises the obsolete PGLite 20/22 limit', () => {
    const summary = describeDreamRun(completedRun({
      status: 'ok',
      phases: [{ phase: 'synthesize', status: 'ok', summary: 'done', details: {} }],
      totals: {},
    }));
    expect(summary.headline).not.toContain('20/22');
    expect(summary.details.join(' ')).not.toContain('PGLite 阶段覆盖');
    expect(dream).not.toContain('20/22');
    expect(dream).not.toContain('PGLite 暂不支持会议与会话整理');
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

  test('overview increment ignores detected files that were not actually written', () => {
    const run = completedRun({
      status: 'ok',
      phases: [{
        phase: 'sync',
        status: 'warn',
        details: { added: 1000, modified: 0, failedFiles: 0 },
        pagesAffected: [],
        pagesAffectedCount: 0,
      }],
      totals: { pages_added: 1000, pages_synced: 1000, links_created: 0 },
    });
    expect(dreamRunDeltas(run)).toEqual({ pages: 0, links: 0 });
    expect(buildDreamOutcome(run).metrics.find(metric => metric.label === '新增知识')?.value).toBe(0);
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
    expect(dream).toContain('<span>已向量化</span>');
    expect(dream).toContain('embedding_coverage_delta');
    expect(dream).not.toContain('可被 AI 搜索');
    expect(dream).toContain('<b>{data.overview?.stats.link_count ?? 0}</b><span>知识关联</span><small>本次 +{latestDeltas.links}</small>');
    expect(dream).toContain('最近一次新增内容');
    expect(dream).toContain('...latestOutcome.knowledgeItems.map(item => `知识：${item}`)');
    expect(dream).toContain('...latestOutcome.extractionItems');
    expect(dream).not.toContain('这些数字来自当前知识库，不会因为刷新页面而丢失。');
  });

  test('uses the separately captured result when the visible stdout log is truncated', () => {
    const run = {
      ...completedRun({ status: 'clean', totals: {} }),
      kind: 'dream_quick',
      command: ['pmbrain', 'dream', '--preset', 'quick', '--json'],
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

    expect(dreamRunDeltas(run)).toEqual({ pages: 985, links: 183 });
    expect(buildDreamOutcome(run).metrics.map(metric => [metric.label, metric.value])).toEqual([
      ['新增知识', 985],
      ['更新知识', 3],
      ['新增关联', 183],
      ['完成向量', 12132],
    ]);
    expect(buildDreamOutcome(run).pendingMetrics.map(metric => [metric.label, metric.value])).toEqual([
      ['异常文件', 0],
      ['待向量化', 1868],
      ['历史待补关联', 0],
    ]);
    expect(buildDreamOutcome(run).failureItems).toEqual(['更新索引：1 项模型或数据处理未成功']);
    expect(describeDreamRun(run).headline).toBe('快速维护已部分完成');
  });

  test('Quick maintenance presents five honest clickable stages with individual states and results', () => {
    const run = quickRun({
      status: 'partial',
      phases: [
        { phase: 'lint', status: 'warn', details: { pages_scanned: 2177, issues: 2777, fixed: 9 } },
        { phase: 'backlinks', status: 'ok', details: { gaps: 3, added: 0 } },
        {
          phase: 'sync',
          status: 'warn',
          details: { added: 81, modified: 7, failedFiles: 2 },
          pagesAffected: ['one', 'two'],
          pagesAffectedCount: 86,
        },
        {
          phase: 'extract',
          status: 'ok',
          details: {
            linksCreated: 48,
            mentionLinksCreated: 40,
            mentionPagesProcessed: 500,
            mentionHistoricalRemaining: 1706,
          },
        },
        { phase: 'extract_facts', status: 'ok', details: { facts_upserted: 0 } },
        { phase: 'resolve_symbol_edges', status: 'ok', details: { chunks_walked: 300, edges_resolved: 8 } },
        { phase: 'embed', status: 'ok', details: { embedded: 420, skipped: 1200, total_chunks: 2000, pending: 380 } },
        { phase: 'orphans', status: 'warn', details: { total_orphans: 31, total_pages: 2177 } },
      ],
      totals: { pages_added: 81, pages_synced: 88, links_created: 56, pages_embedded: 420 },
    });

    const stages = buildQuickMaintenanceStages(run);
    expect(stages.map(stage => [stage.title, stage.state])).toEqual([
      ['检查知识', 'done'],
      ['同步内容', 'partial'],
      ['建立关联', 'done'],
      ['更新索引', 'partial'],
      ['完成检查', 'done'],
    ]);
    expect(stages[0]?.results).toEqual([
      { label: '扫描页面', value: 2177 },
      { label: '发现问题', value: 2780 },
      { label: '自动修复', value: 9 },
    ]);
    expect(stages[1]?.results).toEqual([
      { label: '新增内容', value: 81 },
      { label: '更新内容', value: 7 },
      { label: '异常文件', value: 2 },
    ]);
    expect(stages[2]?.results).toEqual([
      { label: '新增关联', value: 56 },
      { label: '扫描历史页面', value: 414 },
      { label: '历史待补关联', value: 1706 },
    ]);
    expect(stages[3]?.results).toEqual([
      { label: '本次完成向量', value: 420 },
      { label: '待向量化', value: 380 },
    ]);
    expect(stages[4]?.results).toEqual([
      { label: '孤立知识', value: 31 },
      { label: '整体状态', value: '部分完成' },
    ]);
    expect(dream).toContain('未开始');
    expect(dream).toContain('进行中');
    expect(dream).toContain('已完成');
    expect(dream).toContain('部分完成');
    expect(dream).toContain('异常');
  });

  test('Quick maintenance marks earlier stages completed while a later stage is running', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stdout: [
        '[cycle.lint] start',
        '[cycle.lint] done',
        '[cycle.backlinks] start',
        '[cycle.backlinks] done',
        '[cycle.sync] start',
        '[cycle.sync] done',
        '[cycle.extract] start',
        '[cycle.extract] done',
        '[cycle.extract_facts] start',
        '[cycle.extract_facts] done',
        '[cycle.resolve_symbol_edges] start',
        '[cycle.resolve_symbol_edges] done',
        '[cycle.embed] start',
      ].join('\n'),
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'done',
      'done',
      'done',
      'active',
      'idle',
    ]);
  });

  test('Quick maintenance resets the five-step track when all-sources advances to a new Source', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stderr: [
        '[quick-maintenance] Source source-a start (1/2)',
        '[cycle.lint] start',
        '[cycle.lint] done',
        '[cycle.backlinks] start',
        '[cycle.backlinks] done',
        '[cycle.sync] start',
        '[cycle.sync] done',
        '[cycle.extract] start',
        '[cycle.extract] done',
        '[cycle.extract_facts] start',
        '[cycle.extract_facts] done',
        '[cycle.resolve_symbol_edges] start',
        '[cycle.resolve_symbol_edges] done',
        '[cycle.embed] start',
        '[cycle.embed] done',
        '[cycle.orphans] start',
        '[cycle.orphans] done',
        '[quick-maintenance] Source source-a ok',
        '[quick-maintenance] Source source-b start (2/2)',
        '[cycle.lint] start',
      ].join('\n'),
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'active',
      'idle',
      'idle',
      'idle',
      'idle',
    ]);
    expect(quickMaintenanceRunSource(run)).toEqual({ id: 'source-b', completed: 1, index: 2, total: 2 });
  });

  test('Quick maintenance only checks prior stages inside the current Source cycle', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stderr: [
        '[quick-maintenance] Source source-a start',
        '[cycle.orphans] start',
        '[cycle.orphans] done',
        '[quick-maintenance] Source source-a ok',
        '[quick-maintenance] Source source-b start',
        '[cycle.lint] start',
        '[cycle.lint] done',
        '[cycle.backlinks] start',
        '[cycle.backlinks] done',
        '[cycle.sync] start',
        '[cycle.sync] done',
        '[cycle.extract] start',
        '[cycle.extract] done',
        '[cycle.extract_facts] start',
        '[cycle.extract_facts] done',
        '[cycle.resolve_symbol_edges] start',
        '[cycle.resolve_symbol_edges] done',
        '[cycle.embed] start',
      ].join('\n'),
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'done',
      'done',
      'done',
      'active',
      'idle',
    ]);
  });

  test('Quick maintenance reads --progress-json events so running stages are not stuck idle', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stdout: '',
      stderr: [
        '{"event":"start","phase":"cycle.lint","ts":"2026-08-22T13:32:00.000Z"}',
        '{"event":"tick","phase":"cycle.lint","done":18,"elapsed_ms":1200,"ts":"2026-08-22T13:32:01.000Z"}',
      ].join('\n'),
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'active',
      'idle',
      'idle',
      'idle',
      'idle',
    ]);
  });

  test('Quick maintenance JSON finish/start advances the five-step track', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stdout: '',
      stderr: [
        '{"event":"start","phase":"cycle.lint","ts":"2026-08-22T13:32:00.000Z"}',
        '{"event":"finish","phase":"cycle.lint","elapsed_ms":800,"ts":"2026-08-22T13:32:01.000Z"}',
        '{"event":"start","phase":"cycle.backlinks","ts":"2026-08-22T13:32:01.000Z"}',
        '{"event":"finish","phase":"cycle.backlinks","elapsed_ms":200,"ts":"2026-08-22T13:32:01.200Z"}',
        '{"event":"start","phase":"cycle.sync","ts":"2026-08-22T13:32:01.200Z"}',
        '{"event":"tick","phase":"cycle.sync.files","done":2,"ts":"2026-08-22T13:32:02.000Z"}',
      ].join('\n'),
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'done',
      'active',
      'idle',
      'idle',
      'idle',
    ]);
  });

  test('Quick maintenance shows the first stage as active while the child has not emitted phase logs yet', () => {
    const run: ConsoleRun = {
      ...quickRun({}, 'running'),
      stdout: '',
      stderr: '',
    };

    expect(buildQuickMaintenanceStages(run).map(stage => stage.state)).toEqual([
      'active',
      'idle',
      'idle',
      'idle',
      'idle',
    ]);
  });

  test('Quick pending work is shown separately from real failures', () => {
    const run = quickRun({
      status: 'partial',
      phases: [
        { phase: 'sync', status: 'warn', details: { added: 9, modified: 2, failedFiles: 1 } },
        { phase: 'extract', status: 'ok', details: { linksCreated: 4, mentionHistoricalRemaining: 1706 } },
        { phase: 'embed', status: 'ok', details: { embedded: 20, pending: 3563 } },
      ],
      totals: { pages_added: 9, links_created: 4, pages_embedded: 20 },
    });
    const outcome = buildDreamOutcome(run);
    expect(outcome.metrics.map(metric => metric.label)).toEqual(['新增知识', '更新知识', '新增关联', '完成向量']);
    expect(outcome.pendingMetrics.map(metric => [metric.label, metric.value])).toEqual([
      ['异常文件', 1],
      ['待向量化', 3563],
      ['历史待补关联', 1706],
    ]);
    expect(outcome.failureItems).toEqual(['同步内容：1 个文件未处理成功']);
    expect(dream).toContain('仍需处理');
    expect(outcome.metrics.some(metric => metric.label === '未处理成功')).toBe(false);
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
        consolidate_takes_written: 8,
        facts_consolidated: 16,
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
    expect(outcome.extractionItems).toContain('长期判断：形成 8 条，合并 16 条事实。');
    expect(outcome.failureItems).toContain('读取最近新增和更新的内容：1 个文件未处理成功');
    expect(outcome.failureItems).toContain('观点提炼：1 个页面未处理成功');
    expect(dream).toContain('本次成果');
    expect(dream).toContain('查看本次整理内容');
    expect(dream).toContain('taskLink(run)');
    expect(dream).not.toContain('<summary>执行日志</summary>');
  });

  test('Dream settings explain relative paths with a resolved directory preview', () => {
    expect(settingsPage).toContain('默认 Dream 目录');
    expect(settingsPage).toContain('当前实际输出目录');
    expect(settingsPage).toContain('填写 <code>output</code> 不需要盘符');
    expect(settingsPage).toContain('高级设置选择其他 Source 时');
    expect(settingsPage).toContain('目录不存在会自动创建；已经存在则直接复用，不会清空目录');
  });

  test('selected run mode survives the data reload after a run completes', () => {
    expect(dream).toContain("const DREAM_RUN_MODE_KEY = 'pmbrain.dream.runMode'");
    expect(dream).toContain('window.localStorage.setItem(DREAM_RUN_MODE_KEY, mode)');
    const loadingHook = dream.slice(dream.indexOf('function useDreamData()'), dream.indexOf('function DreamShell('));
    expect(loadingHook).not.toContain('setLoading(true)');
    expect(loadingHook).toContain('if (pending.current) return');
  });

  test('PGLite can run AI meeting organization inline while Postgres ensures Worker availability', () => {
    expect(dream).toContain('await api.startSupervisor()');
    expect(dream).toContain('!isPglite');
    expect(dream).toContain("const isPglite = engine === 'pglite'");
    expect(dream).toContain('disabled={!generativeEnabled}');
    expect(dream).not.toContain("saved === 'meeting' && isPglite");
    expect(dream).not.toContain("runMode === 'meeting' && isPglite");
    expect(dream).not.toContain('disabled={isPglite');
    expect(dream).not.toContain('PGLite 暂不支持 AI 会议整理');
    expect(dream).not.toContain('需要 Postgres Worker');
    expect(dream).not.toContain("isPglite && runMode === 'advanced' && phase === 'all'");
    expect(dream).not.toContain('PGLite 请分阶段运行');
    expect(dream).not.toContain('深度整理会明确跳过 synthesize、patterns');
    expect(dream).toContain('PGLite 会在当前进程内串行完成完整 Dream');
    expect(dream).toContain("staged={mode === 'advanced'}");
    expect(dream).not.toContain("staged={mode === 'cycle'}");
    expect(dream).toContain('通常不需要手动操作');
  });

  test('manual Dream runs have no outer timeout unless advanced settings opt in', () => {
    expect(dream).toContain("const [timeoutMinutes, setTimeoutMinutes] = useState('')");
    expect(dream).toContain('placeholder="不限制"');
    expect(dream).toContain('留空表示不限制');
    expect(dream).toContain('手动整理默认不设外层时限');
  });

  test('AI 深度整理说明完整 Dream，而观点提炼保留为独立高级阶段', () => {
    expect(dream).toContain('依次完成完整 Dream');
    expect(dream).toContain('小模型会在昂贵阶段自动缩小单批页数');
    expect(dream).toContain('观点提炼仍可在“高级设置”中独立运行');
    expect(dream).not.toContain('不会自动进入打分、向量化或孤立页处理');
    expect(dream).toContain('已达到本次时间上限并安全停止');
  });

  test('the overview does not duplicate a non-actionable start button', () => {
    expect(dream).not.toContain("scrollIntoView({ behavior: 'smooth' })");
  });
  test('快速与深度整理显示实际关系分项和原生错误，不将补扫失败显示为零成果', () => {
    const phase = {phase:'extract',status:'warn',details:{linksCreated:8,relationLinksCreated:2,mentionLinksCreated:4,nerLinksCreated:2,by_mention:true,typed_ner:true,relationHistoricalRemaining:3,ner_error:'native database failure'}} as any;
    expect(phaseSummaryZh(phase)).toContain('正文实体关联 4 条、关系类型关联 2 条');
    expect(phaseSummaryZh(phase)).toContain('历史仍有 3 页待补扫');
    expect(phaseSummaryZh({phase:'orphans',status:'warn',details:{total_orphans:3,total_pages:5}} as any)).toContain('3 个尚未被其他知识引用的页面');
    for (const kind of ['dream_quick','dream_full']) {
      const run = {...completedRun({status:'partial',phases:[phase],totals:{links_created:8}}),kind};
      expect(buildDreamOutcome(run).failureItems).toContain('关系类型判断：native database failure');
    }
  });
});
