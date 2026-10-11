import type { ConsoleRun } from '../lib/shared';
import type { ImportRunRequest, ImportUploadOptions } from '../../../shared/contracts/import';

export interface Material { id: string; name: string; path?: string; file?: File }
export interface ImportApi {
  startImportRun: (body: ImportRunRequest) => Promise<{ runId: string }>;
  startImportUploadRun: (file: File, body: ImportUploadOptions) => Promise<{ runId: string }>;
}
export async function importMaterials(items: Material[], dependencies: {
  api: ImportApi;
  wait: (id: string, update: (run: ConsoleRun) => void) => Promise<ConsoleRun>;
  update: (run: ConsoleRun) => void;
  completed: (item: Material, run: ConsoleRun) => void;
  starting: (item: Material) => void;
  sourceId?: string;
  accepted?: (item: Material, id: string) => void;
}) {
  for (const item of items) {
    dependencies.starting(item);
    const options = { autoEmbed: true, structuredDocuments: true, documentOcr: true, workers: 1, sourceId: dependencies.sourceId };
    const accepted = item.file
      ? await dependencies.api.startImportUploadRun(item.file, options)
      : await dependencies.api.startImportRun({ ...options, path: item.path ?? '', includeOffice: true, includeImages: true });
    dependencies.accepted?.(item, accepted.runId);
    const run = await dependencies.wait(accepted.runId, dependencies.update);
    if (run.status !== 'completed') throw new Error(run.error || run.stderr || (run.status === 'cancelled' ? '导入已停止' : `${item.name} 导入失败`));
    dependencies.completed(item, run);
  }
}
export function availableImportSources<T extends { archived?: boolean }>(sources: T[]): T[] {
  return sources.filter(source => !source.archived);
}
