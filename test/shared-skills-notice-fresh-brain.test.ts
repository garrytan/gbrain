/**
 * GBRA-585: the v0.53.0 shared-skills orchestrator's console summary counts
 * host work by the same rule as the migration ledger and doctor
 * (sharedSkillsHostWork, #6796): a source whose only open stage is
 * `members` (no client installation enrolled, which is never verified) owes
 * no host work, so a fresh brain is not told on every apply-migrations and
 * post-upgrade that it "need[s] host action". The per-source reason stays
 * visible as information, with the read-only inspect command.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedContentMigration } from '../src/commands/migrations/shared-content.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-notice-'));

beforeAll(() => {
  const init = Bun.spawnSync(['bun', 'run', join(import.meta.dir, '..', 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding', '--non-interactive'], {
    env: { ...process.env, GBRAIN_HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  if (init.exitCode !== 0) throw new Error(`gbrain init failed: ${init.stderr.toString()}`);
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function runOrchestrator(): Promise<{ lines: string[]; result: Awaited<ReturnType<typeof sharedContentMigration.orchestrator>> }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await withEnv({ GBRAIN_HOME: home }, () => sharedContentMigration.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true }));
    return { lines: lines.filter(line => line.startsWith('[shared-skills]')), result };
  } finally { console.error = original; }
}

describe('GBRA-585 shared-skills notice on a fresh brain', () => {
  test('a source with only an unenrolled client installation is not counted as needing host action', async () => {
    const { lines, result } = await runOrchestrator();
    const summary = lines[0] ?? '';
    expect(summary).not.toContain('action_required');
    expect(summary).not.toContain('need host action');
    expect(summary).toContain('No source needs host action');
    expect(lines.join('\n')).toContain('No installation has enrolled');
    expect(lines.join('\n')).toContain('gbrain apply-migrations --migration 0.53.0 --dry-run --json');
    expect(result.status).toBe('complete');
  }, 120_000);
});
