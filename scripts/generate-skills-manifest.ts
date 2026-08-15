#!/usr/bin/env bun
/**
 * Regenerates skills/skills.lock.json — the tamper-evidence manifest mapping
 * every bundled file under skills/ to its sha256 (#159). Not a signature
 * system: it turns silent skill edits into explicit diffs. `gbrain doctor`
 * warns (never fails) on drift; scripts/check-skills-manifest-fresh.sh keeps
 * the committed manifest in sync in CI.
 *
 * Run after any change under skills/:
 *   bun run scripts/generate-skills-manifest.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILLS_MANIFEST_FILENAME,
  renderSkillsManifest,
} from '../src/core/skills-integrity.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(repoRoot, 'skills');
const outPath = join(skillsDir, SKILLS_MANIFEST_FILENAME);
writeFileSync(outPath, renderSkillsManifest(skillsDir));
console.log(`Wrote ${outPath}`);
