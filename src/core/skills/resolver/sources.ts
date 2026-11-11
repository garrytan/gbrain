/**
 * Catalog sources for `gbrain skills index build`: SKILL.md directories
 * (--dir), gbrain's bundled skills (--bundled) and an adapter's JSON list
 * (--from-json), plus an optional routing table (--routing). Each becomes a
 * list of normalized skill records, the skills it skipped (with a reason)
 * and, for directories, a stat fingerprint the turn path compares cheaply.
 *
 * JSON: an adapter's list ([{id, name, ...}] or {skills: [...]}) or, as is,
 * OpenClaw's `skills list --json` document ({workspaceDir, managedSkillsDir,
 * skills: [{name, description, eligible, disabled, ...}]}), whose entries
 * have no id: the name is the id and a skill OpenClaw would not show the
 * model is skipped as ineligible. Bodies are trimmed to the 4 KB the ranker
 * reads, so a list of up to JSON_INPUT_CAP_BYTES is accepted; a snapshot over
 * JSON_SOURCE_CAP_BYTES is kept trimmed. With --dir beside it, the JSON list
 * stays the catalog and each entry takes its body, path and triggers from the
 * folder skill of the same name (mergeSkillFolders).
 *
 * Claude Code plugins: the enabled user-scope plugins in
 * <claude dir>/plugins/installed_plugins.json (enabledPlugins in
 * <claude dir>/settings.json), each install path read as a --dir root whose
 * skills are namespaced `<plugin>:<skill>` (readClaudePluginSources).
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
import { listingKey, skippedEntry } from './catalog-files.ts';
export { fingerprintChanged } from './catalog-files.ts';

export const MAX_SKILLS = 10_000;
export const MAX_DIRS_VISITED = 100_000;
export const MAX_DEPTH = 12;
export const JSON_SOURCE_CAP_BYTES = 8 * 1024 * 1024;
export const JSON_INPUT_CAP_BYTES = 64 * 1024 * 1024;
const CLAUDE_PLUGIN_FILE_CAP_BYTES = 4 * 1024 * 1024;
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

export interface DirFingerprint { dirs: [string, number, string?][]; files: [string, number, number][] }

export interface SourceRead {
  kind: 'dir' | 'bundled' | 'json' | 'claude_plugins';
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

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
          if (typeof name === 'string' && PLUGIN_NAME.test(name)) ns = name;
        } catch { /* not a plugin manifest */ }
      }
      cache.set(d, ns);
    }
    if (ns) return ns;
    if (d === root) break;
  }
  return undefined;
}

/** Read --dir sources in precedence order; rootNamespaces[i] names dirs[i]'s skills when no plugin manifest does. */
export function readDirSources(dirs: readonly string[], rootNamespaces: readonly (string | undefined)[] = []): SourceRead {
  const skills: SkillRecord[] = [];
  const skipped: SkippedSkill[] = [];
  const fp: DirFingerprint = { dirs: [], files: [] };
  const seen = new Map<string, string>();
  const nsCache = new Map<string, string | null>();
  let visited = 0;
  let files = 0;
  for (const [di, given] of dirs.entries()) {
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
          const mtime = statSync(dir).mtimeMs;
          const listed = readdirSync(dir, { withFileTypes: true });
          fp.dirs.push([dir, mtime, listingKey(dir, listed)]);
          entries = listed.map(e => e.name).filter(n => !skippedEntry(n)).sort();
        } catch { skipped.push({ reason: 'unreadable', path: dir }); continue; }
        for (const name of entries) {
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
          const ns = pluginNamespace(skillDir, root, nsCache) ?? rootNamespaces[di];
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
  return new ResolverError('skill_source_invalid', message, { suggestion: 'Pass a JSON array of {id, name, description, when_to_use?, triggers?, routing?, body?, path?, eligible?, disable_model_invocation?} objects, or OpenClaw\'s skills list --json output as is (at most 10,000 entries, 64 MB).' });
}

const optStr = (v: unknown) => v === undefined || typeof v === 'string';
const optStrList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean';
const OPENCLAW_HIDDEN = ['disabled', 'blockedByAllowlist', 'blockedByAgentFilter'] as const;
/** boundBody repeated until it changes nothing (each pass only removes text): an over-cap snapshot stores this, so its re-read bounds every body to itself. */
function settledBody(text: string): string {
  let b = boundBody(text);
  for (let next = boundBody(b); next !== b; next = boundBody(b)) b = next;
  return b;
}

/** The first field that makes entry `o` invalid, or null. OpenClaw entries carry no id: the name stands in. */
function badField(o: Record<string, unknown>, openclaw: boolean): string | null {
  if (!openclaw && (typeof o.id !== 'string' || !o.id.trim() || o.id.length > MAX_ID)) return `id (a required string of at most ${MAX_ID} characters)`;
  if (typeof o.name !== 'string' || !o.name.trim() || (openclaw && o.name.length > MAX_ID)) return 'name (a required string)';
  for (const f of ['description', 'when_to_use', 'body', 'path'] as const) if (!optStr(o[f])) return `${f} (a string)`;
  for (const f of ['triggers', 'routing'] as const) if (!optStrList(o[f])) return `${f} (an array of strings)`;
  for (const f of ['eligible', 'disable_model_invocation', ...(openclaw ? [...OPENCLAW_HIDDEN, 'modelVisible'] : [])]) if (!optBool(o[f])) return `${f} (a boolean)`;
  return null;
}

/**
 * An adapter's catalog snapshot: `[{id, name, description, when_to_use?, triggers?, routing?, body?, path?, eligible?, disable_model_invocation?}]`,
 * `{skills: [...]}`, or OpenClaw's `skills list --json` document.
 */
export function readJsonSource(text: string): SourceRead {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > JSON_INPUT_CAP_BYTES) throw invalid('The JSON catalog is over 64 MB.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw invalid('The JSON catalog does not parse.'); }
  const doc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const list = Array.isArray(parsed) ? parsed : doc && Array.isArray(doc.skills) ? doc.skills as unknown[] : null;
  if (!list) throw invalid('The JSON catalog must be an array of skills (or {"skills": [...]}).');
  if (list.length > MAX_SKILLS) throw invalid(`The JSON catalog has ${list.length} skills; the bound is ${MAX_SKILLS}.`);
  const openclaw = !!doc && ('workspaceDir' in doc || 'managedSkillsDir' in doc);
  const bodyOf = bytes > JSON_SOURCE_CAP_BYTES ? settledBody : boundBody;
  const skills: SkillRecord[] = [];
  const skipped: SkippedSkill[] = [];
  const seen = new Map<string, string>();
  list.forEach((e, i) => {
    const o = e as Record<string, unknown>;
    const bad = o && typeof o === 'object' && !Array.isArray(o) ? badField(o, openclaw) : 'the entry (an object)';
    if (bad) {
      const named = o && typeof o === 'object' && typeof o.name === 'string' ? ` (${cut(cleanText(o.name), 64)})` : '';
      const hint = !openclaw && o && typeof o === 'object' && o.id === undefined && typeof o.name === 'string' ? ' OpenClaw\'s skills list --json output is accepted as is, with its workspaceDir and managedSkillsDir.' : '';
      throw invalid(`Entry ${i}${named} is not a valid skill: ${bad} is wrong or missing.${hint}`);
    }
    const id = (openclaw ? o.name as string : o.id as string).trim();
    const at = typeof o.path === 'string' && o.path ? { path: o.path } : {};
    if (o.disable_model_invocation === true) { skipped.push({ reason: 'not_model_invocable', id, ...at }); return; }
    if (o.eligible === false || (openclaw && (OPENCLAW_HIDDEN.some(f => o[f] === true) || o.modelVisible === false))) { skipped.push({ reason: 'ineligible', id, ...at }); return; }
    if (seen.has(id)) { skipped.push({ reason: 'duplicate_id', id, kept: id }); return; }
    seen.set(id, id);
    const whenToUse = cut(cleanText(o.when_to_use ?? ''), MAX_DESCRIPTION);
    skills.push({ id, name: cut(cleanText(o.name), MAX_NAME), description: cut(cleanText(o.description ?? ''), MAX_DESCRIPTION), ...(whenToUse ? { whenToUse } : {}),
      triggers: boundTriggers(((o.triggers as string[] | undefined) ?? []).map(cleanText).filter(Boolean)),
      routing: ((o.routing as string[] | undefined) ?? []).map(cleanText).filter(Boolean).slice(0, MAX_ROUTING_ROWS),
      body: typeof o.body === 'string' ? bodyOf(o.body) : '', ...at });
  });
  if (bytes <= JSON_SOURCE_CAP_BYTES) return { kind: 'json', skills, skipped, snapshot: text };
  for (const e of list) { const o = e as Record<string, unknown>; if (typeof o.body === 'string') o.body = settledBody(o.body); }
  return { kind: 'json', skills, skipped, snapshot: JSON.stringify(parsed) };
}

/**
 * Fill a JSON list's skills from SKILL.md folders, matched by name (or the
 * skill's directory name): the JSON list stays the catalog, and a folder
 * skill supplies the body, path and triggers the entry lacks. Folder skills
 * the list does not name are left out.
 */
export function mergeSkillFolders(json: SourceRead, folders: SourceRead): SourceRead {
  const byName = new Map<string, SkillRecord>();
  for (const s of folders.skills) {
    if (!byName.has(s.name)) byName.set(s.name, s);
    const dirName = s.path ? basename(dirname(s.path)) : undefined;
    if (dirName && !byName.has(dirName)) byName.set(dirName, s);
  }
  const skills = json.skills.map((s) => {
    const f = byName.get(s.name) ?? byName.get(s.id);
    if (!f) return s;
    return { ...s, description: s.description || f.description, ...(s.whenToUse ?? f.whenToUse ? { whenToUse: s.whenToUse ?? f.whenToUse } : {}),
      triggers: s.triggers.length ? s.triggers : f.triggers, body: s.body || f.body, ...(s.path ?? f.path ? { path: s.path ?? f.path } : {}) };
  });
  return { ...json, skills };
}

function readSmallJson(path: string): unknown {
  try {
    const b = readBounded(path, CLAUDE_PLUGIN_FILE_CAP_BYTES);
    return b === 'too_large' ? null : JSON.parse(b.toString('utf8'));
  } catch { return null; }
}

/**
 * Claude Code's enabled user-scope plugins as SKILL.md roots: `{plugin}@{marketplace}` ids
 * that settings.json's enabledPlugins sets true and installed_plugins.json
 * (version 2: a list of installs per id; version 1: one install) records
 * with an existing installPath. A plugin's skills are namespaced by its
 * manifest name, else by the id's plugin part.
 */
export function claudePluginRoots(claudeDir: string): { roots: string[]; namespaces: (string | undefined)[]; files: string[] } {
  const settingsPath = join(claudeDir, 'settings.json');
  const installedPath = join(claudeDir, 'plugins', 'installed_plugins.json');
  const enabled = (readSmallJson(settingsPath) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins;
  const installed = (readSmallJson(installedPath) as { plugins?: Record<string, unknown> } | null)?.plugins;
  const files = [settingsPath, installedPath].filter(f => existsSync(f));
  const roots: string[] = [];
  const namespaces: (string | undefined)[] = [];
  if (!enabled || typeof enabled !== 'object' || !installed || typeof installed !== 'object') return { roots, namespaces, files };
  for (const id of Object.keys(installed).sort()) {
    if (!Object.hasOwn(enabled, id) || enabled[id] !== true) continue;
    const raw = installed[id];
    const installs = (Array.isArray(raw) ? raw : [raw]) as { scope?: unknown; installPath?: unknown }[];
    const install = installs.find(x => x && typeof x === 'object' && (x.scope === undefined || x.scope === 'user') && typeof x.installPath === 'string' && x.installPath.startsWith('/'));
    if (!install) continue;
    const path = install.installPath as string;
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    const plugin = id.split('@')[0]!;
    roots.push(path);
    namespaces.push(PLUGIN_NAME.test(plugin) ? plugin : undefined);
  }
  return { roots, namespaces, files };
}

/** The skills of Claude Code's enabled user-scope plugins; the fingerprint also covers the two plugin records. */
export function readClaudePluginSources(claudeDir: string): SourceRead {
  const { roots, namespaces, files } = claudePluginRoots(claudeDir);
  const read = roots.length ? readDirSources(roots, namespaces) : { kind: 'dir' as const, skills: [], skipped: [], fingerprint: { dirs: [], files: [] } };
  const fp = read.fingerprint!;
  const pluginsDir = join(claudeDir, 'plugins');
  try { fp.dirs.unshift([pluginsDir, statSync(pluginsDir).mtimeMs]); } catch { /* no plugins yet */ }
  for (const f of files) { try { const st = statSync(f); fp.files.unshift([f, st.size, st.mtimeMs]); } catch { /* raced away */ } }
  return { ...read, kind: 'claude_plugins' };
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
