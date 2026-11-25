/**
 * topology_recovery_stopped: a source lifecycle change (clone, reclone, retire) that is recovering on this host. Every
 * engine that holds a managed worktree, the Rust engine included, converges such a change in the owner's recovery scan
 * (persistence/topology-recovery.ts) through the typed topology store, so the check reports the count and passes; it
 * keeps its name and `stop: null` detail so reports that read it keep their shape. Read-only, through the typed
 * listTopologyRecoveries: it never locks or changes a row.
 */
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { existingHostIdFor } from '../../../core/persistence/identity.ts';
import { readTopologyRecoveryStops } from '../../../core/persistence/topology-stop.ts';
import { managesWorktrees } from '../../../core/rust-engine/errors.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';

const NAME = 'topology_recovery_stopped';
const DOCS = 'docs/ENGINES.md#topology-recovery-on-the-rust-engine';

async function runTopologyRecoveryStopped(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const status: Check['status'] = 'ok';
  let message: string;
  let details: Record<string, unknown> = { count: 0, docs: DOCS };
  try {
    const engine = connectedEngine(ctx);
    if (!managesWorktrees(engine)) {
      message = 'This engine holds no managed worktree, so no topology change can be recovering.';
    } else {
      const { recovering, more, stop } = await readTopologyRecoveryStops(engine, existingHostIdFor(engine));
      const count = `${recovering.length}${more ? '+' : ''}`;
      details = { count: recovering.length, more, stop, recovering, docs: DOCS };
      message = recovering.length ? `${count} topology change(s) are recovering on this host; the owner converges them (supported on every engine, the Rust engine included).` : 'No topology change is recovering on this host.';
    }
  } catch (error) {
    if (!isMissingSchemaObject(error, 'table', ['persistence_topology_changes', 'persistence_worktrees'])) {
      return [checkError(NAME, 'list recovering topology changes', error)];
    }
    message = 'This brain keeps no managed write journal.';
  }
  checks.push({ name: 'topology_recovery_stopped', status, message, details });
  return checks;
}

export const topologyRecoveryStoppedEntry: DoctorEntry = { name: 'topology_recovery_stopped', emits: ['topology_recovery_stopped'], tier: 'ops', run: runTopologyRecoveryStopped };
