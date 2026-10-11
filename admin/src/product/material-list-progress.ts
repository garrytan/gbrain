import type { ConsoleRun } from '../lib/shared';
import type { BrainPageRow } from '../../../shared/contracts/brain';

export interface MaterialSubmission { id: string; name: string; sourceId: string; runId?: string; error?: string }
export interface PendingMaterialRow { id: string; name: string; sourceId: string; type: string | null; existing?: BrainPageRow; run?: ConsoleRun; error?: string }

export function pendingMaterialRows(runs: ConsoleRun[], submissions: MaterialSubmission[], rows: BrainPageRow[], filters: { source: string; type: string; view: string; embedded: string; q: string }): PendingMaterialRow[] {
  if (!['all', 'materials'].includes(filters.view) || filters.embedded !== 'all') return [];
  const pending: PendingMaterialRow[] = runs.filter(run => run.kind === 'import_path' && run.product?.material).map(run => {
    const material = run.product!.material!;
    const existing = material.page ? rows.find(row => row.source_id === material.sourceId && row.slug === material.page!.slug) : undefined;
    return { id: run.id, name: material.directory ? material.name : material.page?.title || material.name, sourceId: material.sourceId, type: material.directory ? 'directory' : material.page?.type ?? null, existing, run, error: run.product?.errorReason ?? undefined };
  });
  for (const submission of submissions) {
    if (submission.runId && runs.some(run => run.id === submission.runId)) continue;
    pending.push({ ...submission, type: null });
  }
  return pending.filter(row => (filters.source === 'all' || row.sourceId === filters.source)
    && (filters.type === 'all' || row.type === filters.type)
    && (!filters.q.trim() || row.name.toLocaleLowerCase().includes(filters.q.trim().toLocaleLowerCase()) || row.existing?.slug.includes(filters.q.trim())));
}
