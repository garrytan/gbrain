/**
 * openclaw-turn-plugin.ts — OpenClaw's native per-turn hook for the
 * brain-first rule: a hook-only OpenClaw plugin whose `before_prompt_build`
 * handler returns the rule as `prependContext`, so it reaches the model next
 * to each user turn. The workspace AGENTS.md block reaches the system prompt
 * only, and bots read it as identity, not as an instruction to call a tool.
 *
 * The plugin is self-contained (the rule text is written into its code; it
 * reads nothing and calls nothing) and lives in <OpenClaw state dir>/gbrain/.
 * Setup installs it with OpenClaw's own CLI, the supported path: a linked
 * install with capability consent, enabled, and
 * `plugins.entries.gbrain-turn-rule.hooks.allowConversationAccess`, which
 * OpenClaw requires of a non-bundled plugin's `before_prompt_build`. With no
 * `openclaw` on PATH, setup writes the plugin and prints those commands.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { bunSpawnSync } from '../spawn.ts';
import { openclawStateDir, renderBrainFirstTurnRule, type BrainFirstAccess } from './brain-first.ts';

export const OPENCLAW_TURN_PLUGIN_ID = 'gbrain-turn-rule';

export interface OpenclawTurnPluginOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip'; path: string; detail: string; commands?: string[] }

export function openclawTurnPluginDir(): string {
  return join(openclawStateDir(), 'gbrain', OPENCLAW_TURN_PLUGIN_ID);
}

const DESCRIPTION = 'Puts the GBrain brain-first rule next to every user turn (managed by gbrain setup openclaw).';

export function openclawTurnPluginFiles(access: BrainFirstAccess): Record<string, string> {
  const rule = renderBrainFirstTurnRule(access, 'openclaw');
  return {
    'package.json': `${JSON.stringify({ name: OPENCLAW_TURN_PLUGIN_ID, version: '1.0.0', private: true, type: 'module', openclaw: { extensions: ['./index.js'] } }, null, 2)}\n`,
    'openclaw.plugin.json': `${JSON.stringify({ id: OPENCLAW_TURN_PLUGIN_ID, name: 'GBrain turn rule', description: DESCRIPTION, configSchema: { type: 'object', additionalProperties: false } }, null, 2)}\n`,
    'index.js': [
      '// Managed by gbrain setup openclaw; a re-run rewrites this file. Remove: gbrain setup openclaw --remove',
      `const RULE = ${JSON.stringify(rule)};`,
      'export default {',
      `  id: ${JSON.stringify(OPENCLAW_TURN_PLUGIN_ID)},`,
      "  name: 'GBrain turn rule',",
      `  description: ${JSON.stringify(DESCRIPTION)},`,
      '  register(api) {',
      "    api.on('before_prompt_build', () => ({ prependContext: RULE }));",
      '  },',
      '};',
      '',
    ].join('\n'),
  };
}

type Run = (argv: string[]) => { ok: boolean; output: string };

function defaultRun(argv: string[]): { ok: boolean; output: string } {
  const r = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env, timeout: 120_000 });
  return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function findOpenclaw(): string | null {
  try { return Bun.which('openclaw', { PATH: process.env.PATH ?? '' }); } catch { return null; }
}

const installArgv = (bin: string, dir: string): string[][] => [
  [bin, 'plugins', 'install', '--link', dir, '--force', '--accept-capabilities'],
  [bin, 'plugins', 'enable', OPENCLAW_TURN_PLUGIN_ID],
  [bin, 'config', 'set', `plugins.entries.${OPENCLAW_TURN_PLUGIN_ID}.hooks.allowConversationAccess`, 'true'],
];

const shown = (argv: string[]) => argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

/** Write the plugin and install it with OpenClaw's CLI (accepted decision). Never throws. */
export function syncOpenclawTurnPlugin(opts: { access: BrainFirstAccess; dryRun: boolean; openclawBin?: string | null; run?: Run }): OpenclawTurnPluginOutcome {
  const dir = openclawTurnPluginDir();
  const files = openclawTurnPluginFiles(opts.access);
  const bin = opts.openclawBin !== undefined ? opts.openclawBin : findOpenclaw();
  const commands = installArgv(bin ?? 'openclaw', dir);
  const changed = Object.entries(files).some(([name, text]) => {
    try { return readFileSync(join(dir, name), 'utf8') !== text; } catch { return true; }
  });
  if (opts.dryRun) return { action: changed ? 'write' : 'keep', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) at ${dir}${bin ? ', installed with the openclaw CLI' : ''}` };
  try {
    if (changed) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) atomicWriteTextFile(join(dir, name), text, { freshMode: 0o644 });
    }
  } catch (e) {
    return { action: 'print', path: dir, detail: `the plugin could not be written to ${dir} (${(e as Error).message})` };
  }
  if (!bin) return { action: 'print', path: dir, detail: `plugin written to ${dir}; no openclaw on PATH, so run these on the OpenClaw host, then restart the gateway`, commands: commands.map(shown) };
  const run = opts.run ?? defaultRun;
  for (const [i, argv] of commands.entries()) {
    const r = run(argv);
    if (!r.ok) return { action: 'print', path: dir, detail: `\`${shown(argv)}\` failed (${r.output.split('\n').at(-1) ?? 'no output'}); run the rest yourself`, commands: commands.slice(i).map(shown) };
  }
  return { action: changed ? 'write' : 'keep', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) at ${dir}, installed and enabled; restart the gateway if it is running` };
}

/**
 * Uninstall the plugin, then delete its directory (decline or --remove). Never throws. The directory stays
 * until the uninstall succeeds: `install --link` put it in plugins.load.paths, and OpenClaw refuses a config
 * whose load path is missing.
 */
export function removeOpenclawTurnPlugin(opts: { dryRun: boolean; openclawBin?: string | null; run?: Run }): OpenclawTurnPluginOutcome {
  const dir = openclawTurnPluginDir();
  if (!existsSync(dir)) return { action: 'skip', path: dir, detail: `no per-turn rule plugin at ${dir}` };
  if (opts.dryRun) return { action: 'remove', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} at ${dir}` };
  const bin = opts.openclawBin !== undefined ? opts.openclawBin : findOpenclaw();
  const uninstall = [bin ?? 'openclaw', 'plugins', 'uninstall', OPENCLAW_TURN_PLUGIN_ID, '--force'];
  const r = bin ? (opts.run ?? defaultRun)(uninstall) : { ok: false, output: 'no openclaw on PATH' };
  if (!r.ok) return { action: 'print', path: dir, detail: `${dir} left in place (OpenClaw still loads it); ${r.output.split('\n').at(-1)}, so run this on the OpenClaw host, then delete ${dir}`, commands: [shown(uninstall)] };
  try {
    rmSync(dir, { recursive: true, force: true });
    if (readdirSync(dirname(dir)).length === 0) rmdirSync(dirname(dir));
  } catch { /* uninstalled; a leftover directory is no longer loaded */ }
  return { action: 'remove', path: dir, detail: `per-turn rule plugin ${OPENCLAW_TURN_PLUGIN_ID} uninstalled and ${dir} removed` };
}
