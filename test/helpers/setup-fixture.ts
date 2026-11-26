import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './cli-spawn.ts';

export const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');

export interface Box { root: string; home: string; gbrainHome: string; bin: string }

export function createSetupFixture() {
  const roots: string[] = [];
  function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function box(): Box {
    const root = tempDir('gbrain-setup-');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const bin = join(root, 'bin', 'gbrain');
    mkdirSync(join(root, 'bin'));
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    return { root, home, gbrainHome: home, bin };
  }

  function cleanup(): void {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }

  return { box, tempDir, cleanup };
}

export const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };

export async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--gbrain-bin', b.bin], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome, ...env } });
  let doc: any = null;
  if (args.includes('--json')) { try { doc = JSON.parse(r.stdout); } catch { doc = null; } }
  return { ...r, doc };
}

/** The hook launcher setup registers serve behind (#8426). */
export const launcher = (b: Box) => join(b.gbrainHome, '.gbrain', 'hook-launcher', 'gbrain-hook');

export const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
export const claudeJson = (b: Box) => join(b.home, '.claude.json');
export const settings = (b: Box) => join(b.home, '.claude', 'settings.json');
export const receipt = (b: Box, name = 'gbrain') => join(b.home, `.gbrain-connection-claude-code-${name}.json`);

/** Every hook entry under an event, flattened. */
export function entries(b: Box, event: string): any[] {
  if (!existsSync(settings(b))) return [];
  return (readJson(settings(b)).hooks?.[event] ?? []).flatMap((g: any) => g.hooks ?? []);
}

export const codexDir = (b: Box) => join(b.home, '.codex');
export const codexToml = (b: Box) => join(codexDir(b), 'config.toml');
export const hooksJson = (b: Box) => join(codexDir(b), 'hooks.json');
export const codexReceipt = (b: Box, name = 'gbrain') => join(codexDir(b), `.gbrain-connection-codex-${name}.json`);
export const toml = (b: Box): any => Bun.TOML.parse(readFileSync(codexToml(b), 'utf8'));
export const trustKeys = (b: Box): string[] => Object.keys(toml(b).hooks?.state ?? {}).sort();
export const trustKey = (b: Box, event: string, index: number) => `${hooksJson(b)}:${event}:${index}:0`;
/** Matcher groups under one hooks.json event. */
export function groups(b: Box, event: string): any[] {
  if (!existsSync(hooksJson(b))) return [];
  return readJson(hooksJson(b)).hooks?.[event] ?? [];
}
export const setupGroups = (b: Box, event: string) => groups(b, event).filter((g) => g.hooks?.[0]?.command?.includes('GBRAIN_HOOK_LANE=setup'));
