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
import { basename, dirname, join, resolve } from 'node:path';
import { removeHermesTurnHook, syncHermesTurnHook } from '../core/setup/hermes-turn-hook.ts';
import { removeOpenclawTurnPlugin, syncOpenclawTurnPlugin } from '../core/setup/openclaw-turn-plugin.ts';
import { describeOpenclawSkill, readOpenclawSkillState, removeOpenclawSkillPlugin, syncOpenclawSkillPlugin, type OpenclawSkillResult } from '../core/setup/openclaw-skill-plugin.ts';
import { describePiSkill, readPiSkillState, removePiSkillExtension, syncPiSkillExtension } from '../core/setup/pi-skill-extension.ts';
import { hasTurnRuleHook, isTurnRuleHarness, removeTurnRuleHook, syncTurnRuleHook, type TurnHookOutcome, type TurnRuleHarness } from '../core/setup/turn-hook.ts';
import { inspectTurnHook, TURN_HOOK_NATIVE_INSPECT, turnHookFix, verifyTurnHook, type TurnHookVerdict } from '../core/setup/turn-hook-check.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { cliRenderContext, docsUrl, renderCliError, renderNotice, type Action, type Notice } from '../core/agent-output.ts';
import { writeCliNotices } from '../core/interop-notices.ts';
import { BOT_HARNESSES, renderedExposure, sharedTokenNotice, writeExposureNotice, type ExposureServes } from '../core/grants/shared-exposure.ts';
import { claudeCodeChannelPlugins } from './shared-exposure-local.ts';
import { setupFirstRunNotices } from './init-first-run.ts';
import { hostedOptionMuted, hostedOptionNotice, writeHostedOption } from '../core/onboard/hosted-option.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';
import { configDir, gbrainPath, isThinClient, loadConfig, type GBrainConfig } from '../core/config.ts';
import { resolveGbrainBin } from '../core/gbrain-bin.ts';
import { exitCodeForCode } from '../core/error-catalogue.ts';
import { parseStdioMemberFlag } from '../core/stdio-member-flag.ts';
import { isRegistrationSurface, isValidName, REGISTRATION_SURFACE, registrationAdvertise, stdioServeArgv } from '../core/mcp-registration.ts';
import { hookLauncherPath } from '../core/setup/hook-launcher.ts';
import { readResolverConfig, resolverHarnesses } from '../core/setup/skill-resolver-config.ts';
import { describeCursorPins, readCursorPinsState, removeCursorSkillPins, syncCursorSkillPins, type CursorPinsResult } from '../core/setup/cursor-skill-pins.ts';
import { describeResolverSetup, removeSkillResolverSetup, syncSkillResolverSetup, type ResolverSetupResult } from '../core/setup/skill-resolver-setup.ts';
import type { ResolverHarness } from '../core/setup/skill-resolver-hook.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { peekLock } from '../core/pglite-lock.ts';
import { claudePluginProvidesName, codexPluginProvidesName } from '../core/bootstrap/plugin-lanes.ts';
import { claudeUserSettingsPath, type ClaudeHookEvent } from '../core/bootstrap/host-specs.ts';
import { readHarnessReceiptState } from '../core/bootstrap/format.ts';
import { smokeStdioRegistration } from './doctor/checks/harness-wiring.ts';
import { finishFreshSetupMigrations } from './setup-migrations.ts';
import { readServesStatus, sharedStdioHarness, servesApply, servesLines, servesOk, servesPreflight, type EntryBinding, type ServesOutcome } from './setup-serves.ts';
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
import {
  applyCodexSetup,
  codexSetupPaths,
  desiredCodexMcpEntry,
  inspectCodexSetup,
  readCodexSetupReceipt,
  removeCodexSetup,
  type CodexSetupPlan,
  type CodexSetupReceipt,
  type CodexSetupStep,
} from '../core/setup/codex.ts';
import type { CodexSetupEvent } from '../core/bootstrap/codex-hooks.ts';
import {
  describeSkillsBlockOutcome,
  skillsOutcomeShown,
  InvalidSkillLoadingEnv,
  isSkillLoading,
  indexLauncher,
  readSkillLoadingLedger,
  refreshSkillsIndexes,
  removeSkillsBlock,
  installerSkillsBlock,
  SKILL_LOADING_ENV,
  skillsOutcomeFailed,
  type SkillLoading,
  type SkillsBlockOutcome,
} from '../core/setup/skills-block.ts';
import {
  BRAIN_FIRST_HARNESSES,
  brainFirstTarget,
  describeBrainFirstOutcome,
  isBrainFirstHarness,
  priorBrainFirst,
  readBrainFirstLedger,
  removeBrainFirst,
  renderBrainFirstSnippet,
  resolveBrainFirstDecision,
  syncBrainFirst,
  type BrainFirstAccess,
  type BrainFirstHarness,
  type BrainFirstOutcome,
} from '../core/setup/brain-first.ts';
import { HARNESS_ADAPTERS } from '../core/harness/registry.ts';

export const SETUP_HELP = `gbrain setup <harness> — give an agent harness memory in one command

Usage: gbrain setup claude-code [flags]
       gbrain setup codex [flags]

Resolves the brain, source, transport, launcher and registration owner first and
prints them; refuses before writing anything when another owner holds the target.
With no brain configured it creates a keyless local one (gbrain init --pglite
--no-embedding). It then writes the MCP entry and hooks into the harness's own
config and verifies them with the harness_wiring smoke. Codex: [mcp_servers.<name>]
and the hook trust entries in $CODEX_HOME/config.toml, the hooks in hooks.json.

Flags:
  --dry-run            Print the target and every step; write nothing.
  --json               One JSON document on stdout (target, decisions, steps, states).
  --surface S          MCP tool surface: verbs, starter or full, listed in full (default:
                       GBRAIN_SURFACE, then the surface already registered, then starter
                       with only the memory verbs and request_tools listed:
                       serve --surface starter --advertise verbs; full is the opt-in for
                       every operation).
  --scope user|project Wiring scope: every Claude Code session (user, default) or only
                       sessions in this directory (project: ~/.claude.json projects
                       entry + .claude/settings.local.json). Codex: user only.
  --no-hooks           Register MCP only; install no hooks (GBRAIN_HOOKS=0 does the same).
  --capture            Accept automatic capture: also install the capture hooks
                       (Claude Code: Stop and SessionEnd; Codex: SessionEnd).
  --no-capture         Decline automatic capture (the default).
  --providers          Accept provider use: a new brain is created with embeddings.
  --no-providers       Decline provider use (the default: keyless, no paid calls).
  --name NAME          MCP server name (default gbrain); one name per install.
  --source ID          Pin the source the MCP server and hooks use.
  --gbrain-bin PATH    Absolute gbrain launcher (default: the gbrain on PATH).
  --serves one|several Whom the brain serves (default one: nothing changes). several labels each
                       person: config access.serves = several, a member, a folder rule
                       people/<member>/ only that member reads and one key bound to that member
                       (a 0600 file under <config>/member-keys/), then one bound read per member
                       proves it. A one-person setup on a brain that already serves several
                       people (2+ enabled members) refuses rather than write a connection bound
                       to nobody, unless this harness's entry or config mcp.stdio_member binds it.
  --members IDS        The people of --serves several, comma-separated (e.g. alice-example,bob-example).
  --labelled-only      With --serves several: each member's key reads only pages labelled for
                       that member (readable_by or a rule), never the owner's. Opt-in.
  --members-file PATH  The same, one id per line.
  --stdio-member ID    claude-code or codex: write serve --stdio-member ID into this harness's
                       MCP entry, so only its sessions read as ID (an enabled member, or one
                       of --members). Other harnesses on this host are unchanged. Use it for a
                       harness only ID uses; refused where OpenClaw or Hermes is installed
                       (give each person their own HTTP key there). A re-run keeps the entry's
                       member; setup never adds one on its own.
  --no-stdio-member    Remove --stdio-member from this harness's entry.
  --remove             Remove exactly what setup wrote (unchanged entries only), the
                       brain-first instruction block included. The brain and your
                       notes stay. Combine with --dry-run to preview.
  --no-instructions    Opt out of the brain-first instruction block (see below); an
                       existing block is removed and the opt-out is remembered.
                       GBRAIN_AGENT_INSTRUCTIONS=0 does the same.
  --instructions       Opt back in after an earlier --no-instructions.
  --instructions-only  Manage only the brain-first block (on OpenClaw and Hermes, with
                       its per-turn hook): no brain, MCP or other hook changes.
                       Works for a hosted connection too, and for any harness below.
  --workspace DIR      OpenClaw: the agent workspace whose AGENTS.md gets the block
                       (default: agents.defaults.workspace, then ~/.openclaw/workspace).
  --skill-loading M    off (default), spring or resolve. spring adds a compact index of
                       gbrain's bundled skills beside the brain-first block (about
                       1.5k tokens) and loads a skill's full text only when a task
                       matches (gbrain bundled-skill <name>, from this gbrain).
                       resolve (claude-code, codex, hermes) indexes the harness's own
                       skills (~/.claude/skills; Codex: ~/.agents/skills,
                       CODEX_HOME/skills; Hermes: $HERMES_HOME/skills) and adds a
                       separate per-turn hook that names the few skills that fit
                       each prompt (word match; nothing leaves the machine).
                       gbrain setup pi --skill-loading resolve does the same for
                       Pi with an extension in $PI_CODING_AGENT_DIR/extensions.
                       gbrain setup cursor --skill-loading resolve, run in a project,
                       gives Cursor that project's pinned skills only (gbrain skills
                       pin) in .cursor/rules/gbrain-pinned-skills.mdc, kept out of
                       commits; Cursor has no per-turn hook gbrain can use.
                       off removes what an earlier run wrote. The
                       choice is remembered; GBRAIN_SKILL_LOADING sets it too.
  --skills-index-only  Refresh every skills index recorded for this harness (its
                       file, launcher and skill set as recorded) and change
                       nothing else; with --skill-loading off, remove them.

Brain-first instructions: registering MCP is not enough; agents use a brain they
are told about. By default setup also writes one short marked block into the
harness's own instruction file (before answering any turn, search the brain
first, read the hit, fill gaps with other tools, apply your own access rules,
finish the task). Text outside the markers is never touched; a re-run upgrades
the block in place. The same rule rides each turn where the harness has a per-turn
hook: Claude Code and Codex get it from setup's UserPromptSubmit hook, OpenClaw
from a hook-only plugin (before_prompt_build) setup installs with the openclaw
CLI, Hermes from a marked pre_llm_call hook setup adds to $HERMES_HOME/config.yaml;
Cursor's rule is always applied.
  claude-code  ~/.claude/CLAUDE.md (project scope: ./CLAUDE.local.md)
  codex        $CODEX_HOME/AGENTS.md (a non-empty AGENTS.override.md instead)
  opencode     ~/.config/opencode/AGENTS.md
  openclaw     <workspace>/AGENTS.md
  hermes       $HERMES_HOME/SOUL.md, after the identity text (never created: an
               empty SOUL.md would replace Hermes's default identity)
  cursor       ./.cursor/rules/gbrain-brain-first.mdc (project rule)
  Other clients (Claude Desktop, ChatGPT, Perplexity, Grok, Muse): --instructions-only
  prints the block to paste into the client's custom instructions.

States: configured (entries written), connection-verified (the smoke answered),
native-pending (no observed push into a native session yet), native-verified (an
observed push is on record for this harness and setup wired and trusted that event;
Codex: UserPromptSubmit, codex-cli 0.162.1).

Refusals: setup never starts a second owner or a second brain. A hosted brain is
wired with gbrain connect <url> --harness <harness> --install; a running
serve --http owner with gbrain bootstrap harness --harness <harness> --yes.

Supported harnesses: claude-code, codex (MCP, hooks and instructions). opencode,
openclaw, hermes and cursor: setup writes the instruction block and prints the MCP
registration step from their guide.
setup and onboard differ: setup wires a harness to a brain; onboard (post-connect)
improves an existing brain's content.
`;

type SetupHarnessId = 'claude-code' | 'codex';
const HARNESS_LABEL: Record<SetupHarnessId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

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
  instructions?: boolean;
  instructionsOnly: boolean;
  skillsIndexOnly: boolean;
  workspace?: string;
  skillLoading?: SkillLoading;
  /** --skill-loading resolve turns the skill-resolver lane on (skill-resolver-setup.ts); off or spring turns it off; unset leaves it as it is. OpenClaw also takes shadow. */
  skillResolver?: 'on' | 'shadow' | 'off';
  /** OpenClaw: the agents --skill-loading applies to (--agent <id>, repeatable, or --all-agents); unset means the agents already on, else main. */
  agents?: string[] | 'all';
  /** OpenClaw rollout knobs written to the plugin's state (hot, no reload): --live-fraction, --pins-route, --owner-sender. */
  openclawTuning?: { live_fraction?: number; pins_route?: 'system' | 'first_turn'; owner_sender_ids?: string[] };
  /** GST-363: whom the brain serves; several labels each person (setup-serves.ts). */
  serves?: 'one' | 'several';
  members?: string;
  membersFile?: string;
  /** GST-2670: --labelled-only, passed to access serves several. */
  labelledOnly?: boolean;
  /** GST-363: written into this harness's MCP entry as serve --stdio-member; never into config. */
  stdioMember?: string;
  noStdioMember: boolean;
}

const VALUE_FLAGS = new Set(['--surface', '--scope', '--name', '--source', '--gbrain-bin', '--workspace', '--skill-loading', '--agent', '--live-fraction', '--pins-route', '--owner-sender', '--serves', '--members', '--members-file', '--stdio-member']);

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
  if (args.includes('--instructions') && args.includes('--no-instructions')) return 'pass --instructions or --no-instructions, not both';
  const serves = value('--serves');
  if (serves !== undefined && serves !== 'one' && serves !== 'several') return `unknown --serves '${serves}'; pass one or several`;
  if ((args.includes('--members') || args.includes('--members-file')) && serves !== 'several') return '--members and --members-file name the people of --serves several';
  if (args.includes('--labelled-only') && serves !== 'several') return '--labelled-only applies to the people of --serves several';
  let stdioMember: string | undefined;
  try { stdioMember = parseStdioMemberFlag(args); } catch (e) { return `${(e as Error).message}; nothing was written`; }
  const noStdioMember = args.includes('--no-stdio-member');
  if (stdioMember !== undefined && noStdioMember) return 'pass --stdio-member or --no-stdio-member, not both';
  const memberFlag = stdioMember !== undefined ? '--stdio-member' : noStdioMember ? '--no-stdio-member' : null;
  if (memberFlag && (!['claude-code', 'codex'].includes(positionals[0] ?? '') || args.includes('--instructions-only') || args.includes('--remove'))) return `${memberFlag} changes the stdio MCP entry setup writes for claude-code or codex (not --instructions-only or --remove); nothing was written`;
  const shared = stdioMember === undefined ? null : sharedStdioHarness();
  if (shared) return `--stdio-member refused: ${shared} is installed on this host, and its sessions serve several people, so a stdio entry bound to one member is not something setup writes here; give each person their own key over HTTP instead (gbrain serve --http with gbrain auth create <name> --member <id> per person); nothing was written`;
  const workspace = value('--workspace');
  if (workspace !== undefined && !workspace.startsWith('/') && !workspace.startsWith('~')) return '--workspace needs an absolute path';
  const flagLoading = value('--skill-loading');
  if (flagLoading !== undefined && flagLoading !== 'resolve' && flagLoading !== 'shadow' && !isSkillLoading(flagLoading)) return `unknown --skill-loading '${flagLoading}'; pass off, spring, resolve or (openclaw) shadow`;
  const envLoading = process.env[SKILL_LOADING_ENV]?.trim();
  if (flagLoading === undefined && envLoading && envLoading !== 'resolve' && !isSkillLoading(envLoading)) return new InvalidSkillLoadingEnv(envLoading).message;
  const openclaw = positionals[0] === 'openclaw';
  const resolverHarness = positionals[0] === 'claude-code' || positionals[0] === 'codex' || positionals[0] === 'hermes' || positionals[0] === 'pi' || positionals[0] === 'cursor' || openclaw;
  if (flagLoading === 'resolve' && !resolverHarness) return '--skill-loading resolve wires Claude Code, Codex, Hermes, OpenClaw and Pi, and pinned skills for Cursor (claude-code, codex, cursor, hermes, openclaw, pi); other harnesses call gbrain skills resolve from their own adapter (docs/guides/skill-resolver.md)';
  if (flagLoading === 'shadow' && !openclaw) return '--skill-loading shadow is for openclaw only (it resolves and logs each turn without showing the model anything)';
  const agentFlags = args.flatMap((a, i) => (a === '--agent' ? [args[i + 1] ?? ''] : []));
  if (agentFlags.some((a) => !/^[\w.@:-]{1,128}$/.test(a))) return '--agent needs an OpenClaw agent id';
  if ((agentFlags.length || args.includes('--all-agents')) && !openclaw) return '--agent and --all-agents are for openclaw only';
  if (agentFlags.length && args.includes('--all-agents')) return 'pass --agent or --all-agents, not both';
  const liveFraction = value('--live-fraction');
  const pinsRoute = value('--pins-route');
  const owners = args.flatMap((a, i) => (a === '--owner-sender' ? [args[i + 1] ?? ''] : []));
  if ((liveFraction !== undefined || pinsRoute !== undefined || owners.length) && !openclaw) return '--live-fraction, --pins-route and --owner-sender are for openclaw only';
  if (liveFraction !== undefined && !(/^(0(\.\d+)?|1(\.0+)?)$/.test(liveFraction))) return '--live-fraction must be a number from 0 to 1 (the share of sessions that see suggestions; the rest are logged as control)';
  if (pinsRoute !== undefined && pinsRoute !== 'system' && pinsRoute !== 'first_turn') return '--pins-route must be system (appendSystemContext, every turn) or first_turn (appendContext on a session\'s first turn and after compaction)';
  if (owners.some((o) => !/^[\x21-\x7e]{1,128}$/.test(o))) return '--owner-sender needs a sender id';
  const openclawTuning = { ...(liveFraction !== undefined ? { live_fraction: Number(liveFraction) } : {}), ...(pinsRoute ? { pins_route: pinsRoute as 'system' | 'first_turn' } : {}), ...(owners.length ? { owner_sender_ids: owners } : {}) };
  const chosenLoading = flagLoading ?? (envLoading || undefined);
  const cursor = positionals[0] === 'cursor';
  const skillResolver = !resolverHarness || chosenLoading === undefined || (cursor && chosenLoading === 'spring') ? undefined : chosenLoading === 'resolve' ? 'on' as const : chosenLoading === 'shadow' ? 'shadow' as const : 'off' as const;
  // resolve replaces the spring index (on Cursor the pins sit beside it, so neither run removes the other): the skills block is decided as off, explicitly, so GBRAIN_SKILL_LOADING=resolve is never read as a block mode.
  const skillLoading = skillResolver === 'on' || skillResolver === 'shadow' ? (cursor ? undefined : 'off') : flagLoading;
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
    instructions: args.includes('--instructions') ? true : args.includes('--no-instructions') ? false : undefined,
    instructionsOnly: args.includes('--instructions-only'),
    skillsIndexOnly: args.includes('--skills-index-only'),
    workspace,
    skillLoading: skillLoading as SkillLoading | undefined,
    ...(skillResolver ? { skillResolver } : {}),
    ...(agentFlags.length ? { agents: agentFlags } : args.includes('--all-agents') ? { agents: 'all' as const } : {}),
    ...(Object.keys(openclawTuning).length ? { openclawTuning } : {}),
    ...(serves ? { serves: serves as 'one' | 'several' } : {}),
    ...(value('--members') !== undefined ? { members: value('--members') } : {}),
    ...(value('--members-file') !== undefined ? { membersFile: value('--members-file') } : {}),
    ...(args.includes('--labelled-only') ? { labelledOnly: true } : {}),
    ...(stdioMember !== undefined ? { stdioMember } : {}),
    noStdioMember,
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
  advertise?: McpSurface;
  /** GST-363: the serve --stdio-member this entry carries. */
  stdio_member?: string;
  registration_owner: 'none' | 'setup' | 'plugin';
  live_owner: { pid: number; transport: 'stdio' | 'http'; ours: boolean } | null;
  scope: WiringScope;
  name: string;
  config_path: string;
  settings_path?: string;
  hooks_path?: string;
  receipt_path: string;
}

function resolveConsent(flags: SetupFlags, prior: { consent: SetupConsent } | null, cfg: GBrainConfig | null, scope: WiringScope, notes: string[]): SetupConsent {
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

function hookEvents<E extends string>(consent: SetupConsent, harness: SetupHarnessId): E[] {
  if (consent.wiring_scope.value.hooks === 'none') return [];
  const row = capabilityRows(harness)[0]!;
  return [...row.read_events, ...(consent.capture.value === 'accepted' ? row.capture_events : [])] as E[];
}

function describeTarget(t: Target, out: Out, harness: SetupHarnessId = 'claude-code'): void {
  const brain = t.brain.kind === 'new-local-pglite' ? `new keyless PGLite brain at ${t.brain.path} (gbrain init --pglite --no-embedding)`
    : t.brain.kind === 'local-pglite' ? `existing PGLite brain at ${t.brain.path}` : 'existing Postgres brain (from this install\'s config)';
  say(out, `Target (${HARNESS_LABEL[harness]}, ${t.scope} scope):`);
  say(out, `  brain      ${brain}`);
  say(out, `  source     ${t.source.id ? `'${t.source.id}' (pinned, from ${t.source.from === 'flag' ? '--source' : 'GBRAIN_SOURCE'})` : 'the brain\'s default source (unpinned)'}`);
  say(out, `  transport  stdio MCP: ${[hookLauncherPath(t.brain.config_dir), ...stdioServeArgv(t.launcher, t.surface, t.advertise ?? null, t.stdio_member)].join(' ')}${t.advertise ? ` (lists the ${t.advertise === 'verbs' ? 'memory verbs and request_tools' : `${t.advertise} tools`}; every ${t.surface} tool stays callable)` : ''}`);
  say(out, `  owner      ${t.registration_owner === 'setup' ? `this setup (${t.receipt_path})` : t.registration_owner === 'plugin' ? `the gbrain ${HARNESS_LABEL[harness]} plugin (MCP); setup adds hooks only` : `none yet; setup will own '${t.name}'`}`);
  if (t.live_owner) say(out, `  live       gbrain ${t.live_owner.transport === 'http' ? 'serve --http' : 'stdio serve'} PID ${t.live_owner.pid}${t.live_owner.ours ? ' (started by this registration)' : ''}`);
  say(out, `  files      ${t.config_path} (MCP${t.hooks_path ? ' + hook trust' : ''}), ${t.hooks_path ?? t.settings_path} (hooks)`);
}

function describeConsent(c: SetupConsent, events: string[], out: Out, harness: SetupHarnessId = 'claude-code'): void {
  const src = (s: string) => `[${s}]`;
  const captureEvents = capabilityRows(harness)[0]!.capture_events;
  say(out, 'Decisions:');
  say(out, `  wiring     ${c.wiring_scope.value.scope} scope; ${events.length ? `hooks ${events.join(', ')}` : 'no hooks'} ${src(c.wiring_scope.source)}`);
  say(out, `  capture    ${c.capture.value}${c.capture.value === 'declined' ? ` (no ${captureEvents.join('/')} hooks, no transcript capture; accept with --capture)` : ` (${captureEvents.join(' and ')} hook${captureEvents.length > 1 ? 's' : ''})`} ${src(c.capture.source)}`);
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
  const adapter = HARNESS_ADAPTERS.find((a) => a.id === flags.harness);
  const mcpWired = flags.harness === 'claude-code' || flags.harness === 'codex';
  if (flags.harness === 'pi') return runPiSetup(flags, out);
  if (flags.skillsIndexOnly) return runSkillsIndexOnly(flags, out);
  if ((flags.instructionsOnly && (isBrainFirstHarness(flags.harness) || adapter)) || (isBrainFirstHarness(flags.harness) && !mcpWired)) {
    return runInstructionsOnly(flags, out);
  }
  if (!isSetupHarness(flags.harness) || capabilityRows(flags.harness).every((r) => r.setup !== 'supported')) {
    const rows = isSetupHarness(flags.harness) ? capabilityRows(flags.harness) : [];
    const guide = rows[0]?.docs;
    const named = flags.harness ? `'${flags.harness}'` : 'no harness';
    return refuse(opError('setup_harness_unsupported',
      `gbrain setup does not wire ${named} yet. ${guide ? `Follow ${guide} to connect it by hand.` : `Supported: ${SETUP_CAPABILITIES.filter((r) => r.setup === 'supported').map((r) => r.harness).join(', ')}; known: ${SETUP_HARNESSES.join(', ')}.`}`,
      guide ? `Follow ${guide}.` : 'Run `gbrain setup claude-code` or `gbrain setup codex`.',
      { reason: guide ? 'harness_not_wired' : 'unknown_harness', docs: 'docs/guides/repair.md#setup-harness-unsupported',
        fix: { consent: [], actor: 'user', requires_exclusive: false, why: guide ? `The manual steps for this harness are in ${guide}.` : 'Setup wires the harnesses in its capability table.',
          user_message: guide ? `gbrain setup can't wire ${flags.harness} yet; the steps are in ${guide}.` : 'Pick a supported harness: gbrain setup claude-code or gbrain setup codex.',
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
  if (flags.harness === 'codex') {
    if (flags.scope === 'project') {
      process.stderr.write('gbrain setup: codex is wired at user scope only (its hooks.json and config.toml live in CODEX_HOME); drop --scope project.\n');
      return 2;
    }
    return runCodexSetup(flags, launcher, cfg, brainHome, out);
  }
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
    const chosenSurface = flags.surface ?? (isRegistrationSurface(envSurface) ? envSurface : undefined);
    const surface: McpSurface = chosenSurface ?? prior?.surface ?? REGISTRATION_SURFACE;
    const advertise = registrationAdvertise({ userChoseSurface: chosenSurface !== undefined, prior });
    const sourceId = flags.source ?? (process.env.GBRAIN_SOURCE && isValidSourceId(process.env.GBRAIN_SOURCE) ? process.env.GBRAIN_SOURCE : null);
    let plan: ClaudeSetupPlan = {
      name: flags.name, scope, ...(projectDir ? { projectDir } : {}), launcher, brainHome,
      ...(process.env.GBRAIN_HOME?.trim() ? { gbrainHomeEnv: process.env.GBRAIN_HOME.trim() } : {}),
      sourceId, surface, advertise, events: hookEvents<ClaudeHookEvent>(consent, 'claude-code'),
    };
    let found = inspectClaudeSetup(plan);
    // An entry identical to setup's own except that it lists everything (the form before the verbs listing default) is kept as it is.
    if (found.mcp.state === 'unowned' && !prior && chosenSurface === undefined && plan.advertise) {
      const listed: ClaudeSetupPlan = { ...plan, advertise: null };
      const again = inspectClaudeSetup(listed);
      if (again.mcp.state === 'current') { plan = listed; found = again; }
    }
    const binding = entryBinding(flags, found.mcp.stdioMember);
    if (binding.member) { plan = { ...plan, stdioMember: binding.member }; found = inspectClaudeSetup(plan); }
    if (found.mcp.state === 'remote') return refuse(hostedConnection(found.mcp.url ?? 'a hosted brain', true, flags.name), out);

    const pluginOwner = flags.name === 'gbrain' ? claudePluginProvidesName(claudeUserSettingsPath(), 'gbrain') : null;
    if (pluginOwner && flags.stdioMember !== undefined) return refuse(pluginBindingRefusal(pluginOwner, 'claude-code', flags.stdioMember), out);
    const { dataDir, liveOwner } = liveOwnerOf(cfg, prior?.status === 'installed' && (found.mcp.state === 'current' || found.mcp.state === 'owned'));
    const target: Target = {
      brain: !cfg ? { kind: 'new-local-pglite', path: gbrainPath('brain.pglite'), config_dir: brainHome }
        : cfg.engine === 'pglite' ? { kind: 'local-pglite', path: dataDir, config_dir: brainHome } : { kind: 'local-postgres', config_dir: brainHome },
      source: { id: sourceId, pinned: sourceId !== null, from: flags.source ? 'flag' : sourceId ? 'env' : 'brain-default' },
      transport: 'local-stdio', launcher, surface, ...(plan.advertise ? { advertise: plan.advertise } : {}), ...(plan.stdioMember ? { stdio_member: plan.stdioMember } : {}),
      registration_owner: pluginOwner ? 'plugin' : prior ? 'setup' : 'none',
      live_owner: liveOwner, scope, name: flags.name,
      config_path: found.configPath, settings_path: found.settingsPath, receipt_path: found.receiptPath,
    };
    describeTarget(target, out);
    describeConsent(consent, plan.events, out);
    for (const n of notes) say(out, `note: ${n}`);

    if (liveOwner && !liveOwner.ours) return refuse(liveServeConflict(liveOwner, 'claude-code', flags.name), out);
    if (found.mcp.state === 'unowned' && !pluginOwner) {
      return refuse(ownerConflict('unowned_entry', `${found.configPath} already has an MCP server named '${flags.name}' that gbrain setup did not write (or it was edited since); setup never overwrites it.`, {
        actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--instructions-only', ...(flags.name === 'gbrain' ? [] : ['--name', flags.name]), ...(scope === 'project' ? ['--scope', 'project'] : [])],
        why: 'Keeps that entry and adds only the brain-first block and the per-turn hook, so its sessions are told to check gbrain first on every turn. Or preview a setup under another name (--name), or remove that entry yourself and run setup again.', verify: verifyDryRun('claude-code', flags.name) }), out);
    }
    const harnessLane = harnessLaneWires(brainHome, 'claude-code', [dirname(claudeUserSettingsPath()), dirname(found.settingsPath)]);
    const laneEvents = found.otherLaneEvents.filter((e) => (plan.events as string[]).includes(e));
    if (harnessLane || laneEvents.length > 0) {
      return refuse(ownerConflict('harness_lane', `${harnessLane ? '`gbrain bootstrap harness` already wires Claude Code for this install' : `${found.settingsPath} already wires ${laneEvents.join(', ')} through another gbrain install lane`}; two lanes would fire every hook twice.`, {
        actor: 'agent', argv: ['gbrain', 'bootstrap', 'harness', '--remove', '--dry-run'],
        why: 'Preview removing the bootstrap harness wiring first, or keep it and skip setup.', verify: verifyDryRun('claude-code', flags.name) }), out);
    }
    const servesPlan = servesPreflight(flags, launcher, 'claude-code', !!cfg, !!liveOwner?.ours, binding);
    if (servesPlan instanceof OperationError) return refuse(servesPlan, out);

    const brainCreate = !cfg;
    const initArgv = [launcher, 'init', '--pglite', ...(consent.providers.value === 'accepted' ? [] : ['--no-embedding']), '--json'];
    if (flags.dryRun) {
      const steps: SetupStep[] = [
        { step: 'receipt', action: found.prior?.status === 'installed' && found.hooksCurrent && (found.mcp.state === 'current' || !!pluginOwner) && !brainCreate ? 'keep' : 'write', detail: found.receiptPath },
        ...(brainCreate ? [{ step: 'brain' as const, action: 'write' as const, detail: `would run: ${initArgv.join(' ')}` }] : []),
        { step: 'mcp', action: pluginOwner ? 'skip' : found.mcp.state === 'current' ? 'keep' : 'write', detail: `'${flags.name}' in ${found.configPath}${plan.stdioMember ? ` (serve --stdio-member ${plan.stdioMember})` : ''}` },
        { step: 'hooks', action: found.hooksCurrent ? 'keep' : 'write', detail: plan.events.length ? `${plan.events.join(', ')} in ${found.settingsPath}` : `no hooks (${found.settingsPath})` },
        ...Object.entries(found.edited).map(([event]) => ({ step: 'hooks' as const, action: 'preserve' as const, detail: `${event} was edited after setup wrote it; kept` })),
      ];
      const serves = servesApply(flags, launcher, 'claude-code', servesPlan, !!cfg, binding);
      const instructions = brainFirstFor('claude-code', flags, mcpAccess(flags.name, plan.advertise ?? surface, serves), { scope, projectDir });
      const skills = skillsFor('claude-code', flags, launcher, { scope, projectDir }, instructions);
      const resolver = await resolverFor('claude-code', flags, launcher);
      return finish(out, { dryRun: true, target, consent, steps, states: [], verify: null, notices: [], notes, instructions, skills, resolver, serves, launcher });
    }

    let notices: Notice[] = [];
    const result = await applyClaudeSetup(plan, consent, {
      pluginOwner, brainCreated: brainCreate, abortAfter: process.env.GBRAIN_SETUP_ABORT_AFTER,
      beforeMcp: brainCreate ? async () => { notices = runBrainInit(initArgv, out, 'claude-code'); } : undefined,
    });
    for (const s of result.steps) say(out, `  ${s.action.padEnd(8)} ${s.step.padEnd(7)} ${s.detail}`);
    const serves = servesApply(flags, launcher, 'claude-code', servesPlan, true, binding);
    const instructions = brainFirstFor('claude-code', flags, mcpAccess(flags.name, plan.advertise ?? surface, serves), { scope, projectDir });
    const skills = skillsFor('claude-code', flags, launcher, { scope, projectDir }, instructions);
    const resolver = await resolverFor('claude-code', flags, launcher);
    if (!result.changed && !instructionsChanged(instructions) && !instructionsChanged(skills) && !resolverChanged(resolver)) say(out, 'Nothing changed: this install is already wired.');

    let verify: { ok: boolean; reason: string; message: string } | null;
    if (pluginOwner) verify = { ok: false, reason: 'plugin_lane', message: `The '${pluginOwner}' plugin serves MCP; start a new Claude Code session and check /mcp lists gbrain.` };
    else if (liveOwner?.ours) verify = { ok: true, reason: 'wired_running', message: `A live stdio serve (PID ${liveOwner.pid}) started by this registration holds the brain.` };
    else {
      const entry = desiredMcpEntry(plan) as { command: string; args: string[]; env: Record<string, string> };
      verify = await smokeStdioRegistration({ harness: 'claude-code', source: found.configPath, kind: 'stdio', command: entry.command, args: entry.args, env: entry.env });
    }
    const states = ['configured', ...(verify.ok ? ['connection-verified', 'native-pending'] : [])];
    const turnHook = plan.events.includes('UserPromptSubmit') && instructions?.decision.value === 'accepted' ? verifyTurnHook('claude-code', { projectDir }) : null;
    const code = await finish(out, { dryRun: false, target: { ...target, registration_owner: pluginOwner ? 'plugin' : 'setup' }, consent: result.receipt.consent, steps: result.steps, states, verify, notices, notes,
      preserved: Object.keys(result.edited).map((event) => ({ kind: 'hook', event, reason: 'edited' })), instructions, skills, turnHook, resolver, serves, launcher });
    if (turnHook && !turnHook.ok) return out.json ? 1 : refuse(turnHookNotLoaded('claude-code', turnHook, ['gbrain', 'setup', 'claude-code', ...(scope === 'project' ? ['--scope', 'project'] : [])]), out);
    return verify.ok || pluginOwner ? code : 1;
  } catch (e) {
    if (e instanceof OperationError) return refuse(e, out);
    if (e instanceof SetupAbortInjected) { process.stderr.write(`${e.message}\n`); return 1; }
    process.stderr.write(`gbrain setup: ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * #7771: whether `gbrain bootstrap harness` wired the configuration setup is
 * about to wire. One install can serve several HOMEs (or CODEX_HOMEs), so the
 * lane conflicts only through a target in one of `configDirs`, project-scoped
 * hooks (every configuration loads a project's), or a receipt that records
 * no paths for the host.
 */
function harnessLaneWires(brainHome: string, host: 'claude-code' | 'codex', configDirs: string[]): boolean {
  const state = readHarnessReceiptState(brainHome);
  if (state.state !== 'ok') return false;
  const targets = state.receipt.targets.filter((t) => t.host === host);
  if (targets.length === 0) return false;
  if (!targets.some((t) => typeof t.path === 'string')) return true;
  const real = (p: string): string => {
    const abs = resolve(p);
    try { return realpathSync(abs); } catch { return dirname(abs) === abs ? abs : join(real(dirname(abs)), basename(abs)); }
  };
  const dirs = new Set(configDirs.map(real));
  return targets.some((t) => (t.kind === 'hooks' && t.scope !== 'user') || (typeof t.path === 'string' && dirs.has(real(dirname(resolve(t.path))))));
}

function liveOwnerOf(cfg: GBrainConfig | null, ours: boolean): { dataDir?: string; liveOwner: Target['live_owner'] } {
  const dataDir = cfg && cfg.engine === 'pglite' && !cfg.database_url ? cfg.database_path ?? gbrainPath('brain.pglite') : undefined;
  const lock = dataDir ? peekLock(dataDir) : null;
  return { dataDir, liveOwner: lock?.held && lock.isServe && lock.pid !== undefined
    ? { pid: lock.pid, transport: lock.http ? 'http' : 'stdio', ours: ours && !lock.http } : null };
}

function liveServeConflict(live: NonNullable<Target['live_owner']>, harness: SetupHarnessId, name: string): OperationError {
  const http = live.transport === 'http';
  return ownerConflict('live_serve',
    `A live gbrain ${http ? 'serve --http' : 'stdio serve'} (PID ${live.pid}) holds this PGLite brain's single-writer lock; a stdio registration would start a second server that fails on the lock.`,
    http
      ? { actor: 'agent', argv: ['gbrain', 'bootstrap', 'harness', '--harness', harness, '--yes'], consent: ['persistent_install', 'credentials'],
        why: `Connect ${HARNESS_LABEL[harness]} to the running shared server instead of starting a second owner.`, verify: { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] } }
      : { actor: 'user', argv: ['kill', String(live.pid)],
        why: 'Stop the server that holds the brain (quit the agent session that started it), then run setup again.',
        user_message: `gbrain's database is in use by another server (PID ${live.pid}). Please quit the agent session that started it, then I'll run setup again.`,
        verify: verifyDryRun(harness, name) });
}

/** Run the `gbrain init --json` child that creates a new keyless brain; returns setup's form of its first-run bundle. */
function runBrainInit(initArgv: string[], out: Out, harness: SetupHarnessId): Notice[] {
  say(out, `Creating the brain: ${initArgv.join(' ')}`);
  const child = Bun.spawnSync(initArgv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
  const initOut = child.stdout?.toString() ?? '';
  const initErr = child.stderr?.toString() ?? '';
  if (child.exitCode !== 0) {
    process.stderr.write(initErr);
    process.stderr.write(initOut);
    throw new Error(`\`${initArgv.join(' ')}\` exited ${child.exitCode}; nothing else was written. Fix the init error above, then run setup again.`);
  }
  process.stderr.write(finishFreshSetupMigrations(initArgv[0]!, initErr));
  const hosted = hostedOptionNotice('setup', hostedOptionMuted());
  try {
    const doc = JSON.parse(initOut) as { path?: string; notices?: unknown[] };
    if (doc.path) say(out, `Brain ready at ${doc.path}`);
    return [...setupFirstRunNotices(doc.notices ?? [], HARNESS_LABEL[harness]), ...(hosted ? [hosted] : [])];
  } catch { process.stderr.write(initOut); return hosted ? [hosted] : []; }
}

async function runCodexSetup(flags: SetupFlags, launcher: string, cfg: GBrainConfig | null, brainHome: string, out: Out): Promise<number> {
  const paths = codexSetupPaths(flags.name);
  try {
    const receiptRead = readCodexSetupReceipt(paths.receiptPath);
    if (flags.remove) return await runCodexRemove(flags, receiptRead.setup, paths.receiptPath, brainHome, out);

    const hostedUrl = cfg?.remote_mcp?.mcp_url ?? receiptRead.hosted?.mcp_url ?? (receiptRead.hosted ? 'a hosted brain' : undefined);
    if (hostedUrl) return refuse(hostedConnection(hostedUrl, receiptRead.hosted !== null, flags.name, 'codex'), out);
    const prior = receiptRead.setup;
    if (prior && prior.gbrain_home !== brainHome) {
      return refuse(ownerConflict('other_install', `The '${flags.name}' connection belongs to the gbrain install at ${prior.gbrain_home}, not ${brainHome}.`, {
        actor: 'agent', argv: ['gbrain', 'setup', 'codex', '--name', `${flags.name}-2`, '--dry-run', '--json'],
        why: 'Each install owns its own MCP name and hooks; preview this install under another name.', verify: verifyDryRun('codex', flags.name) }), out);
    }

    const notes: string[] = [];
    const consent = resolveConsent(flags, prior, cfg, 'user', notes);
    const envSurface = process.env.GBRAIN_SURFACE;
    if (envSurface && !isRegistrationSurface(envSurface)) notes.push(`GBRAIN_SURFACE='${envSurface}' is not verbs, starter or full; ignored.`);
    const chosenSurface = flags.surface ?? (isRegistrationSurface(envSurface) ? envSurface : undefined);
    const surface: McpSurface = chosenSurface ?? prior?.surface ?? REGISTRATION_SURFACE;
    const advertise = registrationAdvertise({ userChoseSurface: chosenSurface !== undefined, prior });
    const sourceId = flags.source ?? (process.env.GBRAIN_SOURCE && isValidSourceId(process.env.GBRAIN_SOURCE) ? process.env.GBRAIN_SOURCE : null);
    let plan: CodexSetupPlan = {
      name: flags.name, launcher, brainHome,
      ...(process.env.GBRAIN_HOME?.trim() ? { gbrainHomeEnv: process.env.GBRAIN_HOME.trim() } : {}),
      sourceId, surface, advertise, events: hookEvents<CodexSetupEvent>(consent, 'codex'),
    };
    let found = inspectCodexSetup(plan);
    if (found.mcp.state === 'unowned' && !prior && chosenSurface === undefined && plan.advertise) {
      const listed: CodexSetupPlan = { ...plan, advertise: null };
      const again = inspectCodexSetup(listed);
      if (again.mcp.state === 'current') { plan = listed; found = again; }
    }
    const binding = entryBinding(flags, found.mcp.stdioMember);
    if (binding.member) { plan = { ...plan, stdioMember: binding.member }; found = inspectCodexSetup(plan); }
    if (found.mcp.state === 'remote') return refuse(hostedConnection(found.mcp.url ?? 'a hosted brain', true, flags.name, 'codex'), out);

    const pluginOwner = codexPluginProvidesName(paths.configPath, flags.name);
    if (pluginOwner && flags.stdioMember !== undefined) return refuse(pluginBindingRefusal(pluginOwner, 'codex', flags.stdioMember), out);
    const { dataDir, liveOwner } = liveOwnerOf(cfg, prior?.status === 'installed' && (found.mcp.state === 'current' || found.mcp.state === 'owned'));
    const target: Target = {
      brain: !cfg ? { kind: 'new-local-pglite', path: gbrainPath('brain.pglite'), config_dir: brainHome }
        : cfg.engine === 'pglite' ? { kind: 'local-pglite', path: dataDir, config_dir: brainHome } : { kind: 'local-postgres', config_dir: brainHome },
      source: { id: sourceId, pinned: sourceId !== null, from: flags.source ? 'flag' : sourceId ? 'env' : 'brain-default' },
      transport: 'local-stdio', launcher, surface, ...(plan.advertise ? { advertise: plan.advertise } : {}), ...(plan.stdioMember ? { stdio_member: plan.stdioMember } : {}),
      registration_owner: pluginOwner ? 'plugin' : prior ? 'setup' : 'none',
      live_owner: liveOwner, scope: 'user', name: flags.name,
      config_path: found.configPath, hooks_path: found.hooksPath, receipt_path: found.receiptPath,
    };
    describeTarget(target, out, 'codex');
    describeConsent(consent, plan.events, out, 'codex');
    for (const n of notes) say(out, `note: ${n}`);

    if (liveOwner && !liveOwner.ours) return refuse(liveServeConflict(liveOwner, 'codex', flags.name), out);
    if (found.mcp.state === 'unowned' && !pluginOwner) {
      return refuse(ownerConflict('unowned_entry', `${found.configPath} already has [mcp_servers.${flags.name}] that gbrain setup did not write (or it was edited since); setup never overwrites it.`, {
        actor: 'agent', argv: ['gbrain', 'setup', 'codex', '--instructions-only', ...(flags.name === 'gbrain' ? [] : ['--name', flags.name])],
        why: 'Keeps that table and adds only the brain-first block and the per-turn hook, so its sessions are told to check gbrain first on every turn. Or preview a setup under another name (--name), or remove that table yourself and run setup again.', verify: verifyDryRun('codex', flags.name) }), out);
    }
    const harnessLane = harnessLaneWires(brainHome, 'codex', [dirname(found.configPath), dirname(found.hooksPath)]);
    const laneEvents = found.otherLaneEvents.filter((e) => (plan.events as string[]).includes(e));
    if (harnessLane || laneEvents.length > 0) {
      return refuse(ownerConflict('harness_lane', `${harnessLane ? '`gbrain bootstrap harness` already wires Codex for this install' : `${found.hooksPath} already wires ${laneEvents.join(', ')} through gbrain's bootstrap Codex lane`}; two lanes would fire every hook twice.`, {
        actor: 'agent', argv: harnessLane ? ['gbrain', 'bootstrap', 'harness', '--remove', '--dry-run'] : ['gbrain', 'setup', 'codex', laneEvents.every((e) => e === 'SessionEnd') ? '--no-capture' : '--no-hooks', '--dry-run', '--json'],
        why: harnessLane ? 'Preview removing the bootstrap harness wiring first, or keep it and skip setup.' : 'Keep the bootstrap lane for those events and preview setup without them.', verify: verifyDryRun('codex', flags.name) }), out);
    }
    const servesPlan = servesPreflight(flags, launcher, 'codex', !!cfg, !!liveOwner?.ours, binding);
    if (servesPlan instanceof OperationError) return refuse(servesPlan, out);

    const brainCreate = !cfg;
    const initArgv = [launcher, 'init', '--pglite', ...(consent.providers.value === 'accepted' ? [] : ['--no-embedding']), '--json'];
    if (flags.dryRun) {
      const unchanged = found.prior?.status === 'installed' && found.hooksCurrent && found.trustCurrent && (found.mcp.state === 'current' || !!pluginOwner) && !brainCreate;
      const steps: CodexSetupStep[] = [
        { step: 'receipt', action: unchanged ? 'keep' : 'write', detail: found.receiptPath },
        ...(brainCreate ? [{ step: 'brain' as const, action: 'write' as const, detail: `would run: ${initArgv.join(' ')}` }] : []),
        { step: 'mcp', action: pluginOwner ? 'skip' : found.mcp.state === 'current' ? 'keep' : 'write', detail: `[mcp_servers.${flags.name}] in ${found.configPath}${plan.stdioMember ? ` (serve --stdio-member ${plan.stdioMember})` : ''}` },
        { step: 'hooks', action: found.hooksCurrent ? 'keep' : 'write', detail: plan.events.length ? `${plan.events.join(', ')} in ${found.hooksPath}` : `no hooks (${found.hooksPath})` },
        { step: 'trust', action: found.trustCurrent ? 'keep' : 'write', detail: `trust entries for setup's groups in ${found.configPath}` },
        ...Object.keys(found.edited).map((event) => ({ step: 'hooks' as const, action: 'preserve' as const, detail: `${event} was edited after setup wrote it; kept` })),
      ];
      const serves = servesApply(flags, launcher, 'codex', servesPlan, !!cfg, binding);
      const instructions = brainFirstFor('codex', flags, mcpAccess(flags.name, plan.advertise ?? surface, serves), {});
      const skills = skillsFor('codex', flags, launcher, {}, instructions);
      const resolver = await resolverFor('codex', flags, launcher);
      return finish(out, { harness: 'codex', dryRun: true, target, consent, steps, states: [], verify: null, notices: [], notes, instructions, skills, resolver, serves });
    }

    let notices: Notice[] = [];
    const result = await applyCodexSetup(plan, consent, {
      pluginOwner, brainCreated: brainCreate, abortAfter: process.env.GBRAIN_SETUP_ABORT_AFTER,
      beforeMcp: brainCreate ? async () => { notices = runBrainInit(initArgv, out, 'codex'); } : undefined,
    });
    for (const s of result.steps) say(out, `  ${s.action.padEnd(8)} ${s.step.padEnd(7)} ${s.detail}`);
    for (const n of result.notes) say(out, `note: ${n}`);
    const serves = servesApply(flags, launcher, 'codex', servesPlan, true, binding);
    const instructions = brainFirstFor('codex', flags, mcpAccess(flags.name, plan.advertise ?? surface, serves), {});
    const skills = skillsFor('codex', flags, launcher, {}, instructions);
    const resolver = await resolverFor('codex', flags, launcher);
    if (!result.changed && !instructionsChanged(instructions) && !instructionsChanged(skills) && !resolverChanged(resolver)) say(out, 'Nothing changed: this install is already wired.');

    let verify: { ok: boolean; reason: string; message: string };
    if (pluginOwner) verify = { ok: false, reason: 'plugin_lane', message: `The '${pluginOwner}' plugin serves MCP; start a new Codex session and check /mcp lists gbrain.` };
    else if (liveOwner?.ours) verify = { ok: true, reason: 'wired_running', message: `A live stdio serve (PID ${liveOwner.pid}) started by this registration holds the brain.` };
    else {
      const entry = desiredCodexMcpEntry(plan) as { command: string; args: string[]; env?: Record<string, string> };
      verify = await smokeStdioRegistration({ harness: 'codex', source: found.configPath, kind: 'stdio', command: entry.command, args: entry.args, env: entry.env });
    }
    const push = capabilityRows('codex')[0]!.push;
    const states = ['configured', ...(verify.ok ? ['connection-verified', push === 'native-verified' && result.receipt.trust.owned.UserPromptSubmit ? 'native-verified' : 'native-pending'] : [])];
    const turnHook = plan.events.includes('UserPromptSubmit') && instructions?.decision.value === 'accepted' ? verifyTurnHook('codex') : null;
    const code = await finish(out, { harness: 'codex', dryRun: false, target: { ...target, registration_owner: pluginOwner ? 'plugin' : 'setup' }, consent: result.receipt.consent,
      steps: result.steps, states, verify, notices, notes: [...notes, ...result.notes], preserved: result.preserved, instructions, skills, turnHook, resolver, serves });
    if (turnHook && !turnHook.ok) return out.json ? 1 : refuse(turnHookNotLoaded('codex', turnHook, ['gbrain', 'setup', 'codex']), out);
    return verify.ok || pluginOwner ? code : 1;
  } catch (e) {
    if (e instanceof OperationError) return refuse(e, out);
    if (e instanceof SetupAbortInjected) { process.stderr.write(`${e.message}\n`); return 1; }
    process.stderr.write(`gbrain setup: ${(e as Error).message}\n`);
    return 1;
  }
}

async function runCodexRemove(flags: SetupFlags, receipt: CodexSetupReceipt | null, receiptPath: string, brainHome: string, out: Out): Promise<number> {
  if (!receipt) {
    say(out, `No gbrain setup receipt at ${receiptPath}; setup owns nothing here, so nothing was removed.`);
    return finish(out, { harness: 'codex', dryRun: flags.dryRun, remove: true, steps: [], states: [], verify: null, notices: [], notes: [], resolver: await resolverFor('codex', flags, '') });
  }
  if (receipt.gbrain_home !== brainHome) {
    return refuse(ownerConflict('other_install', `The '${receipt.name}' connection belongs to the gbrain install at ${receipt.gbrain_home}, not ${brainHome}; --remove leaves it alone.`, {
      actor: 'user', why: `Run --remove with GBRAIN_HOME set to the install that owns it (${receipt.gbrain_home}).`, user_message: 'This setup belongs to another gbrain install; remove it from that install.' }), out);
  }
  const r = await removeCodexSetup(receipt, receiptPath, { dryRun: flags.dryRun });
  for (const s of r.steps) say(out, `  ${(flags.dryRun ? `would ${s.action}` : s.action).padEnd(14)} ${s.step.padEnd(7)} ${s.detail}`);
  for (const n of r.notes) say(out, `note: ${n}`);
  const instructions = removeBrainFirstFor('codex', {}, flags);
  const skills = removeSkillsFor('codex', {}, flags);
  const resolver = await resolverFor('codex', flags, '');
  say(out, 'The brain, its notes and unrelated Codex settings were left as they were.');
  return finish(out, { harness: 'codex', dryRun: flags.dryRun, remove: true, steps: r.steps, states: [], verify: null, notices: [], notes: r.notes, preserved: r.preserved, instructions, skills, resolver });
}

function hostedConnection(url: string, wired: boolean, name: string, harness: SetupHarnessId = 'claude-code'): OperationError {
  const label = HARNESS_LABEL[harness];
  return opError('setup_hosted_connection',
    `This machine already reaches a hosted brain (${url})${wired ? ` and ${label}'s '${name}' entry points at it` : ''}; gbrain setup will not create a second, local brain.`,
    wired ? 'Nothing to do: the hosted connection is wired. `gbrain doctor --only harness_wiring` verifies it.' : `Connect ${label} to it with \`gbrain connect ${url} --harness ${harness} --install\`.`,
    { docs: 'docs/guides/repair.md#setup-hosted-connection',
      fix: wired
        ? { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows which brain the registration reaches and smoke-tests it.' }
        : { argv: ['gbrain', 'connect', url, '--harness', harness, '--install'], consent: ['persistent_install', 'credentials'], actor: 'user', requires_exclusive: false,
          why: `The hosted connection installer writes the ${label} entry with the hosted credential.`, user_message: `Your brain is hosted at ${url}. Run gbrain connect for it (it needs your private handoff); setup will not create a local brain.`,
          verify: { argv: ['gbrain', 'doctor', '--only', 'harness_wiring', '--json'] } } });
}

async function runRemove(flags: SetupFlags, receipt: ClaudeSetupReceipt | null, receiptPath: string, brainHome: string, out: Out): Promise<number> {
  if (!receipt) {
    say(out, `No gbrain setup receipt at ${receiptPath}; setup owns nothing here, so nothing was removed.`);
    return finish(out, { dryRun: flags.dryRun, remove: true, steps: [], states: [], verify: null, notices: [], notes: [], resolver: await resolverFor('claude-code', flags, '') });
  }
  if (receipt.gbrain_home !== brainHome) {
    return refuse(ownerConflict('other_install', `The '${receipt.name}' connection belongs to the gbrain install at ${receipt.gbrain_home}, not ${brainHome}; --remove leaves it alone.`, {
      actor: 'user', why: `Run --remove with GBRAIN_HOME set to the install that owns it (${receipt.gbrain_home}).`, user_message: 'This setup belongs to another gbrain install; remove it from that install.' }), out);
  }
  const r = await removeClaudeSetup(receipt, receiptPath, { dryRun: flags.dryRun });
  for (const s of r.steps) say(out, `  ${(flags.dryRun ? `would ${s.action}` : s.action).padEnd(14)} ${s.step.padEnd(7)} ${s.detail}`);
  const instructions = removeBrainFirstFor('claude-code', { scope: receipt.scope, projectDir: receipt.project_dir }, flags);
  const skills = removeSkillsFor('claude-code', { scope: receipt.scope, projectDir: receipt.project_dir }, flags);
  const resolver = await resolverFor('claude-code', flags, '');
  say(out, 'The brain, its notes and unrelated Claude Code settings were left as they were.');
  return finish(out, { dryRun: flags.dryRun, remove: true, steps: r.steps, states: [], verify: null, notices: [], notes: [], preserved: r.preserved, instructions, skills, resolver });
}

/** The brain-first block for this run: decided from flags, env and the ledger, then applied (or previewed under --dry-run). */
/** GST-363: a plugin serves this harness's MCP server, and setup never writes the plugin's launch arguments, so a member named here would bind nothing. */
function pluginBindingRefusal(plugin: string, harness: SetupHarnessId, member: string): OperationError {
  return opError('invalid_params', `--stdio-member ${member} refused: the '${plugin}' plugin serves this ${harness} gbrain MCP server, and setup does not write the plugin's launch arguments, so its sessions would not read as ${member}; nothing was written.`,
    `Disable the '${plugin}' plugin and run gbrain setup ${harness} --stdio-member ${member}, or serve this brain over HTTP with one key per person (gbrain serve --http; for ${member}: gbrain auth create ${member}-key --member ${member}).`);
}

/** GST-363: the --stdio-member the harness entry will carry: the one named, none for --no-stdio-member, else the one setup's own entry carries now. */
function entryBinding(flags: SetupFlags, previous: string | undefined): EntryBinding {
  return { member: flags.noStdioMember ? null : flags.stdioMember ?? previous ?? null, previous: previous ?? null };
}

/** The access the brain-first block names; a brain that serves several people says the connection is already scoped. */
function mcpAccess(server: string, surface: McpSurface, serves: ServesOutcome | null): BrainFirstAccess {
  return { kind: 'mcp', server, surface, ...(serves?.brain_serves === 'several' ? { serves: 'several' as const } : {}) };
}

function brainFirstFor(harness: BrainFirstHarness, flags: SetupFlags, access: BrainFirstAccess, where: { scope?: WiringScope; projectDir?: string }): BrainFirstOutcome | null {
  const target = brainFirstTarget(harness, { ...where, workspace: flags.workspace });
  if ('error' in target) return null;
  const decision = resolveBrainFirstDecision(flags.instructions, priorBrainFirst(harness, target.path));
  return syncBrainFirst({ target, access, decision, writer: `gbrain setup ${harness}`, dryRun: flags.dryRun });
}

/** The uninstall half: the block setup wrote for this harness and scope, at the path the ledger recorded. */
function removeBrainFirstFor(harness: BrainFirstHarness, where: { scope?: WiringScope; projectDir?: string }, flags: SetupFlags): BrainFirstOutcome | null {
  const target = brainFirstTarget(harness, { ...where, workspace: flags.workspace });
  const path = 'error' in target ? readBrainFirstLedger().find((e) => e.harness === harness)?.path : target.path;
  return path ? removeBrainFirst({ harness, path, dryRun: flags.dryRun }) : null;
}

/**
 * The skills index for this run (--skill-loading, GBRAIN_SKILL_LOADING, the ledger; off by default).
 * It sits beside the brain-first block, so declining that block (--no-instructions) removes the index too.
 */
function skillsFor(harness: BrainFirstHarness, flags: SetupFlags, launcher: string, where: { scope?: WiringScope; projectDir?: string }, brainFirst: BrainFirstOutcome | null): SkillsBlockOutcome | null {
  if (harness === 'cursor' && flags.skillResolver === 'on' && brainFirst?.decision.value !== 'declined') return null;
  const target = brainFirstTarget(harness, { ...where, workspace: flags.workspace });
  if ('error' in target) return null;
  return installerSkillsBlock({ target, launcher, writer: `gbrain setup ${harness}`, brainFirstDeclined: brainFirst?.decision.value === 'declined', skillLoading: flags.skillLoading, audience: isThinClient(loadConfig()) ? 'downstream' : 'owner', dryRun: flags.dryRun });
}

function removeSkillsFor(harness: BrainFirstHarness, where: { scope?: WiringScope; projectDir?: string }, flags: SetupFlags): SkillsBlockOutcome | null {
  const target = brainFirstTarget(harness, { ...where, workspace: flags.workspace });
  let path: string | undefined;
  try {
    path = 'error' in target ? readSkillLoadingLedger().find((e) => e.harness === harness)?.path : target.path;
  } catch {
    path = 'error' in target ? undefined : target.path;
  }
  return path ? removeSkillsBlock({ harness, path, dryRun: flags.dryRun }) : null;
}

/**
 * The skill-resolver lane for this run (claude-code, codex, hermes): --skill-loading
 * resolve turns it on, off or spring turns it off, and with no choice a lane
 * that is on is refreshed. Null when there is nothing to do, so an install
 * that never turned it on gets no new output.
 */
async function resolverFor(harness: ResolverHarness, flags: SetupFlags, launcher: string): Promise<ResolverSetupResult | null> {
  const home = configDir();
  if (flags.skillResolver === 'off' || (flags.remove && flags.skillResolver !== 'on')) return removeSkillResolverSetup({ harness, home, dryRun: flags.dryRun });
  const cfg = readResolverConfig(home);
  if (flags.skillResolver !== 'on' && !(cfg.state === 'ok' && resolverHarnesses(cfg.doc).includes(harness))) return null;
  return syncSkillResolverSetup({ harness, gbrainBin: launcher, gbrainHome: process.env.GBRAIN_HOME?.trim() || undefined, home, dryRun: flags.dryRun });
}

function resolverRefusal(r: ResolverSetupResult): OperationError {
  const { code, message, scanned } = r.error!;
  const rerun = ['gbrain', 'setup', r.harness, '--skill-loading', 'resolve', '--dry-run'];
  return opError(code, message, code === 'skill_resolver_config_unreadable' ? 'Fix or move the config file, then run setup again.' : 'Add a skill to one of the scanned directories (or check they are readable), then run setup again.',
    { docs: `docs/guides/skill-resolver.md#${code}`, ...(scanned.length ? { detail: `scanned: ${scanned.join(', ')}` } : {}),
      fix: { argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews every write the resolver setup would make and names the directories it scans; changes nothing.' } });
}

/**
 * The OpenClaw skill-resolver plugin for this run: --skill-loading resolve
 * (live) or shadow turns it on for --agent/--all-agents (else the agents
 * already on, else main), off turns those agents off (the plugin leaves when
 * none is on), and with no choice an existing plugin is refreshed. It is
 * independent of the brain-first block. Null when there is nothing to do.
 */
async function openclawSkillFor(flags: SetupFlags, refreshOnly = false): Promise<OpenclawSkillResult | null> {
  const home = configDir();
  const agents = flags.agents ?? null;
  if (flags.skillResolver === 'off' || (flags.remove && flags.skillResolver === undefined)) {
    return removeOpenclawSkillPlugin({ home, agents: Array.isArray(agents) ? agents : null, dryRun: flags.dryRun });
  }
  if (flags.skillResolver === undefined && !readOpenclawSkillState(home)) return null;
  return syncOpenclawSkillPlugin({ mode: flags.skillResolver === 'on' ? 'live' : flags.skillResolver === 'shadow' ? 'shadow' : null, agents, home,
    gbrainBin: flags.gbrainBin ?? resolveGbrainBin() ?? '', gbrainHomeEnv: process.env.GBRAIN_HOME?.trim() || null, dryRun: flags.dryRun, refreshOnly, tuning: flags.openclawTuning });
}

function openclawSkillRefusal(r: OpenclawSkillResult): OperationError {
  const e = r.error!;
  const detail = [e.recovery, ...(e.commands ?? []).map((c) => `still to run: ${c}`)].filter(Boolean).join('\n');
  return opError(e.code, e.message, e.commands?.length ? `Run on the OpenClaw host: ${e.commands.join(' && ')}; then gbrain doctor --only skill_resolver.` : 'Fix the cause named above, then preview with gbrain setup openclaw --skill-loading resolve --dry-run.', {
    docs: `docs/guides/skill-resolver.md#${e.code}`, ...(detail ? { detail } : {}),
    fix: e.argv ? { argv: e.argv, consent: ['persistent_install'], actor: 'user', requires_exclusive: false, why: 'Finishes the OpenClaw install setup could not complete; gbrain doctor --only skill_resolver confirms it.' }
      : { argv: ['gbrain', 'setup', 'openclaw', '--skill-loading', 'resolve', '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews every write the OpenClaw resolver setup would make; changes nothing.' },
  });
}

const instructionsChanged = (o: BrainFirstOutcome | SkillsBlockOutcome | null): boolean => !!o && (o.action === 'write' || o.action === 'remove');
const resolverChanged = (r: ResolverSetupResult | null): boolean => !!r && (!!r.error || r.steps.some((s) => s.action === 'write' || s.action === 'remove'));

function describeInstructions(o: BrainFirstOutcome, dryRun: boolean): string {
  const how = o.decision.value === 'accepted' ? 'opt out with --no-instructions' : 'opt back in with --instructions';
  return `${describeBrainFirstOutcome(o, dryRun)} [${o.decision.source}; ${how}]`;
}

/** Whom the brain behind this launcher serves, for the shared-token warning; null when it cannot be read (the warning stays on). */
function exposureServesVia(launcher: string | null | undefined): ExposureServes {
  if (!launcher || !launcher.startsWith('/')) return null;
  try {
    const read = readServesStatus(launcher);
    return 'status' in read ? read.status.serves : null;
  } catch {
    return null;
  }
}

/** --serves several on the instructions alone: the brain must serve several people and its stdio server be bound. */
function servesBound(flags: SetupFlags): boolean {
  const launcher = flags.gbrainBin ?? resolveGbrainBin();
  const read = launcher && launcher.startsWith('/') ? readServesStatus(launcher) : null;
  const ok = !!read && 'status' in read && read.status.serves === 'several' && !!read.status.stdio_member;
  if (!ok) process.stderr.write('gbrain setup: --serves several: this brain does not serve several people with a bound stdio server, so the instructions keep the one-person scoping lines.\n');
  return ok;
}

/**
 * `--instructions-only`, and the harnesses whose MCP registration setup does
 * not write (opencode, openclaw, hermes, cursor): manage the brain-first
 * block and nothing else. A client with no instruction file gbrain can write
 * (Claude Desktop, ChatGPT, …) gets the block printed to paste.
 */
async function runInstructionsOnly(flags: SetupFlags, out: Out): Promise<number> {
  const harness = flags.harness!;
  const adapter = HARNESS_ADAPTERS.find((a) => a.id === harness)!;
  const envSurface = process.env.GBRAIN_SURFACE;
  const surface = flags.surface ?? (isRegistrationSurface(envSurface) ? envSurface : undefined);
  const access: BrainFirstAccess = { kind: 'mcp', server: flags.name, ...(surface ? { surface } : {}), ...(flags.serves === 'several' && servesBound(flags) ? { serves: 'several' as const } : {}) };
  const mcp = { setup: flags.instructionsOnly ? 'unchanged' as const : 'manual' as const, docs: adapter.guide };
  const exposure = flags.remove || !BOT_HARNESSES.includes(harness) ? null
    : sharedTokenNotice({ kind: 'stdio', harness }, { harness, serves: exposureServesVia(flags.gbrainBin ?? resolveGbrainBin()) });
  const notices = renderedExposure(exposure);
  if (!isBrainFirstHarness(harness)) {
    const pasted: BrainFirstAccess = adapter.connection === 'thin-cli' ? { kind: 'cli', launcher: flags.gbrainBin ?? 'gbrain' } : access;
    const snippet = renderBrainFirstSnippet(harness, pasted, 'delete this block');
    if (out.json) {
      await writeJsonDocument(`${JSON.stringify({ harness, dry_run: flags.dryRun, remove: flags.remove, instructions_only: true,
        instructions: { action: 'print', snippet, where: `${adapter.label}'s custom or system instructions` }, mcp, notices }, null, 2)}\n`, (t) => process.stdout.write(t));
      return 0;
    }
    writeExposureNotice(exposure);
    console.log(`${adapter.label} has no instruction file gbrain can write. Paste this block into its custom or system instructions (keep the markers so a later paste replaces it):\n`);
    console.log(snippet);
    console.log(adapter.connection === 'thin-cli'
      ? `The thin-CLI install in ${adapter.guide} already puts this block at the top of GBRAIN-INSTRUCTIONS.md; pass --gbrain-bin <absolute launcher> to print it with that launcher.`
      : `Connect its MCP server with ${adapter.guide}.`);
    return 0;
  }
  const projectDir = harness === 'cursor' || (harness === 'claude-code' && flags.scope === 'project') ? realpathSync(process.cwd()) : undefined;
  const where = { scope: harness === 'claude-code' ? flags.scope ?? 'user' : undefined, projectDir };
  const target = brainFirstTarget(harness, { ...where, workspace: flags.workspace });
  if ('error' in target) {
    return refuse(opError('invalid_params', target.error, 'Pass --workspace <absolute dir> for the agent whose AGENTS.md should carry the block.'), out);
  }
  let instructions: BrainFirstOutcome | null;
  let skills: SkillsBlockOutcome | null;
  if (flags.remove) {
    instructions = removeBrainFirstFor(harness, where, flags);
    skills = removeSkillsFor(harness, where, flags);
  } else {
    say(out, `Target (${adapter.label}): ${target.path} (${target.role})`);
    const decision = resolveBrainFirstDecision(flags.instructions, priorBrainFirst(harness, target.path));
    instructions = syncBrainFirst({ target, access, decision, writer: `gbrain setup ${harness}`, dryRun: flags.dryRun });
    skills = skillsFor(harness, flags, flags.gbrainBin ?? indexLauncher() ?? 'gbrain', where, instructions);
  }
  const off = flags.remove || instructions?.decision.value === 'declined';
  const rerun = ['gbrain', 'setup', harness, '--instructions-only', ...(flags.name !== 'gbrain' ? ['--name', flags.name] : []), ...(flags.workspace ? ['--workspace', flags.workspace] : []), ...(projectDir && harness === 'claude-code' ? ['--scope', 'project'] : [])];
  // The hook carries the block's rule, so it follows the block: none while no block could be placed (Hermes without a SOUL.md).
  const placed = instructions?.action === 'write' || instructions?.action === 'keep';
  const turnHook = !off && !placed ? null : harness === 'hermes'
    ? (off ? removeHermesTurnHook({ hermesHome: dirname(target.path), dryRun: flags.dryRun }) : syncHermesTurnHook({ hermesHome: dirname(target.path), access, dryRun: flags.dryRun }))
    : harness === 'openclaw'
      ? (off ? removeOpenclawTurnPlugin({ dryRun: flags.dryRun, workspace: flags.remove ? undefined : flags.workspace }) : syncOpenclawTurnPlugin({ access, dryRun: flags.dryRun, workspace: flags.workspace }))
      : isTurnRuleHarness(harness) ? turnRuleHookFor(harness, off, flags, projectDir, rerun.join(' ')) : null;
  // Loud failure: an accepted install whose per-turn hook does not load exits non-zero and names the harness's own check.
  // A 'print' outcome installed nothing and already names the step that does, so it is reported, not verified.
  const check = !off && !flags.dryRun && instructions?.decision.value === 'accepted' && !flags.noHooks && process.env.GBRAIN_HOOKS !== '0' && turnHook && turnHook.action !== 'print' && turnHook.action !== 'remove' ? verifyTurnHook(harness, { projectDir }) : null;
  const resolver = harness === 'claude-code' || harness === 'codex' || harness === 'hermes' ? await resolverFor(harness, flags, flags.gbrainBin ?? resolveGbrainBin() ?? '') : null;
  const skillPlugin = harness === 'openclaw' ? await openclawSkillFor(flags) : null;
  const cursorPins = harness === 'cursor' && projectDir ? await cursorPinsFor(flags, projectDir) : null;
  const code = instructions?.action === 'preserve' || skillsFailed(skills) || (check && !check.ok) || resolver?.error || cursorPins?.error ? 1 : 0;
  if (out.json) {
    await writeJsonDocument(`${JSON.stringify({ harness, dry_run: flags.dryRun, remove: flags.remove, instructions_only: true, instructions, ...(turnHook ? { turn_hook: turnHook } : {}), ...(check ? { turn_hook_check: check } : {}), skills, ...(resolver ? { skill_resolver: resolver } : {}), ...(skillPlugin ? { skill_resolver: skillPlugin } : {}), ...(cursorPins ? { skill_pins: cursorPins } : {}), mcp, notices }, null, 2)}\n`, (t) => process.stdout.write(t));
    return skillPlugin?.error ? exitCodeForCode(skillPlugin.error.code) : code;
  }
  writeExposureNotice(exposure);
  if (instructions) say(out, flags.remove ? describeBrainFirstOutcome(instructions, flags.dryRun) : describeInstructions(instructions, flags.dryRun));
  if (turnHook) say(out, `  ${(flags.dryRun && (turnHook.action === 'write' || turnHook.action === 'remove') ? `would ${turnHook.action}` : turnHook.action).padEnd(8)} ${'turn hook'.padEnd(7)} ${turnHook.detail}${'snippet' in turnHook && turnHook.snippet ? `:\n${turnHook.snippet.replace(/^/gm, '    ')}` : ''}${'commands' in turnHook && turnHook.commands ? `:\n${turnHook.commands.map((c) => `    ${c}`).join('\n')}` : ''}${'next' in turnHook && turnHook.next ? `; wire it with: ${turnHook.next}` : ''}`);
  else if (!off && placed) say(out, `  note     ${'turn hook'.padEnd(7)} ${adapter.label} has no per-turn hook gbrain can install; the rule reaches it through ${target.path} only.`);
  if (skills && skillsOutcomeShown(skills)) say(out, describeSkillsBlockOutcome(skills, flags.dryRun));
  if (resolver) for (const line of describeResolverSetup(resolver, flags.dryRun)) say(out, line);
  if (skillPlugin) for (const line of describeOpenclawSkill(skillPlugin, flags.dryRun)) say(out, line);
  if (harness === 'openclaw' && turnHook && !off) say(out, `  note     ${'route'.padEnd(7)} the per-turn rule is OpenClaw's primary route to the brain. Skills from \`gbrain skillpack scaffold --harness openclaw\` are an optional fallback: agents seldom open a listed skill on their own.`);
  if (cursorPins) for (const line of describeCursorPins(cursorPins, flags.dryRun)) say(out, line);
  if (check?.ok) say(out, `  verify   ${'turn hook'.padEnd(7)} ${check.message}`);
  if (mcp.setup === 'manual' && !flags.remove) say(out, `MCP: setup does not register ${adapter.label}'s MCP server. Follow ${adapter.guide} (one command), then start a new session.`);
  if (!flags.remove && instructions?.decision.value === 'accepted') say(out, 'Next: start a new session; the harness reads its instruction file at session start.');
  if (resolver?.error) return refuse(resolverRefusal(resolver), out);
  if (skillPlugin?.error) return refuse(openclawSkillRefusal(skillPlugin), out);
  if (cursorPins?.error) {
    const e = cursorPins.error;
    return refuse(opError(e.code, e.message, 'Fix the cause named above, then preview with gbrain setup cursor --skill-loading resolve --dry-run from the project directory.', {
      docs: `docs/guides/skill-resolver.md#${e.code}`,
      fix: { argv: ['gbrain', 'setup', 'cursor', '--skill-loading', 'resolve', '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews every write the Cursor pinned-skills setup would make in this project; changes nothing.' } }), out);
  }
  if (check && !check.ok) return refuse(turnHookNotLoaded(harness, check, rerun), out);
  return code;
}

/**
 * Cursor's pinned skills for the project setup runs in (cursor-skill-pins.ts):
 * --skill-loading resolve turns them on, off or --remove takes them out, and
 * a bare run refreshes a project that already has them.
 */
async function cursorPinsFor(flags: SetupFlags, projectDir: string): Promise<CursorPinsResult | null> {
  const home = configDir();
  if (flags.remove || flags.skillResolver === 'off') return removeCursorSkillPins({ home, project: projectDir, dryRun: flags.dryRun });
  if (flags.skillResolver !== 'on' && !readCursorPinsState(home).projects[projectDir]) return null;
  return syncCursorSkillPins({ home, project: projectDir, dryRun: flags.dryRun });
}

/**
 * gbrain setup pi: the skill resolver only (pi-skill-extension.ts). Setup
 * does not register an MCP server or write instructions for Pi.
 * --skill-loading resolve turns the extension on, off (or --remove) takes it
 * out, --skills-index-only refreshes the library, catalog and state, and a
 * bare run refreshes an extension that is on.
 */
async function runPiSetup(flags: SetupFlags, out: Out): Promise<number> {
  const home = configDir();
  const off = flags.skillResolver === 'off' || (flags.remove && flags.skillResolver !== 'on');
  if (!off && flags.skillResolver !== 'on' && !readPiSkillState(home)) {
    return refuse(opError('invalid_params', 'gbrain setup pi wires only the skill resolver, and it is not on. Pass --skill-loading resolve to turn it on.', 'Run gbrain setup pi --skill-loading resolve --dry-run to preview it.',
      { docs: 'docs/guides/skill-resolver.md#pi-extension', fix: { argv: ['gbrain', 'setup', 'pi', '--skill-loading', 'resolve', '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews every write the Pi resolver setup would make; changes nothing.' } }), out);
  }
  const result = off ? removePiSkillExtension({ home, dryRun: flags.dryRun })
    : await syncPiSkillExtension({ home, gbrainBin: flags.gbrainBin ?? resolveGbrainBin() ?? '', gbrainHomeEnv: process.env.GBRAIN_HOME?.trim() || null, dryRun: flags.dryRun, refreshOnly: flags.skillsIndexOnly });
  if (out.json) {
    await writeJsonDocument(`${JSON.stringify({ harness: 'pi', dry_run: flags.dryRun, remove: off, skill_resolver: result }, null, 2)}\n`, (t) => process.stdout.write(t));
    return result?.error ? exitCodeForCode(result.error.code) : 0;
  }
  if (!result) say(out, 'The Pi skill resolver is not installed; nothing to remove.');
  else for (const line of describePiSkill(result, flags.dryRun)) say(out, line);
  if (result?.error) {
    const e = result.error;
    return refuse(opError(e.code, e.message, 'Fix the cause named above, then preview with gbrain setup pi --skill-loading resolve --dry-run.', {
      docs: `docs/guides/skill-resolver.md#${e.code}`,
      fix: { argv: ['gbrain', 'setup', 'pi', '--skill-loading', 'resolve', '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Previews every write the Pi resolver setup would make; changes nothing.' } }), out);
  }
  if (result && !off) say(out, 'Next: start a new Pi session; Pi loads extensions when it starts.');
  return 0;
}

/** --skills-index-only: refresh (or, with --skill-loading off, remove) the recorded skills indexes for one harness; nothing else is touched. */
async function runSkillsIndexOnly(flags: SetupFlags, out: Out): Promise<number> {
  const harness = flags.harness;
  if (!isBrainFirstHarness(harness)) {
    return refuse(opError('invalid_params', `--skills-index-only needs a harness with an instruction file: ${BRAIN_FIRST_HARNESSES.join(', ')}`, 'Pass the harness whose skills index to refresh, e.g. gbrain setup claude-code --skills-index-only.'), out);
  }
  const outcomes = refreshSkillsIndexes(harness, { mode: flags.skillLoading, launcher: flags.gbrainBin, dryRun: flags.dryRun });
  const resolver = harness === 'claude-code' || harness === 'codex' || harness === 'hermes' ? await resolverFor(harness, flags, flags.gbrainBin ?? resolveGbrainBin() ?? '') : null;
  const skillPlugin = harness === 'openclaw' ? await openclawSkillFor(flags, true) : null;
  const code = outcomes.some((o) => o.action === 'preserve') || resolver?.error ? 1 : 0;
  if (out.json) {
    await writeJsonDocument(`${JSON.stringify({ harness, dry_run: flags.dryRun, skills_index_only: true, skills: outcomes, ...(resolver ? { skill_resolver: resolver } : {}), ...(skillPlugin ? { skill_resolver: skillPlugin } : {}) }, null, 2)}\n`, (t) => process.stdout.write(t));
    return skillPlugin?.error ? exitCodeForCode(skillPlugin.error.code) : code;
  }
  if (outcomes.length === 0 && !resolver && !skillPlugin) say(out, `No skills index is recorded for ${harness}. Add one with: gbrain setup ${harness} --skill-loading spring`);
  for (const o of outcomes) say(out, describeSkillsBlockOutcome(o, flags.dryRun));
  if (resolver) for (const line of describeResolverSetup(resolver, flags.dryRun)) say(out, line);
  if (skillPlugin) for (const line of describeOpenclawSkill(skillPlugin, flags.dryRun)) say(out, line);
  if (resolver?.error) return refuse(resolverRefusal(resolver), out);
  if (skillPlugin?.error) return refuse(openclawSkillRefusal(skillPlugin), out);
  return code;
}

/**
 * Claude Code and Codex under --instructions-only (a plugin or a bare `mcp add`
 * serves MCP): the per-turn rule hook, unless setup's own hooks, a bootstrap
 * lane or a gbrain plugin already carry the rule.
 */
function turnRuleHookFor(harness: TurnRuleHarness, off: boolean, flags: SetupFlags, projectDir: string | undefined, rerun: string): TurnHookOutcome {
  const paths = projectDir ? { claudeSettings: join(projectDir, '.claude', 'settings.local.json') } : {};
  if (off || flags.noHooks) return removeTurnRuleHook({ harness, paths, dryRun: flags.dryRun });
  if (process.env.GBRAIN_HOOKS === '0') return { harness, action: 'skip', path: '', detail: 'GBRAIN_HOOKS=0 is set: no per-turn hook installed' };
  const carried = inspectTurnHook(harness, { projectDir });
  // An entry of this lane beside another carrier still runs gbrain on every turn (it yields after starting), so it is refreshed, never left on an old launcher.
  if (carried.state !== 'missing' && carried.via !== 'turn-rule' && !hasTurnRuleHook(harness, paths)) return { harness, action: 'skip', path: '', detail: `per-turn rule already carried: ${carried.detail}` };
  return syncTurnRuleHook({ harness, gbrainBin: flags.gbrainBin ?? resolveGbrainBin(), gbrainHome: process.env.GBRAIN_HOME?.trim() || undefined, paths, dryRun: flags.dryRun, rerun });
}

function turnHookNotLoaded(harness: string, check: TurnHookVerdict, rerun: string[]): OperationError {
  const fix = turnHookFix(harness, rerun);
  return opError('turn_hook_not_loaded', `The per-turn gbrain hook for ${harness} is not active: ${check.message}.${TURN_HOOK_NATIVE_INSPECT[harness] ? ` The harness's own check: ${TURN_HOOK_NATIVE_INSPECT[harness]}.` : ''}`, fix.why, { reason: check.reason, docs: 'docs/guides/repair.md#turn-hook-not-loaded', fix });
}

async function finish(out: Out, doc: {
  harness?: SetupHarnessId; dryRun: boolean; remove?: boolean; target?: Target; consent?: SetupConsent; steps: Array<{ step: string; action: string; detail: string }>; states: string[];
  verify: { ok: boolean; reason: string; message: string } | null; notices: Notice[]; notes: string[]; preserved?: unknown[];
  instructions?: BrainFirstOutcome | null;
  skills?: SkillsBlockOutcome | null;
  turnHook?: TurnHookVerdict | null;
  resolver?: ResolverSetupResult | null;
  serves?: ServesOutcome | null;
  launcher?: string;
}): Promise<number> {
  const harness = doc.harness ?? 'claude-code';
  const state = doc.states.at(-1) ?? null;
  const code = skillsFailed(doc.skills ?? null) || doc.resolver?.error || !servesOk(doc.serves ?? null) ? 1 : 0;
  const plugins = harness === 'claude-code' && !doc.remove ? claudeCodeChannelPlugins() : [];
  const exposure = plugins.length ? sharedTokenNotice({ kind: 'stdio', harness }, { channelPlugins: plugins, serves: exposureServesVia(doc.launcher) }) : null;
  const notices = exposure ? [...doc.notices, exposure] : doc.notices;
  if (out.json) {
    await writeJsonDocument(`${JSON.stringify({
      harness, dry_run: doc.dryRun, remove: doc.remove ?? false,
      ...(doc.target ? { target: doc.target } : {}), ...(doc.consent ? { consent: doc.consent } : {}),
      steps: doc.steps, preserved: doc.preserved ?? [], instructions: doc.instructions ?? null, skills: doc.skills ?? null, ...(doc.resolver ? { skill_resolver: doc.resolver } : {}), ...(doc.turnHook ? { turn_hook_check: doc.turnHook } : {}), states: doc.states, state, verify: doc.verify,
      ...(doc.serves ? { serves: doc.serves } : {}),
      capability: capabilityRows(harness)[0], capability_table_version: SETUP_CAPABILITY_TABLE_VERSION,
      notes: doc.notes, notices: notices.map((n) => renderNotice(n, cliRenderContext())),
    }, null, 2)}\n`, (t) => process.stdout.write(t));
    return code;
  }
  if (doc.serves) for (const line of servesLines(doc.serves, doc.dryRun)) say(out, line);
  if (doc.instructions) say(out, doc.remove ? describeBrainFirstOutcome(doc.instructions, doc.dryRun) : describeInstructions(doc.instructions, doc.dryRun));
  if (doc.skills && skillsOutcomeShown(doc.skills)) say(out, describeSkillsBlockOutcome(doc.skills, doc.dryRun));
  if (doc.resolver) for (const line of describeResolverSetup(doc.resolver, doc.dryRun)) say(out, line);
  if (doc.verify) say(out, `Verify: ${doc.verify.ok ? 'ok' : 'not verified'} (${doc.verify.reason}): ${doc.verify.message}`);
  if (doc.turnHook?.ok) say(out, `Turn hook: ok (${doc.turnHook.reason}): ${doc.turnHook.message}`);
  if (state) say(out, `State: ${state} (${doc.states.join(' -> ')}).${state === 'native-verified' ? '' : ' Native push is not claimed until an observed event reaches a fresh session.'}`);
  if (state && !doc.remove) say(out, harness === 'codex'
    ? 'Next: start a new Codex session (config and hooks are read at session start) and check that /mcp lists gbrain.'
    : 'Next: open a new Claude Code session (config is read at session start) and check that /mcp lists gbrain.');
  if (state && !doc.remove) say(out, 'Memory: save what the user asks you to remember as a fact with gbrain remember "<fact>", naming its entity and provenance (MCP tool: remember). '
    + 'World-visible facts (the default) are pushed into new sessions; a private fact is not (local CLI recall only). capture writes a page, not a fact.');
  if (state && !doc.remove) say(out, `Opt-ins (nothing is on until you turn it on): keys and embeddings, autopilot, dream schedule, connectors, auto-upgrade, release channel: ${docsUrl('INSTALL_FOR_AGENTS.md#opt-ins')}`);
  writeCliNotices(notices.filter((n) => n.code !== 'hosted_option'));
  if (doc.notices.some((n) => n.code === 'hosted_option')) writeHostedOption('setup', new Set());
  if (doc.resolver?.error) return refuse(resolverRefusal(doc.resolver), out);
  return code;
}

/** An index the user asked for by flag that could not be written fails the run (the rest of the install still finished). */
const skillsFailed = (o: SkillsBlockOutcome | null): boolean => skillsOutcomeFailed(o);
