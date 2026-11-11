/**
 * Catalog sources for `gbrain skills index build`: SKILL.md directories
 * (--dir), gbrain's bundled skills (--bundled) and an adapter's JSON list
 * (--from-json), plus an optional routing table (--routing). Each becomes a
 * list of normalized skill records, the skills it skipped (with a reason)
 * and, for directories, a stat fingerprint the turn path compares cheaply.
 *
 * Directories: only real paths are read. A symlink whose target leaves the
 * root is skipped (symlink_outside_root); loops are cut by real path. Skills
 * are visited breadth-first (shallower first, then path order) and the --dir
 * order is precedence: the first skill with an id wins and later ones are
 * skipped as duplicate_id with the path that won. An id is the skill's
 * frontmatter name (else its directory name), prefixed with `<plugin>:` when
 * an ancestor holds a Claude Code plugin manifest (.claude-plugin/plugin.json).
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { ResolverError } from './errors.ts';
import { readBounded, readHead } from './fsutil.ts';
import { boundBody, cleanText, parseSkillDoc, SKILL_FILE_CAP_BYTES } from './frontmatter.ts';
import { parseRoutingTable } from './routing.ts';
export { fingerprintChanged } from './catalog-files.ts';

export const MAX_SKILLS = 10_000;
export const MAX_DIRS_VISITED = 100_000;
export const MAX_DEPTH = 12;
export const JSON_SOURCE_CAP_BYTES = 8 * 1024 * 1024;
export const ROUTING_FILE_CAP_BYTES = 1024 * 1024;
const MAX_ID = 256;
const MAX_NAME = 256;
const MAX_DESCRIPTION = 8192;
const MAX_TRIGGERS = 64;
const MAX_TRIGGER_CHARS = 512;
const MAX_ROUTING_ROWS = 64;

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  triggers: string[];
  routing: string[];
  body: string;
  path?: string;
  namespace?: string;
}

export type SkipReason = 'duplicate_id' | 'not_model_invocable' | 'ineligible' | 'symlink_outside_root' | 'unreadable' | 'invalid_entry';
export interface SkippedSkill { reason: SkipReason; id?: string; path?: string; kept?: string }

export interface DirFingerprint { dirs: [string, number][]; files: [string, number, number][] }

export interface SourceRead {
  kind: 'dir' | 'bundled' | 'json';
  skills: SkillRecord[];
  skipped: SkippedSkill[];
  fingerprint?: DirFingerprint;
  snapshot?: string;
}

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));
const boundTriggers = (t: string[]) => t.slice(0, MAX_TRIGGERS).map(x => cut(x, MAX_TRIGGER_CHARS));

function unreadable(dir: string, why: string): ResolverError {
  return new ResolverError('skill_source_unreadable', `The skill directory ${dir} cannot be read (${why}).`, { suggestion: 'Pass an existing directory you can read with --dir.' });
}

function tooLarge(what: string): ResolverError {
  return new ResolverError('skill_catalog_too_large', `The catalog is over its bound: ${what}.`, { suggestion: `Index at most ${MAX_SKILLS.toLocaleString('en-US')} skills per catalog; split the source into several catalogs.` });
}

function pluginNamespace(skillDir: string, root: string, cache: Map<string, string | null>): string | undefined {
  for (let d = skillDir; d === root || d.startsWith(root + sep); d = dirname(d)) {
    let ns = cache.get(d);
    if (ns === undefined) {
      ns = null;
      const manifest = join(d, '.claude-plugin', 'plugin.json');
      if (existsSync(manifest)) {
        try {
          const b = readBounded(manifest, 64 * 1024);
          const name = b === 'too_large' ? undefined : (JSON.parse(b.toString('utf8')) as { name?: unknown }).name;
          if (typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) ns = name;
        } catch { /* not a plugin manifest */ }
      }
      cache.set(d, ns);
    }
    if (ns) return ns;
    if (d === root) break;
  }
  return undefined;
}

/** Read --dir sources in precedence order. */
export function readDirSources(dirs: readonly string[]): SourceRead {
  const skills: SkillRecord[] = [];
  const skipped: SkippedSkill[] = [];
  const fp: DirFingerprint = { dirs: [], files: [] };
  const seen = new Map<string, string>();
  const nsCache = new Map<string, string | null>();
  let visited = 0;
  let files = 0;
  for (const given of dirs) {
    let root: string;
    try {
      root = realpathSync(given);
      if (!statSync(root).isDirectory()) throw unreadable(given, 'not a directory');
    } catch (e) {
      if (e instanceof ResolverError) throw e;
      throw unreadable(given, (e as NodeJS.ErrnoException).code ?? 'unreadable');
    }
    const visitedReal = new Set<string>([root]);
    let level: string[] = [root];
    for (let depth = 0; level.length && depth <= MAX_DEPTH; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (++visited > MAX_DIRS_VISITED) throw tooLarge(`more than ${MAX_DIRS_VISITED} directories under the --dir roots`);
        let entries: string[];
        try {
          fp.dirs.push([dir, statSync(dir).mtimeMs]);
          entries = readdirSync(dir).sort();
        } catch { skipped.push({ reason: 'unreadable', path: dir }); continue; }
        for (const name of entries) {
          if (name === 'node_modules' || name === '.git') continue;
          const full = join(dir, name);
          let real = full;
          let st;
          try {
            const l = lstatSync(full);
            if (l.isSymbolicLink()) {
              real = realpathSync(full);
              if (real !== root && !real.startsWith(root + sep)) { skipped.push({ reason: 'symlink_outside_root', path: full }); continue; }
              st = statSync(real);
            } else st = l;
          } catch { skipped.push({ reason: 'unreadable', path: full }); continue; }
          if (st.isDirectory()) {
            if (!visitedReal.has(real)) { visitedReal.add(real); next.push(real); }
            continue;
          }
          if (!st.isFile() || name !== 'SKILL.md') continue;
          if (++files > MAX_SKILLS) throw tooLarge(`more than ${MAX_SKILLS} SKILL.md files`);
          let text: string;
          try { text = readHead(real, SKILL_FILE_CAP_BYTES).bytes.toString('utf8'); } catch { skipped.push({ reason: 'unreadable', path: real }); continue; }
          fp.files.push([real, st.size, st.mtimeMs]);
          const doc = parseSkillDoc(text);
          const skillDir = dirname(real);
          const name0 = cut(doc.name ?? basename(skillDir), MAX_NAME);
          const ns = pluginNamespace(skillDir, root, nsCache);
          const id = cut(ns ? `${ns}:${name0}` : name0, MAX_ID);
          if (!doc.modelInvocable) { skipped.push({ reason: 'not_model_invocable', id, path: real }); continue; }
          if (!doc.eligible) { skipped.push({ reason: 'ineligible', id, path: real }); continue; }
          const won = seen.get(id);
          if (won !== undefined) { skipped.push({ reason: 'duplicate_id', id, path: real, kept: won }); continue; }
          seen.set(id, real);
          skills.push({ id, name: name0, description: cut(doc.description, MAX_DESCRIPTION), ...(doc.whenToUse ? { whenToUse: cut(doc.whenToUse, MAX_DESCRIPTION) } : {}),
            triggers: boundTriggers(doc.triggers), routing: [], body: doc.body, path: real, ...(ns ? { namespace: ns } : {}) });
        }
      }
      level = next.sort();
    }
  }
  return { kind: 'dir', skills, skipped, fingerprint: fp };
}

/** gbrain's own bundled skills (owner audience), ids `gbrain:<name>`. */
export async function readBundledSource(): Promise<SourceRead> {
  const b = await import('../bundled.ts');
  const { parseSkillFrontmatter } = await import('../../skill-frontmatter.ts');
  const { oneLineDescription } = await import('../../skill-description.ts');
  const skills: SkillRecord[] = b.bundledSkills('owner').map(s => {
    const text = b.bundledSkillText(s);
    const description = cleanText(oneLineDescription(parseSkillFrontmatter(text)?.raw ?? '', text.replace(/^---\n[\s\S]*?\n---\n?/, '')));
    return { id: `gbrain:${s.name}`, name: s.name, description, triggers: boundTriggers(b.bundledSkillTriggers(s).map(cleanText)), routing: [], body: boundBody(text), namespace: 'gbrain' };
  });
  return { kind: 'bundled', skills, skipped: [] };
}

function invalid(message: string): ResolverError {
  return new ResolverError('skill_source_invalid', message, { suggestion: 'Pass a JSON array of {id, name, description, triggers?, routing?, body?, path?, eligible?} objects (at most 10,000 entries, 8 MB).' });
}

const optStr = (v: unknown) => v === undefined || typeof v === 'string';
const optStrList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));

/** An adapter's catalog snapshot: `[{id, name, description, triggers?, routing?, body?, path?, eligible?}]` (or `{skills: [...]}`). */
export function readJsonSource(text: string): SourceRead {
  if (Buffer.byteLength(text, 'utf8') > JSON_SOURCE_CAP_BYTES) throw invalid('The JSON catalog is over 8 MB.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid('The JSON catalog does not parse.'); }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { skills?: unknown }).skills) ? (parsed as { skills: unknown[] }).skills : null;
  if (!list) throw invalid('The JSON catalog must be an array of skills (or {"skills": [...]}).');
  if (list.length > MAX_SKILLS) throw invalid(`The JSON catalog has ${list.length} skills; the bound is ${MAX_SKILLS}.`);
  const skills: SkillRecord[] = [];
  const skipped: SkippedSkill[] = [];
  const seen = new Map<string, string>();
  list.forEach((e, i) => {
    const o = e as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id.trim() || o.id.length > MAX_ID || typeof o.name !== 'string' || !o.name.trim()
      || !optStr(o.description) || !optStr(o.body) || !optStr(o.path) || !optStrList(o.triggers) || !optStrList(o.routing)
      || (o.eligible !== undefined && typeof o.eligible !== 'boolean')) {
      throw invalid(`Entry ${i} is not a valid skill: id and name are required strings (id at most ${MAX_ID} characters); description, body and path are strings; triggers and routing are string arrays; eligible is a boolean.`);
    }
    const id = o.id.trim();
    if (o.eligible === false) { skipped.push({ reason: 'ineligible', id }); return; }
    if (seen.has(id)) { skipped.push({ reason: 'duplicate_id', id, kept: id }); return; }
    seen.set(id, id);
    skills.push({ id, name: cut(cleanText(o.name), MAX_NAME), description: cut(cleanText(o.description ?? ''), MAX_DESCRIPTION),
      triggers: boundTriggers(((o.triggers as string[] | undefined) ?? []).map(cleanText).filter(Boolean)),
      routing: ((o.routing as string[] | undefined) ?? []).map(cleanText).filter(Boolean).slice(0, MAX_ROUTING_ROWS),
      body: typeof o.body === 'string' ? boundBody(o.body) : '', ...(typeof o.path === 'string' && o.path ? { path: o.path } : {}) });
  });
  return { kind: 'json', skills, skipped, snapshot: text };
}

/** Attach a routing file's rows to skills by name (or directory name); returns rows that matched no skill. */
export function applyRouting(skills: SkillRecord[], path: string): { rows: number; unmatched: number; stat: [string, number, number] } {
  let real: string;
  try { real = realpathSync(path); } catch (e) { throw unreadable(path, (e as NodeJS.ErrnoException).code ?? 'unreadable'); }
  const b = readBounded(real, ROUTING_FILE_CAP_BYTES);
  if (b === 'too_large') throw new ResolverError('skill_source_invalid', 'The routing file is over 1 MB.', { suggestion: 'Pass one RESOLVER-style routing table of at most 1 MB with --routing.' });
  const st = statSync(real);
  const rows = parseRoutingTable(b.toString('utf8'));
  const byName = new Map<string, SkillRecord>();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, s);
    const dirName = s.path ? basename(dirname(s.path)) : undefined;
    if (dirName && !byName.has(dirName)) byName.set(dirName, s);
  }
  let unmatched = 0;
  for (const r of rows) {
    const s = byName.get(r.skill);
    if (!s) { unmatched++; continue; }
    const t = cleanText(r.trigger);
    const key = t.toLowerCase();
    if (!t || s.triggers.some(x => x.toLowerCase() === key) || s.routing.some(x => x.toLowerCase() === key) || s.routing.length >= MAX_ROUTING_ROWS) continue;
    s.routing.push(t);
  }
  return { rows: rows.length, unmatched, stat: [real, st.size, st.mtimeMs] };
}
