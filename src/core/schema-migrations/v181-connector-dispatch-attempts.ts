import type { Migration } from './types.ts';
import { seedConnectorDispatchAttempts } from '../persistence/connector-state.ts';

export const v181: Migration = {
  // Fix wave 4 (DX O1): autopilot now dispatches a Google or GitHub source
  // only after its first recorded sync attempt (connector state row field
  // first_attempt_at). Record one for every connector source the pre-upgrade
  // freshness loop dispatched (non-null local_path, not syncEnabled=false), so
  // no source autopilot syncs today goes idle. Handler-only, rerun-safe: an
  // existing attempt is never rewritten.
  version: 181,
  name: 'connector_dispatch_attempts',
  idempotent: true,
  sql: '',
  handler: async engine => { await seedConnectorDispatchAttempts(engine); },
};
