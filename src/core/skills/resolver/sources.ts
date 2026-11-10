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
  kind: 'dir' | 'bundled' | 'json' | 'claude_plugins' | 'shared_catalog';
  skills: SkillRecord[];
  skipped: SkippedSkill[];
  fingerprint?: DirFingerprint;
  snapshot?: string;
  /** The followed catalog's view token per cache root (shared_catalog only); null when a root has no readable active view. */
  viewTokens?: (string | null)[];
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

/**
 * Shared catalog (claude-code-shared): the followed shared-skills install's
 * synced catalog, read engine-free from the adapter's local cache
 * (<home>/skillpack-shared/<key>/shared-skills/, written by
 * src/core/shared-skills/adapter.ts; the same layout
 * src/core/skillpack/shared-brain-bridge.ts installs the native router from).
 * The cache is the router's synced catalog: active.json names the authorized
 * view (view_token) and every usable skill's immutable revision and cached
 * files; only usable, delivery-complete skills are cached (blocked ones are
 * listed on the receipt, never installed). `sync_brain_skills` refreshes the
 * cache, so a new view_token is the freshness signal: the turn path compares
 * it with the receipt's recorded tokens and rebuilds on drift.
 *
 * A skill's id is its qualified id (src/core/shared-skills/catalog.ts
 * qualifiedSkillId: `skill:` + the key's segments joined by `:`), so a ranked
 * line names the exact get_skill selector; the body, description and triggers
 * come from the cached SKILL.md. No path is recorded: the cached files are
 * private to the install, and the agent fetches the skill with get_skill,
 * never by reading the cache.
 */
const SHARED_ACTIVE_CAP_BYTES = 8 * 1024 * 1024;
const SHARED_RECEIPT_CAP_BYTES = 1024 * 1024;
/** Follow statuses that leave no usable cache behind (adapter.ts SharedSkillsLocalReceipt). */
const SHARED_INACTIVE = new Set(['left', 'left_with_retained_files']);

/** The qualified id for a shared skill key (`brain/source/incarnation/pack/name`, URL-encoded segments). */
export function sharedCatalogQualifiedId(key: string): string {
  return `skill:${key.split('/').join(':')}`;
}

function parseSharedSkillKey(key: string): { brain_id: string; source_id: string; source_incarnation: string; pack_id: string; name: string } | null {
  const parts = key.split('/');
  if (parts.length !== 5) return null;
  try {
    const [brain_id, source_id, source_incarnation, pack_id, name] = parts.map(decodeURIComponent);
    if (!brain_id || !source_id || !source_incarnation || !pack_id || !name) return null;
    return { brain_id: brain_id!, source_id: source_id!, source_incarnation: source_incarnation!, pack_id: pack_id!, name: name! };
  } catch { return null; }
}

interface SharedActive { view_token: string; skills: Record<string, { revision: string; files: Record<string, string> }> }

/** The active view of one follow cache: null when there is none (the follow left or never synced). Never throws. */
function readSharedActive(root: string): SharedActive | null {
  try {
    const b = readBounded(join(root, 'active.json'), SHARED_ACTIVE_CAP_BYTES);
    if (b === 'too_large') return null;
    const v = JSON.parse(b.toString('utf8')) as unknown;
    if (!v || typeof v !== 'object' || typeof (v as { view_token?: unknown }).view_token !== 'string'
      || !(v as { skills?: unknown }).skills || typeof (v as { skills?: unknown }).skills !== 'object') return null;
    return v as SharedActive;
  } catch { return null; }
}

/** The current view token per cache root (null when a root has no readable active view). Never throws: the turn path compares these with the receipt's. */
export function sharedCatalogViewTokens(roots: readonly string[]): (string | null)[] {
  return roots.map(r => readSharedActive(r)?.view_token ?? null);
}

/**
 * The followed catalogs for this home: every claude-code shared-skills cache
 * under <home>/skillpack-shared whose follow is still active and whose active
 * view exists. Unreadable or foreign receipts are skipped, never fatal: setup
 * must not fail because one follow's cache is corrupt, and the adapter's own
 * tooling reports the conflict.
 */
export function findSharedSkillCaches(home: string): string[] {
  const base = join(home, 'skillpack-shared');
  let entries: string[];
  try { entries = readdirSync(base); } catch { return []; }
  const roots: string[] = [];
  for (const name of entries.sort()) {
    const root = join(base, name, 'shared-skills');
    try {
      const b = readBounded(join(root, 'receipt.json'), SHARED_RECEIPT_CAP_BYTES);
      if (b === 'too_large') continue;
      const receipt = JSON.parse(b.toString('utf8')) as { format_version?: unknown; adapter?: unknown; status?: unknown };
      if (receipt.format_version !== 1 || receipt.adapter !== 'claude-code' || typeof receipt.status !== 'string' || SHARED_INACTIVE.has(receipt.status)) continue;
      if (!readSharedActive(root)) continue;
      roots.push(root);
    } catch { /* foreign, corrupt or mid-write: not a follow setup can use */ }
  }
  return roots;
}

/** Read the followed shared catalog from its cache roots (the router's synced catalog). */
export function readSharedCatalogSource(roots: readonly string[]): SourceRead {
  const skills: SkillRecord[] = [];
  const skipped: SkippedSkill[] = [];
  const viewTokens: (string | null)[] = [];
  const seen = new Map<string, string>();
  let files = 0;
  for (const root of roots) {
    const realRoot = (() => { try { return realpathSync(root); } catch { return null; } })();
    const active = readSharedActive(root);
    viewTokens.push(active?.view_token ?? null);
    if (!realRoot) continue; // the follow is gone: this root contributes nothing
    if (!active) throw new ResolverError('skill_source_unreadable', `The shared-skills cache at ${root} has no readable active view.`, { suggestion: 'Run sync_brain_skills for that installation, or leave it and re-run setup.' });
    for (const key of Object.keys(active.skills).sort()) {
      const parsed = parseSharedSkillKey(key);
      if (!parsed) { skipped.push({ reason: 'invalid_entry', id: key }); continue; }
      const id = sharedCatalogQualifiedId(key);
      const won = seen.get(id);
      if (won !== undefined) { skipped.push({ reason: 'duplicate_id', id, kept: won }); continue; }
      seen.set(id, root);
      const entry = active.skills[key];
      const filesMap = entry && typeof entry === 'object' && entry.files && typeof entry.files === 'object' ? entry.files : undefined;
      const rel = filesMap?.[`skills/${parsed.name}/SKILL.md`];
      if (typeof rel !== 'string') { skipped.push({ reason: 'unreadable', id }); continue; }
      // Confine the cached file to the cache root: active.json is data, and a
      // path that escapes the root must never be read.
      let real: string;
      try {
        if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('outside root');
        real = realpathSync(join(realRoot, rel));
        if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('outside root');
      } catch { skipped.push({ reason: 'unreadable', id }); continue; }
      if (++files > MAX_SKILLS) throw tooLarge(`more than ${MAX_SKILLS} shared skills`);
      let text: string;
      try { text = readHead(real, SKILL_FILE_CAP_BYTES).bytes.toString('utf8'); } catch { skipped.push({ reason: 'unreadable', id }); continue; }
      const doc = parseSkillDoc(text);
      if (!doc.modelInvocable) { skipped.push({ reason: 'not_model_invocable', id }); continue; }
      if (!doc.eligible) { skipped.push({ reason: 'ineligible', id }); continue; }
      skills.push({ id, name: cut(doc.name ?? parsed.name, MAX_NAME), description: cut(doc.description, MAX_DESCRIPTION),
        ...(doc.whenToUse ? { whenToUse: cut(doc.whenToUse, MAX_DESCRIPTION) } : {}),
        triggers: boundTriggers(doc.triggers), routing: [], body: doc.body });
    }
  }
  return { kind: 'shared_catalog', skills, skipped, viewTokens };
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
