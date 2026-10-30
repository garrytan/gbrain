/**
 * Which paths Git might ignore, answered without a git process per write. A strict write asked `git check-ignore` up to
 * three times (page preparation twice, the door once), and each run reads the checkout's whole index: about 50-60 ms at
 * 155k files. This module reads the ignore sources themselves (every .gitignore from the top level down to the path,
 * .git/info/exclude and core.excludesFile) and answers "not ignored" only when no rule that could ignore the path exists.
 * Every other path is returned for Git to classify exactly as before, so Git stays the only judge of an ignored path:
 * this is a filter in front of check-ignore, never a replacement.
 *
 * The filter over-approximates. Negated rules are dropped (they only un-ignore), every wildcard (`*`, `?`, a bracket
 * expression, `**`) matches any run of characters including `/`, directory-only rules match files too, letters
 * compare case-insensitively, and a rule written with a backslash or a character outside printable ASCII, or an ignore
 * file that is not valid UTF-8 or cannot be read, counts as matching everything under its directory. Each rule is
 * tested against the path and every directory above it (Git ignores a path under an ignored directory), in both the
 * path's own and its NFC spelling, so a path the filter passes is one no positive rule could match.
 *
 * Git is asked whenever the filter cannot see what Git would read: a sparse checkout or an index entry marked
 * skip-worktree (Git then reads .gitignore files from the index), a split or sparse index, a core.excludesFile or an
 * include it cannot resolve (`~user`, `%(prefix)`, a relative path), a gitlink or a symlink along the path
 * (check-ignore refuses those paths), or a probe that failed. The probe (the layout from rev-parse and the
 * configuration with every file it came from) is cached per checkout and taken again when any configuration file it
 * read or could read, HEAD (for includeIf onbranch) or the configuration environment changes. Ignore files are re-read
 * on every call and parsed once per content, so a write that edits a .gitignore is classified against its new rules.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFileBounded } from '../bounded-child-exec.ts';
import { gitChildEnv } from '../git-env.ts';

/** A positive rule: literal chunks that must appear in order, separated by wildcards; `anchored` rules match the path below their directory, the others a single name. */
interface Rule { anchored: boolean; chunks: string[]; open: boolean; close: boolean; literal: boolean }
interface Rules { all: boolean; rules: Rule[] }
interface Probe { top: string; prefix: string; oidBytes: number; exclude: string; index: string; excludesFile: string | null; decidable: boolean;
  watched: Map<string, Buffer | null>; env: string }
interface IndexScan { decidable: boolean; gitlinks: Set<string> }

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
const PROBE_TIMEOUT_MS = 20_000;
const probes = new Map<string, Probe>();
const indexScans = new Map<string, { stamp: string; scan: IndexScan }>();
const sources = new Map<string, { bytes: Buffer; rules: Rules }>();
const NONE: Rules = { all: false, rules: [] };
const ALL: Rules = { all: true, rules: [] };
const WILDCARDS = /\/?\*\*\/?|[*?]/;

const fold = (text: string) => text.replace(/[A-Z]+/g, upper => upper.toLowerCase());

function readOrNull(path: string): Buffer | null | undefined {
  try { return readFileSync(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
  }
}

/** The positive rules of one ignore file, as the over-approximation the module header describes. */
export function parseIgnoreRules(bytes: Buffer): Rules {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return ALL;
  const rules: Rule[] = [];
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line || line[0] === '#' || line[0] === '!') continue;
    if (line.includes('\\') || /[^\x20-\x7e]/.test(line)) return ALL;
    line = line.replace(/ +$/, '');
    if (line.endsWith('/')) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (anchored && line[0] === '/') line = line.slice(1);
    if (!line) continue;
    const bracket = line.indexOf('[');
    if (bracket >= 0) line = line.slice(0, bracket) + '*';
    const parts = line.split(WILDCARDS);
    rules.push({ anchored, chunks: parts.filter(Boolean).map(fold), open: parts[0] === '', close: parts[parts.length - 1] === '', literal: parts.length === 1 });
  }
  return { all: false, rules };
}

/** Whether `rule` could match `text` (already case-folded): its chunks in order, the first a prefix and the last a suffix unless a wildcard stands there. */
function matches(rule: Rule, text: string): boolean {
  if (rule.literal) return text === rule.chunks[0];
  let at = 0, end = text.length, first = 0, last = rule.chunks.length;
  if (!rule.open) {
    const head = rule.chunks[first++]!;
    if (!text.startsWith(head)) return false;
    at = head.length;
  }
  if (!rule.close && last > first) {
    const tail = rule.chunks[--last]!;
    if (end - tail.length < at || !text.endsWith(tail)) return false;
    end -= tail.length;
  }
  for (let i = first; i < last; i++) {
    const found = text.indexOf(rule.chunks[i]!, at);
    if (found < 0 || found + rule.chunks[i]!.length > end) return false;
    at = found + rule.chunks[i]!.length;
  }
  return true;
}

async function git(root: string, args: string[]): Promise<string | null> {
  const { error, stdout } = await execFileBounded('git', ['-C', root, ...args], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: gitChildEnv(GIT_ENV) });
  return error ? null : stdout;
}

/** The configuration environment Git reads: a change takes the probe again. */
function configEnv(): string {
  const env = gitChildEnv();
  return ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT']
    .map(key => `${key}=${env[key] ?? ''}`).concat(Object.keys(env).filter(key => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)).sort().map(key => `${key}=${env[key]}`)).join('\0');
}

/** A configured path as Git expands it (`~/` is the home directory), or undefined when Git's expansion is not reproduced here. */
function configPath(value: string, base?: string): string | undefined {
  const home = process.env.HOME;
  if (value.startsWith('~/') && home) return join(home, value.slice(2));
  if (isAbsolute(value)) return value;
  if (base && value && !value.startsWith('~') && !value.startsWith('%(') && !value.startsWith(':(')) return resolve(base, value);
  return undefined;
}

async function probe(root: string): Promise<Probe | null> {
  const [layout, listed, system, global] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel', '--show-prefix', '--show-object-format', '--git-path', 'info/exclude', '--git-path', 'index', '--git-path', 'HEAD',
      '--git-path', 'config', '--git-path', 'config.worktree']),
    git(root, ['config', '--list', '--show-origin', '-z']),
    git(root, ['var', 'GIT_CONFIG_SYSTEM']), git(root, ['var', 'GIT_CONFIG_GLOBAL'])]);
  const lines = layout?.split('\n');
  if (!lines || lines.length !== 9 || listed === null) return null;
  const [top, prefix, format, exclude, index, head, config, worktreeConfig] = lines.map((line, i) => i < 3 || isAbsolute(line) ? line : resolve(root, line));
  if (!top || (format !== 'sha1' && format !== 'sha256')) return null;
  const home = process.env.HOME, xdg = process.env.XDG_CONFIG_HOME;
  const watchedPaths = new Set<string>([head!, config!, worktreeConfig!, ...(system ?? '/etc/gitconfig').split('\n').filter(Boolean),
    ...(global ?? [home && join(home, '.gitconfig'), xdg ? join(xdg, 'git', 'config') : home && join(home, '.config', 'git', 'config')].filter(Boolean).join('\n')).split('\n').filter(Boolean)]);
  let excludes: string | undefined | null = null, sparse = false, unresolved = false;
  const fields = listed.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const origin = fields[i]!, entry = fields[i + 1]!;
    const newline = entry.indexOf('\n');
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase(), value = newline < 0 ? null : entry.slice(newline + 1);
    const file = origin.startsWith('file:') ? resolve(top, origin.slice(5)) : null;
    if (file) watchedPaths.add(file);
    if (key === 'core.excludesfile') excludes = value === null ? undefined : configPath(value);
    if (key === 'core.sparsecheckout') sparse = value === null || !/^(false|no|off|0)$/i.test(value.trim());
    if ((key === 'include.path' || /^includeif\..*\.path$/.test(key)) && value !== null) {
      const included = configPath(value, file ? dirname(file) : undefined);
      if (included) watchedPaths.add(included); else unresolved = true;
    }
  }
  if (excludes === null) excludes = xdg ? join(xdg, 'git', 'ignore') : home ? join(home, '.config', 'git', 'ignore') : null;
  const watched = new Map<string, Buffer | null>();
  for (const path of watchedPaths) { const bytes = readOrNull(path); if (bytes === undefined) return null; watched.set(path, bytes); }
  return { top, prefix: prefix!, oidBytes: format === 'sha256' ? 32 : 20, exclude: exclude!, index: index!, excludesFile: excludes ?? null,
    decidable: excludes !== undefined && !sparse && !unresolved, watched, env: configEnv() };
}

function current(probed: Probe): boolean {
  if (probed.env !== configEnv()) return false;
  for (const [path, bytes] of probed.watched) {
    const now = readOrNull(path);
    if (now === undefined || (now === null) !== (bytes === null) || (now && !now.equals(bytes!))) return false;
  }
  return true;
}

/**
 * What the index tells the filter: no skip-worktree entry (Git would read such a .gitignore from the index), no split
 * or sparse index (or any other required extension), and the gitlinks (check-ignore refuses a path inside a submodule).
 * Version 4 entries are not named here, so a gitlink there makes the whole index undecidable.
 */
export function scanIndex(bytes: Buffer, oidBytes: number): IndexScan {
  const undecidable = { decidable: false, gitlinks: new Set<string>() };
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'DIRC') return undecidable;
  const version = bytes.readUInt32BE(4), count = bytes.readUInt32BE(8);
  if (version < 2 || version > 4) return undecidable;
  const gitlinks = new Set<string>();
  let at = 12;
  for (let i = 0; i < count; i++) {
    if (at + 42 + oidBytes > bytes.length) return undecidable;
    const mode = bytes.readUInt32BE(at + 24), flags = bytes.readUInt16BE(at + 40 + oidBytes);
    let name = at + 42 + oidBytes;
    if (flags & 0x4000) {
      if (version < 3 || name + 2 > bytes.length || bytes.readUInt16BE(name) & 0x4000) return undecidable;
      name += 2;
    }
    const gitlink = (mode & 0o170000) === 0o160000;
    if (version === 4) {
      while (name < bytes.length && bytes[name]! & 0x80) name++;
      const nul = bytes.indexOf(0, name + 1);
      if (nul < 0 || gitlink) return undecidable;
      at = nul + 1;
      continue;
    }
    const length = (flags & 0xfff) === 0xfff ? bytes.indexOf(0, name) - name : flags & 0xfff;
    if (length < 0 || name + length > bytes.length) return undecidable;
    if (gitlink) gitlinks.add(bytes.toString('utf8', name, name + length));
    at += ((name - at) + length + 8) & ~7;
  }
  while (at + 8 <= bytes.length - oidBytes) {
    if (!/^[A-Z]/.test(bytes.toString('latin1', at, at + 4))) return undecidable;
    at += 8 + bytes.readUInt32BE(at + 4);
  }
  return { decidable: true, gitlinks };
}

function indexScan(probed: Probe): IndexScan {
  let stamp: string;
  try { const s = statSync(probed.index, { bigint: true }); stamp = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error) { return { decidable: (error as NodeJS.ErrnoException).code === 'ENOENT', gitlinks: new Set() }; }
  const cached = indexScans.get(probed.index);
  if (cached?.stamp === stamp) return cached.scan;
  const bytes = readOrNull(probed.index);
  const scan = bytes ? scanIndex(bytes, probed.oidBytes) : { decidable: bytes === null, gitlinks: new Set<string>() };
  indexScans.set(probed.index, { stamp, scan });
  return scan;
}

function rulesOf(path: string): Rules {
  const bytes = readOrNull(path);
  if (bytes === undefined) return ALL;
  if (bytes === null) return NONE;
  const cached = sources.get(path);
  if (cached?.bytes.equals(bytes)) return cached.rules;
  const rules = parseIgnoreRules(bytes);
  sources.set(path, { bytes, rules });
  return rules;
}

/** Whether any of `rules` (from the ignore file of directory `base`, '' for the top level) could match the path in `segments` or a directory above it. */
function couldMatch(rules: Rules, base: string, segments: string[]): boolean {
  const skip = base ? base.split('/').length : 0;
  if (skip >= segments.length) return false;
  if (rules.all) return true;
  for (const rule of rules.rules) {
    for (let depth = skip + 1; depth <= segments.length; depth++) {
      if (matches(rule, rule.anchored ? segments.slice(skip, depth).join('/') : segments[depth - 1]!)) return true;
    }
  }
  return false;
}

/**
 * The paths among `relativePaths` (relative to `root`, `/`-separated) whose ignore status needs Git's answer, in
 * order: every path when the filter cannot decide, otherwise only those some ignore rule could match.
 */
export async function ignoreCandidates(root: string, relativePaths: string[]): Promise<string[]> {
  if (!relativePaths.length) return [];
  let key: string;
  try { key = realpathSync(root); } catch { return relativePaths; }
  let probed = probes.get(key);
  if (!probed || !current(probed)) {
    const fresh = await probe(root);
    if (!fresh) { probes.delete(key); return relativePaths; }
    probes.set(key, probed = fresh);
  }
  const scan = indexScan(probed);
  if (!probed.decidable || !scan.decidable) return relativePaths;
  const shared = [probed.excludesFile ? rulesOf(probed.excludesFile) : NONE, rulesOf(probed.exclude)];
  return relativePaths.filter(relativePath => {
    const full = `${probed.prefix}${relativePath}`;
    const segments = full.split('/');
    if (!relativePath || segments.some(segment => !segment || segment === '.' || segment === '..')) return true;
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join('/');
      if (scan.gitlinks.has(path)) return true;
      if (depth < segments.length) {
        try { if (lstatSync(join(probed.top, path)).isSymbolicLink()) return true; } catch { /* a missing directory holds no rule */ }
      }
    }
    const variants = [...new Set([full, full.normalize('NFC')].map(fold))].map(text => text.split('/'));
    const local = segments.map((_, depth) => ({ base: segments.slice(0, depth).join('/'), rules: rulesOf(join(probed.top, ...segments.slice(0, depth), '.gitignore')) }));
    return variants.some(variant => shared.some(rules => couldMatch(rules, '', variant)) || local.some(({ base, rules }) => couldMatch(rules, base, variant)));
  });
}

/** Test seam: forget every cached probe, index scan and parsed ignore file. */
export function resetIgnoreCandidatesForTests(): void { probes.clear(); indexScans.clear(); sources.clear(); }
