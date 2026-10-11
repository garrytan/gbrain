import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gbrainPath, loadConfig } from '../../core/config.ts';
import { createHash } from 'node:crypto';
import type { SyncFileOptions } from '../../core/sync-file-runtime.ts';
import { SYNC_FILE_FORMAT_VERSION } from '../../core/sync-file-runtime.ts';
import type { MaintenanceCheckpoint } from './types.ts';

export function resumeMaintenanceCheckpoint(checkpoint:MaintenanceCheckpoint,retryCompleted=false):void {
  for(const [source,report] of Object.entries(checkpoint.reports)) {
    if(retryCompleted && !['ok','clean'].includes(String(report.status)))delete checkpoint.reports[source];
  }
  for(const [source,phases] of Object.entries(checkpoint.phases)) {
    if(checkpoint.reports[source])continue;
    const unfinished=phases.findIndex(phase=>phase.status==='fail' || (retryCompleted && phase.status==='warn'));
    if(unfinished>=0)checkpoint.phases[source]=phases.slice(0,unfinished);
  }
}

export function syncFileContentFingerprint(options:SyncFileOptions):string {
  return createHash('sha256').update(JSON.stringify([SYNC_FILE_FORMAT_VERSION,options.sourceId??'default',
    options.structured!==false,options.session===true,options.includeOffice===true,options.includeImages===true,
    options.documentOcr===true,options.activePack?.page_types.map(type=>[type.name,type.path_prefixes])])).digest('hex');
}

export function taskModelFingerprint(): string {
  const config = loadConfig();
  const fields = Object.fromEntries(Object.entries(config ?? {}).filter(([key]) => /model|embedding|ocr|rerank|expansion|provider|api_key/.test(key) || key === 'chat_fallback_chain'));
  return createHash('sha256').update(JSON.stringify([fields, (config?.desktop as Record<string, unknown> | undefined)?.model_services])).digest('hex');
}

export function taskArtifactPath(id: number, suffix = 'jsonl'): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid task checkpoint');
  const config = loadConfig();
  const brain = createHash('sha256').update(JSON.stringify([config?.engine, config?.database_path, config?.database_url])).digest('hex').slice(0, 24);
  if (!['jsonl','files.jsonl','stop.json'].includes(suffix)) throw new Error('Invalid task artifact');
  return join(gbrainPath('task-artifacts'), `${brain}-job-${id}.${suffix}`);
}

export async function appendTaskCheckpoint(id: number, file: Record<string, unknown>): Promise<void> {
  await mkdir(gbrainPath('task-artifacts'), { recursive: true });
  await appendFile(taskArtifactPath(id), `${JSON.stringify(file)}\n`, { mode: 0o600 });
}

export async function readTaskCheckpoint(id: number): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(taskArtifactPath(id), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
