import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = join(import.meta.dir, '..');
const wrapperPaths = [
  'skills/oss-loop/scripts/create-upstream-draft.sh',
  'plugin/skills/oss-loop/scripts/create-upstream-draft.sh',
  'plugin-variants/gbrain-coding/skills/oss-loop/scripts/create-upstream-draft.sh',
];

describe('OSS loop publication guard', () => {
  test('ships one identical wrapper to every coding-agent lane', () => {
    const wrappers = wrapperPaths.map((path) => readFileSync(join(root, path), 'utf8'));
    expect(new Set(wrappers).size).toBe(1);
  });

  test('requires an explicit upstream target and fully qualified head', () => {
    const wrapper = readFileSync(join(root, wrapperPaths[0]), 'utf8');
    expect(wrapper).toContain('--target OWNER/REPO');
    expect(wrapper).toContain('--head OWNER:BRANCH');
    expect(wrapper).toContain('verify-target.sh" --target "$target"');
    expect(wrapper).toContain('pr create --repo "$target"');
    expect(wrapper).toContain('--head "$head"');
    expect(wrapper).toContain('--draft');
  });
});
