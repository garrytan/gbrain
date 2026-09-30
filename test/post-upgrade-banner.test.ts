/**
 * `gbrain post-upgrade` recovery banner (fix wave 3, Lane D): one [AGENT]
 * block on a brain with wave findings, naming the brain, each finding's count
 * and the read-only preview; nothing on a clean brain; never an applying
 * command. The banner runs the full wave checks, not doctor --fast.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put, waveBrain } from './helpers/wave-fixture.ts';

describe('post-upgrade recovery banner', () => {
  test('a brain with wave findings gets one preview-only [AGENT] banner', async () => {
    await waveBrain(async ({ engine }) => {
      const lines = await postUpgradeRecoveryBanner(engine, 'host (pglite, id test-brain)');
      const text = lines.join('\n');
      expect(lines.filter(l => l.includes('Relay this to your operator'))).toHaveLength(1);
      expect(text).toContain('brain host (pglite, id test-brain)');
      expect(text).toContain('timeline_history: 1 (repairable after the user agrees)');
      expect(text).toContain('self_capture: 1 (needs an operator action)');
      expect(text).toContain('stale_embedding_effects: 1 (reported only; no command clears it yet)');
      expect(text).toContain('Preview (read-only): gbrain doctor --remediation-plan');
      expect(text).toContain('Ask the user before applying');
      expect(text).not.toContain('--yes');
      expect(text).not.toContain('--apply');
      for (const line of lines.filter(Boolean)) expect(line).toStartWith('[AGENT]');
    });
  }, 180_000);

  test('a clean brain prints nothing', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'notes/clean', 'Nothing to repair.');
      expect(await postUpgradeRecoveryBanner(engine, 'host')).toEqual([]);
    });
  }, 180_000);

  test('post-upgrade prints the banner and no longer prints an applying safe-chunk advisory', () => {
    // test-reads-source-ok[structural]: runPostUpgrade needs a configured brain plus a full migration run; this pins that it calls the banner and no longer prints the applying advisory.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'upgrade.ts'), 'utf8');
    expect(source).toContain('postUpgradeRecoveryBanner(engine');
    expect(source).not.toContain('safeChunkUpgradeAdvisory');
  });
});
