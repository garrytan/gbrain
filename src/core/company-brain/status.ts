import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { readSourceIngestionState, type SourceIngestionCounts, type SourceIngestionPhase } from './receipts.ts';

export interface CompanyBrainSourceStatus {
  state: 'incomplete' | 'complete' | 'discarded' | 'missing' | 'unavailable';
  receipt_id?: string;
  phase?: SourceIngestionPhase;
  approved_revision?: string;
  counts?: SourceIngestionCounts;
  diagnostic?: string | null;
  updated_at?: string;
}

export async function readCompanyBrainSourceStatus(engine: BrainEngine, sourceId: string): Promise<CompanyBrainSourceStatus | null> {
  const [source] = await engine.executeRaw<{ incarnation: string; config: unknown }>('SELECT incarnation,config FROM sources WHERE id=$1', [sourceId]);
  if (!source) return null;
  const config = parseSourceConfig(source.config);
  if (!Object.hasOwn(config, 'company_brain')) return null;
  const policy = config.company_brain;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return { state: 'unavailable' };
  const receiptId = (policy as Record<string, unknown>).receiptId;
  if (typeof receiptId !== 'string') return { state: 'missing' };
  try {
    const status = await readSourceIngestionState(engine, { sourceId, sourceIncarnation: source.incarnation, receiptId });
    if (!status.receipt) return { state: 'missing' };
    const receipt = status.receipt;
    return { state: receipt.outcome, receipt_id: receipt.id, phase: receipt.phase,
      approved_revision: receipt.approvedRevision, counts: receipt.counts,
      diagnostic: receipt.diagnostic, updated_at: receipt.updatedAt };
  } catch {
    return { state: 'unavailable' };
  }
}
