import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Take-proposal review over MCP (takes_proposal_accept / takes_proposal_reject): the decision records the surface it
// came through (`acted_via`: cli, mcp:<client>, slack:<sink>) next to who made it (`acted_by`), and a reject keeps the
// reviewer's reason (`decision_reason`). Both nullable, no backfill: rows decided before this read NULL. Mirrored in
// the take_proposals CREATE TABLE in schema.sql so fresh installs get them.
export const v332: Migration = {
  version: 332,
  name: 'take_proposals_review',
  idempotent: true,
  sql: `
ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS acted_via TEXT;
ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS decision_reason TEXT;
`,
};
