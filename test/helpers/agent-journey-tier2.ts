/**
 * Shared fixtures for the Lane H1b (Tier 2) agent-journey files: a seeded
 * keyless PGLite brain, the `--json` document contract, and a `gbrain` on PATH
 * for running plan and fix commands as an agent pastes them.
 */
import { expect } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { REPO, journeyEnv, oneDocument, type GbResult } from './agent-journey.ts';

export const MARKER = 'wombat-tier2-marker';

export function writeNotes(dir: string, n: number, prefix = 'tier2-note'): string {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `${prefix}-${i}.md`), `---\ntitle: ${prefix} ${i}\n---\n\n# ${prefix} ${i}\n\nThe ${MARKER} ${i}.\n`);
  return dir;
}

async function withBrain<T>(home: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

export async function seedTimelineFinding(home: string, slug: string): Promise<void> {
  await withBrain(home, engine => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    `INSERT INTO timeline_entries(page_id,date,source,summary,detail)
       SELECT id,'2026-07-01','legacy','A database-only event','' FROM pages WHERE source_id='default' AND slug=$1`, [slug]),
  TEST_WRITE_ATTRIBUTION)));
}

/** A `--json` invocation: one parseable document; a failure document names code + suggestion. */
export function expectJsonContract(r: GbResult, label: string): Record<string, any> {
  const doc = oneDocument(r, label);
  if (r.exitCode !== 0 && r.exitCode !== 3) {
    expect(typeof doc.code, `${label}: failure document has code (exit ${r.exitCode})`).toBe('string');
    expect(typeof doc.suggestion, `${label}: failure document has suggestion`).toBe('string');
  }
  return doc;
}

/** A directory with a `gbrain` that runs this checkout, so plan/fix command strings run as pasted. */
export function gbrainShim(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec bun --no-env-file run ${JSON.stringify(join(REPO, 'src', 'cli.ts'))} "$@"\n`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  return bin;
}

export async function sh(home: string, command: string, bin: string, timeoutMs = 120_000): Promise<GbResult> {
  const t0 = performance.now();
  const env = journeyEnv(home, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const proc = Bun.spawn(['sh', '-c', command], { cwd: home, env, stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(killed, `${command} hung`).toBe(false);
    return { exitCode, stdout, stderr, ms: Math.round(performance.now() - t0), killed };
  } finally { clearTimeout(killer); }
}

export interface Check { name: string; status: string; message: string; fix?: Fix; fix_unavailable_reason?: string }
export interface Fix { argv?: string[]; command?: string; consent: string[]; actor: string; next: string; inputs?: unknown[]; verify?: { argv?: string[] }; then?: Fix; requires_exclusive?: boolean }
