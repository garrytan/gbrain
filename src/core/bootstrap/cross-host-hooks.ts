/** Five-host lifecycle-hook install/remove orchestration (opencode excluded). */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildClaudeHookCommand, claudeSettingsPath, removeClaudeHooksAt, writeClaudeHooksAt } from './hooks.ts';
import {
  CLAUDE_HOOK_EVENTS,
  COMMON_HOOK_EVENTS,
  CROSS_HOST_HOOK_HARNESSES,
  GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE,
  claudeUserSettingsPath,
  codexHooksPath,
  traeCliConfigPath,
  traeCnHooksPath,
  traeDesktopHooksPath,
  type ClaudeHookEvent,
  type CrossHostHookHarness,
} from './host-specs.ts';
import { removeTraeCliHooks, writeTraeCliHooks } from './traecli-hooks-toml.ts';
import { acquireBootstrapLock } from './lock.ts';
import { readManifest } from './format.ts';

export type CrossHostHookSelector = CrossHostHookHarness | 'all';

export interface CrossHostHookTarget {
  harness: CrossHostHookHarness;
  path: string;
  events: readonly ClaudeHookEvent[];
}

export interface CrossHostHookOptions {
  workspaceDir: string;
  gbrainBin: string;
  sourceId: string;
  brainId?: string;
  gbrainHome?: string;
  repair?: boolean;
  dryRun?: boolean;
}

export interface CrossHostHookResult extends CrossHostHookTarget {
  action: 'installed' | 'removed' | 'absent';
  count: number;
  backupPath: string | null;
  notes: string[];
}

export interface RunCrossHostHookRepairOptions {
  workspaceDir: string;
  lockRoot: string;
  rest: string[];
  brainId?: string | null;
  resolveGbrainBin: () => string | null;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

export async function runCrossHostHookRepair(opts: RunCrossHostHookRepairOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const logError = opts.logError ?? console.error;
  const dryRun = opts.rest.includes('--dry-run');
  if (!opts.rest.includes('--repair')) {
    logError('machine-global multi-host hook wiring requires --repair; add --dry-run to preview without writes.');
    return 2;
  }
  if (opts.rest.includes('--no-hooks')) {
    logError('--no-hooks conflicts with --harness all (this path is hooks-only).');
    return 2;
  }
  const explicitSource = flagValue(opts.rest, '--source');
  const state = readManifest(opts.workspaceDir);
  if (!explicitSource && state.state !== 'initialized') {
    logError(
      state.state === 'template'
        ? 'this is an uninitialized template — pass --source <id> or run gbrain bootstrap render first'
        : 'not an initialized agent workspace — pass --source <id> or run gbrain bootstrap render first',
    );
    return 1;
  }
  const gbrainBin = flagValue(opts.rest, '--gbrain-bin') ?? opts.resolveGbrainBin();
  if (!gbrainBin) {
    logError('cannot resolve an absolute gbrain binary path; install gbrain globally or pass --gbrain-bin <abs path>');
    return 2;
  }
  const gbrainHome = process.env.GBRAIN_HOME?.trim() || undefined;
  const brainId = opts.brainId ?? (process.env.GBRAIN_BRAIN_ID?.trim() || undefined);
  const targets = crossHostHookTargets('all', opts.workspaceDir);
  const installOpts: CrossHostHookOptions = {
    workspaceDir: opts.workspaceDir,
    gbrainBin,
    sourceId: explicitSource ?? (state.state === 'initialized' ? state.manifest.source_id : ''),
    ...(brainId ? { brainId } : {}),
    ...(gbrainHome ? { gbrainHome } : {}),
    repair: true,
  };
  try {
    for (const target of targets) installCrossHostHook(target, { ...installOpts, dryRun: true });
    if (dryRun) {
      log('dry-run: machine-global lifecycle hooks only; no hook configs, MCP registrations, or gbrain state will be changed.');
      for (const target of targets) {
        const result = installCrossHostHook(target, { ...installOpts, dryRun: true });
        log(target.harness + ': ' + target.path + ' (' + result.count + ' event(s))');
        for (const command of previewCrossHostHook(target, installOpts)) log('  ' + command);
        for (const note of result.notes) logError(note);
      }
      return 0;
    }
    const lock = await acquireBootstrapLock(opts.lockRoot);
    try {
      for (const target of targets) {
        const result = installCrossHostHook(target, { ...installOpts, dryRun: false });
        log('hooks installed for ' + target.harness + ' (' + result.count + ' event(s)) in ' + target.path + ' [repair]');
        for (const note of result.notes) logError(note);
      }
    } finally {
      lock.release();
    }
    log('multi-host hook repair complete; MCP wiring was intentionally unchanged.');
    return 0;
  } catch (error) {
    logError((error as Error).message);
    return 1;
  }
}

export function isCrossHostHookSelector(value: string | undefined): value is CrossHostHookSelector {
  return value === 'all' || (CROSS_HOST_HOOK_HARNESSES as readonly string[]).includes(value ?? '');
}

export function crossHostHookTargets(
  selector: CrossHostHookSelector,
  workspaceDir: string,
): CrossHostHookTarget[] {
  const harnesses = selector === 'all' ? CROSS_HOST_HOOK_HARNESSES : [selector];
  return harnesses.map((harness) => {
    const events = harness === 'claude-code' ? CLAUDE_HOOK_EVENTS : COMMON_HOOK_EVENTS;
    switch (harness) {
      case 'claude-code': return {
        harness,
        path: selector === 'all' ? resolveClaudeMachineHookPath() : claudeSettingsPath(workspaceDir),
        events,
      };
      case 'codex': return { harness, path: codexHooksPath(), events };
      case 'traecli': return { harness, path: traeCliConfigPath(), events };
      case 'traecode': return { harness, path: traeDesktopHooksPath(), events };
      case 'traecode-cn': return { harness, path: traeCnHooksPath(), events };
    }
  });
}

function hasGbrainHook(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return false; }
  return /(?:\/src\/cli\.ts["']?|\/gbrain["']?|(?:^|\s)gbrain)\s+hook\s+/.test(JSON.stringify(parsed));
}

/** Prefer the one existing user-level Claude carrier that already owns a
 * gbrain hook. Two carriers would double-fire, so refuse instead of guessing. */
export function resolveClaudeMachineHookPath(): string {
  const canonical = claudeUserSettingsPath();
  const local = join(dirname(canonical), 'settings.local.json');
  const canonicalOwns = hasGbrainHook(canonical);
  const localOwns = hasGbrainHook(local);
  if (canonicalOwns && localOwns) {
    throw new Error(
      `gbrain hooks exist in both ${canonical} and ${local}; refusing to double-wire. ` +
        'Remove one carrier, then re-run with --repair.',
    );
  }
  return localOwns ? local : canonical;
}

export function installCrossHostHook(
  target: CrossHostHookTarget,
  opts: CrossHostHookOptions,
): CrossHostHookResult {
  if (target.harness === 'traecli') {
    const result = writeTraeCliHooks(target.path, {
      gbrainBin: opts.gbrainBin,
      sourceId: opts.sourceId,
      ...(opts.brainId ? { brainId: opts.brainId } : {}),
      ...(opts.gbrainHome ? { gbrainHome: opts.gbrainHome } : {}),
      repair: opts.repair,
      dryRun: opts.dryRun,
    });
    return {
      ...target,
      action: 'installed',
      count: result.installed.length,
      backupPath: result.backupPath,
      notes: result.notes,
    };
  }

  const result = writeClaudeHooksAt(target.path, {
    gbrainBin: opts.gbrainBin,
    env: {
      GBRAIN_SOURCE: opts.sourceId,
      ...(opts.brainId ? { GBRAIN_BRAIN_ID: opts.brainId } : {}),
      ...(target.harness === 'claude-code' ? { GBRAIN_HOOK_LANE: 'harness' } : {}),
      GBRAIN_HARNESS: target.harness,
      ...(opts.gbrainHome ? { GBRAIN_HOME: opts.gbrainHome } : {}),
    },
    events: [...target.events],
    marker: GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE,
    backupStrategy: 'timestamped',
    freshMode: 0o600,
    ...(target.harness === 'traecode' || target.harness === 'traecode-cn'
      ? { rootDefaults: { version: 1 } }
      : {}),
    legacyAdoption: {
      repair: opts.repair === true,
      harness: target.harness,
      sourceId: opts.sourceId,
    },
    dryRun: opts.dryRun,
  });
  return {
    ...target,
    action: 'installed',
    count: result.installed.length,
    backupPath: result.backupPath,
    notes: result.notes,
  };
}

export function previewCrossHostHook(target: CrossHostHookTarget, opts: CrossHostHookOptions): string[] {
  return target.events.map((event) => buildClaudeHookCommand(opts.gbrainBin, event, {
    GBRAIN_SOURCE: opts.sourceId,
    ...(opts.brainId ? { GBRAIN_BRAIN_ID: opts.brainId } : {}),
    ...(target.harness === 'claude-code' ? { GBRAIN_HOOK_LANE: 'harness' } : {}),
    GBRAIN_HARNESS: target.harness,
    ...(opts.gbrainHome ? { GBRAIN_HOME: opts.gbrainHome } : {}),
  }));
}

export function removeCrossHostHook(target: CrossHostHookTarget): CrossHostHookResult {
  if (target.harness === 'traecli') {
    const result = removeTraeCliHooks(target.path);
    return {
      ...target,
      action: result.removed ? 'removed' : 'absent',
      count: result.removed ? target.events.length : 0,
      backupPath: result.backupPath,
      notes: result.notes,
    };
  }
  const result = removeClaudeHooksAt(target.path, GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE);
  return {
    ...target,
    action: result.removed > 0 ? 'removed' : 'absent',
    count: result.removed,
    backupPath: result.backupPath,
    notes: result.notes,
  };
}
