import type { Migration } from './types.ts';
import { failClosedLedgerGuards } from '../guard-ledger-checks.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-574 A1: conversation extraction now keeps a name key (a bare slug such as alice-example, no page) on a fact
// whose person or company has no page (facts.unbacked_entity_keys). The three facts guards treat a row on such a key
// (no directory, no live page at that slug in its source) as subject '*': a withdrawal or purge tombstone of its claim
// under any subject but an owned memory page expires or refuses it, so a claim forgotten under a page that is later
// deleted, or forgotten under the key before a page was written, never comes back under the key. Rows with a page or no
// entity match as before. Replaces only the functions: their triggers already call them, and re-creating a trigger would
// take an ACCESS EXCLUSIVE lock on facts. Like v318, a guard another role owns is left and named on stderr, never an
// abort; every later migration run re-creates it once a role that owns it runs (failClosedLedgerGuards reads each
// guard's marker). No row is read or written.
export const v321: Migration = {
  version: 321,
  name: 'unbacked_entity_keys_guards',
  idempotent: true,
  sql: '',
  handler: async engine => {
    const { left, role } = await failClosedLedgerGuards(engine);
    if (left.length === 0) return;
    process.stderr.write(`  guards: ${left.length} purge or withdrawal guard(s) keep their body from before name keys (${left.join(', ')}): `
      + `CREATE OR REPLACE FUNCTION needs the owner. As that role run ALTER FUNCTION public.<name>() OWNER TO ${role}, or connect gbrain as it; the next migration run re-creates them (docs/ENGINES.md#purge-and-withdrawal-guards).\n`);
  },
};
