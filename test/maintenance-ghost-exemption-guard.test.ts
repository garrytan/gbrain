/**
 * #6696 (A12) guard: maintenance refuses a write before admission when its
 * page's canonical file is gone, except for the kinds whose preparer passes
 * `allowMissingFile` (a missing file publishes for them). The exemption set in
 * prepared-maintenance.ts must equal the set of dispatched kinds whose
 * preparer, or a same-file helper it calls, passes that option; a new kind
 * that tolerates a missing file, or an exemption whose preparer stopped
 * tolerating it, fails here.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISHES_WITHOUT_FILE } from '../src/core/persistence/prepared-maintenance.ts';

const ROOT = join(import.meta.dir, '..');
const DISPATCH_FILE = join(ROOT, 'src/core/persistence/prepared-maintenance.ts');
const ALLOWS_MISSING = /\ballowMissing(?:File)?\s*:\s*true\b/;

function functionBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The preparer body plus the bodies of same-file functions it calls (one level). */
function preparerText(file: string, name: string): string {
  const text = readFileSync(file, 'utf8');
  const body = functionBody(text, name);
  if (body === null) throw new Error(`preparer ${name} not found in ${file}`);
  const helpers = [...new Set([...body.matchAll(/\b(\w+)\(/g)].map(m => m[1]!))].filter(callee => callee !== name)
    .map(callee => functionBody(text, callee) ?? '');
  return [body, ...helpers].join('\n');
}

test('the ghost-refusal exemptions are exactly the maintenance kinds whose preparer passes allowMissingFile', () => {
  // test-reads-source-ok[structural]: the exemption set must match the dispatcher's preparers that pass allowMissingFile; enumerating dispatch branches is the only way to catch a new kind that is missing from it.
  const dispatcher = functionBody(readFileSync(DISPATCH_FILE, 'utf8'), 'prepareMaintenanceKind')!;
  const branch = /row\.intent\?\.kind === '([a-z_]+)'(?:\s*\|\|\s*row\.intent\?\.kind === '([a-z_]+)')?\)\s*(?:\{\s*)?return\s+(?:\(await import\('([^']+)'\)\)\.)?(\w+)\(/g;
  const dispatched = new Map<string, boolean>();
  for (const m of dispatcher.matchAll(branch)) {
    const file = m[3] ? join(ROOT, 'src/core/persistence', m[3]) : DISPATCH_FILE;
    const tolerates = ALLOWS_MISSING.test(preparerText(file, m[4]!));
    for (const kind of [m[1], m[2]].filter((k): k is string => !!k)) dispatched.set(kind, tolerates);
  }
  // Every `kind === '...'` branch is a delegating return, so none escapes the parse; the inline kinds (page, consolidate) never pass the option.
  const every = new Set([...dispatcher.matchAll(/row\.intent\?\.kind === '([a-z_]+)'/g)].map(m => m[1]!));
  const inline = [...every].filter(kind => !dispatched.has(kind)).sort();
  expect(inline).toEqual(['managed_maintenance_page']);
  const inlineText = dispatcher.replace(branch, '');
  expect(ALLOWS_MISSING.test(inlineText)).toBe(false);
  expect(dispatched.size).toBeGreaterThanOrEqual(15);
  const tolerant = [...dispatched].filter(([, tolerates]) => tolerates).map(([kind]) => kind).sort();
  expect([...PUBLISHES_WITHOUT_FILE].sort()).toEqual(tolerant);
});
