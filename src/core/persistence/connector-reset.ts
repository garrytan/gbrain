import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';

/** `gbrain sync --reset-checkpoint` names exactly one connector source. */
export async function assertResetCheckpointSource(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string | undefined): Promise<void> {
  const [source] = sourceId ? await engine.executeRaw<{ kind: string | null }>("SELECT config->>'kind' AS kind FROM sources WHERE id=$1 AND NOT archived", [sourceId]) : [];
  if (source?.kind === 'google' || source?.kind === 'github') return;
  throw new OperationError('invalid_params', `--reset-checkpoint applies only to a Google or GitHub connector source${sourceId ? `; ${sourceId} is not one` : ''}.`,
    sourceId ? `Git-backed sources re-import with: gbrain sync --source ${sourceId} --full` : 'Name the connector source: gbrain sync --source <id> --reset-checkpoint');
}
