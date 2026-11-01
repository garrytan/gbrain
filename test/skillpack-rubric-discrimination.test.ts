import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { walkRubric } from '../src/core/skillpack/rubric.ts';
import { loadSkillpackManifest, SKILLPACK_API_VERSION } from '../src/core/skillpack/manifest-v1.ts';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'skillpack-rubric-discrimination-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function scorePack(changelog: string, routingEval: string) {
  const root = mkdtempSync(join(scratch, 'pack-'));
  mkdirSync(join(root, 'skills/sample'), { recursive: true });
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify({
    api_version: SKILLPACK_API_VERSION,
    name: 'sample-pack',
    version: '0.1.0',
    description: 'Rubric regression fixture',
    author: 'Test Author',
    license: 'MIT',
    homepage: 'https://',
    gbrain_min_version: '0.36.0',
    skills: ['skills/sample'],
  }));
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  writeFileSync(join(root, 'skills/sample/routing-eval.jsonl'), routingEval);
  return walkRubric({ packRoot: root, manifest: loadSkillpackManifest(root) });
}

test('routing rubric counts parsed fixtures instead of comment lines', async () => {
  const score = await scorePack(
    '## [0.1.0]\n',
    '// comment\n// comment\n// comment\n// comment\n// comment\n',
  );
  const routing = score.dimensions.find((dimension) => dimension.name === 'routing_evals_present');
  expect(routing?.passed).toBe(false);
  expect(routing?.detail).toContain('has 0 intents');
});

test('changelog rubric accepts only current-version headings with a version boundary', async () => {
  const misleading = [
    '## [0.1.01]\n',
    '## [0.1.0-rc.1]\n',
    'See ## 0.1.0-rc.1\n',
    '##\n0.1.0\n',
  ];
  const valid = ['## [0.1.0]\n', '## [0.1.0]\r\n'];
  const outcomes = await Promise.all(
    [...misleading, ...valid].map(async (changelog) => {
      const score = await scorePack(changelog, '');
      return score.dimensions.find((dimension) => dimension.name === 'changelog_present_and_current')?.passed;
    }),
  );
  expect(outcomes).toEqual([false, false, false, false, true, true]);
});
