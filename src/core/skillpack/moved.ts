/**
 * skillpack/moved.ts — the moved-skills registry (skills/moved-skills.json):
 * the bundled skills whose home is moving to another catalog, the skills
 * gbrain keeps, and the destination they move to.
 *
 * The destination is null until it is announced. While it is null nothing
 * says a skill moved: movedSkillNotice() returns null and every surface
 * behaves as before. Filling it in (name, install command, URL) is the one
 * change that turns the notices on; scripts/announce-moved-skills.ts then
 * writes the deprecation records and the announcement.
 *
 * Every surface (skillpack scaffold, reference, status, pin, unpin,
 * --update-untouched, the harness bridges, bundled-skill, check-resolvable
 * and doctor) asks this module; none builds its own text.
 *
 * The file is embedded at build time (a static JSON import), so a compiled
 * binary carries it. parseMovedRegistry() validates it; the tests load the
 * committed file through it, so a bad file fails a test. At run time a file
 * that does not validate counts as "nothing moved", so it never fails a
 * user's command.
 */
import committed from '../../../skills/moved-skills.json';

export interface MovedDestination {
  /** Short name of the catalog the skills move to. */
  name: string;
  /** The command a user runs to get a moved skill; {skill} is replaced with its name. */
  install: string;
  /** https URL of the destination. */
  url: string;
}

export interface MovedRegistry {
  schema_version: 1;
  destination: MovedDestination | null;
  /** Bundled skills that move to the destination. */
  moved: string[];
  /** Skill folders gbrain keeps. */
  kept: string[];
}

/** Folders under skills/ that hold shared files, not a skill. */
export const NON_SKILL_FOLDERS: readonly string[] = ['conventions', 'migrations'];

const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
const EMPTY: MovedRegistry = { schema_version: 1, destination: null, moved: [], kept: [] };

function nameList(v: unknown, key: string, problems: string[]): string[] {
  if (!Array.isArray(v)) {
    problems.push(`${key} must be a list of skill names`);
    return [];
  }
  const bad = v.filter(n => typeof n !== 'string' || !SKILL_NAME.test(n));
  if (bad.length) problems.push(`${key} holds names that are not skill folder names: ${bad.map(n => JSON.stringify(n)).join(', ')}`);
  const names = v.filter((n): n is string => typeof n === 'string' && SKILL_NAME.test(n));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) problems.push(`${key} lists ${[...new Set(dupes)].join(', ')} more than once`);
  return names;
}

function destinationOf(v: unknown, problems: string[]): MovedDestination | null {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    problems.push('destination must be null or an object with name, install and url');
    return null;
  }
  const d = v as Record<string, unknown>;
  const text = (key: string) => {
    const s = d[key];
    if (typeof s === 'string' && s.trim() && !/[\r\n]/.test(s)) return s.trim();
    problems.push(`destination.${key} must be a one-line, non-empty string`);
    return '';
  };
  const out = { name: text('name'), install: text('install'), url: text('url') };
  if (out.url && !/^https:\/\/\S+$/.test(out.url)) problems.push('destination.url must be an https URL');
  const extra = Object.keys(d).filter(k => !['name', 'install', 'url'].includes(k));
  if (extra.length) problems.push(`destination has unknown keys: ${extra.join(', ')}`);
  return out;
}

/** Validate a registry document; throws an Error listing every problem. */
export function parseMovedRegistry(doc: unknown): MovedRegistry {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('moved-skills registry: must be a JSON object');
  const problems: string[] = [];
  const d = doc as Record<string, unknown>;
  if (d.schema_version !== 1) problems.push('schema_version must be 1');
  const unknown = Object.keys(d).filter(k => !['schema_version', 'destination', 'moved', 'kept'].includes(k));
  if (unknown.length) problems.push(`unknown keys: ${unknown.join(', ')}`);
  const destination = destinationOf(d.destination, problems);
  const moved = nameList(d.moved, 'moved', problems);
  const kept = nameList(d.kept, 'kept', problems);
  const both = moved.filter(n => kept.includes(n));
  if (both.length) problems.push(`${both.join(', ')} cannot be both moved and kept`);
  const shared = [...moved, ...kept].filter(n => NON_SKILL_FOLDERS.includes(n));
  if (shared.length) problems.push(`${shared.join(', ')} hold shared files, not a skill`);
  if (problems.length) throw new Error(`moved-skills registry: ${problems.join('; ')}`);
  return { schema_version: 1, destination, moved, kept };
}

/** The committed skills/moved-skills.json, validated (throws on a bad file). */
export function committedMovedRegistry(): MovedRegistry {
  return parseMovedRegistry(committed);
}

let testOverride: MovedRegistry | null = null;

/** Tests only: use this registry instead of the committed one (null restores it). */
export function setMovedRegistryForTests(registry: MovedRegistry | null): void {
  testOverride = registry;
}

/** The registry in effect: the committed file, or nothing moved when it does not validate. */
export function movedRegistry(): MovedRegistry {
  if (testOverride) return testOverride;
  try {
    return committedMovedRegistry();
  } catch {
    return EMPTY;
  }
}

/** True when the registry lists the skill as moving, whether or not the destination is set yet. */
export function isMovedSkill(name: string): boolean {
  return movedRegistry().moved.includes(name);
}

/** The notice for a moved skill, or null when the skill is not moved or the destination is not set. */
export function movedSkillNotice(name: string): string | null {
  const { destination, moved } = movedRegistry();
  if (!destination || !moved.includes(name)) return null;
  const install = destination.install.split('{skill}').join(name);
  return `The ${name} skill moved to ${destination.name} (${destination.url}). Install it from there with: ${install}. `
    + 'gbrain still includes its own copy for now; a later release removes it.';
}

/** The notices for those of `names` that moved (empty while the destination is null). */
export function movedSkillNotices(names: readonly string[]): string[] {
  return names.map(movedSkillNotice).filter((n): n is string => n !== null);
}

/**
 * Skill folders that neither list names: what the guard refuses once the
 * destination is set (new content skills go to the destination). Empty while
 * the destination is null.
 */
export function unlistedSkillFolders(folders: readonly string[], registry: MovedRegistry = movedRegistry()): string[] {
  if (!registry.destination) return [];
  return folders.filter(f => !NON_SKILL_FOLDERS.includes(f) && !registry.moved.includes(f) && !registry.kept.includes(f)).sort();
}
