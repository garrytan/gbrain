import type { ConsoleRun } from '../lib/shared';

export function taskPhaseSummary(run: ConsoleRun, now = Date.now()) {
  const view=run.product,phase=view?.phaseProgress;
  const elapsed=phase?phase.elapsedMs+(run.status==='running'&&phase.startedAt?Math.max(0,now-Date.parse(phase.startedAt)):0):null;
  const seconds=elapsed==null?null:Math.floor(elapsed/1000);
  const sync=phase?.id==='sync'&&!view?.syncScan?.active?view?.syncFiles:undefined;
  const completed=sync?.completed??phase?.completed??(phase?null:view?.processed??null);
  const total=sync?.total??phase?.total??(phase?null:view?.total??null);
  const remaining=sync?.remaining??phase?.remaining;
  const fresh=view?.heartbeatAt!=null&&now-Date.parse(view.heartbeatAt)<30000;
  return {count:completed==null?'待统计':`${completed} / ${total??'待统计'} ${sync?'份资料':phase?.unit??'项'}`,
    duration:seconds==null?'暂未记录':seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`,
    remaining:remaining==null?'待统计':`${remaining} 个`,active:run.status==='running'&&fresh?phase?.active:null,failed:view?.failedUnits??0};
}

export const taskStopping = (run: ConsoleRun) => run.status === 'running' && run.error === '正在停止任务…';
const taskWasSkipped = (run: ConsoleRun) => (run.result as {status?:string}|undefined)?.status === 'skipped' || run.product?.stage === '任务未执行';
export const taskRoundCompleted = (run: ConsoleRun) => run.kind.startsWith('dream_') && run.status === 'completed' && !taskWasSkipped(run);
export const taskPercent = (run: ConsoleRun) => taskRoundCompleted(run) ? null : run.status==='running'&&run.kind.startsWith('dream_')&&run.product?.phaseProgress ? run.product.phasePercent : run.product?.percent ?? null;
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
