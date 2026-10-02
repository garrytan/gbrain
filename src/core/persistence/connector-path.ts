import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { isConnectorSourceKind } from './connector-identity.ts';
import { withCoordinatedWrite } from './context.ts';

/**
 * `gbrain sources set-path <id> --clear` (#5673): clear a connector source's
 * stale `local_path`. Connector kinds sync from their provider, so the path is
 * only a leftover checkout pointer. A filesystem source is refused (its path
 * is its canonical root), and so is a connector with a live persistence
 * binding (its worktree still owns that root). On a managed brain the update
 * is a coordinated write, rechecked under the source row lock.
 */
export async function clearConnectorLocalPath(engine: BrainEngine, sourceId: string): Promise<{ prior: string | null }> {
  return engine.transaction(async tx => {
    const [source] = await tx.executeRaw<{ local_path: string | null; kind: string | null; incarnation: string }>(
      "SELECT local_path, config->>'kind' AS kind, incarnation FROM sources WHERE id=$1 FOR UPDATE", [sourceId]);
    if (!source) throw new OperationError('not_found', `Source "${sourceId}" not found.`, "Run 'gbrain sources list' to see registered sources.");
    if (!isConnectorSourceKind(source.kind)) {
      throw new OperationError('invalid_params', `--clear applies only to connector sources (google, github); "${sourceId}" is a filesystem source whose path is its canonical checkout.`,
        `Point it at its checkout with gbrain sources set-path ${sourceId} <path>, or remove it with gbrain sources remove ${sourceId}.`);
    }
    const bound = await tx.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1 AND source_incarnation=$2::uuid',
      [sourceId, source.incarnation]);
    if (bound.length) {
      throw new OperationError('writer_transfer_required', `Connector source "${sourceId}" has a canonical owner bound to its checkout, so its path cannot be cleared.`,
        `Inspect the binding with gbrain sources writer status ${sourceId}.`);
    }
    if (source.local_path === null) return { prior: null };
    const [brain] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
    const clear = () => tx.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1 AND incarnation=$2::uuid', [sourceId, source.incarnation]);
    if (brain?.enabled) await withCoordinatedWrite(tx, [sourceId], clear);
    else await clear();
    return { prior: source.local_path };
  });
}
