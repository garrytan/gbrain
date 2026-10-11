import { describe, expect, test } from 'bun:test';
import { TaskProgressAdapter, finishTaskProgress, taskRunSummary } from '../src/product/tasks/progress-adapter.ts';
import { resumeMaintenanceCheckpoint } from '../src/product/tasks/checkpoint.ts';
import type { MaintenanceCheckpoint } from '../src/product/tasks/types.ts';

describe('任务的产品进度', () => {
  test('零份资料通过验收时不能显示100%，未知价格明确说明费用上限无法核算',()=>{
    const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['capture_entities','extract']);
    const result={status:'partial',phases:[{phase:'capture_entities',status:'warn',details:{pages_processed:0,pages_remaining:1482,stop_reason:'tokens',cost_cny:null,cost_cap_cny:5,cost_cap_enforced:false,unresolved_references:[{target:'missing'}]}}]};
    const view=finishTaskProgress(adapter.view,'completed',result,null);
    expect(view.percent).toBe(0);expect(view.processed).toBe(0);expect(view.total).toBe(1482);
    expect(view.stage).toContain('部分完成');expect(view.metrics).toContainEqual({label:'配置费用上限（无法核算）',value:5});
    expect(view.metrics).toContainEqual({label:'未解析引用',value:1});
  });
  test('深度整理保存观点产出、长期判断和未完成页，旧结果重读仍能显示',()=>{
    const adapter=new TaskProgressAdapter('dream_full');adapter.plan(['propose_takes','consolidate']);
    const result={status:'partial',totals:{pages_added:0,proposals_inserted:374,consolidate_takes_written:8,facts_consolidated:16},phases:[
      {phase:'propose_takes',status:'warn',details:{pages_processed:99,pages_failed:1,remaining:2220,proposals_inserted:374}},
      {phase:'consolidate',status:'ok',details:{takes_written:8,facts_consolidated:16}},
    ]};
    const view=finishTaskProgress(adapter.view,'completed',result,null);
    expect(view.metrics).toContainEqual({label:'候选观点',value:374});
    expect(view.metrics).toContainEqual({label:'长期判断',value:8});
    expect(view.metrics).toContainEqual({label:'合并事实',value:16});
    expect(view.metrics).toContainEqual({label:'观点失败页',value:1});
    expect(view.metrics).toContainEqual({label:'待提炼页',value:2220});
    expect(view.stage).toContain('部分完成');
    expect(finishTaskProgress({...adapter.view,metrics:[{label:'新增资料',value:0}]},'completed',result,null).metrics).toEqual(view.metrics);
    const quick=new TaskProgressAdapter('dream_quick');
    expect(finishTaskProgress(quick.view,'completed',result,null).metrics.some(row=>row.label==='候选观点')).toBe(false);
  });
  test('继续保留完成的知识源和阶段，仅重跑未完成的部分', () => {
    const phase=(name:string,status='ok')=>({phase:name,status,duration_ms:0,summary:'test',details:{}}) as any;
    const checkpoint:MaintenanceCheckpoint={phases:{first:[phase('sync'),phase('extract')],second:[phase('lint'),phase('sync'),phase('extract','fail'),phase('embed')]},
      reports:{first:{status:'clean'},second:{status:'partial'}}};
    resumeMaintenanceCheckpoint(checkpoint,true);
    expect(checkpoint.reports).toEqual({first:{status:'clean'}});
    expect(checkpoint.phases.first.map(item=>item.phase)).toEqual(['sync','extract']);
    expect(checkpoint.phases.second.map(item=>item.phase)).toEqual(['lint','sync']);
    const stopped:MaintenanceCheckpoint={phases:{first:[phase('lint','warn')],second:[phase('lint','warn'),phase('sync')]},reports:{first:{status:'partial'}}};
    resumeMaintenanceCheckpoint(stopped);
    expect(stopped.reports.first.status).toBe('partial');
    expect(stopped.phases.second.map(item=>item.phase)).toEqual(['lint','sync']);
  });
  test('扫描显示独立计数与当前文件，换知识源清除旧文件和阶段百分比', () => {
    const adapter=new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint','sync','extract']);
    adapter.view.file='旧的大文件.md';adapter.view.processed=20;adapter.view.total=6693;adapter.view.phasePercent=64;
    adapter.view.syncScan={scanned:6693,unchanged:0};
    adapter.scope({name:'第二个源',index:1,total:3});
    expect(adapter.view.file).toBeNull();expect(adapter.view.phasePercent).toBeNull();expect(adapter.view.syncScan).toBeUndefined();
    expect(adapter.view.processed).toBeNull();expect(adapter.view.total).toBeNull();
    adapter.event({phase:'cycle.sync',event:'start'});
    adapter.write('{"event":"start","phase":"import.files","total":6693}\n');
    adapter.scan({scanned:1862,unchanged:9,path:'正在检查.md',bytes:1000,updatedAt:new Date().toISOString(),active:true});
    expect(adapter.view.stage).toBe('检查待同步资料');expect(adapter.view.file).toBe('正在检查.md');
    expect(adapter.view.syncScan?.total).toBe(6693);expect(adapter.view.phasePercent).toBe(27.8);
  });
  test('分段日志只更新真实事件，不把扫描和未知总量编成百分比', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.write('[pmbrain phase] import.collect_files start target=test\n');
    expect(adapter.view.percent).toBeNull();
    adapter.write('{"event":"start","phase":"import.files","total":4}\n{"event":"ti');
    adapter.write('ck","phase":"import.files","done":1,"total":4}\n');
    expect(adapter.view.percent).toBe(25);
    adapter.event({ phase: 'import.process' });
    adapter.event({ phase: 'import.vector', file: '示例.xlsx' });
    expect(adapter.view.stage).toBe('生成向量');
    expect(adapter.view.file).toBe('示例.xlsx');
    expect(adapter.view.steps.find(step => step.id === 'process')?.status).toBe('completed');
  });
  test('快速维护按实际步骤推进，新的阶段不沿用上一步百分比', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'backlinks', 'sync', 'extract', 'extract_facts', 'resolve_symbol_edges', 'embed', 'orphans']);
    adapter.write('{"event":"start","phase":"cycle.extract"}\n');
    adapter.write('{"event":"tick","phase":"extract.by_mention.scan","done":1440,"total":2372}\n');
    expect(adapter.view.stage).toBe('建立知识关联');
    expect(adapter.view.phasePercent).toBe(60);
    adapter.write('{"event":"start","phase":"cycle.embed"}\n');
    expect(adapter.view.phasePercent).toBeNull();
    expect(adapter.view.steps.find(step => step.id === 'relations')?.status).toBe('completed');
  });
  test('完成与失败使用实际结果，失败保留当时进度且技术错误不充当阶段', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.write('{"event":"tick","phase":"import.files","done":3,"total":4}\n');
    const failed = finishTaskProgress(adapter.view, 'failed', { imported: 3, errors: 1, chunksCreated: 36 }, 'fetch failed');
    expect(failed.percent).toBe(75);
    expect(failed.errorReason).toContain('模型');
    expect(failed.metrics).toContainEqual({ label: '知识分块', value: 36 });
    const completed = finishTaskProgress(adapter.view, 'completed', { imported: 4, errors: 0 }, null);
    expect(completed.percent).toBe(100);
    expect(completed.stage).toBe('导入完成');
  });
  test('整理结果中的 skipped 不显示为实际完成，未知日志不显示在普通进度', () => {
    const adapter = new TaskProgressAdapter('dream_full');
    adapter.plan(['lint', 'sync', 'extract_atoms', 'embed']);
    adapter.write('SQL secret technical diagnostic\n');
    expect(JSON.stringify(adapter.view)).not.toContain('SQL');
    const result = finishTaskProgress(adapter.view, 'completed', { phases: [{ phase: 'lint', status: 'ok' }, { phase: 'sync', status: 'skipped' }, { phase: 'extract_atoms', status: 'ok' }, { phase: 'embed', status: 'ok' }], totals: { pages_added: 12, links_created: 26, pages_embedded: 148 } }, null);
    expect(result.steps.find(step => step.id === 'sync')?.status).toBe('skipped');
    expect(result.metrics).toContainEqual({ label: '新增资料', value: 12 });
  });
  test('整理中的内部文件进度不能覆盖整体步骤进度', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync', 'extract', 'embed', 'orphans']);
    adapter.event({ phase: 'cycle.sync' });
    adapter.event({ phase: 'import.files', done: 3, total: 4 });
    expect(adapter.view.total).toBeNull();
    expect(adapter.view.stage).toBe('检查待同步资料');
    expect(adapter.view.percent).toBe(0);
  });
  test('部分失败和预览不报告实际全部完成', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync', 'embed']);
    const partial = finishTaskProgress(adapter.view, 'completed', { status: 'partial', phases: [{ phase: 'lint', status: 'ok' }, { phase: 'sync', status: 'fail' }] }, null);
    expect(partial.stage).toContain('部分完成');
    expect(partial.errorReason).toContain('同步资料');
    expect(partial.steps.find(step => step.id === 'embed')?.status).toBe('skipped');
    const modelFailure = finishTaskProgress(adapter.view, 'completed', { status: 'partial', phases: [{ phase: 'sync', status: 'fail', error: { message: 'fetch failed' } }] }, null);
    expect(modelFailure.errorReason).toContain('模型调用失败');
    const preview = finishTaskProgress(adapter.view, 'completed', { phases: [{ phase: 'embed', status: 'ok', details: { dryRun: true } }], totals: { pages_embedded: 10 } }, null);
    expect(preview.stage).toContain('未写入');
    expect(preview.metrics).toContainEqual({ label: '预计向量化', value: 10 });
  });
  test('列表摘要保留产品进度，不传技术日志和模型中间结果，原始记录不改变', () => {
    const run = { product: new TaskProgressAdapter('import_path').view, command: ['legacy'], stdout: 'technical log', stderr: 'technical error', result: { raw: true }, error: 'SQL failure' } as any;
    const summary = taskRunSummary(run);
    expect(summary.product).toEqual(run.product);
    expect(summary.stdout).toBe('');
    expect(summary.result).toBeUndefined();
    expect(summary.error).toBeNull();
    expect(run.stdout).toBe('technical log');
  });
  test('多个知识源按实际步骤累计，切换知识源不沿用上一源的已完成步骤', () => {
    const adapter = new TaskProgressAdapter('dream_quick');
    adapter.plan(['lint', 'sync']);
    adapter.scope({ name: '合成知识源二', index: 1, total: 2 });
    expect(adapter.view.percent).toBe(50);
    expect(adapter.view.completedSteps).toBe(0);
    adapter.event({ phase: 'cycle.lint', event: 'finish' });
    expect(adapter.view.percent).toBe(75);
    expect(adapter.view.steps.find(step => step.id === 'sync')?.status).toBe('pending');
  });
  test('目录导入下一文件时重置文件内步骤，保留整体文件计数', () => {
    const adapter = new TaskProgressAdapter('import_path');
    adapter.event({ phase: 'import.process', file: 'folder-a/one.md' });
    adapter.event({ phase: 'import.vector' });
    adapter.event({ phase: 'import.write' });
    adapter.event({ phase: 'import.files', done: 1, total: 2 });
    adapter.event({ phase: 'import.process', file: 'folder-b/one.md' });
    expect(adapter.view.percent).toBe(50);
    expect(adapter.view.steps.find(step => step.id === 'vector')?.status).toBe('pending');
    expect(adapter.view.file).toBe('one.md');
  });
  test('快速和深度整理的列表统计都保留关系分项和历史剩余', () => {
    for (const kind of ['dream_quick','dream_full']) {
      const result = finishTaskProgress(new TaskProgressAdapter(kind).view,'completed',{phases:[{phase:'extract',status:'ok',details:{relationLinksCreated:2,mentionLinksCreated:4,nerLinksCreated:2,relationHistoricalRemaining:3,mentionHistoricalRemaining:1}}]},null);
      expect(result.metrics).toContainEqual({label:'历史显式关联',value:2});
      expect(result.metrics).toContainEqual({label:'正文实体关联',value:4});
      expect(result.metrics).toContainEqual({label:'关系类型关联',value:2});
      expect(result.metrics).toContainEqual({label:'历史待补关联',value:3});
    }
  });
});
