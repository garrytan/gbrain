import type { ConsoleRun } from '../lib/shared';

export const taskStopping = (run: ConsoleRun) => run.status === 'running' && run.error === '正在停止任务…';
const taskWasSkipped = (run: ConsoleRun) => (run.result as {status?:string}|undefined)?.status === 'skipped' || run.product?.stage === '任务未执行';
export const taskRoundCompleted = (run: ConsoleRun) => run.kind.startsWith('dream_') && run.status === 'completed' && !taskWasSkipped(run);
export const taskPercent = (run: ConsoleRun) => taskRoundCompleted(run) ? null : run.product?.percent ?? null;
export const taskStatus = (run: ConsoleRun) => taskStopping(run) ? '正在停止' : taskWasSkipped(run) ? '未执行' : taskRoundCompleted(run) ? '本轮已完成' : ({ queued:'排队中',running:'执行中',completed:'已完成',failed:'失败',cancelled:'已停止' })[run.status];

const remainingMetric = (label: string) => /^(?:待|剩余|未关联|未解析|孤立|异常)|失败|待补/.test(label);
const operationalMetric = (label: string) => /Token|费用|预算|上限/.test(label);

export function taskRoundSummary(run: ConsoleRun): { completed: string[]; remaining: string[]; reason: string | null } {
  const view=run.product;
  const completed=(view?.metrics??[]).filter(metric=>metric.value>0 && !remainingMetric(metric.label) && !operationalMetric(metric.label)).map(metric=>`${metric.label} ${metric.value}`);
  const remaining=(view?.metrics??[]).filter(metric=>metric.value>0 && remainingMetric(metric.label)).map(metric=>`${metric.label} ${metric.value}`);
  if(view?.syncFiles){
    if(view.syncFiles.completed>0)completed.unshift(`同步资料 ${view.syncFiles.completed} 份`);
    if(view.syncFiles.failed>0)remaining.push(`同步失败 ${view.syncFiles.failed} 份`);
    if(view.syncFiles.remaining>0)remaining.push(`待同步 ${view.syncFiles.remaining} 份`);
  }
  if(!completed.length)completed.push(...(view?.steps??[]).filter(step=>step.status==='completed').map(step=>step.label));
  remaining.push(...(view?.steps??[]).filter(step=>['pending','running','failed'].includes(step.status)).map(step=>step.label));
  return {completed:[...new Set(completed)],remaining:[...new Set(remaining)],reason:view?.errorReason??run.error??null};
}

export function taskHasRemaining(run: ConsoleRun): boolean {
  const summary=taskRoundSummary(run);
  return summary.remaining.length>0 || Boolean(summary.reason) || Boolean(run.product?.stage.startsWith('部分完成'));
}

export function taskRoundListSummary(run: ConsoleRun): string {
  const summary=taskRoundSummary(run);
  return [summary.completed.slice(0,2).join(' · ')||'本轮没有新增知识成果',summary.remaining.length?`待处理：${summary.remaining.slice(0,2).join(' · ')}`:summary.reason?`未完成原因：${summary.reason}`:taskHasRemaining(run)?'还有未完成事项，可查看详情':''].filter(Boolean).join('；');
}
