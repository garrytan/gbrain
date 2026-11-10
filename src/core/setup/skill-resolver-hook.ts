/**
 * skill-resolver-hook.ts — the skill-resolver lane's hook wiring
 * (`GBRAIN_HOOK_LANE=skill-resolver`, runtime in
 * src/core/skills/resolver/hook-lane.ts), written by
 * `gbrain setup <claude-code|codex> --skill-loading resolve`
 * (skill-resolver-setup.ts) and removed by `--skill-loading off` and
 * `setup --remove`.
 *
 *  - Claude Code: its own entries in the user settings file, marked
 *    `skill-resolver-v1`: UserPromptSubmit (`hook user-prompt`) and
 *    SessionStart (`hook session-start`, which only resets a session's
 *    dedupe state after a compaction).
 *  - Codex: its own UserPromptSubmit group in CODEX_HOME/hooks.json
 *    (`hook user-prompt --harness codex`) and its own SessionStart group
 *    (`hook session-start --harness codex`, the same compaction reset:
 *    Codex sends SessionStart with source "compact" after it compacts),
 *    each trusted by its hash in config.toml beside it, like the turn-rule
 *    lane.
 *
 * Both run gbrain through the existing hook launcher (hook-launcher.ts); this
 * module writes nothing else into the launcher's directory. Ownership: the
 * marker, else the lane token in the command (Claude Code), the lane token
 * (Codex). Nothing else in either file is touched.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { codexHookCensus, codexHookGroupRuns, codexSetupHookGroup, codexSetupTrustEntry, writeCodexSetupHooks, type CodexHookGroup } from '../bootstrap/codex-hooks.ts';
import { appendCodexTomlTable, readCodexTomlTable, removeCodexTomlTable } from '../bootstrap/codex-toml.ts';
import { buildClaudeHookCommand, hookEntryHash, removeClaudeHooksAt, writeClaudeHooksAt } from '../bootstrap/hooks.ts';
import { CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS, claudeUserSettingsPath, codexConfigPath, codexHooksPath, type ClaudeHookEvent } from '../bootstrap/host-specs.ts';
import { readJsonObjectSafe } from './skill-resolver-config.ts';
import { ensureHookLauncher, hookLauncherPath, hookLauncherState } from './hook-launcher.ts';
import { isSkillResolverCommand, isSkillResolverEntry, SKILL_RESOLVER_LANE, SKILL_RESOLVER_MARKER } from './skill-resolver-lane.ts';

export type ResolverHarness = 'claude-code' | 'codex';
const CLAUDE_EVENTS: ClaudeHookEvent[] = ['UserPromptSubmit', 'SessionStart'];
const CODEX_EVENTS = ['UserPromptSubmit', 'SessionStart'] as const;
type CodexEvent = (typeof CODEX_EVENTS)[number];
const CODEX_TIMEOUT_SECS = 15;

export interface ResolverHookPaths { claudeSettings?: string; codexHooks?: string; codexConfig?: string; hookLauncher?: string }
export interface ResolverHookOutcome { action: 'write' | 'keep' | 'remove' | 'skip' | 'refuse'; path: string; detail: string }

const claudePath = (p: ResolverHookPaths) => p.claudeSettings ?? claudeUserSettingsPath();
const codexPaths = (p: ResolverHookPaths) => ({ hooks: p.codexHooks ?? codexHooksPath(), config: p.codexConfig ?? codexConfigPath() });
const laneEnv = (home: string | undefined) => ({ ...(home ? { GBRAIN_HOME: home } : {}), GBRAIN_HOOK_LANE: SKILL_RESOLVER_LANE });

/** Every entry of this lane in a Claude Code settings file, by event. */
function claudeOurs(path: string): Array<{ event: string; entry: Record<string, unknown> }> {
  const hooks = readJsonObjectSafe(path)?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return Object.entries(hooks as Record<string, unknown>).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : [])
    .flatMap((g) => (Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : []))
    .filter(isSkillResolverEntry).map((entry) => ({ event, entry: entry as Record<string, unknown> })));
}

function codexOurs(p: { hooks: string }) {
  return codexHookCensus(p.hooks).filter((g) => (CODEX_EVENTS as readonly string[]).includes(g.event) && g.commands.some(isSkillResolverCommand)) as Array<ReturnType<typeof codexHookCensus>[number] & { event: CodexEvent }>;
}

export function codexResolverGroup(bin: string, home: string | undefined, launcher: string, event: CodexEvent = 'UserPromptSubmit'): CodexHookGroup {
  return codexSetupHookGroup(bin, event, home ? { GBRAIN_HOME: home } : {}, SKILL_RESOLVER_LANE, launcher);
}

const codexTrusted = (p: { hooks: string; config: string }, g: { event: CodexEvent; index: number }) => codexHookGroupRuns(p.hooks, p.config, g);

/** The commands this install's lane runs (what the hook entries would hold). */
export function skillResolverCommands(harness: ResolverHarness, bin: string, home: string | undefined, launcher: string): string[] {
  if (harness === 'codex') return CODEX_EVENTS.flatMap((e) => codexResolverGroup(bin, home, launcher, e).hooks.map((h) => h.command));
  return CLAUDE_EVENTS.map((e) => buildClaudeHookCommand(bin, e, laneEnv(home), launcher));
}

/** Whether this lane's hook is present: absent, wired (and, on Codex, trusted) or untrusted. */
export function inspectSkillResolverHook(harness: ResolverHarness, paths: ResolverHookPaths = {}): { state: 'absent' | 'wired' | 'untrusted'; path: string; commands: string[] } {
  try {
    if (harness === 'codex') {
      const p = codexPaths(paths);
      const ours = codexOurs(p);
      if (!ours.some((g) => g.event === 'UserPromptSubmit')) return { state: 'absent', path: p.hooks, commands: [] };
      return { state: ours.every((g) => codexTrusted(p, g)) ? 'wired' : 'untrusted', path: p.hooks, commands: ours.flatMap((g) => g.commands) };
    }
    const path = claudePath(paths);
    const ours = claudeOurs(path);
    return { state: ours.some((o) => o.event === 'UserPromptSubmit') ? 'wired' : 'absent', path, commands: ours.map((o) => String(o.entry.command)) };
  } catch {
    return { state: 'absent', path: harness === 'codex' ? codexPaths(paths).hooks : claudePath(paths), commands: [] };
  }
}

/** Install or refresh the lane's hook. Throws on a file it cannot write safely. */
export function syncSkillResolverHook(opts: { harness: ResolverHarness; gbrainBin: string; gbrainHome?: string; paths?: ResolverHookPaths; dryRun?: boolean }): ResolverHookOutcome {
  const paths = opts.paths ?? {};
  const launcher = paths.hookLauncher ?? hookLauncherPath();
  const launcherFresh = hookLauncherState(launcher).state === 'current';
  if (!opts.dryRun) ensureHookLauncher(launcher);
  const out = opts.harness === 'codex' ? syncCodex(opts.gbrainBin, opts.gbrainHome, launcher, codexPaths(paths), !!opts.dryRun)
    : syncClaude(opts.gbrainBin, opts.gbrainHome, launcher, claudePath(paths), !!opts.dryRun);
  return out.action === 'keep' && !launcherFresh ? { ...out, action: 'write', detail: `${out.detail}; hook launcher ${launcher}` } : out;
}

function syncClaude(bin: string, home: string | undefined, launcher: string, path: string, dryRun: boolean): ResolverHookOutcome {
  const want = CLAUDE_EVENTS.map((e) => hookEntryHash({ type: 'command', command: buildClaudeHookCommand(bin, e, laneEnv(home), launcher), timeout: CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[e] })!);
  const ours = claudeOurs(path);
  const detail = `skill-resolver lane hooks (UserPromptSubmit, SessionStart) in ${path}`;
  const have = ours.map((o) => hookEntryHash(o.entry));
  if (have.length === want.length && want.every((h) => have.includes(h))) return { action: 'keep', path, detail };
  if (dryRun) return { action: 'write', path, detail };
  mkdirSync(dirname(path), { recursive: true });
  writeClaudeHooksAt(path, { gbrainBin: bin, hookLauncher: launcher, env: { ...laneEnv(home), GBRAIN_SEAT: '' }, events: CLAUDE_EVENTS, marker: SKILL_RESOLVER_MARKER,
    ownedEntryHashes: new Set([...want, ...have.filter((h): h is string => !!h)]), freshMode: 0o600 });
  return { action: 'write', path, detail };
}

const trustPath = (key: string) => ['hooks', 'state', key];

/** Drop the trust entries of our groups, each only while it still trusts one of our commands. */
function dropOurTrust(config: string, hooks: string, ours: ReturnType<typeof codexOurs>): void {
  const commands = ours.flatMap((g) => g.commands);
  for (const g of ours) {
    const entries = commands.map((command) => codexSetupTrustEntry(hooks, g.event, g.index, { hooks: [{ type: 'command', command, timeout: CODEX_TIMEOUT_SECS }] }));
    const table = readCodexTomlTable(config, trustPath(entries[0]!.key)) as { trusted_hash?: unknown } | undefined;
    if (table && entries.some((t) => t.trusted_hash === table.trusted_hash)) removeCodexTomlTable(config, trustPath(entries[0]!.key));
  }
}

function syncCodex(bin: string, home: string | undefined, launcher: string, p: { hooks: string; config: string }, dryRun: boolean): ResolverHookOutcome {
  const groups = Object.fromEntries(CODEX_EVENTS.map((e) => [e, codexResolverGroup(bin, home, launcher, e)])) as Record<CodexEvent, CodexHookGroup>;
  const ours = codexOurs(p);
  const detail = `skill-resolver lane hooks (UserPromptSubmit, SessionStart) in ${p.hooks}, trusted in ${p.config}`;
  const current = ours.length === CODEX_EVENTS.length && CODEX_EVENTS.every((e) => ours.some((g) => g.event === e && g.hash === ownedEntryFingerprint(groups[e]) && codexTrusted(p, g)));
  if (current) return { action: 'keep', path: p.hooks, detail };
  if (dryRun) return { action: 'write', path: p.hooks, detail };
  mkdirSync(dirname(p.hooks), { recursive: true, mode: 0o700 });
  dropOurTrust(p.config, p.hooks, ours);
  const w = writeCodexSetupHooks(p.hooks, { want: groups, owned: new Set(ours.map((g) => g.hash)), preserve: new Set() });
  for (const event of CODEX_EVENTS) {
    const index = w.indexes[event];
    if (index === undefined) return { action: 'refuse', path: p.hooks, detail: `${p.hooks} did not take the skill-resolver ${event} hook` };
    const trust = codexSetupTrustEntry(p.hooks, event, index, groups[event]);
    const existing = readCodexTomlTable(p.config, trustPath(trust.key)) as { trusted_hash?: unknown } | undefined;
    if (existing === undefined) appendCodexTomlTable(p.config, trustPath(trust.key), { trusted_hash: trust.trusted_hash }, `gbrain setup (skill-resolver): trusts the skill-resolver lane ${event} hook; owned by its hash`);
    else if (existing.trusted_hash !== trust.trusted_hash) return { action: 'refuse', path: p.hooks, detail: `${p.config} already has a different [hooks.state."${trust.key}"]; trust gbrain's skill-resolver hook in Codex's /hooks` };
  }
  return { action: 'write', path: p.hooks, detail };
}

/** Remove the lane's hook (and, on Codex, its trust entry). Throws on a file it cannot write safely. */
export function removeSkillResolverHook(opts: { harness: ResolverHarness; paths?: ResolverHookPaths; dryRun?: boolean }): ResolverHookOutcome {
  const paths = opts.paths ?? {};
  if (opts.harness === 'codex') {
    const p = codexPaths(paths);
    const ours = codexOurs(p);
    if (ours.length === 0) return { action: 'skip', path: p.hooks, detail: `no skill-resolver hook in ${p.hooks}` };
    if (!opts.dryRun) {
      dropOurTrust(p.config, p.hooks, ours);
      writeCodexSetupHooks(p.hooks, { want: {}, owned: new Set(ours.map((g) => g.hash)), preserve: new Set() });
    }
    return { action: 'remove', path: p.hooks, detail: `skill-resolver lane hooks from ${p.hooks} and their trust entries from ${p.config}` };
  }
  const path = claudePath(paths);
  const ours = claudeOurs(path);
  if (ours.length === 0) return { action: 'skip', path, detail: `no skill-resolver hooks in ${path}` };
  if (!opts.dryRun) removeClaudeHooksAt(path, SKILL_RESOLVER_MARKER, { ownedEntryHashes: new Set(ours.map((o) => hookEntryHash(o.entry)).filter((h): h is string => !!h)) });
  return { action: 'remove', path, detail: `skill-resolver lane hooks from ${path}` };
}
