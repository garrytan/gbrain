import { describe, expect, test } from 'bun:test';
import type { ConsoleRun } from '../shared/contracts/common.ts';
import { taskHasRemaining, taskPercent, taskRoundCompleted, taskRoundSummary, taskStatus } from '../admin/src/product/task-presentation.ts';

const sample = (): ConsoleRun => ({ id:'task-7',kind:'dream_full',status:'completed',command:[],stdout:'',stderr:'',error:null,exitCode:0,startedAt:'2026-10-09T01:00:00Z',completedAt:'2026-10-09T01:01:00Z',durationMs:60000,
  product:{name:'AI 深度整理',stage:'部分完成，请查看未完成步骤',percent:0,phasePercent:null,completedSteps:1,processed:0,total:1482,file:null,
    steps:[{id:'relations',label:'建立知识关联',status:'completed',phases:['extract']},{id:'capture',label:'识别实体',status:'failed',phases:['capture_entities']}],
    metrics:[{label:'待检查项',value:2939},{label:'长期判断',value:5},{label:'合并事实',value:11},{label:'创建实体',value:4},{label:'新增关系',value:0},{label:'剩余页面',value:1482},{label:'输入 Token',value:120000},{label:'费用上限',value:5}],errorReason:'实体落库验收失败：目标未保存'} });

describe('整理按本轮成果展示',()=>{
  test('结束的部分整理显示本轮完成，不把原始0页进度改成100%',()=>{
    const run=sample(),before=JSON.stringify(run);
    expect(taskStatus(run)).toBe('本轮已完成');expect(taskRoundCompleted(run)).toBe(true);expect(taskPercent(run)).toBeNull();
    expect(taskHasRemaining(run)).toBe(true);expect(JSON.stringify(run)).toBe(before);expect(run.product?.percent).toBe(0);
  });
  test('真实成果先展示，待检查和剩余页分开，不把Token与预算当成果',()=>{
    const summary=taskRoundSummary(sample());
    expect(summary.completed).toContain('长期判断 5');expect(summary.completed).toContain('合并事实 11');expect(summary.completed).toContain('创建实体 4');
    expect(summary.remaining).toContain('待检查项 2939');expect(summary.remaining).toContain('剩余页面 1482');
    expect(summary.remaining).toContain('识别实体');expect(summary.reason).toContain('目标未保存');
    expect(summary.completed.join(' ')).not.toMatch(/Token|预算|费用|新增关系 0/);
  });
  test('没有资料通过验收时不编造成果，仍保留待处理数和失败原因',()=>{
    const run=sample();run.product!.metrics=[{label:'已处理页面',value:0},{label:'剩余页面',value:1482}];run.product!.steps=[];
    expect(taskRoundSummary(run).completed).toEqual([]);expect(taskRoundSummary(run).remaining).toEqual(['剩余页面 1482']);
    expect(taskRoundSummary(run).reason).toContain('目标未保存');
  });
  test('完全完成的轮次与旧版没有详细统计的任务均可展示',()=>{
    const run=sample();run.product!.stage='整理完成';run.product!.steps.forEach(step=>step.status='completed');run.product!.metrics=[{label:'新建关联',value:26}];run.product!.errorReason=null;
    expect(taskHasRemaining(run)).toBe(false);expect(taskStatus(run)).toBe('本轮已完成');
    delete run.product;expect(taskRoundSummary(run).completed).toEqual([]);expect(taskStatus(run)).toBe('本轮已完成');
  });
  test('执行中保留实际百分比，真正失败与取消不能标记成绿色完成',()=>{
    const run=sample();run.status='running';expect(taskStatus(run)).toBe('执行中');expect(taskPercent(run)).toBe(0);
    run.status='failed';expect(taskStatus(run)).toBe('失败');expect(taskRoundCompleted(run)).toBe(false);
    run.status='cancelled';expect(taskStatus(run)).toBe('已停止');expect(taskRoundCompleted(run)).toBe(false);
  });
  test('同步队列遗留失败和待处理仍能筛出并提供继续入口',()=>{
    const run=sample();run.kind='dream_quick';run.product!.stage='维护完成';run.product!.steps=[];run.product!.metrics=[];run.product!.errorReason=null;
    run.product!.syncFiles={total:60,completed:58,failed:1,remaining:1};
    expect(taskHasRemaining(run)).toBe(true);expect(taskRoundSummary(run).completed).toContain('同步资料 58 份');
    expect(taskRoundSummary(run).remaining).toContain('同步失败 1 份');expect(taskRoundSummary(run).remaining).toContain('待同步 1 份');
  });
});
