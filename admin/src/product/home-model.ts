export const OPEN_CONVERSATION_KEY = 'pmbrain.openConversation';
export const CREATE_RETURN_KEY = 'pmbrain.createReturn';
export const NAV_COLLAPSED_KEY = 'pmbrain.navCollapsed';

export type LibraryMode = 'new' | 'ready';
export type StepState = 'pending' | 'current' | 'done' | 'failed';
export type MaintenanceStepId = 'backup' | 'upgrade' | 'health' | 'service';
export type CreateIntent = 'import' | 'organize' | 'ask' | '';

export interface NamedStep {
  id: string;
  label: string;
  state: StepState;
}

export interface MaintenanceView {
  visible: boolean;
  title: string;
  message: string;
  steps: NamedStep[];
}

const MAINTENANCE_ORDER = ['backup', 'upgrade', 'health', 'service'] as const;
const MAINTENANCE_LABELS: Record<MaintenanceStepId, string> = {
  backup: '数据备份',
  upgrade: '数据库升级',
  health: '健康检查',
  service: '服务启动',
};

export interface StartupSnapshot {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface ImportRunSnapshot {
  status: string;
  stdout: string;
  stderr: string;
  error?: string | null;
}

const STARTUP_STAGE: Record<StartupSnapshot['stage'], MaintenanceStepId> = {
  database: 'backup',
  migration: 'upgrade',
  health: 'health',
  sidecar: 'service',
};

export function libraryMode(desktop: boolean, needsSetup: boolean | null): LibraryMode | 'loading' {
  if (desktop && needsSetup === null) return 'loading';
  return desktop && needsSetup ? 'new' : 'ready';
}

export function createIntent(hash: string): CreateIntent {
  const query = hash.replace(/^#/, '').split('?')[1] ?? '';
  const intent = new URLSearchParams(query).get('intent');
  return intent === 'import' || intent === 'organize' || intent === 'ask' ? intent : '';
}

export function assistantTarget(page: string): boolean {
  return page === 'assistant' || page === 'import';
}

export function navActive(page: string, target: string): boolean {
  if (target === 'assistant') return assistantTarget(page);
  if (target === 'home') return page === 'home' || page === 'create';
  return page === target;
}

function maintenanceSteps(current: MaintenanceStepId | null, failed = false): NamedStep[] {
  const index = current ? MAINTENANCE_ORDER.indexOf(current) : -1;
  return MAINTENANCE_ORDER.map((id, position) => ({
    id,
    label: MAINTENANCE_LABELS[id],
    state: failed && position === index
      ? 'failed'
      : index < 0
        ? 'pending'
        : position < index
          ? 'done'
          : position === index
            ? 'current'
            : 'pending',
  }));
}

export function finishedMaintenance(): MaintenanceView {
  return {
    visible: false,
    title: '已经完成',
    message: '可以继续使用知识库。',
    steps: MAINTENANCE_ORDER.map(id => ({ id, label: MAINTENANCE_LABELS[id], state: 'done' as const })),
  };
}

export function maintenanceView(input: {
  startup: StartupSnapshot | null;
  servicePhase: string | null;
  updatePhase: string | null;
  updateMessage?: string;
  needsSetup: boolean;
}): MaintenanceView {
  const startup = input.startup;
  if (startup?.visible) {
    return {
      visible: true,
      title: startup.title || '正在准备 PMBrain…',
      message: startup.message,
      steps: maintenanceSteps(STARTUP_STAGE[startup.stage]),
    };
  }
  if (input.updatePhase === 'downloading' || input.updatePhase === 'downloaded' || input.updatePhase === 'installing') {
    return {
      visible: true,
      title: '正在更新 PMBrain…',
      message: input.updateMessage || '正在准备新的版本。',
      steps: maintenanceSteps(null),
    };
  }
  if (input.needsSetup && input.servicePhase !== 'failed') {
    return { visible: false, title: '', message: '', steps: maintenanceSteps(null) };
  }
  if (input.servicePhase === 'failed') {
    return {
      visible: true,
      title: '知识库服务没有启动',
      message: '可以查看恢复步骤，或打开恢复页面。',
      steps: maintenanceSteps('service', true),
    };
  }
  if (input.servicePhase === 'starting') {
    return {
      visible: true,
      title: '正在启动知识库服务…',
      message: '启动完成后这个提示会消失。',
      steps: maintenanceSteps('service'),
    };
  }
  return { visible: false, title: '', message: '', steps: maintenanceSteps(null) };
}

const IMPORT_STEPS = [
  ['import', '导入资料'],
  ['read', '读取和整理'],
  ['index', '建立索引'],
] as const;

function importPhase(text: string): number {
  if (/chunks created|pages imported|Import complete|embedding|向量/i.test(text)) return 2;
  if (/Found \d+|imported=|process_file|正在导入/i.test(text)) return 1;
  return 0;
}

export function importBuildSteps(run: ImportRunSnapshot | null): NamedStep[] {
  if (!run) {
    return IMPORT_STEPS.map(([id, label], index) => ({ id, label, state: index === 0 ? 'current' : 'pending' }));
  }
  if (run.status === 'completed') return IMPORT_STEPS.map(([id, label]) => ({ id, label, state: 'done' }));
  const phase = run.status === 'queued' ? 0 : importPhase(`${run.stdout}\n${run.stderr}`);
  const failed = run.status === 'failed' || run.status === 'cancelled';
  return IMPORT_STEPS.map(([id, label], index) => ({
    id,
    label,
    state: failed && index === phase ? 'failed' : index < phase ? 'done' : index === phase ? 'current' : 'pending',
  }));
}

export function importBuildDetail(run: ImportRunSnapshot | null): string {
  if (!run) return '选择资料后，PMBrain 会读取内容、整理成知识，并建立可搜索的索引。';
  if (run.error) return run.error;
  const lines = `${run.stdout}\n${run.stderr}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('[pmbrain phase]') && !line.startsWith('{'));
  const useful = [...lines].reverse().find(line => /Found |Import complete|pages imported|chunks created|imported=|正在导入/.test(line));
  if (useful) return useful.replace(/^\[pmbrain import-file\]\s*/, '');
  if (run.status === 'completed') return '资料已经进入知识库。';
  if (run.status === 'cancelled') return '导入已取消。已经写入的资料会保留。';
  if (run.status === 'failed') return '导入没有完成。';
  if (run.status === 'queued') return '正在等待开始导入。';
  return '正在读取资料并写入知识库。配置了向量模型时会一并写入向量。';
}

export function suggestedChatModel(current: string | undefined, choices: Array<{ value: string }>): string | null {
  if (current?.trim()) return null;
  return choices.length === 1 ? choices[0].value : null;
}
