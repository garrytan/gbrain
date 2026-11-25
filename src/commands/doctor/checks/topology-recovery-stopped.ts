/**
 * topology_recovery_stopped: a source lifecycle change (clone, reclone, retire) that is recovering on this host while
 * the brain's engine refuses the recovery by name (persistence/topology-stop.ts: the Rust engine, which serves no raw
 * SQL for the topology locks). Such a change never converges on that engine; the owner parks its scan and reports the
 * stop once. Read-only, through the typed listTopologyRecoveries: it never locks or changes a row. With raw SQL
 * (PGLite, Postgres) the owner converges each change itself and the check passes.
 */
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { existingHostIdFor } from '../../../core/persistence/identity.ts';
import { readTopologyRecoveryStops, TOPOLOGY_STOPS } from '../../../core/persistence/topology-stop.ts';
import { managesWorktrees } from '../../../core/rust-engine/errors.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';

const NAME = 'topology_recovery_stopped';
const DOCS = 'docs/ENGINES.md#topology-recovery-on-the-rust-engine';

async function runTopologyRecoveryStopped(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  let status: Check['status'] = 'ok';
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
      if (!stop) {
        message = recovering.length ? `${count} topology change(s) are recovering on this host; the owner converges them.` : 'No topology change is recovering on this host.';
      } else {
        const listed = recovering.slice(0, 5).map(row => `${row.operation} of source ${row.source_id} (change ${row.change_id})`).join('; ');
        status = 'warn';
        message = `${count} topology change(s) are recovering on this host and cannot converge on this engine: ${listed}${recovering.length > 5 ? '; and more' : ''}. `
          + `The Rust engine stops ${stop} by name (${TOPOLOGY_STOPS[stop]}); the change is kept exactly as recorded and nothing was moved or deleted. `
          + `Finish it from a pglite or postgres engine on this brain, or wait for a gbrain release whose Rust engine serves it (${DOCS}).`;
      }
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
