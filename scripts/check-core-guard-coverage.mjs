#!/usr/bin/env node
/**
 * Core memory write-path guard coverage (docs/guides/core-memory.md).
 *
 * Always-loaded core pages are guarded in preparePageMutation
 * (src/core/persistence/page-prepare.ts -> core-guard.ts): owner-only
 * marking, the brain-wide budget, the remote-edit policy, and the ordered
 * source lock the coordinator takes from `exclusiveSources`. This check
 * fails when:
 *   1. a module that builds a PreparedMutation neither routes through
 *      preparePageMutation / prepareMemoryMutation nor sits on the reviewed
 *      exemption list below (with its reason), or
 *   2. a module wraps preparePageMutation but drops `exclusiveSources`
 *      (neither spreads the prepared result nor forwards the field), which
 *      would publish a core write without the ordered source lock.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Fixture root for scripts/guard-self-test.sh: argv[2] or GBRAIN_GUARD_ROOT.
const ROOT = process.argv[2] ?? process.env.GBRAIN_GUARD_ROOT ?? new URL('..', import.meta.url).pathname;

/** Reviewed: preparers that publish without the core guard, and why that is safe. */
const EXEMPT = {
  'src/core/persistence/sync-prepare.ts': 'owner git edits (managed sync) pass by design; doctor core_memory reports any overage',
  'src/core/persistence/group-publish.ts': 'bulk managed sync of owner git edits; groupable() excludes core-locked members',
  'src/core/persistence/reconcile-prepare.ts': 'reconciles the owner checkout into the database (owner edit)',
  'src/core/persistence/file-repair.ts': 'publishes bytes the owner approved with gbrain repair frontmatter --apply',
  'src/core/persistence/grandfather.ts': 'adopts pages that already exist at activation; no content change',
  'src/core/persistence/import-prepare.ts': 'owner-run local import (gbrain import); doctor reports any overage',
  'src/core/persistence/connector-sync.ts': 'connector-owned pages; core marking is owner-written frontmatter the connector never sets',
  'src/core/persistence/connector-google-receipts.ts': 'connector receipt rows, not page text',
  'src/core/persistence/projection-reindex.ts': 'rebuilds derived projections; page text is unchanged',
  'src/core/persistence/noop-kernel.ts': 'decides that nothing would change; publishes nothing',
  'src/core/persistence/consumer.ts': 'dispatches to preparers; no page content of its own',
  'src/core/persistence/coordinator.ts': 'takes the ordered source lock from exclusiveSources; prepares nothing itself',
  'src/core/persistence/effect-journal.ts': 'post-publication effects; no page text',
  'src/core/repair/captured-facts.ts': 'owner-run repair that expires fact rows (shrinks only)',
  'src/core/repair/extractor-facts.ts': 'owner-run repair restoring expired fact rows',
  'src/core/shared-skills/publication.ts': 'skill bundles, not pages',
  'src/core/persistence/prepared-import.ts': 'type definitions shared by import preparers; prepares nothing itself',
  'src/commands/extract-timeline-db.ts': 'writes timeline rows; timeline never enters core',
};

const GUARDED = /\b(preparePageMutation|prepareMemoryMutation|prepareCoreGuard)\b/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.includes('.generated.')) out.push(path);
  }
  return out;
}

const problems = [];
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  if (!/\bPreparedMutation\b/.test(text)) continue;
  if (rel === 'src/core/persistence/page-prepare.ts' || rel === 'src/core/persistence/core-guard.ts') continue;
  if (!GUARDED.test(text)) {
    if (!EXEMPT[rel]) problems.push(`${rel}: builds a PreparedMutation without the core guard. Route page writes through preparePageMutation, or add it to EXEMPT in scripts/check-core-guard-coverage.mjs with the reason core pages are safe.`);
    continue;
  }
  const names = [...text.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?[^;\n]*?\b(?:preparePageMutation|prepareMemoryMutation)\s*\(/g)].map(m => m[1]);
  const reassigned = [...text.matchAll(/\b(\w+)\s*=\s*await\s+[^;\n]*?\b(?:preparePageMutation|prepareMemoryMutation)\s*\(/g)].map(m => m[1]);
  const vars = [...new Set([...names, ...reassigned])];
  const returnsDirect = /return\s+(?:await\s+)?(?:preparePageMutation|prepareMemoryMutation)\s*\(/.test(text);
  const spread = new Set([...text.matchAll(/\.\.\.(\w+)\b/g)].map(m => m[1]));
  const forwards = text.includes('exclusiveSources') || vars.some(v => spread.has(v));
  if (!returnsDirect && !forwards) problems.push(`${rel}: wraps preparePageMutation but drops exclusiveSources, so a core write would publish without the ordered source lock. Spread the prepared result or forward exclusiveSources.`);
}

if (problems.length) {
  console.error('check-core-guard-coverage: FAIL');
  for (const p of problems) console.error(`  ${p}`);
  console.error('See docs/guides/core-memory.md (write-path guard) and src/core/persistence/core-guard.ts.');
  process.exit(1);
}
console.log('check-core-guard-coverage: OK');
