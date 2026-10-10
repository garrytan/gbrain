/**
 * `gbrain setup <harness>` (D8): one command from an installed CLI to a
 * harness with memory. An orchestrator over the existing pieces, never a new
 * installation system:
 *
 *   - target first: resolve the brain (existing local, hosted, or a new
 *     keyless PGLite brain through `gbrain init --pglite --no-embedding`), the
 *     source, the transport, the absolute launcher and the registration owner,
 *     print them, and refuse (coded) before any write when another owner holds
 *     the target: a live PGLite server, an unowned entry, another install, the
 *     bootstrap harness lane, or a hosted connection (never a new local brain);
 *   - consent as three recorded decisions: wiring scope, automatic capture and
 *     provider use. Memory-only (the default) installs the read-context hooks
 *     SessionStart and UserPromptSubmit only; Stop/SessionEnd capture and
 *     provider use need `--capture` / `--providers`; existing opt-outs win;
 *   - hash-keyed ownership through the connection receipt
 *     (src/core/setup/claude-code.ts), so a resume never duplicates an entry
 *     and `--remove` deletes only unchanged owned entries;
 *   - verify through the `harness_wiring` smoke (spawn the registered argv,
 *     initialize + tools/list + recall), reporting configured /
 *     connection-verified / native-pending / native-verified.
 *
 * Engine-free: setup never opens the database itself.
 */
import { realpathSync } from 'node:fs';
import { opError, OperationError } from '../core/ops/contract.ts';
import { renderCliError, type Action } from '../core/agent-output.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';
import { configDir, gbrainPath, loadConfig, type GBrainConfig } from '../core/config.ts';
import { resolveGbrainBin } from '../core/gbrain-bin.ts';
import { isRegistrationSurface, isValidName, REGISTRATION_SURFACE } from '../core/mcp-registration.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { peekLock } from '../core/pglite-lock.ts';
import { claudePluginProvidesName } from '../core/bootstrap/plugin-lanes.ts';
import { claudeUserSettingsPath, type ClaudeHookEvent } from '../core/bootstrap/host-specs.ts';
import { readHarnessReceiptState } from '../core/bootstrap/format.ts';
import { smokeStdioRegistration } from './doctor/checks/harness-wiring.ts';
import type { McpSurface } from '../mcp/surface.ts';
import {
  SETUP_CAPABILITIES,
  SETUP_CAPABILITY_TABLE_VERSION,
  SETUP_HARNESSES,
  capabilityRows,
  isSetupHarness,
} from '../core/setup/capabilities.ts';
import {
  SetupAbortInjected,
  applyClaudeSetup,
  claudeSetupPaths,
  desiredMcpEntry,
  inspectClaudeSetup,
  readSetupReceipt,
  removeClaudeSetup,
  type ClaudeSetupPlan,
  type ClaudeSetupReceipt,
  type SetupConsent,
  type SetupStep,
  type WiringScope,
} from '../core/setup/claude-code.ts';

export const SETUP_HELP = `gbrain setup <harness> — give an agent harness memory in one command

Usage: gbrain setup claude-code [flags]

Resolves the brain, source, transport, launcher and registration owner first and
prints them; refuses before writing anything when another owner holds the target.
With no brain configured it creates a keyless local one (gbrain init --pglite
--no-embedding). It then writes the MCP entry and hooks into Claude Code's own
config and verifies them with the harness_wiring smoke.

Flags:
  --dry-run            Print the target and every step; write nothing.
  --json               One JSON document on stdout (target, decisions, steps, states).
  --surface S          MCP tool surface: verbs, starter or full (default: GBRAIN_SURFACE,
                       then the surface already registered, then full).
  --scope user|project Wiring scope: every Claude Code session (user, default) or only
                       sessions in this directory (project: ~/.claude.json projects
                       entry + .claude/settings.local.json).
  --no-hooks           Register MCP only; install no hooks (GBRAIN_HOOKS=0 does the same).
  --capture            Accept automatic capture: also install Stop and SessionEnd hooks.
  --no-capture         Decline automatic capture (the default).
  --providers          Accept provider use: a new brain is created with embeddings.
  --no-providers       Decline provider use (the default: keyless, no paid calls).
  --name NAME          MCP server name (default gbrain); one name per install.
  --source ID          Pin the source the MCP server and hooks use.
  --gbrain-bin PATH    Absolute gbrain launcher (default: the gbrain on PATH).
  --remove             Remove exactly what setup wrote (unchanged entries only). The
                       brain and your notes stay. Combine with --dry-run to preview.

States: configured (entries written), connection-verified (the smoke answered),
native-pending (no observed push into a native session yet), native-verified.

Refusals: setup never starts a second owner or a second brain. A hosted brain is
wired with gbrain connect <url> --harness claude-code --install; a running
serve --http owner with gbrain bootstrap harness --harness claude-code --yes.

Supported harnesses: claude-code. codex, openclaw and hermes print their guide.
setup and onboard differ: setup wires a harness to a brain; onboard (post-connect)
improves an existing brain's content.
`;

interface SetupFlags {
  harness?: string;
  dryRun: boolean;
  json: boolean;
  remove: boolean;
  noHooks: boolean;
  capture?: boolean;
  providers?: boolean;
  scope?: WiringScope;
  surface?: McpSurface;
  name: string;
  source?: string;
  gbrainBin?: string;
}

const VALUE_FLAGS = new Set(['--surface', '--scope', '--name', '--source', '--gbrain-bin']);

function parseFlags(args: string[]): SetupFlags | string {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1] ?? '';
  };
  const positionals = args.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(args[i - 1] ?? ''));
  const surface = value('--surface');
  if (surface !== undefined && !isRegistrationSurface(surface)) return `unknown --surface '${surface}'; pass verbs, starter or full`;
  const scope = value('--scope');
  if (scope !== undefined && scope !== 'user' && scope !== 'project') return `unknown --scope '${scope}'; pass user or project`;
  const name = value('--name') ?? 'gbrain';
  if (!isValidName(name)) return `invalid --name '${name}'; use lowercase letters, digits, '-' or '_'`;
  const source = value('--source');
  if (source !== undefined && !isValidSourceId(source)) return `invalid --source '${source}'`;
  if (args.includes('--capture') && args.includes('--no-capture')) return 'pass --capture or --no-capture, not both';
  if (args.includes('--providers') && args.includes('--no-providers')) return 'pass --providers or --no-providers, not both';
  return {
    harness: positionals[0],
    dryRun: args.includes('--dry-run'),
    json: args.includes('--json'),
    remove: args.includes('--remove'),
    noHooks: args.includes('--no-hooks'),
    capture: args.includes('--capture') ? true : args.includes('--no-capture') ? false : undefined,
    providers: args.includes('--providers') ? true : args.includes('--no-providers') ? false : undefined,
    scope: scope as WiringScope | undefined,
    surface: surface as McpSurface | undefined,
    name,
    source,
    gbrainBin: value('--gbrain-bin'),
  };
}

interface Out { json: boolean; lines: string[]; notes: string[] }

function say(out: Out, line: string): void {
  if (out.json) process.stderr.write(`${line}\n`);
  else console.log(line);
}

async function refuse(e: OperationError, out: Out): Promise<number> {
  const r = renderCliError(e, { json: out.json, command: 'setup', tty: process.stderr.isTTY === true });
  if (r.stdout) await writeJsonDocument(r.stdout, (t) => process.stdout.write(t));
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

const verifyDryRun = (harness: string, name: string): Action['verify'] => ({ argv: ['gbrain', 'setup', harness, '--dry-run', '--json', ...(name === 'gbrain' ? [] : ['--name', name])] });

function ownerConflict(reason: string, message: string, fix: Pick<Action, 'actor' | 'why'> & Partial<Action>): OperationError {
  return opError('setup_owner_conflict', message, fix.user_message ?? fix.why, {
    reason, docs: 'docs/guides/repair.md#setup-owner-conflict',
    fix: { consent: [], requires_exclusive: false, ...fix },
  });
}

interface Target {
  brain: { kind: 'local-pglite' | 'local-postgres' | 'new-local-pglite'; path?: string; config_dir: string };
  source: { id: string | null; pinned: boolean; from: 'flag' | 'env' | 'brain-default' };
  transport: 'local-stdio';
  launcher: string;
  surface: McpSurface;
  registration_owner: 'none' | 'setup' | 'plugin';
  live_owner: { pid: number; transport: 'stdio' | 'http'; ours: boolean } | null;
  scope: WiringScope;
  name: string;
  config_path: string;
  settings_path: string;
  receipt_path: string;
}

function resolveConsent(flags: SetupFlags, prior: ClaudeSetupReceipt | null, cfg: GBrainConfig | null, scope: WiringScope, notes: string[]): SetupConsent {
  const hooksOff = flags.noHooks || process.env.GBRAIN_HOOKS === '0';
  if (!flags.noHooks && process.env.GBRAIN_HOOKS === '0') notes.push('GBRAIN_HOOKS=0 is set: treated as an opt-out, so no hooks are installed.');
  const wiring: SetupConsent['wiring_scope'] = {
    value: { scope, hooks: hooksOff ? 'none' : 'read-context' },
    source: flags.noHooks || flags.scope ? 'flag' : process.env.GBRAIN_HOOKS === '0' ? 'opt_out' : prior ? 'prior' : 'default',
  };
  const writebackOff = String((cfg as { memory?: { auto_writeback?: unknown } } | null)?.memory?.auto_writeback ?? '').toLowerCase() === 'off';
  let capture: SetupConsent['capture'];
  if (writebackOff && flags.capture !== false) {
    capture = { value: 'declined', source: 'opt_out', note: 'memory.auto_writeback is off on this brain; that opt-out wins' };
    if (flags.capture) notes.push('--capture ignored: memory.auto_writeback is off on this brain (an existing opt-out wins). Change it with `gbrain config set memory.auto_writeback salient`, then run setup with --capture.');
  } else if (flags.capture !== undefined) {
    capture = { value: flags.capture ? 'accepted' : 'declined', source: 'flag' };
  } else if (prior) {
    capture = { value: prior.consent.capture.value, source: 'prior' };
  } else {
    capture = { value: 'declined', source: 'default' };
  }
  const providers: SetupConsent['providers'] = flags.providers !== undefined ? { value: flags.providers ? 'accepted' : 'declined', source: 'flag' }
    : prior ? { value: prior.consent.providers.value, source: 'prior' } : { value: 'declined', source: 'default' };
  return { wiring_scope: wiring, capture, providers };
}

function hookEvents(consent: SetupConsent): ClaudeHookEvent[] {
  if (consent.wiring_scope.value.hooks === 'none') return [];
  const row = capabilityRows('claude-code')[0]!;
  return [...row.read_events, ...(consent.capture.value === 'accepted' ? row.capture_events : [])] as ClaudeHookEvent[];
}

function describeTarget(t: Target, out: Out): void {
  const brain = t.brain.kind === 'new-local-pglite' ? `new keyless PGLite brain at ${t.brain.path} (gbrain init --pglite --no-embedding)`
    : t.brain.kind === 'local-pglite' ? `existing PGLite brain at ${t.brain.path}` : 'existing Postgres brain (from this install\'s config)';
  say(out, `Target (Claude Code, ${t.scope} scope):`);
  say(out, `  brain      ${brain}`);
  say(out, `  source     ${t.source.id ? `'${t.source.id}' (pinned, from ${t.source.from === 'flag' ? '--source' : 'GBRAIN_SOURCE'})` : 'the brain\'s default source (unpinned)'}`);
  say(out, `  transport  stdio MCP: ${t.launcher} serve --surface ${t.surface}`);
  say(out, `  owner      ${t.registration_owner === 'setup' ? `this setup (${t.receipt_path})` : t.registration_owner === 'plugin' ? 'the gbrain Claude Code plugin (MCP); setup adds hooks only' : `none yet; setup will own '${t.name}'`}`);
  if (t.live_owner) say(out, `  live       gbrain ${t.live_owner.transport === 'http' ? 'serve --http' : 'stdio serve'} PID ${t.live_owner.pid}${t.live_owner.ours ? ' (started by this registration)' : ''}`);
  say(out, `  files      ${t.config_path} (MCP), ${t.settings_path} (hooks)`);
}

function describeConsent(c: SetupConsent, events: ClaudeHookEvent[], out: Out): void {
  const src = (s: string) => `[${s}]`;
  say(out, 'Decisions:');
  say(out, `  wiring     ${c.wiring_scope.value.scope} scope; ${events.length ? `hooks ${events.join(', ')}` : 'no hooks'} ${src(c.wiring_scope.source)}`);
  say(out, `  capture    ${c.capture.value}${c.capture.value === 'declined' ? ' (no Stop/SessionEnd hooks, no transcript capture; accept with --capture)' : ' (Stop and SessionEnd hooks)'} ${src(c.capture.source)}`);
  say(out, `  providers  ${c.providers.value}${c.providers.value === 'declined' ? ' (keyless: setup configures no paid provider; accept with --providers)' : ''} ${src(c.providers.source)}`);
}

export async function runSetup(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(SETUP_HELP);
    return 0;
  }
  const parsed = parseFlags(args);
  const out: Out = { json: args.includes('--json'), lines: [], notes: [] };
  if (typeof parsed === 'string') {
    process.stderr.write(`gbrain setup: ${parsed}\n`);
    return 2;
  }
  const flags = parsed;
  if (!isSetupHarness(flags.harness) || capabilityRows(flags.harness).every((r) => r.setup !== 'supported')) {
    const rows = isSetupHarness(flags.harness) ? capabilityRows(flags.harness) : [];
    const guide = rows[0]?.docs;
    const named = flags.harness ? `'${flags.harness}'` : 'no harness';
    return refuse(opError('setup_harness_unsupported',
      `gbrain setup does not wire ${named} yet. ${guide ? `Follow ${guide} to connect it by hand.` : `Supported: ${SETUP_CAPABILITIES.filter((r) => r.setup === 'supported').map((r) => r.harness).join(', ')}; known: ${SETUP_HARNESSES.join(', ')}.`}`,
      guide ? `Follow ${guide}.` : 'Run `gbrain setup claude-code`.',
      { reason: guide ? 'harness_not_wired' : 'unknown_harness', docs: 'docs/guides/repair.md#setup-harness-unsupported',
        fix: { consent: [], actor: 'user', requires_exclusive: false, why: guide ? `The manual steps for this harness are in ${guide}.` : 'Setup wires the harnesses in its capability table.',
          user_message: guide ? `gbrain setup can't wire ${flags.harness} yet; the steps are in ${guide}.` : 'Pick a supported harness: gbrain setup claude-code.',
          ...(guide ? { docs: guide } : {}) } }), out);
  }

  const launcher = flags.gbrainBin ?? resolveGbrainBin();
  if (!launcher || !launcher.startsWith('/')) {
    process.stderr.write('gbrain setup: cannot resolve an absolute gbrain launcher (GUI hosts inherit no PATH). Install gbrain globally (`bun install -g github:garrytan/gbrain`) or pass --gbrain-bin <absolute path>.\n');
    return 2;
  }

  let cfg: GBrainConfig | null;
  try { cfg = loadConfig(); } catch (e) {
    process.stderr.write(`gbrain setup: this install's config cannot be read (${(e as Error).message}); run \`gbrain doctor\`.\n`);
    return 1;
  }
  const brainHome = configDir();
  const scope: WiringScope = flags.scope ?? 'user';
  const projectDir = scope === 'project' ? realpathSync(process.cwd()) : undefined;
  const paths = claudeSetupPaths({ name: flags.name, scope, projectDir });

  try {
    const receiptRead = readSetupReceipt(paths.receiptPath);
    if (flags.remove) return await runRemove(flags, receiptRead.setup, paths.receiptPath, brainHome, out);

    const hostedUrl = cfg?.remote_mcp?.mcp_url ?? receiptRead.hosted?.mcp_url ?? (receiptRead.hosted ? 'a hosted brain' : undefined);
    if (hostedUrl) return refuse(hostedConnection(hostedUrl, receiptRead.hosted !== null, flags.name), out);
    const prior = receiptRead.setup;
    if (prior && prior.gbrain_home !== brainHome) {
      return refuse(ownerConflict('other_install', `The '${flags.name}' connection belongs to the gbrain install at ${prior.gbrain_home}, not ${brainHome}.`, {
        actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--name', `${flags.name}-2`, '--dry-run', '--json'],
        why: 'Each install owns its own MCP name and hooks; preview this install under another name.', verify: verifyDryRun('claude-code', flags.name) }), out);
    }

    const notes: string[] = [];
    const consent = resolveConsent(flags, prior, cfg, scope, notes);
    const envSurface = process.env.GBRAIN_SURFACE;
    if (envSurface && !isRegistrationSurface(envSurface)) notes.push(`GBRAIN_SURFACE='${envSurface}' is not verbs, starter or full; ignored.`);
    const surface: McpSurface = flags.surface ?? (isRegistrationSurface(envSurface) ? envSurface : undefined) ?? prior?.surface ?? REGISTRATION_SURFACE;
    const sourceId = flags.source ?? (process.env.GBRAIN_SOURCE && isValidSourceId(process.env.GBRAIN_SOURCE) ? process.env.GBRAIN_SOURCE : null);
    const plan: ClaudeSetupPlan = {
      name: flags.name, scope, ...(projectDir ? { projectDir } : {}), launcher, brainHome,
      ...(process.env.GBRAIN_HOME?.trim() ? { gbrainHomeEnv: process.env.GBRAIN_HOME.trim() } : {}),
      sourceId, surface, events: hookEvents(consent),
    };
    const found = inspectClaudeSetup(plan);
    if (found.mcp.state === 'remote') return refuse(hostedConnection(found.mcp.url ?? 'a hosted brain', true, flags.name), out);

    const pluginOwner = flags.name === 'gbrain' ? claudePluginProvidesName(claudeUserSettingsPath(), 'gbrain') : null;
    const dataDir = cfg && cfg.engine === 'pglite' && !cfg.database_url ? cfg.database_path ?? gbrainPath('brain.pglite') : undefined;
    const lock = dataDir ? peekLock(dataDir) : null;
    const ours = prior?.status === 'installed' && found.mcp.state === 'current';
    const liveOwner = lock?.held && lock.isServe && lock.pid !== undefined
      ? { pid: lock.pid, transport: lock.http ? 'http' as const : 'stdio' as const, ours: ours && !lock.http } : null;
    const target: Target = {
      brain: !cfg ? { kind: 'new-local-pglite', path: gbrainPath('brain.pglite'), config_dir: brainHome }
        : cfg.engine === 'pglite' ? { kind: 'local-pglite', path: dataDir, config_dir: brainHome } : { kind: 'local-postgres', config_dir: brainHome },
      source: { id: sourceId, pinned: sourceId !== null, from: flags.source ? 'flag' : sourceId ? 'env' : 'brain-default' },
      transport: 'local-stdio', launcher, surface,
      registration_owner: pluginOwner ? 'plugin' : prior ? 'setup' : 'none',
      live_owner: liveOwner, scope, name: flags.name,
      config_path: found.configPath, settings_path: found.settingsPath, receipt_path: found.receiptPath,
    };
    describeTarget(target, out);
    describeConsent(consent, plan.events, out);
    for (const n of notes) say(out, `note: ${n}`);

    if (liveOwner && !liveOwner.ours) {
      const http = liveOwner.transport === 'http';
      return refuse(ownerConflict('live_serve',
        `A live gbrain ${http ? 'serve --http' : 'stdio serve'} (PID ${liveOwner.pid}) holds this PGLite brain's single-writer lock; a stdio registration would start a second server that fails on the lock.`,
        http
          ? { actor: 'agent', argv: ['gbrain', 'bootstrap', 'harness', '--harness', 'claude-code', '--yes'], consent: ['persistent_install', 'credentials'],
            why: 'Connect Claude Code to the running shared server instead of starting a second owner.', verify: { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] } }
          : { actor: 'user', argv: ['kill', String(liveOwner.pid)],
            why: 'Stop the server that holds the brain (quit the agent session that started it), then run setup again.',
            user_message: `gbrain's database is in use by another server (PID ${liveOwner.pid}). Please quit the agent session that started it, then I'll run setup again.`,
            verify: verifyDryRun('claude-code', flags.name) }), out);
    }
    if (found.mcp.state === 'unowned' && !pluginOwner) {
      return refuse(ownerConflict('unowned_entry', `${found.configPath} already has an MCP server named '${flags.name}' that gbrain setup did not write (or it was edited since); setup never overwrites it.`, {
        actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--name', `${flags.name}-local`, '--dry-run', '--json'],
        why: 'Preview a setup under another name, or remove that entry yourself and run setup again.', verify: verifyDryRun('claude-code', flags.name) }), out);
    }
    const harnessReceipt = readHarnessReceiptState(brainHome);
    const harnessLane = harnessReceipt.state === 'ok' && harnessReceipt.receipt.targets.some((t) => t.host === 'claude-code');
    const laneEvents = found.otherLaneEvents.filter((e) => (plan.events as string[]).includes(e));
    if (harnessLane || laneEvents.length > 0) {
      return refuse(ownerConflict('harness_lane', `${harnessLane ? '`gbrain bootstrap harness` already wires Claude Code for this install' : `${found.settingsPath} already wires ${laneEvents.join(', ')} through another gbrain install lane`}; two lanes would fire every hook twice.`, {
        actor: 'agent', argv: ['gbrain', 'bootstrap', 'harness', '--remove', '--dry-run'],
        why: 'Preview removing the bootstrap harness wiring first, or keep it and skip setup.', verify: verifyDryRun('claude-code', flags.name) }), out);
    }

    const brainCreate = !cfg;
    const initArgv = [launcher, 'init', '--pglite', ...(consent.providers.value === 'accepted' ? [] : ['--no-embedding']), ...(out.json ? ['--json'] : [])];
    if (flags.dryRun) {
      const steps: SetupStep[] = [
        { step: 'receipt', action: found.prior?.status === 'installed' && found.hooksCurrent && (found.mcp.state === 'current' || !!pluginOwner) && !brainCreate ? 'keep' : 'write', detail: found.receiptPath },
        ...(brainCreate ? [{ step: 'brain' as const, action: 'write' as const, detail: `would run: ${initArgv.join(' ')}` }] : []),
        { step: 'mcp', action: pluginOwner ? 'skip' : found.mcp.state === 'current' ? 'keep' : 'write', detail: `'${flags.name}' in ${found.configPath}` },
        { step: 'hooks', action: found.hooksCurrent ? 'keep' : 'write', detail: plan.events.length ? `${plan.events.join(', ')} in ${found.settingsPath}` : `no hooks (${found.settingsPath})` },
        ...Object.entries(found.edited).map(([event]) => ({ step: 'hooks' as const, action: 'preserve' as const, detail: `${event} was edited after setup wrote it; kept` })),
      ];
      return finish(out, { dryRun: true, target, consent, steps, states: [], verify: null, notices: [], notes });
    }

    let notices: unknown[] = [];
    const result = await applyClaudeSetup(plan, consent, {
      pluginOwner, brainCreated: brainCreate, abortAfter: process.env.GBRAIN_SETUP_ABORT_AFTER,
      beforeMcp: brainCreate ? async () => {
        say(out, `Creating the brain: ${initArgv.join(' ')}`);
        const child = Bun.spawnSync(initArgv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
        const initOut = child.stdout?.toString() ?? '';
        process.stderr.write(child.stderr?.toString() ?? '');
        if (!out.json) process.stdout.write(initOut);
        if (child.exitCode !== 0) throw new Error(`\`${initArgv.join(' ')}\` exited ${child.exitCode}; nothing else was written. Fix the init error above, then run setup again.`);
        if (out.json) {
          try { notices = (JSON.parse(initOut) as { notices?: unknown[] }).notices ?? []; } catch { process.stderr.write(initOut); }
        }
      } : undefined,
    });
    for (const s of result.steps) say(out, `  ${s.action.padEnd(8)} ${s.step.padEnd(7)} ${s.detail}`);
    if (!result.changed) say(out, 'Nothing changed: this install is already wired.');

    let verify: { ok: boolean; reason: string; message: string } | null;
    if (pluginOwner) verify = { ok: false, reason: 'plugin_lane', message: `The '${pluginOwner}' plugin serves MCP; start a new Claude Code session and check /mcp lists gbrain.` };
    else if (liveOwner?.ours) verify = { ok: true, reason: 'wired_running', message: `A live stdio serve (PID ${liveOwner.pid}) started by this registration holds the brain.` };
    else {
      const entry = desiredMcpEntry(plan) as { command: string; args: string[]; env: Record<string, string> };
      verify = await smokeStdioRegistration({ harness: 'claude-code', source: found.configPath, kind: 'stdio', command: entry.command, args: entry.args, env: entry.env });
    }
    const states = ['configured', ...(verify.ok ? ['connection-verified', 'native-pending'] : [])];
    const code = await finish(out, { dryRun: false, target: { ...target, registration_owner: pluginOwner ? 'plugin' : 'setup' }, consent: result.receipt.consent, steps: result.steps, states, verify, notices, notes,
      preserved: Object.keys(result.edited).map((event) => ({ kind: 'hook', event, reason: 'edited' })) });
    return verify.ok || pluginOwner ? code : 1;
  } catch (e) {
    if (e instanceof OperationError) return refuse(e, out);
    if (e instanceof SetupAbortInjected) { process.stderr.write(`${e.message}\n`); return 1; }
    process.stderr.write(`gbrain setup: ${(e as Error).message}\n`);
    return 1;
  }
}

function hostedConnection(url: string, wired: boolean, name: string): OperationError {
  return opError('setup_hosted_connection',
    `This machine already reaches a hosted brain (${url})${wired ? ` and Claude Code's '${name}' entry points at it` : ''}; gbrain setup will not create a second, local brain.`,
    wired ? 'Nothing to do: the hosted connection is wired. `gbrain doctor --only harness_wiring` verifies it.' : `Connect Claude Code to it with \`gbrain connect ${url} --harness claude-code --install\`.`,
    { docs: 'docs/guides/repair.md#setup-hosted-connection',
      fix: wired
        ? { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows which brain the registration reaches and smoke-tests it.' }
        : { argv: ['gbrain', 'connect', url, '--harness', 'claude-code', '--install'], consent: ['persistent_install', 'credentials'], actor: 'user', requires_exclusive: false,
          why: 'The hosted connection installer writes the Claude Code entry with the hosted credential.', user_message: `Your brain is hosted at ${url}. Run gbrain connect for it (it needs your private handoff); setup will not create a local brain.`,
          verify: { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] } } });
}

async function runRemove(flags: SetupFlags, receipt: ClaudeSetupReceipt | null, receiptPath: string, brainHome: string, out: Out): Promise<number> {
  if (!receipt) {
    say(out, `No gbrain setup receipt at ${receiptPath}; setup owns nothing here, so nothing was removed.`);
    return finish(out, { dryRun: flags.dryRun, remove: true, steps: [], states: [], verify: null, notices: [], notes: [] });
  }
  if (receipt.gbrain_home !== brainHome) {
    return refuse(ownerConflict('other_install', `The '${receipt.name}' connection belongs to the gbrain install at ${receipt.gbrain_home}, not ${brainHome}; --remove leaves it alone.`, {
      actor: 'user', why: `Run --remove with GBRAIN_HOME set to the install that owns it (${receipt.gbrain_home}).`, user_message: 'This setup belongs to another gbrain install; remove it from that install.' }), out);
  }
  const r = await removeClaudeSetup(receipt, receiptPath, { dryRun: flags.dryRun });
  for (const s of r.steps) say(out, `  ${(flags.dryRun ? `would ${s.action}` : s.action).padEnd(14)} ${s.step.padEnd(7)} ${s.detail}`);
  say(out, 'The brain, its notes and unrelated Claude Code settings were left as they were.');
  return finish(out, { dryRun: flags.dryRun, remove: true, steps: r.steps, states: [], verify: null, notices: [], notes: [], preserved: r.preserved });
}

async function finish(out: Out, doc: {
  dryRun: boolean; remove?: boolean; target?: Target; consent?: SetupConsent; steps: SetupStep[]; states: string[];
  verify: { ok: boolean; reason: string; message: string } | null; notices: unknown[]; notes: string[]; preserved?: unknown[];
}): Promise<number> {
  const state = doc.states.at(-1) ?? null;
  if (out.json) {
    await writeJsonDocument(`${JSON.stringify({
      harness: 'claude-code', dry_run: doc.dryRun, remove: doc.remove ?? false,
      ...(doc.target ? { target: doc.target } : {}), ...(doc.consent ? { consent: doc.consent } : {}),
      steps: doc.steps, preserved: doc.preserved ?? [], states: doc.states, state, verify: doc.verify,
      capability: capabilityRows('claude-code')[0], capability_table_version: SETUP_CAPABILITY_TABLE_VERSION,
      notes: doc.notes, notices: doc.notices,
    }, null, 2)}\n`, (t) => process.stdout.write(t));
    return 0;
  }
  if (doc.verify) say(out, `Verify: ${doc.verify.ok ? 'ok' : 'not verified'} (${doc.verify.reason}): ${doc.verify.message}`);
  if (state) say(out, `State: ${state} (${doc.states.join(' -> ')}). Native push is not claimed until an observed event reaches a fresh session.`);
  if (state && !doc.remove) say(out, 'Next: open a new Claude Code session (config is read at session start) and check that /mcp lists gbrain.');
  return 0;
}
