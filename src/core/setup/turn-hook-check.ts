/**
 * turn-hook-check.ts — is the per-turn brain-first hook wired, and does it
 * load? Read by doctor's harness_wiring check (`inspectTurnHook`, files only)
 * and by every install path (`verifyTurnHook`, which also runs the hook or
 * the harness's own inspect command), so an install whose hook cannot load
 * fails loudly with the command that shows why.
 *
 * Native inspect commands, per harness:
 *   Claude Code  /hooks inside a session (lists UserPromptSubmit hooks)
 *   Codex        /hooks inside a session (trust a hook there)
 *   OpenClaw     openclaw plugins inspect gbrain-turn-rule --runtime --json
 *   Hermes       hermes hooks doctor
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Action } from '../agent-output.ts';
import { bunSpawnSync } from '../spawn.ts';
import { codexHookCensus, codexHookGroupRuns, codexHookTrustHash } from '../bootstrap/codex-hooks.ts';
import { readCodexTomlTable } from '../bootstrap/codex-toml.ts';
import { classifyHarnessHook, hookEntryHash } from '../bootstrap/hooks.ts';
import { localSetupRecords } from './local-receipts.ts';
import { CLAUDE_SETTINGS_FILE_RELPATH, GBRAIN_HOOK_MARKER_KEY, GBRAIN_SETUP_MARKER_VALUE, claudeManagedSettingsPaths, claudeUserSettingsPath, codexConfigPath, codexHooksPath } from '../bootstrap/host-specs.ts';
import { hookLauncherInCommand, hookLauncherState, type HookLauncherState } from './hook-launcher.ts';
import type { LauncherLane } from './launcher-lanes.ts';
import { enabledPluginLanes } from '../bootstrap/plugin-lanes.ts';
import { brainFirstTarget, openclawConfigPath, parseJson5ish, readBrainFirstLedger } from './brain-first.ts';
import { inspectHermesTurnHook } from './hermes-turn-hook.ts';
import { OPENCLAW_TURN_PLUGIN_ID, openclawTurnPluginDir } from './openclaw-turn-plugin.ts';
import { isSkillResolverEntry } from './skill-resolver-lane.ts';
import { isOtherGbrainEntry, isTurnRuleEntry, isTurnRuleHarness, removeTurnRuleHook, syncTurnRuleHook, type TurnHookOutcome, type TurnHookPaths } from './turn-hook.ts';

export const TURN_HOOK_NATIVE_INSPECT: Record<string, string> = {
  'claude-code': '/hooks (inside a Claude Code session)',
  codex: '/hooks (inside a Codex session)',
  openclaw: `openclaw plugins inspect ${OPENCLAW_TURN_PLUGIN_ID} --runtime --json`,
  hermes: 'hermes hooks doctor',
};

export interface TurnHookState {
  harness: string;
  /** wired: a per-turn hook is configured; untrusted: configured but the harness will not run it yet; missing: none; not_supported: the harness has no per-turn hook gbrain can install. */
  state: 'wired' | 'untrusted' | 'missing' | 'not_supported';
  /** Which lane carries it. */
  via?: 'setup' | 'bootstrap' | 'turn-rule' | 'plugin' | 'native';
  detail: string;
  /** The hook command gbrain can run to prove it (Claude Code and Codex, not plugin lanes). */
  command?: string;
  /** The file the command came from. */
  source?: string;
  native_inspect?: string;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

function claudeEntries(path: string): Array<Record<string, unknown>> {
  const groups = (readJson(path)?.hooks as Record<string, unknown> | undefined)?.UserPromptSubmit;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : []))
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
}

const isGbrainPromptEntry = (e: Record<string, unknown>) =>
  !isSkillResolverEntry(e) && (isTurnRuleEntry(e) || typeof e[GBRAIN_HOOK_MARKER_KEY] === 'string' || !!classifyHarnessHook(e, 'UserPromptSubmit', 'any'));

/** Files only, no process run. `projectDir`: a project-scope Claude Code install's directory; `managedDir`: Claude Code's managed-settings directory (default: the system one). */
export function inspectTurnHook(harness: string, opts: { projectDir?: string; managedDir?: string } = {}): TurnHookState {
  const native_inspect = TURN_HOOK_NATIVE_INSPECT[harness];
  const plugin = enabledPluginLanes('gbrain').find((l) => l.harness === harness);
  if (harness === 'claude-code') {
    const files = [claudeUserSettingsPath(), ...(opts.projectDir ? [join(opts.projectDir, '.claude', 'settings.local.json'), join(opts.projectDir, '.claude', 'settings.json')] : []), ...claudeManagedSettingsPaths(opts.managedDir)];
    for (const path of files) {
      const committed = !!opts.projectDir && path === join(opts.projectDir, '.claude', 'settings.json');
      const entries = claudeEntries(path).filter((e) => isTurnRuleEntry(e) || isOtherGbrainEntry(e, committed));
      const effective = entries.find((e) => !isTurnRuleEntry(e)) ?? entries[0];
      if (effective) return { harness, state: 'wired', via: isTurnRuleEntry(effective) ? 'turn-rule' : effective[GBRAIN_HOOK_MARKER_KEY] === 'setup-v1' ? 'setup' : 'bootstrap', detail: `UserPromptSubmit hook in ${path}`, command: String(effective.command), source: path, native_inspect };
    }
    if (plugin) return { harness, state: 'wired', via: 'plugin', detail: `the '${plugin.plugin}' plugin declares the UserPromptSubmit hook`, native_inspect };
    return { harness, state: 'missing', detail: `no gbrain UserPromptSubmit hook in ${files.join(' or ')}`, native_inspect };
  }
  if (harness === 'codex') {
    let groups: ReturnType<typeof codexHookCensus> = [];
    try { groups = codexHookCensus(codexHooksPath()).filter((g) => g.event === 'UserPromptSubmit' && g.lane !== 'other'); } catch { /* unparseable: Codex skips it too */ }
    const g = groups.find((x) => x.lane !== 'turn-rule') ?? groups[0];
    if (g) {
      const command = g.commands[0]!;
      const key = `${codexHooksPath()}:user_prompt_submit:${g.index}:0`;
      let table: { trusted_hash?: unknown } | undefined;
      try { table = readCodexTomlTable(codexConfigPath(), ['hooks', 'state', key]) as typeof table; } catch { table = undefined; }
      const trusted = table?.trusted_hash === codexHookTrustHash('user_prompt_submit', command, 15) && (g.lane === 'turn-rule' || codexHookGroupRuns(codexHooksPath(), codexConfigPath(), g));
      return { harness, state: trusted ? 'wired' : 'untrusted', via: g.lane as TurnHookState['via'], command, native_inspect,
        detail: trusted ? `UserPromptSubmit hook in ${codexHooksPath()}, trusted in ${codexConfigPath()}` : `UserPromptSubmit hook in ${codexHooksPath()} has no matching trust entry in ${codexConfigPath()}, so Codex does not run it` };
    }
    if (plugin) return { harness, state: 'wired', via: 'plugin', detail: `the '${plugin.plugin}' plugin declares the UserPromptSubmit hook (Codex runs it once you trust it in /hooks)`, native_inspect };
    return { harness, state: 'missing', detail: `no gbrain UserPromptSubmit hook in ${codexHooksPath()}`, native_inspect };
  }
  if (harness === 'openclaw') {
    const dir = openclawTurnPluginDir();
    const cfg = existsSync(openclawConfigPath()) ? parseJson5ish(readFileSync(openclawConfigPath(), 'utf8')) as { plugins?: { entries?: Record<string, { enabled?: unknown; hooks?: { allowConversationAccess?: unknown } }> } } | undefined : undefined;
    const entry = cfg?.plugins?.entries?.[OPENCLAW_TURN_PLUGIN_ID];
    if (!existsSync(join(dir, 'index.js'))) return { harness, state: 'missing', detail: `no per-turn rule plugin at ${dir}`, native_inspect };
    if (!entry || entry.enabled === false) return { harness, state: 'missing', detail: `${dir} exists but ${openclawConfigPath()} does not enable ${OPENCLAW_TURN_PLUGIN_ID}`, native_inspect };
    if (entry.hooks?.allowConversationAccess !== true) return { harness, state: 'untrusted', via: 'native', detail: `${OPENCLAW_TURN_PLUGIN_ID} is enabled without plugins.entries.${OPENCLAW_TURN_PLUGIN_ID}.hooks.allowConversationAccess, so OpenClaw skips its before_prompt_build hook`, native_inspect };
    return { harness, state: 'wired', via: 'native', detail: `${OPENCLAW_TURN_PLUGIN_ID} (before_prompt_build) enabled in ${openclawConfigPath()}`, native_inspect };
  }
  if (harness === 'hermes') {
    const target = brainFirstTarget('hermes');
    const soul = 'error' in target ? '' : target.path;
    const recorded = readBrainFirstLedger().find((e) => e.harness === harness && e.path === soul && e.status === 'installed');
    const h = inspectHermesTurnHook(soul ? dirname(soul) : '', recorded?.access);
    if (h.state === 'absent') return { harness, state: 'missing', detail: `no gbrain pre_llm_call hook in ${h.path}`, native_inspect };
    if (h.state === 'unapproved') return { harness, state: 'untrusted', via: 'native', detail: `the gbrain pre_llm_call hook in ${h.path} is not in Hermes's shell-hooks-allowlist.json, so Hermes does not run it`, native_inspect };
    return { harness, state: 'wired', via: 'native', detail: `pre_llm_call hook in ${h.path}, approved`, native_inspect };
  }
  return { harness, state: 'not_supported', detail: `${harness} has no per-turn hook gbrain can install; the rule reaches it only through its instruction file` };
}

/**
 * A hook the setup or turn-rule lane wrote that would let the session
 * directory's bunfig.toml or .env load (#8424): its command starts gbrain in
 * the session's directory (written before the hook launcher existed), or the
 * launcher it names is missing, changed, or shares its directory with a file
 * gbrain did not write.
 */
export interface HookLauncherProblem {
  harness: 'claude-code' | 'codex' | 'opencode';
  /** setup and turn-rule: hooks; mcp, harness and bootstrap: the other lanes (launcher-lanes.ts), which carry their own rerun. */
  lane: 'setup' | 'turn-rule' | LauncherLane;
  /** The settings or hooks file holding the entry. */
  source: string;
  /** session_cwd: no launcher in the command; otherwise the launcher's state. */
  reason: 'session_cwd' | Exclude<HookLauncherState, 'current'>;
  detail: string;
  /** A setup entry the user edited after setup wrote it: setup keeps it as is, so only the user can move it. */
  edited?: boolean;
  /** The other lanes: the command that rewrites the entry, where to run it, and whether it is setup's own (an agent may run it). */
  rerun?: string[];
  rerunFrom?: string;
  setupOwned?: boolean;
  owner?: 'setup' | 'bootstrap' | 'none';
  /** The setup receipt that owns the hook, when its hash is recorded. */
  receiptPath?: string;
}

/** The hook hashes a harness's setup receipts own and the ones they record as edited by the user: Claude Code can drop the `_gbrain` marker on a rewrite, and setup owns its entries by hash. */
function setupReceiptHashes(harness: 'claude-code' | 'codex'): { owned: Map<string, string>; edited: Map<string, string> } {
  const owned = new Map<string, string>();
  const edited = new Map<string, string>();
  for (const r of localSetupRecords().filter((x) => x.harness === harness)) {
    const hooks = (readJson(r.path) as { hooks?: { owned?: Record<string, unknown>; pending?: Record<string, unknown>; edited?: Record<string, unknown> } } | null)?.hooks;
    for (const h of [...Object.values(hooks?.owned ?? {}), ...Object.values(hooks?.pending ?? {})]) if (typeof h === 'string') owned.set(h, r.path);
    for (const h of Object.values(hooks?.edited ?? {})) if (typeof h === 'string') edited.set(h, r.path);
  }
  return { owned, edited };
}

type LaneCommand = { lane: 'setup' | 'turn-rule'; command: string; edited?: boolean; receiptPath?: string };

function claudeLaneCommands(path: string, setup: { owned: Map<string, string>; edited: Map<string, string> }): LaneCommand[] {
  const hooks = readJson(path)?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const out: LaneCommand[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const e of groups.flatMap((g) => (Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : []))) {
      if (!e || typeof e !== 'object' || typeof (e as Record<string, unknown>).command !== 'string') continue;
      const entry = e as Record<string, unknown>;
      const hash = hookEntryHash(entry) ?? '';
      if (isTurnRuleEntry(entry)) out.push({ lane: 'turn-rule', command: entry.command as string });
      else if (setup.edited.has(hash)) out.push({ lane: 'setup', command: entry.command as string, edited: true, receiptPath: setup.edited.get(hash) });
      else if (entry[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_SETUP_MARKER_VALUE || setup.owned.has(hash)) out.push({ lane: 'setup', command: entry.command as string, receiptPath: setup.owned.get(hash) });
    }
  }
  return out;
}

/** Files only. Every event's setup and turn-rule entries, user scope plus `projectDir`'s settings.local.json (Claude Code). */
export function hookLauncherProblem(harness: 'claude-code' | 'codex', opts: { projectDir?: string } = {}): HookLauncherProblem | null {
  const found: Array<LaneCommand & { source: string }> = [];
  const setup = setupReceiptHashes(harness);
  if (harness === 'claude-code') {
    for (const source of [claudeUserSettingsPath(), ...(opts.projectDir ? [join(opts.projectDir, CLAUDE_SETTINGS_FILE_RELPATH)] : [])]) {
      found.push(...claudeLaneCommands(source, setup).map((c) => ({ ...c, source })));
    }
  } else {
    try {
      for (const g of codexHookCensus(codexHooksPath())) {
        if (g.lane === 'setup' || g.lane === 'turn-rule') found.push(...g.commands.map((command) => ({ lane: g.lane as 'setup' | 'turn-rule', command, source: codexHooksPath(), ...(setup.edited.has(g.hash) ? { edited: true } : {}), receiptPath: setup.owned.get(g.hash) ?? setup.edited.get(g.hash) })));
      }
    } catch { /* unparseable: Codex runs none of it */ }
  }
  for (const f of found) {
    const launcher = hookLauncherInCommand(f.command);
    if (!launcher) {
      return { harness, lane: f.lane, source: f.source, reason: 'session_cwd', ...(f.edited ? { edited: true } : {}), ...(f.receiptPath ? { receiptPath: f.receiptPath } : {}),
        detail: `gbrain's ${f.lane} hook in ${f.source} starts gbrain in the session's directory, so Bun loads that directory's bunfig.toml and .env before gbrain runs${f.edited ? '; it was edited after setup wrote it, so setup keeps it as is' : ''}` };
    }
    const s = hookLauncherState(launcher);
    if (s.state !== 'current') return { harness, lane: f.lane, source: f.source, reason: s.state, ...(f.receiptPath ? { receiptPath: f.receiptPath } : {}), detail: `gbrain's ${f.lane} hook in ${f.source} runs through ${launcher}, but ${s.detail}` };
  }
  return null;
}

type Run = (argv: string[], stdin?: string) => { ok: boolean; output: string };
/** Only what a hook needs to find the brain and the rule; never provider keys. */
function hookEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && /^(HOME|PATH|USER|LANG|TMPDIR|XDG_CONFIG_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME|GBRAIN_HOME|GBRAIN_AGENT_INSTRUCTIONS|GBRAIN_HOOKS)$/.test(e[0])));
}
const defaultRun: Run = (argv, stdin) => {
  try {
    // From the home directory: a project's own gbrain hook would make the turn-rule lane yield there.
    const r = bunSpawnSync(argv, { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env: hookEnv(), cwd: process.env.HOME || undefined, timeout: 60_000 });
    return { ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}` };
  } catch (e) { return { ok: false, output: (e as Error).message }; }
};
const which = (bin: string): string | null => { try { return Bun.which(bin, { PATH: process.env.PATH ?? '' }); } catch { return null; } };

export interface TurnHookVerdict { ok: boolean; state: TurnHookState; reason: string; message: string }

/**
 * Install-time proof that the hook loads: Claude Code and Codex run the
 * configured command once and look for the rule in its output; OpenClaw runs
 * its runtime inspect; Hermes runs `hermes hooks doctor`. A harness binary
 * that is not on PATH leaves the file-level answer standing.
 */
export function verifyTurnHook(harness: string, opts: { projectDir?: string; run?: Run; which?: (bin: string) => string | null } = {}): TurnHookVerdict {
  const run = opts.run ?? defaultRun;
  const find = opts.which ?? which;
  const state = inspectTurnHook(harness, opts);
  const fail = (reason: string, message: string): TurnHookVerdict => ({ ok: false, state, reason, message });
  if (state.state === 'not_supported') return { ok: true, state, reason: 'not_supported', message: state.detail };
  if (state.state === 'missing') return fail('missing', state.detail);
  if (state.state === 'untrusted') return fail('untrusted', state.detail);
  if (state.via === 'plugin') return { ok: true, state, reason: 'plugin_lane', message: `${state.detail}; check it with ${state.native_inspect}` };
  if ((harness === 'claude-code' || harness === 'codex') && state.command) {
    // A command from a project's settings file is the repo's, not the user's: never run it.
    if (harness === 'claude-code' && state.source !== claudeUserSettingsPath()) return { ok: true, state, reason: 'project_unverified', message: `${state.detail}; a hook outside the user settings file (project or managed) is not run here, so check it with ${state.native_inspect}` };
    const r = run(['sh', '-c', state.command], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '', session_id: 'gbrain-install-check' }));
    if (!r.ok) return fail('hook_failed', `the UserPromptSubmit hook exited non-zero (${r.output.trim().split('\n').at(-1) || 'no output'})`);
    if (!r.output.includes('GBrain: before answering')) return fail('no_rule', 'the UserPromptSubmit hook ran but did not add the brain-first rule (is the brain-first block installed for this harness?)');
    return { ok: true, state, reason: 'ran', message: `${state.detail}; it ran and added the rule` };
  }
  if (harness === 'openclaw') {
    const bin = find('openclaw');
    if (!bin) return { ok: true, state, reason: 'native_unavailable', message: `${state.detail}; openclaw is not on PATH, so run ${state.native_inspect} on the OpenClaw host` };
    const r = run([bin, 'plugins', 'inspect', OPENCLAW_TURN_PLUGIN_ID, '--runtime', '--json']);
    const loaded = r.ok && r.output.includes('before_prompt_build') && /"(?:status)"\s*:\s*"loaded"|"imported"\s*:\s*true/.test(r.output) && !/"status"\s*:\s*"(?:error|disabled)"/.test(r.output);
    return loaded ? { ok: true, state, reason: 'ran', message: `${state.detail}; openclaw loads it with before_prompt_build` }
      : fail('not_loaded', `\`${state.native_inspect}\` does not show ${OPENCLAW_TURN_PLUGIN_ID} loaded with before_prompt_build`);
  }
  if (harness === 'hermes') {
    const bin = find('hermes');
    if (!bin) return { ok: true, state, reason: 'native_unavailable', message: `${state.detail}; hermes is not on PATH, so run ${state.native_inspect} on the Hermes host` };
    const r = run([bin, 'hooks', 'doctor']);
    const block = r.output.split(/\n(?=\s*\[)/).find((b) => /\[pre_llm_call\]/.test(b) && b.includes('GBrain'));
    if (!r.ok || !block) return fail('not_loaded', `\`hermes hooks doctor\` does not list gbrain's pre_llm_call hook`);
    if (/✗|⚠/.test(block)) return fail('not_loaded', `\`hermes hooks doctor\` reports a problem with gbrain's pre_llm_call hook: ${block.split('\n').filter((l) => /✗|⚠/.test(l)).map((l) => l.trim()).join(' ')}`);
    return { ok: true, state, reason: 'ran', message: `${state.detail}; hermes hooks doctor reports it healthy` };
  }
  return { ok: true, state, reason: 'wired', message: state.detail };
}

/**
 * The operator-protocol fix for a hook that is missing or does not load:
 * re-run the install that writes it, then verify with the harness's own
 * inspect command (OpenClaw, Hermes) or doctor (Claude Code, Codex, whose
 * inspect is the in-session /hooks menu).
 */
export function turnHookFix(harness: string, rerun: string[]): Action {
  const native = TURN_HOOK_NATIVE_INSPECT[harness];
  const verify = harness === 'openclaw' ? ['openclaw', 'plugins', 'inspect', OPENCLAW_TURN_PLUGIN_ID, '--runtime', '--json']
    : harness === 'hermes' ? ['hermes', 'hooks', 'doctor'] : ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'];
  return { argv: rerun, consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: { argv: verify },
    why: `Writes the per-turn hook that puts "check gbrain first" next to every turn; without it agents rarely use the brain. ${native ? `The harness's own check: ${native}.` : ''}`.trim() };
}

/**
 * The installer lanes' per-turn hook (`gbrain connect --install`, the hosted
 * harness install, `gbrain bootstrap harness`): with the brain-first block
 * accepted, install the turn-rule hook unless another gbrain lane already
 * carries the rule, then prove it loads; declined, remove it. opencode and
 * other clients get `not_supported` (no per-turn hook to install).
 */
export function installerTurnHook(opts: { harness: string; accepted: boolean; gbrainBin: string | null; gbrainHome?: string; paths?: TurnHookPaths; rerun: string; verify?: boolean }): { outcome: TurnHookOutcome; verdict: TurnHookVerdict | null } {
  const { harness } = opts;
  if (!isTurnRuleHarness(harness)) {
    return { outcome: { harness, action: 'skip', path: '', detail: `${harness} has no per-turn hook gbrain can install; the rule reaches it through its instruction file only` }, verdict: null };
  }
  if (!opts.accepted) return { outcome: removeTurnRuleHook({ harness, paths: opts.paths }), verdict: null };
  if (process.env.GBRAIN_HOOKS === '0') return { outcome: { harness, action: 'skip', path: '', detail: 'GBRAIN_HOOKS=0 is set: no per-turn hook installed' }, verdict: null };
  const carried = opts.paths ? null : inspectTurnHook(harness);
  const outcome = carried && carried.state !== 'missing' && carried.via !== 'turn-rule'
    ? { harness, action: 'skip' as const, path: '', detail: `per-turn rule already carried: ${carried.detail}` }
    : syncTurnRuleHook({ harness, gbrainBin: opts.gbrainBin, gbrainHome: opts.gbrainHome, paths: opts.paths, rerun: opts.rerun });
  // Nothing was installed and the outcome names the step that does it: reported, never a failed install.
  if (outcome.action === 'print') return { outcome, verdict: null };
  return { outcome, verdict: opts.verify === false || opts.paths ? null : verifyTurnHook(harness) };
}
