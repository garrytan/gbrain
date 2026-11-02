/**
 * turn-hook.ts — the per-turn brain-first rule on install paths that do not
 * run `gbrain setup`'s own hooks: `gbrain connect --install` (a remote brain),
 * `gbrain connect --harness … --install` (a hosted grant),
 * `gbrain bootstrap harness` (Codex, and Claude Code when its own hooks are off) and
 * `gbrain setup <claude-code|codex> --instructions-only` (a bare `mcp add`
 * registration gbrain did not write).
 *
 * Why: harness evals found the brain is used when "check gbrain first" reaches
 * the model on every turn (a per-turn hook: 80 of 80) and almost never when it
 * rides only the MCP tool list (2 of 99) or a startup file (0 of 80).
 *
 * The hook is one UserPromptSubmit entry running
 * `env GBRAIN_HOOK_LANE=turn-rule <gbrain> hook user-prompt`. In that lane the
 * hook adds only the rule (read from the brain-first ledger, so an opt-out or
 * GBRAIN_AGENT_INSTRUCTIONS=0 silences it) and never reads local context: the
 * connection may point at another brain. It yields when another gbrain lane
 * (setup, bootstrap) wires the same event, so a turn gets the rule once; a
 * gbrain plugin yields to it the same way.
 *
 * Ownership: Claude Code entries carry the `turn-rule-v1` marker, and the
 * command (lane token + `hook user-prompt`) identifies them when Claude Code
 * dropped the marker on a rewrite. Codex groups are identified by the lane
 * token; the trust entry Codex requires is written beside the group and owned
 * by its hash. Nothing else in either file is touched.
 *
 * `inspectTurnHook` (doctor) and `verifyTurnHook` (install time) answer
 * whether a per-turn hook is wired and loads, naming the harness's own
 * inspect command when it does not.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bunSpawnSync } from '../spawn.ts';
import { ownedEntryFingerprint } from '../bootstrap/adopted-connections.ts';
import { codexHookCensus, codexHookGroupRuns, codexHookTrustHash, codexSetupHookGroup, codexSetupTrustEntry, writeCodexSetupHooks, type CodexHookGroup } from '../bootstrap/codex-hooks.ts';
import { appendCodexTomlTable, readCodexTomlTable, removeCodexTomlTable } from '../bootstrap/codex-toml.ts';
import { buildClaudeHookCommand, classifyHarnessHook, hookEntryHash, removeClaudeHooksAt, writeClaudeHooksAt } from '../bootstrap/hooks.ts';
import { CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS, GBRAIN_HOOK_MARKER_KEY, claudeUserSettingsPath, codexConfigPath, codexHooksPath } from '../bootstrap/host-specs.ts';

export const TURN_RULE_LANE = 'turn-rule';
export const TURN_RULE_MARKER = 'turn-rule-v1';
export const TURN_RULE_LANE_TOKEN = 'GBRAIN_HOOK_LANE=turn-rule';
const EVENT = 'UserPromptSubmit';
const TRUST_STATE = 'user_prompt_submit';

export type TurnRuleHarness = 'claude-code' | 'codex';
export function isTurnRuleHarness(h: string): h is TurnRuleHarness { return h === 'claude-code' || h === 'codex'; }

export interface TurnHookPaths {
  /** Claude Code settings.json (default: the user settings file). */
  claudeSettings?: string;
  /** Codex hooks.json and config.toml (default: CODEX_HOME's). */
  codexHooks?: string;
  codexConfig?: string;
}

export interface TurnHookOutcome {
  harness: string;
  action: 'write' | 'keep' | 'remove' | 'skip' | 'print';
  path: string;
  detail: string;
  /** For `print`: the one command that wires it. */
  next?: string;
}

const claudePath = (p: TurnHookPaths) => p.claudeSettings ?? claudeUserSettingsPath();
const codexPaths = (p: TurnHookPaths) => ({ hooks: p.codexHooks ?? codexHooksPath(), config: p.codexConfig ?? codexConfigPath() });

export function claudeTurnRuleCommand(gbrainBin: string, gbrainHome?: string): string {
  return buildClaudeHookCommand(gbrainBin, EVENT, { ...(gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}), GBRAIN_HOOK_LANE: TURN_RULE_LANE });
}

export function codexTurnRuleGroup(gbrainBin: string, gbrainHome?: string): CodexHookGroup {
  return codexSetupHookGroup(gbrainBin, EVENT, gbrainHome ? { GBRAIN_HOME: gbrainHome } : {}, TURN_RULE_LANE);
}

/** A Claude Code hook entry that is this lane's: marked, or (marker dropped) its command shape. */
export function isTurnRuleEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (e[GBRAIN_HOOK_MARKER_KEY] === TURN_RULE_MARKER) return true;
  return !Object.prototype.hasOwnProperty.call(e, GBRAIN_HOOK_MARKER_KEY) && typeof e.command === 'string'
    && e.command.includes(TURN_RULE_LANE_TOKEN) && /\shook user-prompt(?:\s|$)/.test(e.command);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Every command entry under UserPromptSubmit in a Claude Code settings file. */
function claudePromptEntries(path: string): Array<Record<string, unknown>> {
  const groups = (readJson(path)?.hooks as Record<string, unknown> | undefined)?.[EVENT];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((g) => (Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : []))
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
}

/** An entry another gbrain lane owns (setup, workspace bootstrap, bootstrap harness). A repo's committed settings.json counts only a command that parses as gbrain's hook, never a bare marker. */
export function isOtherGbrainEntry(e: Record<string, unknown>, committed = false): boolean {
  if (isTurnRuleEntry(e)) return false;
  return (!committed && typeof e[GBRAIN_HOOK_MARKER_KEY] === 'string') || !!classifyHarnessHook(e, EVENT, 'any');
}

/**
 * Runtime dedupe for the turn-rule lane: another gbrain lane already wires
 * UserPromptSubmit for this harness, and that hook adds the same rule.
 * Fail-open (an unreadable file counts as not wired).
 */
export function turnRuleHookYields(harness: string, cwd: string): boolean {
  if (harness === 'codex') {
    // Only a group Codex actually runs (trusted, enabled) carries the rule.
    try { return codexHookCensus(codexHooksPath()).some((g) => g.event === EVENT && (g.lane === 'setup' || g.lane === 'bootstrap') && codexHookGroupRuns(codexHooksPath(), codexConfigPath(), g)); } catch { return false; }
  }
  return claudePromptEntries(claudeUserSettingsPath()).some((e) => isOtherGbrainEntry(e))
    || claudePromptEntries(join(cwd, '.claude', 'settings.local.json')).some((e) => isOtherGbrainEntry(e))
    || claudePromptEntries(join(cwd, '.claude', 'settings.json')).some((e) => isOtherGbrainEntry(e, true));
}

/** Install or refresh the turn-rule hook. Never throws; anything it cannot write safely comes back as `print` with the command that wires it. */
export function syncTurnRuleHook(opts: { harness: TurnRuleHarness; gbrainBin: string | null; gbrainHome?: string; paths?: TurnHookPaths; dryRun?: boolean; rerun: string }): TurnHookOutcome {
  const paths = opts.paths ?? {};
  const where = opts.harness === 'codex' ? codexPaths(paths).hooks : claudePath(paths);
  const print = (why: string): TurnHookOutcome => ({ harness: opts.harness, action: 'print', path: where, detail: `per-turn rule hook not installed: ${why}`, next: opts.rerun });
  if (!opts.gbrainBin || !opts.gbrainBin.startsWith('/')) return print('no absolute gbrain binary was found (harnesses inherit no PATH); install gbrain globally or pass --gbrain-bin');
  try {
    return opts.harness === 'codex' ? syncCodex(opts.gbrainBin, opts.gbrainHome, codexPaths(paths), !!opts.dryRun, print)
      : syncClaude(opts.gbrainBin, opts.gbrainHome, claudePath(paths), !!opts.dryRun);
  } catch (e) {
    return print((e as Error).message);
  }
}

function syncClaude(bin: string, home: string | undefined, path: string, dryRun: boolean): TurnHookOutcome {
  const command = claudeTurnRuleCommand(bin, home);
  const want = { type: 'command', command, timeout: CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[EVENT] };
  const wantHash = hookEntryHash(want)!;
  const ours = claudePromptEntries(path).filter(isTurnRuleEntry);
  const detail = `per-turn rule hook (UserPromptSubmit) in ${path}`;
  if (ours.length === 1 && hookEntryHash(ours[0]) === wantHash) return { harness: 'claude-code', action: 'keep', path, detail };
  if (dryRun) return { harness: 'claude-code', action: 'write', path, detail };
  mkdirSync(dirname(path), { recursive: true });
  const owned = new Set([wantHash, ...ours.map((e) => hookEntryHash(e)).filter((h): h is string => !!h)]);
  writeClaudeHooksAt(path, { gbrainBin: bin, env: { ...(home ? { GBRAIN_HOME: home } : {}), GBRAIN_HOOK_LANE: TURN_RULE_LANE, GBRAIN_SEAT: '' },
    events: [EVENT], marker: TURN_RULE_MARKER, ownedEntryHashes: owned, freshMode: 0o600 });
  return { harness: 'claude-code', action: 'write', path, detail };
}

const trustPath = (key: string) => ['hooks', 'state', key];
const trustKey = (hooksPath: string, index: number) => `${hooksPath}:${TRUST_STATE}:${index}:0`;

/** Our groups in hooks.json with the trust table Codex would read for each. */
function codexOurs(paths: { hooks: string; config: string }) {
  return codexHookCensus(paths.hooks).filter((g) => g.event === EVENT && g.lane === 'turn-rule');
}

/** Remove the trust table at `key` only when it trusts exactly one of our commands. */
function dropOurTrust(config: string, key: string, commands: string[]): void {
  const table = readCodexTomlTable(config, trustPath(key)) as { trusted_hash?: unknown } | undefined;
  if (!table || !commands.some((c) => codexHookTrustHash(TRUST_STATE, c, 15) === table.trusted_hash)) return;
  removeCodexTomlTable(config, trustPath(key));
}

function syncCodex(bin: string, home: string | undefined, paths: { hooks: string; config: string }, dryRun: boolean, print: (why: string) => TurnHookOutcome): TurnHookOutcome {
  const group = codexTurnRuleGroup(bin, home);
  const hash = ownedEntryFingerprint(group);
  const ours = codexOurs(paths);
  const detail = `per-turn rule hook (UserPromptSubmit) in ${paths.hooks}, trusted in ${paths.config}`;
  const current = ours.length === 1 && ours[0]!.hash === hash;
  const { key, trusted_hash } = codexSetupTrustEntry(paths.hooks, EVENT, current ? ours[0]!.index : 0, group);
  const trusted = current && (readCodexTomlTable(paths.config, trustPath(key)) as { trusted_hash?: unknown } | undefined)?.trusted_hash === trusted_hash;
  if (current && trusted) return { harness: 'codex', action: 'keep', path: paths.hooks, detail };
  if (dryRun) return { harness: 'codex', action: 'write', path: paths.hooks, detail };
  mkdirSync(dirname(paths.hooks), { recursive: true, mode: 0o700 });
  const commands = ours.flatMap((g) => g.commands);
  for (const g of ours) dropOurTrust(paths.config, trustKey(paths.hooks, g.index), commands);
  const w = writeCodexSetupHooks(paths.hooks, { want: { [EVENT]: group }, owned: new Set(ours.map((g) => g.hash)), preserve: new Set() });
  const index = w.indexes[EVENT];
  if (index === undefined) return print(`${paths.hooks} did not take the hook`);
  const entry = codexSetupTrustEntry(paths.hooks, EVENT, index, group);
  const existing = readCodexTomlTable(paths.config, trustPath(entry.key)) as { trusted_hash?: unknown } | undefined;
  if (existing === undefined) appendCodexTomlTable(paths.config, trustPath(entry.key), { trusted_hash: entry.trusted_hash }, 'gbrain setup (turn-rule): trusts the per-turn brain-first rule hook; owned by its hash');
  else if (existing.trusted_hash !== entry.trusted_hash) return print(`${paths.config} already has a different [hooks.state."${entry.key}"]; trust gbrain's UserPromptSubmit hook in Codex's /hooks`);
  return { harness: 'codex', action: 'write', path: paths.hooks, detail };
}

/** Remove the turn-rule hook (opt-out or uninstall). Never throws. */
export function removeTurnRuleHook(opts: { harness: TurnRuleHarness; paths?: TurnHookPaths; dryRun?: boolean }): TurnHookOutcome {
  const paths = opts.paths ?? {};
  try {
    if (opts.harness === 'codex') {
      const p = codexPaths(paths);
      const ours = codexOurs(p);
      if (ours.length === 0) return { harness: 'codex', action: 'skip', path: p.hooks, detail: `no per-turn rule hook in ${p.hooks}` };
      if (!opts.dryRun) {
        const commands = ours.flatMap((g) => g.commands);
        for (const g of ours) dropOurTrust(p.config, trustKey(p.hooks, g.index), commands);
        const w = writeCodexSetupHooks(p.hooks, { want: {}, owned: new Set(ours.map((g) => g.hash)), preserve: new Set() });
        if (w.notes.length) return { harness: 'codex', action: 'remove', path: p.hooks, detail: `per-turn rule hook removed from ${p.hooks}; ${w.notes.join(' ')}` };
      }
      return { harness: 'codex', action: 'remove', path: p.hooks, detail: `per-turn rule hook removed from ${p.hooks}` };
    }
    const path = claudePath(paths);
    const ours = claudePromptEntries(path).filter(isTurnRuleEntry);
    if (ours.length === 0) return { harness: 'claude-code', action: 'skip', path, detail: `no per-turn rule hook in ${path}` };
    if (!opts.dryRun) removeClaudeHooksAt(path, TURN_RULE_MARKER, { ownedEntryHashes: new Set(ours.map((e) => hookEntryHash(e)).filter((h): h is string => !!h)) });
    return { harness: 'claude-code', action: 'remove', path, detail: `per-turn rule hook removed from ${path}` };
  } catch (e) {
    return { harness: opts.harness, action: 'skip', path: opts.harness === 'codex' ? codexPaths(paths).hooks : claudePath(paths), detail: `per-turn rule hook left as it is (${(e as Error).message})` };
  }
}

export function describeTurnHookOutcome(o: TurnHookOutcome, dryRun = false): string {
  const verb = dryRun && (o.action === 'write' || o.action === 'remove') ? `would ${o.action}` : o.action;
  return `  ${verb.padEnd(8)} ${'turn hook'.padEnd(7)} ${o.detail}${o.next ? `; wire it with: ${o.next}` : ''}`;
}
