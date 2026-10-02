// Guard self-test fixture (known-BAD, refactor wave 1 module dir): a split
// migration reintroducing max_stalled DEFAULT 1 (#219).
export const sql = `ALTER TABLE minion_jobs ADD COLUMN max_stalled INTEGER NOT NULL DEFAULT 1`;
