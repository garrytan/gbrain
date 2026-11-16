#!/usr/bin/env bun
/**
 * Regenerates skills/skills.lock.json — the tamper-evidence manifest mapping
 * every bundled file under skills/ to its sha256 (#159). Not a signature
 * system: it turns silent skill edits into explicit diffs. `gbrain doctor`
 * warns (never fails) on drift; scripts/check-skills-manifest-fresh.sh keeps
 * the committed manifest in sync in CI.
 *
 * It first appends the current hashes to skills/skills.lock.history.json (the
 * append-only record of every released version of each bundled file, read by
 * `gbrain skillpack reference --update-untouched`), then writes the lock, so
 * the lock records the history's own hash. scripts/check-skills-lock-history.ts
 * fails CI when the history drops an entry.
 *
 * Run after any change under skills/:
 *   bun run scripts/generate-skills-manifest.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILLS_LOCK_HISTORY_FILENAME,
  SKILLS_MANIFEST_FILENAME,
  computeSkillsManifest,
  mergeSkillsLockHistory,
  parseSkillsLockHistory,
  renderSkillsLockHistory,
  renderSkillsManifest,
} from '../src/core/skills-integrity.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(repoRoot, 'skills');
const historyPath = join(skillsDir, SKILLS_LOCK_HISTORY_FILENAME);
const previous = existsSync(historyPath) ? parseSkillsLockHistory(readFileSync(historyPath, 'utf-8')) : null;
writeFileSync(historyPath, renderSkillsLockHistory(mergeSkillsLockHistory(previous, computeSkillsManifest(skillsDir))));
const outPath = join(skillsDir, SKILLS_MANIFEST_FILENAME);
writeFileSync(outPath, renderSkillsManifest(skillsDir));
console.log(`Wrote ${historyPath}\nWrote ${outPath}`);
