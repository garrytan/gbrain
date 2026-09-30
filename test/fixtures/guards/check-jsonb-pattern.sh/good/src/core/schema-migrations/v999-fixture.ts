// Guard self-test fixture (known-GOOD): a split migration keeping the
// SIGKILL-rescue default.
export const sql = `ALTER TABLE minion_jobs ADD COLUMN max_stalled INTEGER NOT NULL DEFAULT 5`;
