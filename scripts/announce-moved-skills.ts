#!/usr/bin/env bun
/**
 * Announce the moved skills, once skills/moved-skills.json names a destination: writes, from the registry,
 *
 *   deprecations.d/skill_moved_<skill>.md       one record per moved skill (surface: bundled-skill)
 *   behavior-changes.d/skills_moved_<date>.md   the upgrade-notice row naming them all (kind: action)
 *   changelog.d/skills-moved-<date>.md          the release-notes announcement, with that row's marker
 *
 *   bun scripts/announce-moved-skills.ts --remove-after <YYYY-MM-DD> --owner <who removes them>
 *
 * <date> is remove_after without dashes. Refuses while the destination is null, when remove_after is less than 14
 * days away (docs/STABILITY.md: removal no sooner than 14 days and two stable releases after the announcement; the
 * two-releases part is checked in review), and when any file it would write already exists. Writes nothing on a
 * refusal. Exit: 0 written, 1 refused, 2 usage.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseMovedRegistry, type MovedRegistry } from '../src/core/skillpack/moved.ts';

const NOTICE_DAYS = 14;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const recordId = (skill: string) => `skill_moved_${skill.replaceAll('-', '_')}`;
const installFor = (registry: MovedRegistry, skill: string) => registry.destination!.install.split('{skill}').join(skill);
const code = (s: string) => '`' + s + '`';

/** The files the announcement writes, path to text. */
export function announcementFiles(registry: MovedRegistry, removeAfter: string, owner: string): Record<string, string> {
  const d = registry.destination;
  if (!d) throw new Error('the destination is null');
  const stamp = removeAfter.replaceAll('-', '');
  const rowId = `skills_moved_${stamp}`;
  const files: Record<string, string> = {};
  for (const skill of registry.moved) {
    files[`deprecations.d/${recordId(skill)}.md`] = [
      '---',
      'surface: bundled-skill',
      `name: ${skill}`,
      `replacement: ${installFor(registry, skill)}`,
      `owner: ${owner}`,
      `remove_after: ${removeAfter}`,
      '---',
      `The ${skill} skill moved to ${d.name} (${d.url}). Install it from there with ${code(installFor(registry, skill))}. `
        + `Until ${removeAfter}, gbrain keeps its own copy: gbrain skillpack scaffold, gbrain skillpack reference and `
        + 'gbrain bundled-skill still work for it and print where it went. After that date a later release removes the copy; '
        + 'a copy you already scaffolded stays in your skills folder, and gbrain skillpack reference --update-untouched no longer updates it.',
      '',
    ].join('\n');
  }
  files[`behavior-changes.d/${rowId}.md`] = [
    '---',
    'kind: action',
    '---',
    `${registry.moved.length} bundled skills moved to ${d.name} (${d.url}): ${registry.moved.join(', ')}. `
      + 'gbrain still includes them for now, and skillpack scaffold, skillpack reference, skillpack status and bundled-skill say where each went. '
      + `A release on or after ${removeAfter} removes them from gbrain. If you use one, install it from ${d.name} with: ${installFor(registry, '<skill>')}. `
      + 'check-resolvable and doctor accept a resolver row for a moved skill that another skill catalog or a configured skill folder provides.',
    '',
  ].join('\n');
  files[`changelog.d/skills-moved-${stamp}.md`] = [
    `**${registry.moved.length} bundled skills moved to ${d.name}; gbrain keeps its copies until at least ${removeAfter}.**`,
    '',
    '### Changed',
    `- These skills now live in ${d.name} (${d.url}): ${registry.moved.map(code).join(', ')}. `
      + 'gbrain still includes its copies, and gbrain skillpack scaffold, reference, status, pin and unpin and gbrain bundled-skill print where each one went. '
      + `Install a moved skill from its new home with ${code(installFor(registry, '<skill>'))}. A release on or after ${removeAfter} removes gbrain's copies (deprecations.d/skill_moved_*.md).`,
    '',
    `<!-- behavior-change: ${rowId} -->`,
    '',
  ].join('\n');
  return files;
}

export function main(argv: string[], opts: { cwd?: string; today?: string; log?: (line: string) => void } = {}): number {
  const root = opts.cwd ?? join(import.meta.dir, '..');
  const log = opts.log ?? ((line: string) => console.log(line));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };
  const removeAfter = value('--remove-after');
  const owner = value('--owner');
  if (!removeAfter || !DATE.test(removeAfter) || !owner || owner.startsWith('--')) {
    log('Usage: bun scripts/announce-moved-skills.ts --remove-after <YYYY-MM-DD> --owner <who removes them>');
    return 2;
  }
  let registry: MovedRegistry;
  try {
    registry = parseMovedRegistry(JSON.parse(readFileSync(join(root, 'skills', 'moved-skills.json'), 'utf8')));
  } catch (e) {
    log(`REFUSED: skills/moved-skills.json: ${(e as Error).message}`);
    return 1;
  }
  if (!registry.destination) {
    log('REFUSED: skills/moved-skills.json names no destination yet; fill in destination (name, install, url) first.');
    return 1;
  }
  if (!registry.moved.length) {
    log('REFUSED: skills/moved-skills.json moves no skills.');
    return 1;
  }
  if (removeAfter < addDays(today, NOTICE_DAYS)) {
    log(`REFUSED: --remove-after ${removeAfter} is less than ${NOTICE_DAYS} days away; use ${addDays(today, NOTICE_DAYS)} or later (and at least two stable releases after the one that carries this announcement).`);
    return 1;
  }
  const files = announcementFiles(registry, removeAfter, owner);
  const existing = Object.keys(files).filter(p => existsSync(join(root, p)));
  if (existing.length) {
    log(`REFUSED: these already exist, so the skills were announced before: ${existing.join(', ')}`);
    return 1;
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  log(`Wrote ${Object.keys(files).length} files: ${registry.moved.length} deprecation records, one upgrade-notice row and the changelog announcement.`);
  log('Next: bun run regen:all, then review the text and ship it in a stable release.');
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
