import { taskName, type TaskProductProgress } from '../../../shared/task-progress.ts';

const labels: Record<string, string> = {
  collect: '读取资料清单', process: '读取与解析资料', vector: '生成向量', write: '写入知识库',
  check: '检查知识', sync: '同步资料', relations: '建立知识关联', embed: '更新搜索索引', finish: '完成检查',
  synthesize: '理解新增知识', extract_atoms: '提炼长期知识', patterns: '发现知识模式',
  synthesize_concepts: '整理概念', recompute_emotional_weight: '更新知识权重', consolidate: '合并重复知识',
  propose_takes: '整理观点', grade_takes: '检查观点', calibration_profile: '检查整理质量', drift: '检查知识变化',
  conversation_facts_backfill: '整理会话事实', capture_entities: '识别实体', enrich_thin: '补充知识内容', 'schema-suggest': '检查知识结构', purge: '完成维护',
};

function group(phase: string): string {
  if (['lint', 'backlinks'].includes(phase)) return 'check';
  if (['extract', 'extract_facts', 'resolve_symbol_edges'].includes(phase)) return 'relations';
  if (phase === 'orphans') return 'finish';
  return phase;
}

export function taskErrorReason(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/ENOENT|no such file/i.test(error)) return '找不到资料文件，请检查路径后重试。';
  if (/too large/i.test(error)) return '资料超过支持的大小，请拆分后重试。';
  if (/fetch failed|ECONN|timeout|timed out|401|403|429|API.?key|credentials|balance/i.test(error)) return '模型调用失败，请检查模型连接、密钥或额度。';
  if (/SQL|syntax error|constraint|database/i.test(error)) return '数据库操作未成功，请在技术日志中查看原因。';
  return /[\u4e00-\u9fff]/.test(error) ? error.replace(/^Error:\s*/, '').slice(0, 500) : '任务未完成，请在技术日志中查看原因后重试。';
}

export class TaskProgressAdapter {
  private buffer = '';
  private currentPhase = '';
  private currentFile = '';
  private completed = new Set<string>();
  view: TaskProductProgress;

  constructor(kind: string, saved?: TaskProductProgress) {
    this.view = saved ? structuredClone(saved) : {
      name: taskName(kind), stage: '准备执行', percent: null, phasePercent: null, completedSteps: 0,
      steps: [], processed: null, total: null, file: null, metrics: [], errorReason: null,
    };
    if (!saved) {
      if (kind === 'import_path') this.plan(['collect', 'process', 'vector', 'write']);
      else if (kind === 'embed_stale') this.plan(['embed']);
      else if (kind === 'sync_all') this.plan(['sync']);
    }
  }

  plan(phases: string[]): void {
    this.view.steps = [];
    this.completed.clear();
    for (const phase of phases) {
      const id = group(phase);
      let step = this.view.steps.find(item => item.id === id);
      if (!step) { step = { id, label: labels[id] ?? '处理知识', status: 'pending', phases: [] }; this.view.steps.push(step); }
      step.phases.push(phase);
    }
    this.view.completedSteps = 0;
    this.currentPhase = '';
  }

  scope(scope: { name: string; index: number; total: number }): void {
    const phases = this.view.steps.flatMap(step => step.phases);
    this.plan(phases);
    this.view.scope = scope;
    this.view.percent = Math.floor(scope.index / scope.total * 100);
    this.view.phasePercent=null;this.view.file=null;this.view.processed=null;this.view.total=null;
    this.view.syncScan=undefined;this.view.activeFiles=[];
  }

  scan(scan:NonNullable<TaskProductProgress['syncScan']>):void {
    this.view.syncScan={...this.view.syncScan,...scan};
    if(!scan.active)return;
    this.view.stage='检查待同步资料';
    if(scan.path)this.view.file=scan.path;
    const total=this.view.syncScan.total;
    this.view.phasePercent=total?Math.floor(scan.scanned/total*1000)/10:null;
  }

  event(event: { phase: string; file?: string; event?: string; done?: number; total?: number }): void {
    const raw = event.phase.replace(/^cycle\./, '').replace(/^import\./, '');
    if (raw === 'files') {
      if(this.view.name==='快速维护' && this.currentPhase==='sync'){
        const scan=this.view.syncScan??{scanned:0,unchanged:0};
        if(typeof event.total==='number')scan.total=event.total;
        this.scan({...scan,active:event.event!=='finish'});
        return;
      }
      if (this.view.name !== '导入资料') return;
      if (typeof event.done === 'number') this.view.processed = event.done;
      if (typeof event.total === 'number') this.view.total = event.total;
      if (this.view.total && this.view.processed !== null) this.view.percent = Math.min(99, Math.floor(this.view.processed / this.view.total * 100));
      return;
    }
    const phase = raw.split('.')[0]!;
    const step = this.view.steps.find(item => item.phases.includes(phase));
    if (!step) return;
    if (event.file && phase === 'process' && event.file !== this.currentFile) {
      for (const item of this.view.steps) if (item.id !== 'collect') item.status = 'pending';
      this.currentPhase = '';
      this.currentFile = event.file;
      if (this.view.material) this.view.material.page = undefined;
    }
    if (event.file) this.view.file = event.file.split(/[\\/]/).at(-1) ?? event.file;
    if (phase !== this.currentPhase) {
      if(phase!=='sync' && this.view.syncScan)this.view.syncScan.active=false;
      const index = this.view.steps.indexOf(step);
      for (const previous of this.view.steps.slice(0, index)) if (previous.status === 'running') previous.status = 'completed';
      this.currentPhase = phase;
      this.view.phasePercent = null;
    }
    if (event.event === 'finish') {
      this.completed.add(phase);
      if (step.phases.every(item => this.completed.has(item))) step.status = 'completed';
    } else step.status = 'running';
    this.view.stage = step.label;
    if (typeof event.total === 'number' && event.total > 0 && typeof event.done === 'number') {
      this.view.phasePercent = Math.min(100, Math.floor(event.done / event.total * 100));
    }
    this.view.completedSteps = this.view.steps.filter(item => item.status === 'completed').length;
    if (this.view.name !== '导入资料') {
      const done = this.view.steps.filter(item => item.status === 'completed').length;
      const scope = this.view.scope;
      this.view.percent = this.view.steps.length ? Math.min(99, Math.floor(((scope?.index ?? 0) + done / this.view.steps.length) / (scope?.total ?? 1) * 100)) : null;
    }
  }

  write(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop()!.slice(-20_000);
    for (const line of lines) {
      if (line.includes('import.collect_files start')) this.event({ phase: 'import.collect' });
      if (!line.trim().startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.phase === 'string' && ['start', 'tick', 'finish', 'heartbeat'].includes(event.event)) this.event(event);
      } catch {}
    }
  }
}

export function finishTaskProgress(view: TaskProductProgress, status: string, result: unknown, error: string | null): TaskProductProgress {
  const next = structuredClone(view);
  const data = result && typeof result === 'object' ? result as Record<string, any> : {};
  if (data.status === 'skipped' && Array.isArray(data.phases)) {
    next.percent = null; next.phasePercent = null; next.stage = '任务未执行';
    next.errorReason = data.reason === 'cycle_already_running' ? '未执行：其他整理任务占用数据库，请排队后继续。' : `未执行：${data.reason ?? '整理被跳过'}`;
    for (const step of next.steps) step.status = 'skipped';
    next.completedSteps = 0;
    return next;
  }
  const metrics: Array<{ label: string; value: number }> = [];
  const add = (label: string, value: unknown) => { if (typeof value === 'number' && Number.isFinite(value)) metrics.push({ label, value }); };
  if(next.name!=='快速维护'&&Array.isArray(data.phases)){
    const proposals=data.phases.find((phase:any)=>phase.phase==='propose_takes');
    const consolidate=data.phases.find((phase:any)=>phase.phase==='consolidate');
    add('候选观点',proposals?.details?.proposals_inserted??data.totals?.proposals_inserted);
    add('长期判断',consolidate?.details?.takes_written??data.totals?.consolidate_takes_written);
    add('合并事实',consolidate?.details?.facts_consolidated??data.totals?.facts_consolidated);
    add('观点处理页',proposals?.details?.pages_processed);
    add('观点失败页',proposals?.details?.pages_failed);
    add('待提炼页',proposals?.details?.remaining);
  }
  add('新增资料', data.imported ?? data.totals?.pages_added);
  add('跳过资料', data.skipped);
  add('失败文件', data.errors);
  add('知识分块', data.chunksCreated);
  add(next.relations?.available ? '新增关联' : '新建关联', next.relations?.available ? next.relations.total : data.totals?.links_created);
  add('向量化', data.embedded ?? data.totals?.pages_embedded);
  if (Array.isArray(data.phases)) {
    add('异常步骤', data.phases.filter((phase: any) => phase.status === 'fail').length);
    const sync = data.phases.find((phase: any) => phase.phase === 'sync');
    add('更新资料', sync?.details?.modified);
    const relations = data.phases.find((phase: any) => phase.phase === 'extract')?.details;
    add('历史显式关联', relations?.relationLinksCreated);
    add('正文实体关联', relations?.mentionLinksCreated);
    add('关系类型关联', relations?.nerLinksCreated);
    add('历史待补关联', Math.max(relations?.relationHistoricalRemaining ?? 0, relations?.mentionHistoricalRemaining ?? 0) || (relations?.historical_relation_backfill ? 0 : undefined));
    const lint = data.phases.find((phase: any) => phase.phase === 'lint');
    add('待检查项', lint?.details?.issues);
    const capture = data.phases.find((phase: any) => phase.phase === 'capture_entities')?.details;
    if (capture) {
      add('已处理页面', capture.pages_processed);
      add('已处理分块', capture.chunks_processed);
      add('输入 Token', capture.input_tokens);
      add('输出 Token', capture.output_tokens);
      if (typeof capture.cost_cny === 'number') add('当前费用', capture.cost_cny);
      if (typeof capture.cost_cap_cny === 'number') add(capture.cost_cap_enforced===false?'配置费用上限（无法核算）':'费用上限', capture.cost_cap_cny);
      if (Array.isArray(capture.unresolved_references)) add('未解析引用',capture.unresolved_references.length);
      add('剩余页面', capture.pages_remaining);
      add('创建实体', capture.entities_written);
      if (!next.relations?.available) add('新增关系', capture.relations_created);
      if (typeof capture.entities_isolated === 'number') add('孤立实体', capture.entities_isolated);
      if (typeof capture.unlinked_mentions === 'number') add('未关联提及', capture.unlinked_mentions);
      if (typeof capture.report_line === 'string' && capture.report_line.trim()) next.detail = capture.report_line;
    }
  }
  add('孤立知识', data.totals?.orphans_found);
  if (metrics.length) next.metrics = metrics;
  const capturePhase = Array.isArray(data.phases)
    ? data.phases.find((phase: any) => phase.phase === 'capture_entities')
    : undefined;
  if (Array.isArray(data.phases)) {
    for (const step of next.steps) {
      const matches = data.phases.filter((phase: any) => step.phases.includes(phase.phase));
      if (!matches.length) { step.status = 'skipped'; continue; }
      step.status = matches.some((phase: any) => phase.status === 'fail') ? 'failed'
        : matches.every((phase: any) => phase.status === 'skipped') ? 'skipped' : 'completed';
    }
    const captureStop = capturePhase?.details?.stop_reason;
    if (captureStop === 'failure' || captureStop === 'model_unavailable' || (capturePhase?.details?.pages_remaining>0)) {
      const captureStep = next.steps.find(step => step.phases.includes('capture_entities'));
      if (captureStep && captureStep.status !== 'skipped') captureStep.status = ['tokens','cost'].includes(captureStop)?'pending':'failed';
    }
  }
  if (status === 'completed') {
    next.percent = 100;
    const remaining=Number(capturePhase?.details?.pages_remaining??0);
    if(remaining>0){
      next.processed=Number(capturePhase.details.pages_processed??0);
      next.total=next.processed+remaining;
      next.percent=Math.floor(next.processed/next.total*100);
    }
    next.stage = remaining>0 || data.status === 'partial' || next.steps.some(step => step.status === 'failed') ? '部分完成，请查看未完成步骤'
      : next.name === '导入资料' ? '导入完成' : `${next.name}完成`;
    for (const step of next.steps) {
      if (step.status === 'running') step.status = 'completed';
      else if (step.status === 'pending' && !step.phases.includes('capture_entities')) step.status = 'skipped';
    }
    const failed = next.steps.find(step => step.status === 'failed');
    if (failed) {
      const failure = data.phases?.find((phase: any) => failed.phases.includes(phase.phase) && (
        phase.status === 'fail' || ['failure','ingest_validation','relation_failure','model_unavailable'].includes(phase.details?.stop_reason)
      ));
      next.errorReason = failure?.details?.stop_reason === 'model_unavailable'
        ? '实体识别模型不可用'
        : taskErrorReason(failure?.error?.message) ?? `${failed.label}未完成，请查看技术日志。`;
    }
    if (Array.isArray(data.phases) && data.phases.some((phase: any) => phase.details?.dryRun === true)) {
      next.stage = '预览完成，未写入知识库';
      next.metrics = next.metrics.map(metric => ({ ...metric, label: `预计${metric.label}` }));
    }
  } else if (status === 'failed' || status === 'cancelled') {
    for (const step of next.steps) if (step.status === 'running') step.status = status === 'failed' ? 'failed' : 'pending';
    next.errorReason = status === 'failed' ? taskErrorReason(error) : null;
    if (status === 'failed') {
      const failed = data.phases?.find((phase: any) => phase.error?.message);
      if (failed?.error?.message) next.errorReason = failed.error.message;
      next.stage = '任务未完成';
    }
  } else if (status === 'queued' && next.stage !== '等待前面的整理任务完成') next.stage = '等待执行';
  next.completedSteps = next.steps.filter(step => step.status === 'completed').length;
  return next;
}

export function taskRunSummary(run: import('../../commands/natural-lang/types.ts').ConsoleRun) {
  return { ...run, command: [], stdout: '', stderr: '', result: undefined,
    error: run.product?.errorReason ?? null };
}
