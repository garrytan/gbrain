/**
 * `gbrain bootstrap harness` lane of the brain-first instruction block
 * (src/core/setup/brain-first.ts): each host whose MCP entry is confirmed gets
 * the managed block in its own instruction file; removal strips only the
 * blocks this lane recorded.
 */
import { dirname, join } from 'node:path';
import { claudeUserSettingsPath, codexConfigPath } from './host-specs.ts';
import { describeTurnHookOutcome, removeTurnRuleHook } from '../setup/turn-hook.ts';
import { installerTurnHook, TURN_HOOK_NATIVE_INSPECT, type TurnHookVerdict } from '../setup/turn-hook-check.ts';
import { brainFirstTargetAt, codexInstructionFile, describeBrainFirstOutcome, installerBrainFirst, readBrainFirstLedger, removeBrainFirst } from '../setup/brain-first.ts';

const WRITER = 'gbrain bootstrap harness';

export type BrainFirstHost = 'claude-code' | 'codex' | 'opencode';

export interface HarnessInstructionPaths {
  claudeMemoryPath: string;
  codexAgentsPath: string;
  codexAgentsOverride: string;
  opencodeAgentsPath: string;
}

export function writeHarnessBrainFirst(opts: { hosts: readonly BrainFirstHost[]; server: string; optOut: boolean; paths: HarnessInstructionPaths; log: (line: string) => void }): void {
  const { paths } = opts;
  for (const host of opts.hosts) {
    const path = host === 'claude-code' ? paths.claudeMemoryPath
      : host === 'codex' ? codexInstructionFile(paths.codexAgentsOverride, paths.codexAgentsPath)
        : paths.opencodeAgentsPath;
    const o = installerBrainFirst({ target: brainFirstTargetAt(host, path), access: { kind: 'mcp', server: opts.server },
      writer: WRITER, instructions: opts.optOut ? false : undefined });
    opts.log(describeBrainFirstOutcome(o, false).trim());
  }
}

export function removeHarnessBrainFirst(server: string, log: (line: string) => void): void {
  for (const e of readBrainFirstLedger().filter((entry) => entry.writer === WRITER)) {
    log(describeBrainFirstOutcome(removeBrainFirst({ harness: e.harness, path: e.path, dryRun: false, server }), false).trim());
  }
}

/**
 * The per-turn rule for hosts whose hooks this lane does not otherwise wire:
 * Codex always (the bootstrap Codex lane wires only SessionEnd capture), Claude
 * Code when its lifecycle hooks are off here. Registrar mode wires none. Opted out
 * (block declined) removes it. Returns false when a hook could not be wired or
 * does not load, so the install fails loudly.
 */
export function writeHarnessTurnHooks(opts: { hosts: readonly BrainFirstHost[]; claudeHooksWired: boolean; noHooks: boolean; gbrainBin: string | null;
  userSettingsPath: string; codexConfig: string; log: (line: string) => void; logError: (line: string) => void }): { ok: boolean; results: Array<{ host: string; action: string; detail: string; check?: TurnHookVerdict }> } {
  const results: Array<{ host: string; action: string; detail: string; check?: TurnHookVerdict }> = [];
  let ok = true;
  if (opts.noHooks) return { ok, results };
  const ledger = readBrainFirstLedger();
  for (const host of opts.hosts) {
    if (host === 'opencode' || (host === 'claude-code' && opts.claudeHooksWired)) continue;
    const paths = host === 'codex' ? { codexHooks: join(dirname(opts.codexConfig), 'hooks.json'), codexConfig: opts.codexConfig } : { claudeSettings: opts.userSettingsPath };
    const sandboxed = host === 'codex' ? opts.codexConfig !== codexConfigPath() : opts.userSettingsPath !== claudeUserSettingsPath();
    const accepted = process.env.GBRAIN_AGENT_INSTRUCTIONS !== '0' && ledger.some((e) => e.harness === host && e.writer === WRITER && e.status === 'installed');
    const { outcome, verdict } = installerTurnHook({ harness: host, accepted, gbrainBin: opts.gbrainBin, gbrainHome: process.env.GBRAIN_HOME?.trim() || undefined,
      paths: sandboxed ? paths : undefined, rerun: `gbrain setup ${host} --instructions-only` });
    opts.log(describeTurnHookOutcome(outcome).trim());
    results.push({ host, action: outcome.action, detail: outcome.detail, ...(verdict ? { check: verdict } : {}) });
    if (verdict && !verdict.ok) {
      ok = false;
      opts.logError(`turn_hook_not_loaded (${verdict.reason}): the per-turn gbrain hook for ${host} is not active: ${verdict.message}. Fix: gbrain setup ${host} --instructions-only; check: ${TURN_HOOK_NATIVE_INSPECT[host]}`);
    }
  }
  return { ok, results };
}

/** Uninstall: drop the turn-rule hook for a host once no brain-first block is recorded for it any more. */
export function removeHarnessTurnHooks(opts: { userSettingsPath: string; codexConfig: string; log: (line: string) => void }): void {
  const ledger = readBrainFirstLedger();
  for (const host of ['claude-code', 'codex'] as const) {
    if (ledger.some((e) => e.harness === host && e.status === 'installed')) continue;
    const paths = host === 'codex' ? { codexHooks: join(dirname(opts.codexConfig), 'hooks.json'), codexConfig: opts.codexConfig } : { claudeSettings: opts.userSettingsPath };
    const o = removeTurnRuleHook({ harness: host, paths });
    if (o.action === 'remove') opts.log(describeTurnHookOutcome(o).trim());
  }
}

/** The hosts bootstrap harness gives only the per-turn rule hook (consent block): Claude Code when its own hooks are off, Codex always; none when hooks, instructions or the lane are off. */
export function harnessTurnRuleHosts(p: { off: boolean | undefined; wireClaude: boolean; claudeHooksWired: boolean; wireCodex: boolean }): string[] {
  if (p.off || process.env.GBRAIN_AGENT_INSTRUCTIONS === '0') return [];
  return [...(p.wireClaude && !p.claudeHooksWired ? ['Claude Code'] : []), ...(p.wireCodex ? ['Codex'] : [])];
}

export function turnRuleConsentLine(hosts: string[] | undefined): string {
  return hosts?.length ? `The per-turn brain-first rule hook (UserPromptSubmit: one line telling the agent to check gbrain first; it reads no brain data) is wired for ${hosts.join(' and ')}. ` : '';
}
