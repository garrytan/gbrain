#!/usr/bin/env bun
/**
 * CI guard for skills/skills.lock.history.json, the append-only record of
 * every released sha256 of each bundled skill file that
 * `gbrain skillpack reference --update-untouched` reads.
 *
 * Fails when:
 *   1. the history does not parse, or misses a hash the current lock lists
 *      (run `bun run scripts/generate-skills-manifest.ts`);
 *   2. the history dropped a (path, hash) the previous committed copy had.
 *      "Previous" is HEAD's copy and the merge-base with the default branch
 *      (`GBRAIN_SKILLS_HISTORY_BASE` overrides the base ref); a ref that has no
 *      copy, or no git at all, skips that comparison.
 *
 * The lock's own hash of the history is checked by check-skills-manifest-fresh.sh.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SKILLS_LOCK_HISTORY_FILENAME,
  computeSkillsManifest,
  droppedHistoryEntries,
  mergeSkillsLockHistory,
  parseSkillsLockHistory,
  type SkillsLockHistory,
} from '../src/core/skills-integrity.ts';

const root = process.env.GBRAIN_GUARD_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = `skills/${SKILLS_LOCK_HISTORY_FILENAME}`;
const path = join(root, rel);
const fail = (lines: string[]): never => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

if (!existsSync(path)) fail([`ERROR: ${rel} not found.`, 'Run: bun run scripts/generate-skills-manifest.ts']);
let current: SkillsLockHistory;
try {
  current = parseSkillsLockHistory(readFileSync(path, 'utf-8'));
} catch (err) {
  fail([`ERROR: ${(err as Error).message}`]);
}
const missing = droppedHistoryEntries(mergeSkillsLockHistory(null, computeSkillsManifest(join(root, 'skills'))), current!);
if (missing.length) {
  fail([`ERROR: ${rel} is missing ${missing.length} hash(es) the current skills.lock.json lists:`, ...missing.slice(0, 20).map(m => `  ${m}`),
    'Run: bun run scripts/generate-skills-manifest.ts']);
}

const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
const refs = new Set<string>(['HEAD']);
const base = process.env.GBRAIN_SKILLS_HISTORY_BASE
  ?? ['origin/master', 'origin/main'].map(ref => git(['merge-base', 'HEAD', ref])).find(r => r.status === 0)?.stdout.trim();
if (base) refs.add(base);
for (const ref of refs) {
  const shown = git(['show', `${ref}:${rel}`]);
  if (shown.status !== 0) continue;
  let previous: SkillsLockHistory;
  try {
    previous = parseSkillsLockHistory(shown.stdout);
  } catch {
    continue;
  }
  const dropped = droppedHistoryEntries(previous, current!);
  if (dropped.length) {
    fail([`ERROR: ${rel} dropped ${dropped.length} entr${dropped.length === 1 ? 'y' : 'ies'} that ${ref} has (the file is append-only):`,
      ...dropped.slice(0, 20).map(d => `  ${d}`), `Re-add them from git show ${ref}:${rel}, then run bun run scripts/generate-skills-manifest.ts.`]);
  }
}
console.log(`✓ ${rel} covers the lock and keeps every committed entry`);
