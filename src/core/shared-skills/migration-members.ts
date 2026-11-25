import type { BrainEngine } from '../engine.ts';

export interface SharedMemberMigration {
  installation_id: string;
  adapter: string;
  enrollment_epoch: number;
  state: 'left' | 'source_changed' | 'refresh_pending' | 'delivery_reported' | 'joined';
  native_activation: 'unverified';
  next_action: string;
}

export async function inspectSharedMemberMigration(engine: BrainEngine, sourceId: string, incarnation: string): Promise<SharedMemberMigration[]> {
  const rows = await engine.listSharedMemberMigrationRows(sourceId);
  return rows.map(row => {
    const state: SharedMemberMigration['state'] = !row.active ? 'left' : row.approved_incarnation !== incarnation ? 'source_changed'
      : row.desired_view !== row.acknowledged_view ? 'refresh_pending' : row.stage === 'installed' ? 'delivery_reported' : 'joined';
    const actions: Record<SharedMemberMigration['state'], string> = {
      left: 'Following is stopped. Check for retained edited native files using this installation’s local status.',
      source_changed: 'Reconnect with explicit approval for the current source incarnation; old enrollment does not transfer.',
      refresh_pending: 'Reconnect or refresh this installation. An issued catalog is not an installed revision.',
      delivery_reported: 'The client reports installed files; verify current authorization and actual skill use in a new native conversation.',
      joined: 'Complete managed delivery or the client-specific enablement step, then test a new native conversation.',
    };
    return { installation_id: row.installation_id, adapter: row.adapter, enrollment_epoch: Number(row.epoch), state,
      native_activation: 'unverified' as const, next_action: actions[state] };
  });
}
