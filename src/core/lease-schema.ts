/** Unique acquisition identity survives PID reuse and timestamp truncation. */
export const LEASE_TOKEN_SCHEMA_SQL = `
ALTER TABLE gbrain_cycle_locks
  ADD COLUMN IF NOT EXISTS acquisition_token UUID NOT NULL DEFAULT gen_random_uuid();
`;
