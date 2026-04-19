#!/usr/bin/env bun
/**
 * eval:query:validate — validate a query file (or the built-in Tier 5/5.5 set).
 *
 * Usage:
 *   bun run eval:query:validate                  # validate all built-in T5+T5.5
 *   bun run eval:query:validate path/to/file.ts  # validate a file that exports Query[]
 *   bun run eval:query:validate --help
 *
 * Exit code 0 if all queries pass, 1 otherwise. Suitable for CI.
 */

import { readFileSync } from 'fs';
import { validateAll, validateQuerySet, formatIssues } from '../runner/queries/index.ts';
import type { Query } from '../runner/types.ts';

function printHelp() {
  console.log(`eval:query:validate — validate a Query set

USAGE
  bun run eval:query:validate                 validate all built-in T5 + T5.5 queries
  bun run eval:query:validate <path>          validate a JSON file containing Query[]

VALIDATOR CHECKS
  - id, text, tier, expected_output_type present
  - Temporal verbs (is/was/were/current/now/at the time/during/as of/when did)
    require as_of_date ("corpus-end" | "per-source" | ISO-8601)
  - cited-source-pages requires non-empty gold.relevant with valid slug format
  - abstention requires gold.expected_abstention === true
  - externally-authored (Tier 5.5) requires author field
  - Duplicate IDs caught at batch level

EXIT CODES
  0  all queries valid
  1  one or more queries failed validation
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const filePath = args[0];

  if (!filePath) {
    // Validate built-in T5 + T5.5 sets
    const result = validateAll();
    console.log(result.report);
    process.exit(result.ok ? 0 : 1);
  }

  // Validate a file — supports JSON with { queries: Query[] } or Query[]
  let queries: Query[] = [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    queries = Array.isArray(parsed) ? parsed : (parsed.queries ?? []);
  } catch (e) {
    console.error(`Error reading ${filePath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (queries.length === 0) {
    console.error(`No queries found in ${filePath}. Expected JSON Query[] or { queries: Query[] }.`);
    process.exit(1);
  }

  const result = validateQuerySet(queries);
  console.log(formatIssues(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
