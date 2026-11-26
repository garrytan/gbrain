#!/usr/bin/env bun
/**
 * check:moved-skills: once skills/moved-skills.json names a destination, refuses a skill folder under skills/ that
 * neither its kept nor its moved list names, because new content skills go to the destination
 * (docs/guides/skillpacks-as-scaffolding.md#moved-skills). While the destination is null it checks nothing and says
 * so. A registry file that does not validate fails here too.
 *
 *   bun scripts/check-moved-skills.ts
 *
 * Seam: GBRAIN_GUARD_ROOT (tree root). Exit: 0 ok or skipped, 1 refused.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMovedRegistry, unlistedSkillFolders } from '../src/core/skillpack/moved.ts';

export function main(root: string = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..'), log: (line: string) => void = console.log): number {
  let registry;
  try {
    registry = parseMovedRegistry(JSON.parse(readFileSync(join(root, 'skills', 'moved-skills.json'), 'utf8')));
  } catch (e) {
    log(`FAIL: skills/moved-skills.json: ${(e as Error).message}`);
    return 1;
  }
  if (!registry.destination) {
    log('GBRAIN_CHECK_SKIPPED: skills/moved-skills.json names no destination yet');
    return 0;
  }
  const folders = readdirSync(join(root, 'skills'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  const unlisted = unlistedSkillFolders(folders, registry);
  if (!unlisted.length) {
    log(`check-moved-skills: ok (${registry.kept.length} kept, ${registry.moved.length} moved)`);
    return 0;
  }
  for (const f of unlisted) log(`FAIL: skills/${f}/ is a new skill folder; skills/moved-skills.json neither keeps nor moves it`);
  log(`Fix:  add a new content skill to ${registry.destination.name} (${registry.destination.url}) instead; a skill gbrain itself needs goes on the kept list in skills/moved-skills.json`);
  return 1;
}

if (import.meta.main) process.exit(main());
