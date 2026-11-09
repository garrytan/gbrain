#!/usr/bin/env node
/**
 * Wave C 1H (large-pages spec §17 ceo-r3-native-2): a new literal list of write-request states fails verify.
 *
 * `persistence_requests.state` gained `indexing` (committed in Git, not yet indexed). A hand-written list of states, in
 * TypeScript or SQL, silently decides for every new state whether it sequences the source, counts as pending or is final;
 * src/core/persistence/request-states.ts is the one place that says it (PENDING_STATES_SQL, PUBLISHED_STATES_SQL,
 * TERMINAL_STATES_SQL, isPublishedRequestState, isTerminalReceiptState). The lists written before it are baselined per
 * file in scripts/request-state-lists-baseline.json; a file whose count grows, or a new file with one, fails. Lower
 * counts are fine; run with --update to rewrite the baseline after removing lists.
 *
 * A "list" is two or more of the request states quoted next to each other (`'queued','running'`, `['committed', 'failed'`),
 * which is how every such list is spelled. Effect and staging state lists share some names, so they are counted too: the
 * baseline absorbs the existing ones, and a new effect list belongs next to its own model.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv.find((arg, i) => i > 1 && !arg.startsWith('--')) ?? process.cwd();
const baselinePath = join(root, 'scripts', 'request-state-lists-baseline.json');
const ALLOWED = new Set(['src/core/persistence/request-states.ts']);
const STATE = "(?:queued|deferred|running|recovering|indexing|committed|conflict|failed|cancelled)";
const LIST = new RegExp(`'${STATE}'\\s*,\\s*'${STATE}'`, 'g');

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.generated.ts')) out.push(path);
  }
  return out;
}

const counts = {};
for (const path of walk(join(root, 'src'), [])) {
  const rel = relative(root, path).split('\\').join('/');
  if (ALLOWED.has(rel)) continue;
  const text = readFileSync(path, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    LIST.lastIndex = 0;
    if (LIST.test(line)) n++;
  }
  if (n) counts[rel] = n;
}

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n');
  console.log(`check-request-state-lists: baseline written (${Object.keys(counts).length} files)`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const grown = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0));
if (grown.length) {
  for (const [file, n] of grown) console.error(`${file}: ${n} lines with a literal request-state list (baseline ${baseline[file] ?? 0}). Use the classes in src/core/persistence/request-states.ts instead.`);
  process.exit(1);
}
console.log(`check-request-state-lists: ok (${Object.keys(counts).length} files at or under their baseline)`);
