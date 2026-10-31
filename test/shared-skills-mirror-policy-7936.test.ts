import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { sharedSkillSourcePolicy } from '../src/core/shared-skills/setup-source-policy.ts';

test('read-only mirrors are not shared-skill write targets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-mirror-policy-7936-'));
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine();
    try {
      await engine.executeRaw(`UPDATE sources SET config='{"mirror_read_only":true}'::jsonb WHERE id='default'`);
      const policy = await sharedSkillSourcePolicy(engine, 'default');
      expect(policy.mode).toBe('preserve_files');
      expect(policy.mode === 'preserve_files' && policy.reason).toContain('source_mirror_read_only');
    } finally { await close(); rmSync(home, { recursive: true, force: true }); }
  });
}, 60_000);
