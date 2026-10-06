/**
 * scripts/check-ai-sdk-importers.ts keeps provider SDK imports inside the
 * allowlist, so every model call stays observable through invokeAI.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-ai-sdk-importers.ts');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-sdk-guard-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const r = spawnSync('bun', [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-ai-sdk-importers.ts', () => {
  test.each([
    ['named import', "import { generateText } from 'ai';"],
    ['default import', "import Anthropic from '@anthropic-ai/sdk';"],
    ['provider package', "import { createOpenAI } from '@ai-sdk/openai';"],
    ['dynamic import', "export const f = () => import('openai');"],
    ['require', "export const f = () => require('ai');"],
    ['multi-line import', "import {\n  embedMany,\n} from 'ai';"],
  ])('%s outside the allowlist fails with FAIL/Fix/Why/See', (_label, line) => {
    const r = run({ 'scripts/ai-sdk-importers.allowlist': 'src/core/ai/gateway.ts\n', 'src/core/ai/gateway.ts': "import { generateText } from 'ai';\n", 'src/core/new-writer.ts': line + '\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/new-writer.ts');
    for (const label of ['Fix:', 'Why:', 'See:  docs/TESTING.md#ai-sdk-importer-guard']) expect(r.out).toContain(label);
  });

  test('type-only imports and allowlisted importers pass', () => {
    const r = run({
      'scripts/ai-sdk-importers.allowlist': '# comment\nsrc/core/ai/gateway.ts\n',
      'src/core/ai/gateway.ts': "import { generateText } from 'ai';\n",
      'src/core/ai/providers/cli.ts': "import type { LanguageModelV2 } from '@ai-sdk/provider';\nimport { type JSONSchema7 } from 'ai';\n",
    });
    expect(r.code).toBe(0);
  });

  test('a stale allowlist line fails', () => {
    const r = run({ 'scripts/ai-sdk-importers.allowlist': 'src/core/ai/gateway.ts\nsrc/core/old.ts\n', 'src/core/ai/gateway.ts': "import { generateText } from 'ai';\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain('lists src/core/old.ts');
  });
});
