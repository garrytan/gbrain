import type { Migration } from './types.ts';
import { WRITE_GATE_DETECTOR_VERSION, WRITE_GATE_SCAN_BASELINE_KEY, WRITE_GATE_SCHEMA_SQL } from '../write-gate-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5575 blocking write gate: verdict receipts and the holding table for
// quarantined facts and takes (src/core/write-gate-store.ts). New empty
// tables, so their indexes build inline on both engines. The gate goes live
// here under the binary's detector version: rows written from now on are assessed by their
// writers, so the legacy scan (eligibility/scan.ts) is bounded by each
// table's max id at this point (`write_gate.scan_baseline`; zero on an empty
// brain, which therefore has nothing to scan). Graduation carries config and
// row ids, so a copy keeps the baseline valid.
export const v227: Migration = {
  version: 227,
  name: 'write_gate',
  idempotent: true,
  sql: `${WRITE_GATE_SCHEMA_SQL}
INSERT INTO config (key, value)
  SELECT '${WRITE_GATE_SCAN_BASELINE_KEY}', jsonb_build_object('detector_version', ${WRITE_GATE_DETECTOR_VERSION}, 'until', jsonb_build_object(
    'pages', COALESCE((SELECT max(id) FROM pages), 0), 'facts', COALESCE((SELECT max(id) FROM facts), 0),
    'takes', COALESCE((SELECT max(id) FROM takes), 0), 'timeline_entries', COALESCE((SELECT max(id) FROM timeline_entries), 0)))::text
ON CONFLICT (key) DO NOTHING;
`,
};
