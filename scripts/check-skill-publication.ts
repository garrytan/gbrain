#!/usr/bin/env bun
/**
 * A-NEW-3 (#5476): every bundled SKILL.md (skills/, plugin/skills/ and each
 * plugin-variants/<v>/skills/) must pass the shared-skill publication parser
 * (`normalizeSkillFiles` + `skillMetadata`), the same check `put_skill` and
 * the 0.53 adoption run. A bundled skill that fails it (the capture skill's
 * list-valued `writes_pages:` did) blocks every brain that adopts the pack.
 *
 * GBRAIN_GUARD_ROOT points the scan at a fixture tree (guard self-test).
 * Exit 0 clean, 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ? resolve(process.env.GBRAIN_GUARD_ROOT) : resolve(import.meta.dir, '..');
const variants = existsSync(join(ROOT, 'plugin-variants')) ? readdirSync(join(ROOT, 'plugin-variants')).map(v => join('plugin-variants', v, 'skills')) : [];
const lanes = ['skills', join('plugin', 'skills'), ...variants].map(dir => join(ROOT, dir)).filter(dir => existsSync(dir));

const failures: string[] = [];
let checked = 0;
for (const lane of lanes) {
  for (const entry of readdirSync(lane, { withFileTypes: true })) {
    const path = join(lane, entry.name, 'SKILL.md');
    if (!entry.isDirectory() || !existsSync(path)) continue;
    checked++;
    try {
      const files = normalizeSkillFiles(entry.name, [{ path: `skills/${entry.name}/SKILL.md`, content: readFileSync(path, 'utf8'), file_class: 'prose' }]);
      skillMetadata(entry.name, files, {});
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'error';
      failures.push(`${relative(ROOT, path)}: ${code}: ${(error as Error).message} ${(error as { suggestion?: string }).suggestion ?? ''}`.trim());
    }
  }
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} bundled SKILL.md file(s) fail the shared-skill publication parser:`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('Why:  put_skill and the 0.53 shared-skills adoption refuse these files, so a brain adopting the bundled pack is blocked.');
  console.error('Fix:  correct the frontmatter (markers like writes_pages take true/false; list directories under writes_to), then regenerate plugin trees.');
  process.exit(1);
}
console.log(`OK: ${checked} bundled SKILL.md file(s) pass the shared-skill publication parser.`);
