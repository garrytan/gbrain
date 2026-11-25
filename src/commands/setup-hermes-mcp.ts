/**
 * setup-hermes-mcp.ts — `gbrain setup hermes` registers gbrain's stdio MCP server
 * through Hermes's own CLI, `hermes mcp add`. That is the path Hermes names
 * when its write guard refuses an agent's edit of config.yaml ("use 'hermes
 * config' instead"): Hermes validates the entry, runs a real handshake and
 * writes config.yaml itself, so no agent has to edit that file.
 *
 * `hermes mcp add` asks on stdin (overwrite an existing entry, enable all
 * tools) and exits 0 even when it saved nothing, so setup answers yes, then
 * reads config.yaml back and runs `hermes mcp test`. Hermes rewrites
 * config.yaml as plain YAML, which drops comments, so gbrain's marked hook
 * block is set aside around each call and put back unchanged. An
 * `mcp_servers.<name>` entry gbrain did not write is left alone. Without a
 * hermes command, setup prints the one command to run. An update keeps the
 * entry's member binding and connect timeout; an entry with settings setup
 * cannot carry through `hermes mcp add` (environment beyond GBRAIN_HOME,
 * which would otherwise travel on a command line, among them) is left for the
 * user. When an update
 * fails, the entry gbrain had before is put back with `hermes config set`, and
 * a run without GBRAIN_HOME keeps the brain the entry already points at.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadBoundedYaml } from '../core/data-frontmatter.ts';
import { registeredAdvertise, registeredSurface, stdioServeArgv, type RegistrationProfile } from '../core/mcp-registration.ts';
import type { McpSurface } from '../mcp/surface.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { ensureHookLauncher, HOOK_LAUNCHER_NAME, hookLauncherPath } from '../core/setup/hook-launcher.ts';
import { withHermesHookBlockSetAside } from '../core/setup/hermes-turn-hook.ts';
import { STDIO_MEMBER_FLAG } from '../core/stdio-member-flag.ts';

export type HermesRun = (argv: string[], input: string) => { ok: boolean; output: string };

/** `surface`: the surface the entry serves after a write or keep (the brain-first block and turn rule name its tools). */
export interface HermesMcpOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip' | 'error'; path: string; detail: string; command?: string; surface?: McpSurface }

export interface HermesMcpOptions {
  hermesHome: string;
  name: string;
  /** The command Hermes starts: the hook launcher, which execs gbrain from a directory that holds only itself. */
  command: string;
  /** The absolute gbrain binary the launcher execs. */
  gbrainBin: string;
  surface: McpSurface | null;
  advertise: McpSurface | null;
  /** The brain Hermes serves; null keeps the existing entry's, else HOME. */
  gbrainHome: string | null;
  dryRun: boolean;
  bin?: string | null;
  run?: HermesRun;
}

function defaultRun(argv: string[], input: string): { ok: boolean; output: string } {
  const r = bunSpawnSync(argv, { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 180_000 });
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

const executable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** `hermes` on PATH, else where Hermes's installer puts it (the agent's shell may not have it on PATH). */
export function findHermesBin(hermesHome: string): string | null {
  try {
    const found = Bun.which('hermes', { PATH: process.env.PATH ?? '' });
    if (found) return found;
  } catch { /* fall through */ }
  const home = process.env.HOME?.trim() || homedir();
  return [join(hermesHome, 'hermes-agent', 'venv', 'bin', 'hermes'), join(home, '.local', 'bin', 'hermes')].find(executable) ?? null;
}

const quote = (w: string) => (/^[A-Za-z0-9_./:=@+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function readEntry(path: string, name: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const doc = loadBoundedYaml(readFileSync(path, 'utf8')) as { mcp_servers?: Record<string, unknown> } | null;
  const entry = doc && typeof doc === 'object' ? doc.mcp_servers?.[name] : undefined;
  return entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
}

/** An entry gbrain wrote: its command is gbrain or gbrain's launcher. A URL or another command is the user's. */
function ours(entry: Record<string, unknown>): boolean {
  return typeof entry.command === 'string' && (basename(entry.command) === 'gbrain' || basename(entry.command) === HOOK_LAUNCHER_NAME);
}

const MANAGED_KEYS = new Set(['command', 'args', 'env', 'enabled', 'connect_timeout']);
const SERVE_FLAGS = new Set(['--surface', '--advertise', STDIO_MEMBER_FLAG]);
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** What gbrain's entry holds that setup does not carry over: keys beyond command/args/env, env beyond GBRAIN_HOME, and serve flags setup does not write. */
function unmanaged(entry: Record<string, unknown>): string[] {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const rest = args.slice(args.indexOf('serve') + 1);
  const flags = rest.filter((a, i) => !SERVE_FLAGS.has(a) && !SERVE_FLAGS.has(rest[i - 1] ?? ''));
  const env = entry.env && typeof entry.env === 'object' ? Object.keys(entry.env).filter((k) => k !== 'GBRAIN_HOME').map((k) => `env ${k}`) : [];
  return [...Object.keys(entry).filter((k) => !MANAGED_KEYS.has(k)), ...env, ...flags, ...(SERVE_FLAGS.has(rest.at(-1) ?? '') ? [rest.at(-1)!] : [])];
}

const tail = (s: string) => s.split('\n').filter(Boolean).slice(-3).join(' / ');

/** Register (or update) gbrain's entry with `hermes mcp add`. Never throws. */
export function syncHermesMcp(o: HermesMcpOptions): HermesMcpOutcome {
  const path = join(o.hermesHome, 'config.yaml');
  const bin = o.bin !== undefined ? o.bin : findHermesBin(o.hermesHome);
  let command: string | undefined;
  try {
    const entry = readEntry(path, o.name);
    if (entry && !ours(entry)) {
      return { action: 'skip', path, detail: `mcp_servers.${o.name} in ${path} is not gbrain's (${String(entry.url ?? entry.command)}), so setup left it; pass --name <other> to register gbrain beside it` };
    }
    const prior = entry?.env && typeof entry.env === 'object' ? entry.env as Record<string, unknown> : {};
    const gbrainHome = o.gbrainHome ?? (typeof prior.GBRAIN_HOME === 'string' ? prior.GBRAIN_HOME : process.env.HOME?.trim() || homedir());
    const env = { GBRAIN_HOME: gbrainHome };
    const timeout = typeof entry?.connect_timeout === 'number' ? String(entry.connect_timeout) : '60';
    const priorArgs = Array.isArray(entry?.args) ? (entry.args as unknown[]).map(String) : [];
    const member = priorArgs.includes(STDIO_MEMBER_FLAG) ? priorArgs[priorArgs.indexOf(STDIO_MEMBER_FLAG) + 1] : undefined;
    const wanted = { command: o.command, args: stdioServeArgv(o.gbrainBin, o.surface, o.advertise, member), env };
    const matches = (e: Record<string, unknown> | null) => !!e && e.enabled !== false && e.command === wanted.command && canon(e.args) === canon(wanted.args) && canon(e.env) === canon(env);
    const argv = [bin ?? 'hermes', 'mcp', 'add', o.name, '--env', `GBRAIN_HOME=${gbrainHome}`, '--connect-timeout', timeout, '--command', o.command, '--args', ...wanted.args];
    command = `printf 'y\\ny\\n' | ${argv.map(quote).join(' ')}`;
    if (matches(entry)) return { action: 'keep', path, detail: `MCP server ${o.name} in ${path}` };
    const extra = entry ? unmanaged(entry) : [];
    if (extra.length) return { action: 'skip', path, detail: `gbrain's MCP server ${o.name} in ${path} has settings setup would drop (${extra.join(', ')}), so setup left it; edit it with hermes mcp, or remove it and run setup again` };
    if (!bin) return { action: 'print', path, detail: `no hermes command found, so the MCP server was not registered; run this where Hermes is installed`, command };
    if (o.dryRun) return { action: 'write', path, detail: `would register MCP server ${o.name} with Hermes's own CLI: ${command}`, command };
    const run = o.run ?? defaultRun;
    const fail = (detail: string): HermesMcpOutcome => {
      if (!entry || entry.enabled === false || o.name.includes('.')) return { action: 'error', path, detail, command };
      const back = withHermesHookBlockSetAside(o.hermesHome, () => run([bin, 'config', 'set', `mcp_servers.${o.name}`, JSON.stringify(entry)], ''));
      const restored = back.ok && canon(readEntry(path, o.name)) === canon(entry);
      return { action: 'error', path, detail: `${detail}; ${restored ? 'the previous entry was put back' : `putting the previous entry back failed too (${tail(back.output) || 'no output'})`}`, command };
    };
    const added = withHermesHookBlockSetAside(o.hermesHome, () => run(argv, 'y\ny\n'));
    if (!matches(readEntry(path, o.name))) {
      return fail(`hermes mcp add did not save the requested ${o.name} entry (${tail(added.output) || 'no output'}); run \`hermes mcp test ${o.name}\` to see why`);
    }
    const test = run([bin, 'mcp', 'test', o.name], '');
    if (!test.ok) return fail(`registered ${o.name}, but hermes mcp test ${o.name} failed (${tail(test.output) || 'no output'})`);
    return { action: 'write', path, detail: `MCP server ${o.name} registered with hermes mcp add; hermes mcp test ${o.name} connected` };
  } catch (e) {
    return { action: 'error', path, detail: `the MCP server was not registered (${(e as Error).message})`, command };
  }
}

/**
 * The MCP step of `gbrain setup hermes`: a surface the user chose is listed in full, else gbrain's existing entry
 * keeps its own surface and listing, else Hermes gets its default profile (registrationProfile('hermes'): starter
 * listing the memory verbs). Hermes starts the server through the hook launcher, as Codex does, so a script-mode gbrain never starts Bun
 * next to a cloned repository's bunfig.toml.
 */
export function hermesMcpStep(o: { hermesHome: string; name: string; surface?: McpSurface; defaults: RegistrationProfile; gbrainBin: string | null; remove: boolean; dryRun: boolean }): HermesMcpOutcome {
  if (o.remove) return removeHermesMcp(o);
  const path = join(o.hermesHome, 'config.yaml');
  if (!o.gbrainBin?.startsWith('/')) return { action: 'print', path, detail: 'cannot resolve an absolute gbrain path for the MCP server, so it was not registered; run setup by its full path (~/.local/bin/gbrain setup hermes) or pass --gbrain-bin <absolute path>' };
  let command: string;
  try { command = o.dryRun ? hookLauncherPath() : ensureHookLauncher(hookLauncherPath()); } catch (e) {
    return { action: 'error', path, detail: `the MCP server was not registered (${(e as Error).message})` };
  }
  let profile: RegistrationProfile = o.surface ? { surface: o.surface, advertise: null } : o.defaults;
  if (!o.surface) {
    try {
      const entry = readEntry(path, o.name);
      const text = entry && ours(entry) && Array.isArray(entry.args) ? entry.args.map(String).join(' ') : '';
      const surface = registeredSurface(text);
      if (surface) profile = { surface, advertise: registeredAdvertise(text) };
    } catch { /* silent-read-ok: syncHermesMcp reads the same file inside its own handler and reports the error */ }
  }
  const outcome = syncHermesMcp({ hermesHome: o.hermesHome, name: o.name, command, gbrainBin: o.gbrainBin, surface: profile.surface,
    advertise: profile.advertise, gbrainHome: process.env.GBRAIN_HOME?.trim() || null, dryRun: o.dryRun });
  return outcome.action === 'write' || outcome.action === 'keep' ? { ...outcome, surface: profile.surface } : outcome;
}

/** Remove gbrain's entry with `hermes mcp remove`. Never throws. */
export function removeHermesMcp(o: Pick<HermesMcpOptions, 'hermesHome' | 'name' | 'dryRun' | 'bin' | 'run'>): HermesMcpOutcome {
  const path = join(o.hermesHome, 'config.yaml');
  try {
    const entry = readEntry(path, o.name);
    if (!entry || !ours(entry)) return { action: 'skip', path, detail: `no gbrain MCP server ${o.name} in ${path}` };
    const bin = o.bin !== undefined ? o.bin : findHermesBin(o.hermesHome);
    const command = `${quote(bin ?? 'hermes')} mcp remove ${quote(o.name)}`;
    if (!bin) return { action: 'print', path, detail: 'no hermes command found, so the MCP server was left; remove it where Hermes is installed', command };
    if (o.dryRun) return { action: 'remove', path, detail: `would remove MCP server ${o.name}: ${command}`, command };
    const run = o.run ?? defaultRun;
    const out = withHermesHookBlockSetAside(o.hermesHome, () => run([bin, 'mcp', 'remove', o.name], 'y\n'));
    if (readEntry(path, o.name)) return { action: 'error', path, detail: `hermes mcp remove left ${o.name} in ${path} (${tail(out.output) || 'no output'})`, command };
    return { action: 'remove', path, detail: `MCP server ${o.name} removed with hermes mcp remove` };
  } catch (e) {
    return { action: 'error', path, detail: `the MCP server was left (${(e as Error).message})` };
  }
}
