/**
 * A roster agent's own workspace written as ~/... sits under OpenClaw's home,
 * which is OPENCLAW_HOME when it is set, the same as the default agent's.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { openclawSkillRoots } from '../src/core/setup/openclaw-skill-plugin.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-oc-agent-skills-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a roster agent's ~/ workspace resolves under OPENCLAW_HOME", async () => {
  const home = join(root, 'home');
  const openclawHome = join(root, 'openclaw-home');
  mkdirSync(join(openclawHome, 'ws', 'skills'), { recursive: true });
  mkdirSync(join(home, 'ws', 'skills'), { recursive: true });
  await withEnv({ HOME: home, OPENCLAW_HOME: openclawHome, OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_PROFILE: undefined }, async () => {
    const roster = [{ id: 'writer', workspace: '~/ws' }, { id: 'other', workspace: '~/elsewhere' }];
    expect(openclawSkillRoots('writer', null, { roster }).roots).toEqual([{ dir: join(openclawHome, 'ws', 'skills'), source: 'openclaw-workspace' }]);
  });
});
