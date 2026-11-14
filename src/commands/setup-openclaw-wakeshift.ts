/**
 * `gbrain setup openclaw --wakeshift` (Wakeshift plan D11): install Wakeshift's own OpenClaw plugin, pinned, so
 * gbrain's report-back wakes can start a turn in an OpenClaw session. gbrain builds no bridge and vendors nothing:
 * after consent (persistent install, egress) it runs exactly OpenClaw's documented npm install and enable,
 * through an injectable runner (tests never run openclaw). `--force` is how OpenClaw installs from npm instead of
 * ClawHub; `--accept-capabilities` accepts the plugin's tool-result filter where nothing can prompt.
 *
 * The plugin turns on OpenClaw's hooks endpoint. On a gateway that listens beyond this computer, Wakeshift asks
 * first (`allowNetworkHooks`): setup prints that question and never sets the key itself. Verification reads
 * `openclaw plugins inspect wakeshift --runtime --json`; the "Wakeshift: connected" note appears in the agent's
 * own session after its first watch, which no openclaw command shows, so setup reports it as pending unless the
 * inspect output carries it. The pinned version lives in WAKESHIFT_OPENCLAW_VERSION; doctor's
 * `wakeshift_openclaw` check warns when the installed plugin differs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { bunSpawnSync } from '../core/spawn.ts';
import { openclawConfigPath, parseJson5ish } from '../core/setup/brain-first.ts';

export const WAKESHIFT_OPENCLAW_PACKAGE = '@wakeshift/openclaw';
export const WAKESHIFT_OPENCLAW_VERSION = '1.4.31';
export const WAKESHIFT_OPENCLAW_PLUGIN_ID = 'wakeshift';
export const WAKESHIFT_CONNECTED_NOTE = 'Wakeshift: connected';
export const ALLOW_NETWORK_HOOKS_ARGV = ['openclaw', 'config', 'set', `plugins.entries.${WAKESHIFT_OPENCLAW_PLUGIN_ID}.config.allowNetworkHooks`, 'true', '--strict-json'];

export type OpenclawRun = (argv: string[]) => { ok: boolean; output: string };

export function defaultOpenclawRun(argv: string[], timeoutMs = 180_000): { ok: boolean; output: string } {
  const r = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: timeoutMs });
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

export function findOpenclawBin(): string | null {
  try { return Bun.which('openclaw', { PATH: process.env.PATH ?? '' }); } catch { return null; }
}

/** The exact install and enable commands, in order. */
export function wakeshiftOpenclawInstallArgv(bin = 'openclaw'): string[][] {
  return [
    [bin, 'plugins', 'install', `npm:${WAKESHIFT_OPENCLAW_PACKAGE}@${WAKESHIFT_OPENCLAW_VERSION}`, '--force', '--accept-capabilities'],
    [bin, 'plugins', 'enable', WAKESHIFT_OPENCLAW_PLUGIN_ID, '--accept-capabilities'],
  ];
}

export const inspectArgv = (bin = 'openclaw') => [bin, 'plugins', 'inspect', WAKESHIFT_OPENCLAW_PLUGIN_ID, '--runtime', '--json'];

/** The gateway's `gateway.bind` from openclaw.json, or null when unset or unreadable. */
export function openclawGatewayBind(): string | null {
  try {
    const path = openclawConfigPath();
    if (!existsSync(path)) return null;
    const bind = (parseJson5ish(readFileSync(path, 'utf8')) as { gateway?: { bind?: unknown } } | undefined)?.gateway?.bind;
    return typeof bind === 'string' && bind.trim() ? bind.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Wakeshift's question about the hooks endpoint, when the gateway listens beyond this computer (a bind other than
 * loopback), else null. Printed for the user to answer; gbrain never sets allowNetworkHooks.
 */
export function networkHooksQuestion(bind: string | null): string | null {
  if (!bind || bind === 'loopback') return null;
  return `Your OpenClaw gateway listens beyond this computer (gateway.bind: ${bind}). Wakeshift's plugin turns on OpenClaw's hooks endpoint, `
    + 'with a token of its own and only for conversations that connect through Wakeshift, and on this gateway that endpoint is reachable wherever the gateway is. '
    + `The plugin turns nothing on there until you agree. To agree, run: ${ALLOW_NETWORK_HOOKS_ARGV.join(' ')} (and block /hooks/ from other machines with a firewall or proxy rule). gbrain never sets this for you.`;
}

/** The installed plugin's version from `openclaw plugins inspect`, or null when it is not installed or the output names none. */
export function installedWakeshiftOpenclawVersion(run: OpenclawRun, bin: string): string | null {
  const r = run(inspectArgv(bin));
  if (!r.ok) return null;
  return /"version"\s*:\s*"([^"]+)"/.exec(r.output)?.[1] ?? null;
}

export interface WakeshiftOpenclawResult {
  action: 'installed' | 'dry_run' | 'failed';
  version: string;
  commands: string[];
  failed_command?: string;
  output?: string;
  network_hooks_question: string | null;
  verify: { loaded: boolean; connected: 'seen' | 'pending'; message: string } | null;
}

const shown = (argv: string[]) => argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

/** Run the pinned install and enable (consent already given), then inspect. Never throws. */
export function installWakeshiftOpenclaw(opts: { bin: string; run?: OpenclawRun; dryRun: boolean; bind?: string | null }): WakeshiftOpenclawResult {
  const run = opts.run ?? defaultOpenclawRun;
  const argvs = wakeshiftOpenclawInstallArgv(opts.bin);
  const base = { version: WAKESHIFT_OPENCLAW_VERSION, commands: argvs.map(shown), network_hooks_question: networkHooksQuestion(opts.bind === undefined ? openclawGatewayBind() : opts.bind) };
  if (opts.dryRun) return { ...base, action: 'dry_run', verify: null };
  for (const argv of argvs) {
    const r = run(argv);
    if (!r.ok) return { ...base, action: 'failed', failed_command: shown(argv), output: r.output.split('\n').slice(-5).join('\n'), verify: null };
  }
  const inspect = run(inspectArgv(opts.bin));
  const loaded = inspect.ok && /"status"\s*:\s*"loaded"|"imported"\s*:\s*true|"enabled"\s*:\s*true/.test(inspect.output) && !/"status"\s*:\s*"(?:error|disabled)"/.test(inspect.output);
  const connected = inspect.output.includes(WAKESHIFT_CONNECTED_NOTE) ? 'seen' as const : 'pending' as const;
  const message = !loaded
    ? `\`${shown(inspectArgv(opts.bin))}\` does not show the wakeshift plugin loaded; restart the gateway and check again.`
    : connected === 'seen'
      ? `The wakeshift plugin is loaded and reports "${WAKESHIFT_CONNECTED_NOTE}".`
      : `The wakeshift plugin is loaded. "${WAKESHIFT_CONNECTED_NOTE}" appears in the OpenClaw session itself once the agent first watches a job; no openclaw command shows it, so ask the agent to watch one and look for that note.`;
  return { ...base, action: 'installed', verify: { loaded, connected, message } };
}
