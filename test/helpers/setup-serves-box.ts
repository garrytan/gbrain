/**
 * The spawned half of the gbrain setup --serves suites (GST-363): a temp HOME / GBRAIN_HOME box with a gbrain launcher
 * that runs this checkout's src/cli.ts, and the readers those suites assert through. Used by
 * test/setup-serves-several.test.ts, test/setup-serves-stdio-member.test.ts and test/setup-serves-upgrade.test.ts; each
 * case builds its own box, so no case reads another's brain.
 */
import { expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownedEntryFingerprint } from '../../src/core/bootstrap/adopted-connections.ts';
import { runCli, type CliResult } from './cli-spawn.ts';

export const ROSTER = ['alice-example', 'bob-example'];
export const PAGES: Record<string, string> = {
  'people/alice-example/plan': 'alicecanary',
  'people/bob-example/plan': 'bobcanary',
  'people/carol-public': 'carolcanary',
  'notes/world-topic': 'worldcanary',
};
export const pageText = (slug: string, canary: string) => `---\ntype: note\ntitle: ${slug}\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`;
const roots: string[] = [];
/** A temp directory removeTempDirs() deletes; register afterAll(removeTempDirs) in each file that makes one. */
export const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
export const removeTempDirs = () => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); };

export const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');
export const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
export interface Box { root: string; home: string; bin: string }

export function box(): Box {
  const root = tempDir('gbrain-setup-serves-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}
export const gbrain = (b: Box, args: string[], env: Record<string, string | undefined> = {}) => runCli(args, { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, OPENCLAW_STATE_DIR: join(b.root, 'openclaw-state'), OPENCLAW_PROFILE: undefined, HERMES_HOME: join(b.root, 'hermes-home'), ...env }, timeoutMs: 120_000 });
export async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await gbrain(b, ['setup', ...args, '--gbrain-bin', b.bin]);
  let doc: any = null;
  if (args.includes('--json')) { try { doc = JSON.parse(r.stdout); } catch { doc = null; } }
  return { ...r, doc };
}
export async function brainWithPages(b: Box): Promise<void> {
  expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
  for (const [slug, canary] of Object.entries(PAGES)) expect((await gbrain(b, ['put', slug, '--content', pageText(slug, canary)])).exitCode).toBe(0);
}
export const entry = (b: Box) => JSON.parse(readFileSync(join(b.home, '.claude.json'), 'utf8')).mcpServers.gbrain as { command: string; args: string[] };
export const entryArgs = (b: Box) => entry(b).args;
/** setup's claude-code entry as it was before the launcher (#8426), still owned by its receipt, so post-upgrade rewrites it. */
export function staleEntry(b: Box): void {
  const cfgPath = join(b.home, '.claude.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.mcpServers.gbrain = { ...cfg.mcpServers.gbrain, command: b.bin };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const receiptPath = join(b.home, '.gbrain-connection-claude-code-gbrain.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, entry_hash: ownedEntryFingerprint(cfg.mcpServers.gbrain) }, null, 2));
}
export const stdioKey = async (b: Box) => { const r = await gbrain(b, ['config', 'get', 'mcp.stdio_member']); return r.exitCode === 0 ? r.stdout.trim() : ''; };
export function fakeOpenclaw(b: Box): string {
  const dir = join(b.root, 'oc-bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'openclaw'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'openclaw'), 0o755);
  return dir;
}
/** Every setup connection receipt under the box's HOME. */
export function setupReceipts(b: Box): any[] {
  const found: any[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json')) { try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j?.connection === 'local-stdio' && j?.setup_receipt_version) found.push(j); } catch { /* not JSON */ } }
  } };
  walk(b.home);
  return found;
}
export const claudeMd = (b: Box) => readFileSync(join(b.home, '.claude', 'CLAUDE.md'), 'utf8');
export const normalized = (doc: any) => JSON.parse(JSON.stringify(doc).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T'));
