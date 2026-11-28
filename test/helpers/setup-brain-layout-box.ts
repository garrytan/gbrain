/**
 * The fixture behind the test/setup-brain-layout*.test.ts files (GST-2731; split by shape in GST-4082): a throwaway home
 * with a gbrain shim, the setup and gbrain runners in it, and the notes, docs and call folders the layouts read.
 * A file that makes boxes registers `afterAll(cleanupBoxes)`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './cli-spawn.ts';

const CLI = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');
export const roots: string[] = [];
export function cleanupBoxes(): void { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); }

export interface Box { root: string; home: string; bin: string }
export function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-layout-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, bin };
}

const CLEAN = { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };
export const envOf = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home });

export async function setup(b: Box, args: string[]): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--json', '--gbrain-bin', b.bin], { env: envOf(b) });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
export const gbrain = (b: Box, args: string[]) => runCli(args, { env: envOf(b) });
export const claudeMd = (b: Box) => join(b.home, '.claude', 'CLAUDE.md');

export function notesDir(b: Box, extra = 0): string {
  const dir = join(b.root, 'notes');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'pricing.md'), '# Pricing thoughts\n\nCharge per seat, not per query.\n');
  writeFileSync(join(dir, 'sub', 'hiring.md'), '---\ntitle: Hiring notes\n---\nHire slowly.\n');
  for (let i = 0; i < extra; i++) writeFileSync(join(dir, `bulk-${i}.md`), `# Bulk ${i}\n`);
  return dir;
}
export function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true }).sort((a, z) => a.name.localeCompare(z.name))) {
      const p = join(d, n.name);
      h.update(p);
      if (n.isDirectory()) walk(p); else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

export function docsDir(b: Box): string {
  const dir = join(b.root, 'company-docs');
  mkdirSync(join(dir, 'pricing'), { recursive: true });
  writeFileSync(join(dir, 'pricing', 'q3.md'), '# Q3 pricing review\n\nWe moved the team plan to annual billing.\n');
  writeFileSync(join(dir, 'onboarding.md'), '# Onboarding playbook\n\nSend the welcome email first.\n');
  return dir;
}
export const sourceIds = async (b: Box): Promise<any[]> => JSON.parse((await gbrain(b, ['sources', 'list', '--json'])).stdout).sources;

export const plantedToken = (): string => 'github' + '_pat_' + randomBytes(24).toString('hex');
export function callsDir(b: Box, token: string): string {
  const dir = join(b.root, 'call-exports');
  mkdirSync(join(dir, 'q1'), { recursive: true });
  writeFileSync(join(dir, '2026-03-04 acme-example renewal.txt'), `Alice: we agreed to move acme-example to annual billing.\nBob: the deploy key is ${token} for the record.\n`);
  writeFileSync(join(dir, 'q1', 'weekly-sync.md'), '# Weekly sync 2026-02-01\n\nAlice: pricing stays at 20 dollars per seat.\n');
  const undated = join(dir, 'kickoff.txt');
  writeFileSync(undated, 'Kickoff with acme-example\nBob: the first milestone is onboarding.\n');
  utimesSync(undated, new Date(2026, 0, 15, 12), new Date(2026, 0, 15, 12));
  writeFileSync(join(dir, 'slides.pdf'), 'not a call');
  return dir;
}
export const CALL_SLUGS = ['company/calls/2026-03-04-acme-example-renewal', 'company/calls/2026-02-01-weekly-sync', 'company/calls/2026-01-15-kickoff-with-acme-example'];
export const callPages = async (b: Box): Promise<string[]> => {
  const r = await gbrain(b, ['list', '--source', 'company', '--json']);
  return (JSON.parse(r.stdout) as Array<{ slug: string }>).map((p) => p.slug).filter((s) => s.startsWith('company/calls/')).sort();
};
